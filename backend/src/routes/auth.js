// src/routes/auth.js
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db.js';
import { auth } from '../middleware/auth.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { enviarCorreoRecuperacion } from '../mailer.js';
import { permitir } from '../rateLimiter.js';
import { passwordCumplePolitica, MENSAJE_POLITICA_PASSWORD } from '../passwordPolicy.js';
import { logger } from '../logger.js';
import { verificarSegundoFactor } from '../segundoFactor.js';

const router = Router();
const DURACION_TOKEN = '8h';
// El freeze de 8h de DURACION_TOKEN no solo congela los permisos (ver la
// nota de trade-off en middleware/permisos.js) -- desde Fase A también
// congela la EMPRESA activa: a alguien removido de una empresa a media
// sesión le sigue funcionando el acceso a esos datos hasta por 8h, o hasta
// que vuelva a iniciar sesión. Aceptado como trade-off de Fase A; si algún
// día hace falta revocar al instante, la alternativa es una tabla de
// tokens invalidados o acortar este valor.
const DURACION_PREAUTH = '5m';
// Prueba de que la contraseña ya se validó y falta el código de 2FA. Igual
// que el preAuthToken: no lleva empresa_id, así que requireEmpresa() la
// rechaza en todo router de datos (ver middleware/auth.js).
const DURACION_DESAFIO_2FA = '5m';

// Junta el rol, la lista de permisos y la sucursal (si la tiene asignada)
// que tiene un usuario DENTRO de una empresa concreta (join usuario_empresa
// → roles → rol_permiso → permisos). Se usa al hacer login para "congelar"
// esto dentro del JWT -- ver la nota de trade-off en middleware/permisos.js
// (misma lógica aplica ahora a sucursal_id: cambiarla tarda hasta el
// próximo login, no es instantáneo). A partir de Fase A el rol ya no es un
// atributo global del usuario (usuarios.rol_id) sino de su membresía a esa
// empresa (usuario_empresa.rol_id), porque una misma persona puede tener
// roles distintos en cada empresa a la que pertenece -- sucursal_id sigue
// el mismo criterio (Sub-fase D).
async function permisosDeUsuario(usuarioId, empresaId) {
  const { rows } = await pool.query(
    `SELECT r.nombre AS rol, ue.sucursal_id,
            COALESCE(array_agg(p.nombre) FILTER (WHERE p.nombre IS NOT NULL), '{}') AS permisos
     FROM usuario_empresa ue
     JOIN roles r ON r.id = ue.rol_id
     LEFT JOIN rol_permiso rp ON rp.rol_id = r.id
     LEFT JOIN permisos p ON p.id = rp.permiso_id
     WHERE ue.usuario_id = $1 AND ue.empresa_id = $2
     GROUP BY r.nombre, ue.sucursal_id`,
    [usuarioId, empresaId]
  );
  return rows[0] || { rol: null, sucursal_id: null, permisos: [] };
}

// Firma el token completo de una sesión ya resuelta a UNA empresa concreta
// (ya sea porque el usuario solo pertenece a una, o porque acaba de
// elegirla en /login/empresa).
async function firmarSesion(usuario, empresaId, empresaNombre) {
  const { rol, sucursal_id, permisos } = await permisosDeUsuario(usuario.id, empresaId);
  const payload = {
    id: usuario.id,
    nombre: usuario.nombre,
    email: usuario.email,
    empresa_id: empresaId,
    empresa_nombre: empresaNombre,
    rol,
    // Sub-fase D: null = sin restricción (ve/opera en todas las sucursales
    // de la empresa). Explícito acá, nunca "el campo simplemente no está" --
    // ver middleware/sucursal.js, que ya trata undefined igual que null,
    // pero un payload viejo (JWT emitido antes de esta sub-fase) de verdad
    // no trae el campo, y eso también debe leerse como sin restricción.
    sucursal_id: sucursal_id ?? null,
    permisos
  };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: DURACION_TOKEN });
  return { token, usuario: payload };
}

