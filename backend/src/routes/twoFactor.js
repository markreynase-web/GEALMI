// src/routes/twoFactor.js
// Pantalla "Seguridad" (Nivel 3): activar y desactivar la verificación en dos
// pasos (TOTP) de la PROPIA cuenta. El paso extra al iniciar sesión vive en
// routes/auth.js (POST /login/2fa); restablecerle el 2FA a otra persona, en
// routes/usuarios.js (POST /:id/reset-2fa).
//
// Transversal, como sucursales/cajas/api-keys: sin requireModulo() ni
// permisos de rol -- cada persona gestiona su propia cuenta. Lo que sí se
// revisa es el PLAN de la empresa (planes.acceso_2fa) al activar. Una vez
// activado, bajar de plan NO apaga el 2FA: quitarle una protección a alguien
// por un cambio de plan sería peor que dejársela.

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { permitir } from '../rateLimiter.js';
import { logger } from '../logger.js';
import { verificarSegundoFactor } from '../segundoFactor.js';
import {
  generarSecreto, urlOtpauth, cifrarSecreto, descifrarSecreto, verificarCodigoTotp, cifradoDisponible,
  generarCodigosRecuperacion, normalizarCodigoRecuperacion, hashCodigoRecuperacion
} from '../totp.js';

const router = Router();
router.use(auth, requireEmpresa);
// Una sesión de soporte (super admin impersonando una empresa) lleva el id
// del SUPER ADMIN: no debe poder tocar el 2FA de nadie desde ahí.
router.use((req, res, next) => {
  if (req.usuario.impersonando === true) {
    return res.status(403).json({ error: 'No disponible durante una sesión de soporte.' });
  }
  next();
});

const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const CANTIDAD_CODIGOS_RECUPERACION = 10;

async function planIncluye2FA(empresaId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(p.acceso_2fa, false) AS permite
     FROM empresas e LEFT JOIN planes p ON p.id = e.plan_id
     WHERE e.id = $1`,
    [empresaId]
  );
  return rows[0]?.permite === true;
}

const auditar = (req, accion) => registrarAuditoria(pool, {
  usuario: req.usuario, accion, modulo: 'auth', registroId: req.usuario.id, detalle: null
});

const MENSAJES_FACTOR = {
  incorrecto: 'Código incorrecto.',
  reutilizado: 'Ese código ya se usó. Espera a que tu app genere uno nuevo.',
  sin_2fa: 'Tu cuenta no tiene la verificación en dos pasos activada.'
};

// GET /api/2fa/estado
router.get('/estado', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.totp_activado_el,
              (SELECT count(*)::int FROM codigos_recuperacion_2fa c WHERE c.usuario_id = u.id AND c.usado_el IS NULL) AS codigos_restantes
       FROM usuarios u WHERE u.id = $1`,
      [req.usuario.id]
    );
    const activado = !!rows[0]?.totp_activado_el;
    const planIncluye = await planIncluye2FA(req.usuario.empresa_id);
    const servidorConfigurado = cifradoDisponible();
    res.json({
      activado,
      planIncluye,
      servidorConfigurado,
      // ¿Puede empezar a activarlo ahora? (desactivarlo siempre se puede)
      disponible: planIncluye && servidorConfigurado,
      codigosRestantes: activado ? rows[0].codigos_restantes : 0
    });
  } catch (err) {
    logger.error({ requestId: req.requestId, err }, 'No se pudo leer el estado del 2FA.');
    res.status(500).json({ error: 'No se pudo leer el estado de la verificación en dos pasos.' });
  }
});

// POST /api/2fa/iniciar -- genera el secreto y lo guarda PENDIENTE (cifrado);
// no protege nada todavía: el login solo lo exige después de /activar.
// Devuelve el secreto en claro UNA vez, para mostrarlo como QR / texto.
router.post('/iniciar', async (req, res) => {
  if (!cifradoDisponible()) {
    return res.status(503).json({ error: 'La verificación en dos pasos no está configurada en este servidor.' });
  }
  try {
    if (!(await planIncluye2FA(req.usuario.empresa_id))) {
      return res.status(403).json({ error: 'Tu plan actual no incluye la verificación en dos pasos. Contáctanos para actualizar tu plan.' });
    }
    const secreto = generarSecreto();
    const { rowCount } = await pool.query(
      'UPDATE usuarios SET totp_secreto_cifrado = $2, totp_ultimo_paso = NULL WHERE id = $1 AND totp_activado_el IS NULL',
      [req.usuario.id, cifrarSecreto(secreto)]
    );
    if (!rowCount) return res.status(409).json({ error: 'Ya tienes la verificación en dos pasos activada.' });
    res.json({ secreto, otpauthUrl: urlOtpauth({ secreto, email: req.usuario.email }) });
  } catch (err) {
    logger.error({ requestId: req.requestId, err }, 'No se pudo iniciar la activación del 2FA.');
    res.status(500).json({ error: 'No se pudo iniciar la activación.' });
  }
});

