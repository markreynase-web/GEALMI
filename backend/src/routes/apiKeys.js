// src/routes/apiKeys.js
// Gestión de API keys desde la app (JWT de sesión normal, no la key en sí
// -- para ESO está publicAPi.js). Transversal, mismo criterio que
// sucursales.js/cajas.js: sin requireModulo(), solo permisos (ver
// migración 042).

import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';

const router = Router();
router.use(auth, requireEmpresa);

const LARGO_PARTE_ALEATORIA = 40; // caracteres hex -- crypto.randomBytes(20) = 40 hex
const LARGO_PREFIJO_VISIBLE = 12; // cuánto de la parte aleatoria se guarda sin hashear (ver migración 042)

function generarApiKey() {
  const parteAleatoria = crypto.randomBytes(LARGO_PARTE_ALEATORIA / 2).toString('hex');
  const keyCompleta = `gealmi_${parteAleatoria}`;
  const prefijo = keyCompleta.slice(0, 'gealmi_'.length + LARGO_PREFIJO_VISIBLE);
  return { keyCompleta, prefijo };
}

// GET / -- lista las keys de la empresa. NUNCA devuelve key_hash ni la key
// completa -- eso solo se ve una vez, en el momento de POST /.
router.get('/', verificarPermiso('api_keys.ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ak.id, ak.nombre, ak.prefijo, ak.creado_el, ak.ultimo_uso_el, ak.activa, u.nombre AS creado_por_nombre
       FROM api_keys ak
       LEFT JOIN usuarios u ON u.id = ak.creado_por
       WHERE ak.empresa_id = $1
       ORDER BY ak.creado_el DESC`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron leer las API keys.' });
  }
});

// POST / -- { nombre }. Devuelve la key COMPLETA una sola vez -- el
// frontend tiene que mostrarla con una advertencia clara de "copiala ahora,
// no la vas a poder ver de nuevo" (mismo principio que cualquier secreto:
// nunca se guarda en texto plano, ver key_hash arriba).
router.post('/', verificarPermiso('api_keys.crear'), async (req, res) => {
  const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
  if (!nombre) return res.status(400).json({ error: 'nombre es requerido (ej. "Integración con mi contador").' });

  try {
    // El plan actual de la empresa tiene que incluir acceso a la API --
    // mismo chequeo que hace authApiKey() en cada request real, pero acá
    // además evita que alguien genere una key que nunca va a poder usar.
    const { rows: empresaRows } = await pool.query(
      `SELECT COALESCE(p.acceso_api, false) AS acceso_api
       FROM empresas e LEFT JOIN planes p ON p.id = e.plan_id
       WHERE e.id = $1`,
      [req.usuario.empresa_id]
    );
    if (!empresaRows[0]?.acceso_api) {
      return res.status(403).json({ error: 'Tu plan actual no incluye acceso a la API pública. Contáctanos para actualizar tu plan.' });
    }

    const { keyCompleta, prefijo } = generarApiKey();
    const hash = await bcrypt.hash(keyCompleta, 10);

    const { rows } = await pool.query(
      `INSERT INTO api_keys (empresa_id, nombre, prefijo, key_hash, creado_por) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nombre, prefijo, creado_el, activa`,
      [req.usuario.empresa_id, nombre, prefijo, hash, req.usuario.id]
    );
    // La única vez que la key completa sale de la base -- ni el propio
    // backend la guarda en ningún lado después de esta respuesta.
    res.status(201).json({ ...rows[0], key: keyCompleta });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'api_keys', registroId: rows[0].id, detalle: { nombre, prefijo } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear la API key.' });
  }
});

// DELETE /:id -- revoca (no borra la fila, para que quede historial de
// auditoría de qué keys existieron -- mismo motivo que las contraseñas
// vencidas en password_reset_tokens no se borran, ver migración 030).
router.delete('/:id', verificarPermiso('api_keys.eliminar'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE api_keys SET activa = false WHERE id = $1 AND empresa_id = $2 AND activa = true RETURNING id, nombre`,
      [req.params.id, req.usuario.empresa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'API key no encontrada (o ya estaba revocada).' });
    res.json({ ok: true });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'api_keys', registroId: req.params.id, detalle: { revocada: rows[0].nombre } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo revocar la API key.' });
  }
});

export default router;