// Último paso del login, una vez que la persona ya probó quién es (contraseña
// y, si lo tiene activado, 2FA): resuelve a qué empresa entra. Lo comparten
// POST /login y POST /login/2fa.
//
// "Login inteligente": la identidad (usuarios) es global, la empresa activa
// sale de a qué empresas pertenece ese usuario (usuario_empresa).
async function completarLogin(res, usuario, { segundoFactorVerificado = false } = {}) {
  const { rows: membresias } = await pool.query(
    `SELECT ue.empresa_id, e.nombre AS empresa_nombre
     FROM usuario_empresa ue
     JOIN empresas e ON e.id = ue.empresa_id
     WHERE ue.usuario_id = $1 AND ue.activo = true AND e.activo = true
     ORDER BY e.nombre`,
    [usuario.id]
  );

  if (!membresias.length) {
    return res.status(401).json({ error: 'Tu usuario no está asociado a ninguna empresa activa.' });
  }

  if (membresias.length === 1) {
    const sesion = await firmarSesion(usuario, membresias[0].empresa_id, membresias[0].empresa_nombre);
    return res.json(sesion);
  }

  // Más de una empresa: no se firma el token completo todavía. Se manda
  // un preAuthToken de corta duración (prueba de que el password ya se
  // validó, sin repetir el login) + la lista para que el frontend
  // muestre el selector.
  //
  // `mfa: true` = esta persona ya pasó el código de 2FA en ESTE login. Sin
  // esa marca, un preAuthToken pedido cuando el 2FA estaba apagado (dura 5
  // min) serviría para saltarse el código si la persona lo activa justo
  // después -- POST /login/empresa lo exige mientras el 2FA esté activo.
  const preAuthToken = jwt.sign(
    { id: usuario.id, tipo: 'preauth', ...(segundoFactorVerificado ? { mfa: true } : {}) },
    process.env.JWT_SECRET,
    { expiresIn: DURACION_PREAUTH }
  );
  res.json({
    requiereSeleccionEmpresa: true,
    preAuthToken,
    empresas: membresias.map(m => ({ id: m.empresa_id, nombre: m.empresa_nombre }))
  });
}

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña son requeridos.' });

  // Mismo mecanismo que ya usa forgot-password (rateLimiter.js), aplicado acá
  // por primera vez -- antes este endpoint no tenía ningún freno contra
  // fuerza bruta o credential stuffing. 5 intentos/15min por email: más
  // holgado que forgot-password (3) porque acá es normal tipear mal la
  // contraseña un par de veces seguidas.
  const emailNormalizado = String(email).trim().toLowerCase();
  if (!permitir(`login:${emailNormalizado}`, { maxIntentos: 5, ventanaMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT * FROM usuarios WHERE lower(email) = lower($1) AND activo = true',
      [email]
    );
    const usuario = rows[0];
    // Mismo mensaje si el usuario no existe o si la contraseña está mal —
    // no le decimos a quien intenta entrar cuál de las dos cosas falló.
    if (!usuario) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

    const coincide = await bcrypt.compare(password, usuario.password_hash);
    if (!coincide) return res.status(401).json({ error: 'Email o contraseña incorrectos.' });

    // Super admin: sesión exclusiva, nunca pasa por la resolución de
    // empresas de abajo -- ni siquiera si esta cuenta también tuviera
    // membresías en usuario_empresa (v1: no hay selector de modo "entro
    // como super admin" vs "entro como empresa X").
    if (usuario.es_super_admin) {
      // Sesión de super admin (fuera de una impersonación): no tiene
      // empresa_id, así que sucursal_id no tiene sentido -- explícito en
      // null igual que en el resto de sesiones, nunca "el campo no está".
      const payload = { id: usuario.id, nombre: usuario.nombre, email: usuario.email, es_super_admin: true, sucursal_id: null };
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: DURACION_TOKEN });
      return res.json({ token, usuario: payload });
    }

    // Segundo factor (2FA), solo si esta persona lo activó. Va ANTES de mirar
    // sus empresas: quien solo conoce la contraseña no debe enterarse de a
    // cuáles pertenece. La cuenta de super admin queda fuera en esta versión
    // (el 2FA es una función del plan Empresarial, ver planes.acceso_2fa).
    if (usuario.totp_activado_el) {
      const desafioToken = jwt.sign({ id: usuario.id, tipo: 'desafio2fa' }, process.env.JWT_SECRET, { expiresIn: DURACION_DESAFIO_2FA });
      return res.json({ requiere2FA: true, desafioToken });
    }

    return await completarLogin(res, usuario);
  } catch (err) {
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 500, body: req.body, err }, 'No se pudo iniciar sesión.');
    res.status(500).json({ error: 'No se pudo iniciar sesión.' });
  }
});