// POST /api/2fa/activar { codigo } -- confirma que la app quedó bien
// configurada (probando un código real) y recién ahí enciende el 2FA.
// Devuelve los códigos de recuperación EN CLARO, una sola vez.
router.post('/activar', async (req, res) => {
  if (!permitir(`2fa-activar:${req.usuario.id}`, { maxIntentos: 10, ventanaMs: VENTANA_INTENTOS_MS })) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' });
  }

  let cliente;
  try {
    cliente = await pool.connect();
    await cliente.query('BEGIN');
    // FOR UPDATE: dos activaciones simultáneas no deben generar dos juegos de
    // códigos de recuperación (el usuario solo vería uno, y el otro lo dejaría sin validez).
    const { rows } = await cliente.query(
      'SELECT totp_secreto_cifrado, totp_activado_el FROM usuarios WHERE id = $1 FOR UPDATE',
      [req.usuario.id]
    );
    const usuario = rows[0];
    if (usuario?.totp_activado_el) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({ error: 'Ya tienes la verificación en dos pasos activada.' });
    }
    if (!usuario?.totp_secreto_cifrado) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: 'Primero inicia la activación para obtener tu código QR.' });
    }

    const paso = verificarCodigoTotp(descifrarSecreto(usuario.totp_secreto_cifrado), req.body?.codigo);
    if (paso === null) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: 'Código incorrecto. Revisa que la hora de tu celular sea automática e inténtalo de nuevo.' });
    }

    const codigos = generarCodigosRecuperacion(CANTIDAD_CODIGOS_RECUPERACION);
    // totp_ultimo_paso = paso: el código usado para activar no sirve otra vez.
    await cliente.query('UPDATE usuarios SET totp_activado_el = now(), totp_ultimo_paso = $2 WHERE id = $1', [req.usuario.id, paso]);
    await cliente.query('DELETE FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [req.usuario.id]);
    await cliente.query(
      'INSERT INTO codigos_recuperacion_2fa (usuario_id, codigo_hash) SELECT $1, unnest($2::text[])',
      [req.usuario.id, codigos.map(c => hashCodigoRecuperacion(normalizarCodigoRecuperacion(c)))]
    );
    await cliente.query('COMMIT');

    await auditar(req, 'activar_2fa');
    res.json({ codigosRecuperacion: codigos });
  } catch (err) {
    await cliente?.query('ROLLBACK').catch(() => {});
    logger.error({ requestId: req.requestId, err }, 'No se pudo activar el 2FA.');
    res.status(500).json({ error: 'No se pudo activar la verificación en dos pasos.' });
  } finally {
    cliente?.release();
  }
});

// POST /api/2fa/desactivar { password, codigo | codigoRecuperacion } -- pide
// la contraseña Y un código: una sesión abierta y desatendida no basta para
// quitar la protección de la cuenta.
//
// Contraseña o código incorrectos responden 403, NUNCA 401: el frontend
// (js/api.js) trata todo 401 como "sesión vencida" y cierra la sesión -- un
// simple error de tipeo sacaría a la persona de la aplicación.
router.post('/desactivar', async (req, res) => {
  if (!permitir(`2fa-desactivar:${req.usuario.id}`, { maxIntentos: 5, ventanaMs: VENTANA_INTENTOS_MS })) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' });
  }
  const { password, codigo, codigoRecuperacion } = req.body || {};
  if (typeof password !== 'string' || !password || (!codigo && !codigoRecuperacion)) {
    return res.status(400).json({ error: 'Se requiere tu contraseña y un código.' });
  }

  try {
    const { rows } = await pool.query('SELECT password_hash, totp_activado_el FROM usuarios WHERE id = $1', [req.usuario.id]);
    if (!rows[0]?.totp_activado_el) return res.status(409).json({ error: MENSAJES_FACTOR.sin_2fa });
    // La contraseña se revisa ANTES que el código: un intento con la
    // contraseña mal no debe gastar un código válido.
    if (!(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(403).json({ error: 'Contraseña incorrecta.' });
    }

    const resultado = await verificarSegundoFactor(req.usuario.id, { codigo, codigoRecuperacion });
    if (!resultado.ok) return res.status(403).json({ error: MENSAJES_FACTOR[resultado.motivo] });

    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(
        'UPDATE usuarios SET totp_secreto_cifrado = NULL, totp_activado_el = NULL, totp_ultimo_paso = NULL WHERE id = $1',
        [req.usuario.id]
      );
      await cliente.query('DELETE FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [req.usuario.id]);
      await cliente.query('COMMIT');
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      cliente.release();
    }

    await auditar(req, 'desactivar_2fa');
    res.json({ ok: true });
  } catch (err) {
    logger.error({ requestId: req.requestId, err }, 'No se pudo desactivar el 2FA.');
    res.status(500).json({ error: 'No se pudo desactivar la verificación en dos pasos.' });
  }
});

export default router;
