// src/routes/notificaciones.js
// Notificaciones y mensajes entre usuarios (paso 6 del backlog; migración 044).
// UN solo sistema: la campana, la pantalla "Notificaciones" y los mensajes que
// se mandan entre personas leen la misma tabla. Los avisos automáticos (stock
// bajo, arqueo con diferencia, caja abierta, vencimientos) los crea
// src/notificaciones.js; acá vive lo que ve y hace cada usuario:
//   - leer las PROPIAS notificaciones (sin permiso: todo usuario con sesión),
//   - marcarlas leídas / dar "Enterado" a las importantes,
//   - mandar un mensaje a personas, un rol, una sucursal o a todos
//     (permiso mensajes.enviar) y ver quién lo recibió, lo leyó y lo confirmó.
//
// Como sucursales.js y usuarios.js, es transversal: auth() + requireEmpresa(),
// sin requireModulo (no es un módulo que se contrate).
//
// Todo se filtra por usuario_id Y empresa_id: no existe ninguna ruta que lea o
// cambie la notificación de otra persona. Los ids ajenos responden 404/0 filas,
// igual que uno que no existe.
//
// Entrega: no hay conexión en vivo (Render gratis duerme al servicio y no
// mantiene sockets); la campana consulta GET /resumen cada ~30 s y al volver a
// la pestaña. "Entregada" = la primera vez que el navegador del destinatario
// consultó después de que se creó.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { auth, requireEmpresa } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { permitir } from '../rateLimiter.js';
import { insertarNotificaciones, revisarAlertasProgramadas } from '../notificaciones.js';

const router = Router();
router.use(auth, requireEmpresa);

const MAX_TITULO = 120;
const MAX_CUERPO = 2000;
const MAX_DESTINATARIOS = 500;
const MAX_IDS_POR_PEDIDO = 200;
const RE_ENLACE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // solo el nombre de una página interna ("cajas"), nunca una URL
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAMPOS = `id, tipo, prioridad, titulo, cuerpo, enlace, remitente_nombre, creada_el, entregada_el, leida_el, enterado_el`;

function fila(n) {
  return {
    ...n,
    leida: n.leida_el !== null,
    requiere_enterado: n.prioridad === 'alta' && n.enterado_el === null
  };
}

const esEnteroPositivo = (v) => Number.isInteger(v) && v > 0;

function error500(res, mensaje) {
  return (err) => {
    console.error(err);
    res.status(500).json({ error: mensaje });
  };
}

// ---------- Lo que ve cada usuario ----------