// Segundo paso del login para quien tiene 2FA activado. El desafioToken (lo
// entrega POST /login solo cuando la contraseña era correcta) demuestra que
// falta únicamente el código. Acepta el código de la app (`codigo`) o uno de
// recuperación (`codigoRecuperacion`, de un solo uso, para quien perdió el
// celular). Si la persona tiene varias empresas, sigue el mismo selector de
// siempre (preAuthToken) -- el 2FA es de la identidad, se pide una sola vez.
router.post('/login/2fa', async (req, res) => {
  const { desafioToken, codigo, codigoRecuperacion } = req.body || {};
  if (!desafioToken || (!codigo && !codigoRecuperacion)) {
    return res.status(400).json({ error: 'desafioToken y un código son requeridos.' });
  }

  let payload;
  try {
    payload = jwt.verify(desafioToken, process.env.JWT_SECRET);
    if (payload.tipo !== 'desafio2fa') throw new Error('tipo inválido');
  } catch (err) {
    return res.status(401).json({ error: 'La verificación venció. Inicia sesión de nuevo.' });
  }

  // Sin este freno, quien ya conoce la contraseña podría probar los
  // 1.000.000 de códigos posibles. El límite es por CUENTA (no por IP): un
  // atacante rota IPs, pero la cuenta atacada es siempre la misma.
  if (!permitir(`2fa:${payload.id}`, { maxIntentos: 5, ventanaMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos antes de volver a intentar.' });
  }

  try {
    const { rows } = await pool.query('SELECT id, nombre, email FROM usuarios WHERE id = $1 AND activo = true', [payload.id]);
    const usuario = rows[0];
    if (!usuario) return res.status(401).json({ error: 'La verificación venció. Inicia sesión de nuevo.' });

    const resultado = await verificarSegundoFactor(usuario.id, { codigo, codigoRecuperacion });
    // Sin 2FA activo (se lo restablecieron entre los dos pasos): el desafío ya no aplica.
    if (resultado.motivo === 'sin_2fa') return res.status(401).json({ error: 'La verificación venció. Inicia sesión de nuevo.' });

    const empresaIdAuditoria = await empresaIdParaAuditoria(usuario.id);
    const auditar = (accion) => empresaIdAuditoria && registrarAuditoria(pool, {
      usuario: { id: usuario.id, nombre: usuario.nombre, empresa_id: empresaIdAuditoria },
      accion, modulo: 'auth', registroId: usuario.id, detalle: null
    });

    if (!resultado.ok) {
      await auditar('login_2fa_fallo');
      return res.status(401).json({
        error: resultado.motivo === 'reutilizado'
          ? 'Ese código ya se usó. Espera a que tu app genere uno nuevo.'
          : 'Código incorrecto.'
      });
    }

    // Entrar con un código de recuperación es un evento que la empresa debe
    // poder ver: significa que esa persona no tenía a mano su app.
    if (resultado.medio === 'recuperacion') await auditar('usar_cod_recup');

    return await completarLogin(res, usuario, { segundoFactorVerificado: true });
  } catch (err) {
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 500, err }, 'No se pudo verificar el segundo factor.');
    res.status(500).json({ error: 'No se pudo verificar el código.' });
  }
});

// Segundo paso del login para usuarios con más de una empresa. El
// empresa_id que manda el cliente NUNCA se confía a ciegas -- se revalida
// server-side contra usuario_empresa antes de firmar el token real.
router.post('/login/empresa', async (req, res) => {
  const { preAuthToken, empresa_id } = req.body || {};
  if (!preAuthToken || !empresa_id) {
    return res.status(400).json({ error: 'preAuthToken y empresa_id son requeridos.' });
  }

  let payload;
  try {
    payload = jwt.verify(preAuthToken, process.env.JWT_SECRET);
    if (payload.tipo !== 'preauth') throw new Error('tipo inválido');
  } catch (err) {
    return res.status(401).json({ error: 'Selección de empresa vencida. Inicia sesión de nuevo.' });
  }

  try {
    // u.* (y no una lista de columnas) para que leer totp_activado_el no
    // dependa de que la migración 043 ya esté aplicada: el login no debe
    // caerse en la ventana entre desplegar el código y migrar.
    const { rows } = await pool.query(
      `SELECT u.*, e.id AS empresa_id, e.nombre AS empresa_nombre
       FROM usuario_empresa ue
       JOIN usuarios u ON u.id = ue.usuario_id
       JOIN empresas e ON e.id = ue.empresa_id
       WHERE ue.usuario_id = $1 AND ue.empresa_id = $2 AND ue.activo = true AND u.activo = true AND e.activo = true`,
      [payload.id, empresa_id]
    );
    if (!rows.length) return res.status(403).json({ error: 'No perteneces a esa empresa.' });

    const fila = rows[0];
    // Si tiene 2FA activo, este preAuthToken tiene que venir de un login que
    // SÍ pasó el código (mfa:true, ver completarLogin). Uno pedido antes de
    // que lo activara no vale: se vuelve a iniciar sesión.
    if (fila.totp_activado_el && payload.mfa !== true) {
      return res.status(401).json({ error: 'Selección de empresa vencida. Inicia sesión de nuevo.' });
    }
    const sesion = await firmarSesion(fila, fila.empresa_id, fila.empresa_nombre);
    res.json(sesion);
  } catch (err) {
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 500, body: req.body, err }, 'No se pudo completar el inicio de sesión.');
    res.status(500).json({ error: 'No se pudo completar el inicio de sesión.' });
  }
});

// --- Recuperación de contraseña ---
// Las tres rutas de abajo son públicas a propósito (nadie tiene sesión
// todavía cuando las usa) -- por eso NO llevan auth(). La seguridad acá no
// es "quién puede llamar a esto" sino "qué se revela y qué tan explotable
// es": nunca se confirma si un correo existe (ver MENSAJE_GENERICO), el
// token es aleatorio de 256 bits y de un solo uso, y hay un límite de
// solicitudes por correo (ver rateLimiter.js).

const DURACION_RESET_MS = 30 * 60 * 1000; // 30 minutos -- dentro del rango 15-60 recomendado
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// audit_log.empresa_id es NOT NULL (ver 012_empresas.sql) -- pero un evento
// de recuperación de contraseña es de la IDENTIDAD (usuarios), no de una
// empresa concreta. Se resuelve la primera empresa a la que pertenece ese
// usuario (si tiene alguna) para que el evento SÍ aparezca en la pantalla de
// Auditoría de esa empresa; un super admin sin ninguna empresa (o un usuario
// sin membresías activas) simplemente no genera fila de auditoría -- mismo
// criterio de "el audit log es un además, nunca bloquea" que ya documenta
// registroAuditoria.js.
async function empresaIdParaAuditoria(usuarioId) {
  const { rows } = await pool.query(
    'SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1 ORDER BY empresa_id LIMIT 1',
    [usuarioId]
  );
  return rows[0]?.empresa_id ?? null;
}

// POST /forgot-password { email }
router.post('/forgot-password', async (req, res) => {
  const email = normalizarEmail(req.body?.email);
  const MENSAJE_GENERICO = { mensaje: 'Si existe una cuenta asociada a este correo, recibirás instrucciones para restablecer tu contraseña.' };

  if (!email || !REGEX_EMAIL.test(email)) {
    return res.status(400).json({ error: 'Ingresa un correo electrónico válido.' });
  }

  // El límite se aplica ANTES de buscar si la cuenta existe, con el mismo
  // mensaje de "demasiados intentos" exista o no esa cuenta -- así ni
  // siquiera la frecuencia de respuestas deja adivinar si un correo está
  // registrado.
  if (!permitir(`forgot:${email}`, { maxIntentos: 3, ventanaMs: 15 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Ya solicitaste esto hace poco. Espera unos minutos antes de volver a intentar.' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, nombre, email FROM usuarios WHERE lower(email) = $1 AND activo = true',
      [email]
    );
    const usuario = rows[0];

    // No revelar si el correo existe: SIEMPRE 200 con el mismo mensaje. Todo
    // lo de abajo (token, correo, auditoría) solo corre cuando SÍ hay una
    // cuenta real -- no tiene sentido generar un token para nadie.
    if (!usuario) return res.json(MENSAJE_GENERICO);

    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + DURACION_RESET_MS);
    await pool.query(
      'INSERT INTO password_reset_tokens (usuario_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [usuario.id, tokenHash, expiresAt]
    );

    const baseFrontend = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
    const resetUrl = `${baseFrontend}/pages/restablecer-password.html?token=${token}`;
    await enviarCorreoRecuperacion({ to: usuario.email, nombre: usuario.nombre, resetUrl });

    const empresaIdAuditoria = await empresaIdParaAuditoria(usuario.id);
    if (empresaIdAuditoria) {
      // accion <= 20 caracteres: audit_log.accion es VARCHAR(20) (ver
      // 006_auditoria.sql) -- 'solicitar_recuperacion' (22) no entraba.
      await registrarAuditoria(pool, {
        usuario: { id: usuario.id, nombre: usuario.nombre, empresa_id: empresaIdAuditoria },
        accion: 'solicitar_reset', modulo: 'auth', registroId: usuario.id, detalle: null
      });
    }

    res.json(MENSAJE_GENERICO);
  } catch (err) {
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 500, body: req.body, err }, 'No se pudo procesar la solicitud de recuperación de contraseña.');
    // Acá sí se distingue: un error real de servidor no es lo mismo que
    // "no existe esa cuenta" (eso arriba siempre da 200) -- decirlo no
    // revela nada sobre ninguna cuenta, solo que algo falló y conviene reintentar.
    res.status(500).json({ error: 'No se pudo procesar tu solicitud. Intenta de nuevo en unos minutos.' });
  }
});