// Lo que consulta la campana cada ~30 s: cuántas hay sin leer, las importantes
// que esperan un "Enterado" y las últimas para el desplegable. Un solo viaje.
// Primero corre el barrido periódico (con freno, ver src/notificaciones.js) y
// recién después se lee, así lo que él genera ya llega en esta misma respuesta.
router.get('/resumen', async (req, res) => {
  const { id: usuarioId, empresa_id: empresaId } = req.usuario;
  try {
    // Una sesión de soporte lleva el id del super admin: sin notificaciones
    // propias, y no debe disparar trabajo dentro de la empresa que atiende.
    if (req.usuario.impersonando !== true) await revisarAlertasProgramadas(empresaId);

    await pool.query(
      `UPDATE notificaciones SET entregada_el = now() WHERE usuario_id = $1 AND empresa_id = $2 AND entregada_el IS NULL`,
      [usuarioId, empresaId]
    );
    // En secuencia, no con Promise.all: cada consulta tarda milisegundos y así un sondeo usa UNA
    // conexión a la vez -- el pool es de 10 y esto corre cada ~30 s por cada persona conectada.
    const conteo = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE leida_el IS NULL)::int AS no_leidas,
              COUNT(*) FILTER (WHERE prioridad = 'alta' AND enterado_el IS NULL)::int AS pendientes_enterado
       FROM notificaciones WHERE usuario_id = $1 AND empresa_id = $2 AND (leida_el IS NULL OR (prioridad = 'alta' AND enterado_el IS NULL))`,
      [usuarioId, empresaId]
    );
    const importantes = await pool.query(
      `SELECT ${CAMPOS} FROM notificaciones
       WHERE usuario_id = $1 AND empresa_id = $2 AND prioridad = 'alta' AND enterado_el IS NULL
       ORDER BY creada_el DESC, id DESC LIMIT 5`,
      [usuarioId, empresaId]
    );
    const recientes = await pool.query(
      `SELECT ${CAMPOS} FROM notificaciones WHERE usuario_id = $1 AND empresa_id = $2 ORDER BY creada_el DESC, id DESC LIMIT 8`,
      [usuarioId, empresaId]
    );
    res.json({
      no_leidas: conteo.rows[0].no_leidas,
      pendientes_enterado: conteo.rows[0].pendientes_enterado,
      importantes: importantes.rows.map(fila),
      recientes: recientes.rows.map(fila)
    });
  } catch (err) {
    error500(res, 'No se pudieron leer las notificaciones.')(err);
  }
});

// GET /api/notificaciones?estado=todas|sin_leer|importantes&limite=&pagina=
router.get('/', async (req, res) => {
  const { id: usuarioId, empresa_id: empresaId } = req.usuario;
  const limite = Math.min(Math.max(parseInt(req.query.limite, 10) || 30, 1), 100);
  const pagina = Math.max(parseInt(req.query.pagina, 10) || 1, 1);
  const estado = req.query.estado || 'todas';
  const filtros = { todas: '', sin_leer: ' AND leida_el IS NULL', importantes: " AND prioridad = 'alta' AND enterado_el IS NULL" };
  if (!(estado in filtros)) return res.status(400).json({ error: 'estado debe ser todas, sin_leer o importantes.' });
  try {
    await pool.query(
      `UPDATE notificaciones SET entregada_el = now() WHERE usuario_id = $1 AND empresa_id = $2 AND entregada_el IS NULL`,
      [usuarioId, empresaId]
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND empresa_id = $2${filtros[estado]}`, [usuarioId, empresaId]);
    const datos = await pool.query(
      `SELECT ${CAMPOS} FROM notificaciones WHERE usuario_id = $1 AND empresa_id = $2${filtros[estado]}
       ORDER BY creada_el DESC, id DESC LIMIT $3 OFFSET $4`,
      [usuarioId, empresaId, limite, (pagina - 1) * limite]
    );
    res.json({ total: total.rows[0].n, pagina, limite, datos: datos.rows.map(fila) });
  } catch (err) {
    error500(res, 'No se pudieron leer las notificaciones.')(err);
  }
});

// POST /api/notificaciones/leer -- { ids: [1, 2] } o { todas: true }
router.post('/leer', async (req, res) => {
  const { id: usuarioId, empresa_id: empresaId } = req.usuario;
  const { ids, todas } = req.body || {};
  try {
    let resultado;
    if (todas === true) {
      resultado = await pool.query(
        `UPDATE notificaciones SET leida_el = now(), entregada_el = COALESCE(entregada_el, now())
         WHERE usuario_id = $1 AND empresa_id = $2 AND leida_el IS NULL`,
        [usuarioId, empresaId]
      );
    } else {
      if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS_POR_PEDIDO || !ids.every(esEnteroPositivo)) {
        return res.status(400).json({ error: `Manda { todas: true } o { ids: [...] } con hasta ${MAX_IDS_POR_PEDIDO} números.` });
      }
      resultado = await pool.query(
        `UPDATE notificaciones SET leida_el = COALESCE(leida_el, now()), entregada_el = COALESCE(entregada_el, now())
         WHERE usuario_id = $1 AND empresa_id = $2 AND id = ANY($3::int[])`,
        [usuarioId, empresaId, ids]
      );
    }
    res.json({ actualizadas: resultado.rowCount });
  } catch (err) {
    error500(res, 'No se pudieron marcar las notificaciones.')(err);
  }
});

// POST /api/notificaciones/:id/enterado -- confirma una importante (y la da por leída).
router.post('/:id/enterado', async (req, res) => {
  const id = Number(req.params.id);
  if (!esEnteroPositivo(id)) return res.status(404).json({ error: 'Notificación no encontrada.' });
  try {
    const { rows } = await pool.query(
      `UPDATE notificaciones
       SET enterado_el = COALESCE(enterado_el, now()), leida_el = COALESCE(leida_el, now()), entregada_el = COALESCE(entregada_el, now())
       WHERE id = $1 AND usuario_id = $2 AND empresa_id = $3
       RETURNING ${CAMPOS}`,
      [id, req.usuario.id, req.usuario.empresa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Notificación no encontrada.' });
    res.json(fila(rows[0]));
  } catch (err) {
    error500(res, 'No se pudo confirmar la notificación.')(err);
  }
});

// ---------- Mensajes entre usuarios (mensajes.enviar) ----------

// Miembros de la empresa a los que este usuario puede escribirle: activos, sin
// él mismo y -- si su cuenta está atada a una sucursal -- de su sucursal o sin
// sucursal fija (el administrador que ve todo).
const BASE_DESTINATARIOS = `
  FROM usuario_empresa ue
  JOIN usuarios u ON u.id = ue.usuario_id
  LEFT JOIN roles r ON r.id = ue.rol_id
  WHERE ue.empresa_id = $1 AND ue.activo = true AND u.activo = true AND u.id <> $2
    AND ($3::int IS NULL OR ue.sucursal_id IS NULL OR ue.sucursal_id = $3)`;

const parametrosBase = (req) => [req.usuario.empresa_id, req.usuario.id, req.usuario.sucursal_id ?? null];

// GET /api/notificaciones/destinatarios -- lo que necesita el formulario de "Nuevo mensaje".
router.get('/destinatarios', verificarPermiso('mensajes.enviar'), async (req, res) => {
  try {
    const params = parametrosBase(req);
    const [usuarios, sucursales] = await Promise.all([
      pool.query(`SELECT u.id, u.nombre, r.nombre AS rol, ue.sucursal_id ${BASE_DESTINATARIOS} ORDER BY u.nombre`, params),
      pool.query(
        `SELECT id, nombre FROM sucursales WHERE empresa_id = $1 AND activo = true AND ($2::int IS NULL OR id = $2) ORDER BY principal DESC, nombre`,
        [req.usuario.empresa_id, req.usuario.sucursal_id ?? null]
      )
    ]);
    const roles = new Map();
    for (const u of usuarios.rows) if (u.rol) roles.set(u.rol, (roles.get(u.rol) || 0) + 1);
    res.json({
      usuarios: usuarios.rows,
      roles: [...roles].map(([nombre, cantidad]) => ({ nombre, cantidad })),
      sucursales: sucursales.rows
    });
  } catch (err) {
    error500(res, 'No se pudo leer la lista de destinatarios.')(err);
  }
});

// Valida { tipo, ids | rol | sucursal_id } y devuelve el criterio SQL, o un texto de error.
function criterioDestino(destino) {
  if (!destino || typeof destino !== 'object') return { error: 'destino es requerido.' };
  switch (destino.tipo) {
    case 'usuarios':
      if (!Array.isArray(destino.ids) || !destino.ids.length || destino.ids.length > MAX_IDS_POR_PEDIDO || !destino.ids.every(esEnteroPositivo)) {
        return { error: `Elige entre 1 y ${MAX_IDS_POR_PEDIDO} personas.` };
      }
      return { sql: ' AND ue.usuario_id = ANY($4::int[])', valor: destino.ids };
    case 'rol':
      if (typeof destino.rol !== 'string' || !destino.rol.trim() || destino.rol.length > 40) return { error: 'Elige un rol.' };
      return { sql: ' AND r.nombre = $4', valor: destino.rol.trim() };
    case 'sucursal':
      if (!esEnteroPositivo(destino.sucursal_id)) return { error: 'Elige una sucursal.' };
      return { sql: ' AND ue.sucursal_id = $4', valor: destino.sucursal_id };
    case 'todos':
      return { sql: '' };
    default:
      return { error: 'destino.tipo debe ser usuarios, rol, sucursal o todos.' };
  }
}

// POST /api/notificaciones/mensajes
// { destino: { tipo, ids|rol|sucursal_id }, titulo, cuerpo?, enlace?, prioridad? }
router.post('/mensajes', verificarPermiso('mensajes.enviar'), async (req, res) => {
  // Una sesión de soporte lleva el id del super admin: no debe escribirle a nadie de la empresa.
  if (req.usuario.impersonando === true) return res.status(403).json({ error: 'No disponible durante una sesión de soporte.' });
  if (!permitir(`mensajes:${req.usuario.id}`, { maxIntentos: 20, ventanaMs: 10 * 60 * 1000 })) {
    return res.status(429).json({ error: 'Enviaste muchos mensajes seguidos. Espera unos minutos.' });
  }

  const { destino, cuerpo, enlace } = req.body || {};
  const titulo = typeof req.body?.titulo === 'string' ? req.body.titulo.trim() : '';
  const prioridad = req.body?.prioridad ?? 'normal';
  if (!titulo) return res.status(400).json({ error: 'El título es requerido.' });
  if (titulo.length > MAX_TITULO) return res.status(400).json({ error: `El título admite hasta ${MAX_TITULO} caracteres.` });
  if (cuerpo !== undefined && cuerpo !== null && typeof cuerpo !== 'string') return res.status(400).json({ error: 'El mensaje debe ser texto.' });
  const texto = typeof cuerpo === 'string' && cuerpo.trim() ? cuerpo.trim() : null;
  if (texto && texto.length > MAX_CUERPO) return res.status(400).json({ error: `El mensaje admite hasta ${MAX_CUERPO} caracteres.` });
  if (!['normal', 'alta'].includes(prioridad)) return res.status(400).json({ error: 'prioridad debe ser normal o alta.' });
  if (enlace !== undefined && enlace !== null && enlace !== '' && (typeof enlace !== 'string' || enlace.length > 40 || !RE_ENLACE.test(enlace))) {
    return res.status(400).json({ error: 'enlace debe ser el nombre de una página (ej. "cajas").' });
  }
  const criterio = criterioDestino(destino);
  if (criterio.error) return res.status(400).json({ error: criterio.error });

  try {
    const params = parametrosBase(req);
    if ('valor' in criterio) params.push(criterio.valor);
    const { rows } = await pool.query(`SELECT ue.usuario_id AS id ${BASE_DESTINATARIOS}${criterio.sql}`, params);
    if (!rows.length) return res.status(400).json({ error: 'No hay destinatarios para este envío.' });
    if (rows.length > MAX_DESTINATARIOS) {
      return res.status(400).json({ error: `Este envío llegaría a ${rows.length} personas y el máximo es ${MAX_DESTINATARIOS}. Elige un grupo más chico.` });
    }

    const lote = randomUUID();
    await insertarNotificaciones(pool, {
      empresaId: req.usuario.empresa_id, usuarioIds: rows.map(r => r.id), tipo: 'mensaje', prioridad, titulo,
      cuerpo: texto, enlace: enlace || null, remitente: { id: req.usuario.id, nombre: req.usuario.nombre }, lote
    });
    await registrarAuditoria(pool, {
      usuario: req.usuario, accion: 'crear', modulo: 'mensajes', registroId: lote,
      detalle: { titulo, destino: destino.tipo, destinatarios: rows.length, prioridad }
    });
    res.status(201).json({ lote, destinatarios: rows.length });
  } catch (err) {
    error500(res, 'No se pudo enviar el mensaje.')(err);
  }
});

// GET /api/notificaciones/enviados -- los mensajes que mandó ESTA persona, con cuántos lo recibieron/leyeron/confirmaron.
router.get('/enviados', verificarPermiso('mensajes.enviar'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT lote, MIN(titulo) AS titulo, MIN(cuerpo) AS cuerpo, MIN(prioridad) AS prioridad, MIN(enlace) AS enlace,
              MIN(creada_el) AS creada_el, COUNT(*)::int AS destinatarios, COUNT(entregada_el)::int AS entregadas,
              COUNT(leida_el)::int AS leidas, COUNT(enterado_el)::int AS enteradas
       FROM notificaciones
       WHERE empresa_id = $1 AND remitente_id = $2 AND lote IS NOT NULL
       GROUP BY lote ORDER BY MIN(creada_el) DESC LIMIT 50`,
      [req.usuario.empresa_id, req.usuario.id]
    );
    res.json(rows);
  } catch (err) {
    error500(res, 'No se pudieron leer los mensajes enviados.')(err);
  }
});

// GET /api/notificaciones/enviados/:lote -- el detalle persona por persona.
router.get('/enviados/:lote', verificarPermiso('mensajes.enviar'), async (req, res) => {
  if (!RE_UUID.test(req.params.lote)) return res.status(404).json({ error: 'Mensaje no encontrado.' });
  try {
    const { rows } = await pool.query(
      `SELECT n.id, u.nombre AS destinatario, n.titulo, n.cuerpo, n.prioridad, n.creada_el, n.entregada_el, n.leida_el, n.enterado_el
       FROM notificaciones n JOIN usuarios u ON u.id = n.usuario_id
       WHERE n.lote = $1 AND n.remitente_id = $2 AND n.empresa_id = $3
       ORDER BY u.nombre`,
      [req.params.lote, req.usuario.id, req.usuario.empresa_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Mensaje no encontrado.' });
    res.json({ lote: req.params.lote, titulo: rows[0].titulo, cuerpo: rows[0].cuerpo, prioridad: rows[0].prioridad, creada_el: rows[0].creada_el, destinatarios: rows.map(r => ({
      destinatario: r.destinatario, entregada_el: r.entregada_el, leida_el: r.leida_el, enterado_el: r.enterado_el
    })) });
  } catch (err) {
    error500(res, 'No se pudo leer el detalle del mensaje.')(err);
  }
});

export default router;