// GET /reset-password/validar?token=... -- la pantalla de "nueva
// contraseña" lo llama al cargar, para mostrar de entrada "enlace inválido"
// en vez de esperar a que el usuario escriba una contraseña para recién ahí
// descubrirlo. Nunca distingue expirado/usado/inexistente -- ver sección de
// abajo, "no mostrar información técnica".
router.get('/reset-password/validar', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.json({ valido: false });
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await pool.query(
      'SELECT 1 FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [tokenHash]
    );
    res.json({ valido: rows.length > 0 });
  } catch (err) {
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 200, query: req.query, err }, 'Error al validar un token de reset.');
    res.json({ valido: false });
  }
});

// POST /reset-password { token, password }
router.post('/reset-password', async (req, res) => {
  const token = String(req.body?.token || '');
  const password = req.body?.password;
  if (!token) return res.status(400).json({ error: 'Este enlace ya no es válido.' });
  if (!passwordCumplePolitica(password)) {
    return res.status(400).json({ error: MENSAJE_POLITICA_PASSWORD });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // FOR UPDATE: si el enlace se abre/envía dos veces casi al mismo tiempo
    // (doble clic, dos pestañas), esto evita que ambos requests pasen la
    // validación "no usado todavía" a la vez y el token se gaste dos veces.
    const { rows } = await cliente.query(
      `SELECT prt.id, prt.usuario_id, u.nombre
       FROM password_reset_tokens prt
       JOIN usuarios u ON u.id = prt.usuario_id
       WHERE prt.token_hash = $1 AND prt.used_at IS NULL AND prt.expires_at > now()
       FOR UPDATE OF prt`,
      [tokenHash]
    );
    if (!rows.length) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ error: 'Este enlace ya no es válido.' });
    }
    const fila = rows[0];

    const hash = await bcrypt.hash(password, 10);
    await cliente.query('UPDATE usuarios SET password_hash = $1, actualizado_el = now() WHERE id = $2', [hash, fila.usuario_id]);
    // Se marca usado, nunca se borra la fila -- queda como registro de que
    // ese token existió y se consumió (ver comentario en la migración 030).
    await cliente.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [fila.id]);
    await cliente.query('COMMIT');

    const empresaIdAuditoria = await empresaIdParaAuditoria(fila.usuario_id);
    if (empresaIdAuditoria) {
      await registrarAuditoria(pool, {
        usuario: { id: fila.usuario_id, nombre: fila.nombre, empresa_id: empresaIdAuditoria },
        accion: 'completar_reset', modulo: 'auth', registroId: fila.usuario_id, detalle: null
      });
    }

    res.json({ mensaje: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    await cliente.query('ROLLBACK');
    logger.error({ requestId: req.requestId, method: req.method, url: req.originalUrl, statusCode: 500, body: req.body, err }, 'No se pudo actualizar la contraseña (reset).');
    res.status(500).json({ error: 'No se pudo actualizar la contraseña. Intenta de nuevo.' });
  } finally {
    cliente.release();
  }
});

// Protegida con auth(): sirve para que el frontend confirme que el token
// sigue siendo válido, y es la primera ruta que de verdad usa el middleware.
router.get('/me', auth, (req, res) => {
  res.json({ usuario: req.usuario });
});

export default router;
