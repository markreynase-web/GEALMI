// src/routes/marketing.js
// Marketing v1 (paso 9). La cadena que se mide:
//   Campaña -> Clientes objetivo -> Venta -> Resultado
// GEALMI arma la lista de a quién contactar (por criterios o a mano), lleva el
// avance de cada contacto (objetivo, contactado, respondió, convirtió) y suma las
// ventas que se atribuyen a la campaña al registrarlas (ventas.campana_id, ver
// routes/ventas.js). NO envía nada: el contacto lo hace la persona por su cuenta.
//
// Todo cliente que llega en un body pasa por la comprobación de empresa: sin ella,
// una campaña podría listar (y filtrar datos de) clientes de otra empresa.

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa, requireModulo } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { ErrorValidacion, responderError, validar, idPositivo, tienePermiso } from '../validacion.js';

const router = Router();
router.use(auth, requireEmpresa, requireModulo('marketing'));

export const CANALES = ['whatsapp', 'correo', 'redes', 'presencial', 'llamada', 'otro'];
export const ESTADOS_CAMPANA = ['borrador', 'activa', 'pausada', 'finalizada'];
export const ESTADOS_CLIENTE = ['objetivo', 'contactado', 'respondio', 'convirtio', 'descartado'];
const MAX_CLIENTES_POR_OPERACION = 2000;

// ---------------------------------------------------------------------------
// Consultas de campañas con sus resultados
// ---------------------------------------------------------------------------

// El embudo: 'contactado' cuenta como contactado; 'respondio' como contactado y
// respondió; 'convirtio' como los tres. Los descartados no cuentan como objetivo.
const SQL_CAMPANA = `
  c.id, c.nombre, c.descripcion, c.canal, c.estado, c.fecha_inicio::text AS fecha_inicio, c.fecha_fin::text AS fecha_fin,
  c.presupuesto::float8 AS presupuesto, c.mensaje, c.segmento, c.creado_el,
  COALESCE(cc.objetivo, 0) AS objetivo, COALESCE(cc.contactados, 0) AS contactados, COALESCE(cc.respuestas, 0) AS respuestas,
  COALESCE(cc.conversiones, 0) AS conversiones, COALESCE(v.ventas, 0) AS ventas_generadas, COALESCE(v.ingresos, 0)::float8 AS ingresos
  FROM campanas c
  LEFT JOIN (
    SELECT campana_id,
           count(*) FILTER (WHERE estado <> 'descartado')::int AS objetivo,
           count(*) FILTER (WHERE estado IN ('contactado', 'respondio', 'convirtio'))::int AS contactados,
           count(*) FILTER (WHERE estado IN ('respondio', 'convirtio'))::int AS respuestas,
           count(*) FILTER (WHERE estado = 'convirtio')::int AS conversiones
    FROM campana_clientes WHERE empresa_id = $1 GROUP BY campana_id
  ) cc ON cc.campana_id = c.id
  LEFT JOIN (
    SELECT campana_id, count(*)::int AS ventas, sum(monto) AS ingresos
    FROM ventas WHERE empresa_id = $1 AND campana_id IS NOT NULL GROUP BY campana_id
  ) v ON v.campana_id = c.id`;

// Indicadores derivados (null cuando no se pueden calcular, no 0: "sin dato" no es "cero").
function conIndicadores(c) {
  return {
    ...c,
    retorno: c.presupuesto > 0 ? +(c.ingresos / c.presupuesto).toFixed(2) : null,
    tasa_conversion: c.objetivo > 0 ? +(c.conversiones / c.objetivo).toFixed(4) : null,
    costo_por_conversion: c.presupuesto > 0 && c.conversiones > 0 ? +(c.presupuesto / c.conversiones).toFixed(2) : null
  };
}

async function campanaDeEmpresa(db, empresaId, id, { conMetricas = false } = {}) {
  const cid = idPositivo(id);
  if (!cid) throw new ErrorValidacion('Campaña no encontrada.', 404);
  const { rows } = await db.query(`SELECT ${SQL_CAMPANA} WHERE c.id = $2 AND c.empresa_id = $1`, [empresaId, cid]);
  if (!rows.length) throw new ErrorValidacion('Campaña no encontrada.', 404);
  return conMetricas ? conIndicadores(rows[0]) : rows[0];
}

function leerCampana(body) {
  const fecha_inicio = validar.fecha(body.fecha_inicio, 'La fecha de inicio');
  const fecha_fin = validar.fecha(body.fecha_fin, 'La fecha de fin');
  if (fecha_inicio && fecha_fin && fecha_fin < fecha_inicio) throw new ErrorValidacion('La fecha de fin no puede ser anterior a la de inicio.');
  return {
    nombre: validar.texto(body.nombre, 'El nombre', { max: 150, requerido: true }),
    descripcion: validar.texto(body.descripcion, 'La descripción', { max: 2000 }),
    canal: validar.enumerado(body.canal, 'canal', CANALES, { porDefecto: 'whatsapp' }),
    estado: validar.enumerado(body.estado, 'estado', ESTADOS_CAMPANA, { porDefecto: 'borrador' }),
    fecha_inicio, fecha_fin,
    presupuesto: validar.numero(body.presupuesto, 'El presupuesto', { min: 0, max: 99999999, porDefecto: 0 }),
    mensaje: validar.texto(body.mensaje, 'El mensaje', { max: 1000 })
  };
}

router.get('/campanas', verificarPermiso('marketing.ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${SQL_CAMPANA} WHERE c.empresa_id = $1 ORDER BY (c.estado = 'activa') DESC, c.creado_el DESC, c.id DESC LIMIT 500`,
      [req.usuario.empresa_id]
    );
    res.json(rows.map(conIndicadores));
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las campañas.');
  }
});

// Las campañas en las que se puede registrar una venta: las ACTIVAS. Lo usa el
// formulario de Ventas, así que lo puede leer quien registra ventas aunque no
// tenga marketing.ver (solo ve id y nombre).
router.get('/campanas-activas', async (req, res) => {
  try {
    if (!tienePermiso(req, 'marketing.ver') && !tienePermiso(req, 'ventas.crear')) {
      return res.status(403).json({ error: 'No tienes permiso para esto (ventas.crear).' });
    }
    const { rows } = await pool.query(`SELECT id, nombre FROM campanas WHERE empresa_id = $1 AND estado = 'activa' ORDER BY nombre LIMIT 200`, [req.usuario.empresa_id]);
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las campañas activas.');
  }
});

router.get('/campanas/:id', verificarPermiso('marketing.ver'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id, { conMetricas: true });
    const { rows: clientes } = await pool.query(
      `SELECT cc.cliente_id, c.nombre, c.email, c.telefono, c.compras_totales::float8 AS compras_totales, cc.estado, cc.etiqueta, cc.notas,
              cc.contactado_el, cc.respondio_el, cc.convirtio_el
       FROM campana_clientes cc JOIN clientes c ON c.id = cc.cliente_id
       WHERE cc.campana_id = $1 AND cc.empresa_id = $2
       ORDER BY (cc.estado = 'convirtio') DESC, c.nombre LIMIT $3`,
      [campana.id, empresaId, MAX_CLIENTES_POR_OPERACION]
    );
    const { rows: ventas } = await pool.query(
      `SELECT id, fecha::text AS fecha, cliente, producto, monto::float8 AS monto FROM ventas
       WHERE campana_id = $1 AND empresa_id = $2 ORDER BY fecha DESC, id DESC LIMIT 50`,
      [campana.id, empresaId]
    );
    res.json({ ...campana, clientes, ventas });
  } catch (err) {
    responderError(res, err, 'No se pudo leer la campaña.');
  }
});

router.post('/campanas', verificarPermiso('marketing.crear'), async (req, res) => {
  try {
    const c = leerCampana(req.body);
    const { rows } = await pool.query(
      `INSERT INTO campanas (empresa_id, nombre, descripcion, canal, estado, fecha_inicio, fecha_fin, presupuesto, mensaje, creada_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.usuario.empresa_id, c.nombre, c.descripcion, c.canal, c.estado, c.fecha_inicio, c.fecha_fin, c.presupuesto, c.mensaje, req.usuario.id]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'marketing', registroId: rows[0].id, detalle: c });
  } catch (err) {
    responderError(res, err, 'No se pudo crear la campaña.');
  }
});

router.put('/campanas/:id', verificarPermiso('marketing.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const antes = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const c = leerCampana(req.body);
    await pool.query(
      `UPDATE campanas SET nombre=$1, descripcion=$2, canal=$3, estado=$4, fecha_inicio=$5, fecha_fin=$6, presupuesto=$7, mensaje=$8, actualizado_el=now()
       WHERE id=$9 AND empresa_id=$10`,
      [c.nombre, c.descripcion, c.canal, c.estado, c.fecha_inicio, c.fecha_fin, c.presupuesto, c.mensaje, antes.id, empresaId]
    );
    res.json({ id: antes.id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: antes.id, detalle: c });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar la campaña.');
  }
});

// Cambio rápido de estado (Activar / Pausar / Finalizar) sin reenviar todo el formulario.
router.put('/campanas/:id/estado', verificarPermiso('marketing.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const antes = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const estado = validar.enumerado(req.body.estado, 'estado', ESTADOS_CAMPANA, { requerido: true });
    await pool.query(`UPDATE campanas SET estado = $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [estado, antes.id, empresaId]);
    res.json({ id: antes.id, estado });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: antes.id, detalle: { estado: { antes: antes.estado, despues: estado } } });
  } catch (err) {
    responderError(res, err, 'No se pudo cambiar el estado de la campaña.');
  }
});

// Con ventas atribuidas no se borra: se perdería el resultado que se midió. Se finaliza.
router.delete('/campanas/:id', verificarPermiso('marketing.eliminar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id);
    if (campana.ventas_generadas > 0) {
      throw new ErrorValidacion(`No se puede eliminar: tiene ${campana.ventas_generadas} venta(s) atribuida(s). Finalízala para conservar su resultado.`, 409);
    }
    await pool.query(`DELETE FROM campanas WHERE id = $1 AND empresa_id = $2`, [campana.id, empresaId]);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'marketing', registroId: campana.id, detalle: { eliminada: { nombre: campana.nombre, estado: campana.estado } } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la campaña.');
  }
});

// ---------------------------------------------------------------------------
// Segmentación: a quién contactar
// ---------------------------------------------------------------------------

// Criterios (todos opcionales, se combinan con Y). Salen de lo que GEALMI ya sabe
// del cliente: sus compras (ventas) y su total gastado.
function leerCriterios(body) {
  return {
    inactivos_dias: validar.entero(body.inactivos_dias, 'Los días sin comprar', { min: 1, max: 3650 }),
    compras_min: validar.entero(body.compras_min, 'Las compras mínimas', { min: 1, max: 100000 }),
    gasto_min: validar.numero(body.gasto_min, 'El gasto mínimo', { min: 0, max: 99999999 }),
    con_telefono: body.con_telefono === true || body.con_telefono === 'true',
    con_email: body.con_email === true || body.con_email === 'true'
  };
}

function etiquetaDeCriterios(c) {
  const partes = [];
  if (c.inactivos_dias) partes.push(`Inactivos ${c.inactivos_dias} d`);
  if (c.compras_min) partes.push(`${c.compras_min}+ compras`);
  if (c.gasto_min) partes.push(`Gasto desde S/ ${c.gasto_min}`);
  if (c.con_telefono) partes.push('Con teléfono');
  if (c.con_email) partes.push('Con correo');
  return (partes.join(' · ') || 'Todos los clientes').slice(0, 40);
}

// "Inactivos" incluye a quien nunca compró (no tiene última compra): también es alguien a quien reactivar.
async function clientesDelSegmento(db, empresaId, c, limite) {
  const { rows } = await db.query(
    `SELECT c.id, c.nombre, c.telefono, c.email
     FROM clientes c
     LEFT JOIN (SELECT cliente_id, max(fecha) AS ultima, count(*) AS n FROM ventas WHERE empresa_id = $1 AND cliente_id IS NOT NULL GROUP BY cliente_id) u ON u.cliente_id = c.id
     WHERE c.empresa_id = $1
       AND ($2::int IS NULL OR u.ultima IS NULL OR u.ultima < (now() AT TIME ZONE 'America/Lima')::date - $2::int)
       AND ($3::int IS NULL OR COALESCE(u.n, 0) >= $3)
       AND ($4::numeric IS NULL OR c.compras_totales >= $4)
       AND (NOT $5::boolean OR btrim(COALESCE(c.telefono, '')) <> '')
       AND (NOT $6::boolean OR btrim(COALESCE(c.email, '')) <> '')
     ORDER BY c.nombre, c.id LIMIT $7`,
    [empresaId, c.inactivos_dias, c.compras_min, c.gasto_min, c.con_telefono, c.con_email, limite]
  );
  return rows;
}

router.post('/segmento/vista-previa', verificarPermiso('marketing.ver'), async (req, res) => {
  try {
    const criterios = leerCriterios(req.body);
    const filas = await clientesDelSegmento(pool, req.usuario.empresa_id, criterios, MAX_CLIENTES_POR_OPERACION + 1);
    res.json({
      total: Math.min(filas.length, MAX_CLIENTES_POR_OPERACION), supera_el_limite: filas.length > MAX_CLIENTES_POR_OPERACION,
      limite: MAX_CLIENTES_POR_OPERACION, etiqueta: etiquetaDeCriterios(criterios), muestra: filas.slice(0, 8)
    });
  } catch (err) {
    responderError(res, err, 'No se pudo calcular el segmento.');
  }
});

router.post('/campanas/:id/clientes/segmento', verificarPermiso('marketing.editar'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const criterios = leerCriterios(req.body);
    const etiqueta = validar.texto(req.body.etiqueta, 'La etiqueta', { max: 40 }) || etiquetaDeCriterios(criterios);
    const coincidentes = await clientesDelSegmento(cliente, empresaId, criterios, MAX_CLIENTES_POR_OPERACION + 1);
    if (coincidentes.length > MAX_CLIENTES_POR_OPERACION) {
      throw new ErrorValidacion(`El segmento trae más de ${MAX_CLIENTES_POR_OPERACION} clientes: acótalo con algún criterio más.`);
    }
    await cliente.query('BEGIN');
    const { rowCount } = await cliente.query(
      `INSERT INTO campana_clientes (campana_id, cliente_id, empresa_id, etiqueta)
       SELECT $1, d.id, $2, $3 FROM unnest($4::int[]) AS d(id)
       ON CONFLICT (campana_id, cliente_id) DO NOTHING`,
      [campana.id, empresaId, etiqueta, coincidentes.map(f => f.id)]
    );
    await cliente.query(`UPDATE campanas SET segmento = $1, actualizado_el = now() WHERE id = $2 AND empresa_id = $3`, [JSON.stringify({ ...criterios, etiqueta }), campana.id, empresaId]);
    await cliente.query('COMMIT');
    res.json({ coincidieron: coincidentes.length, agregados: rowCount, ya_estaban: coincidentes.length - rowCount, etiqueta });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: campana.id, detalle: { agregados_por_segmento: rowCount, criterios } });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudieron agregar los clientes del segmento.');
  } finally {
    cliente.release();
  }
});

// ---------------------------------------------------------------------------
// Clientes objetivo
// ---------------------------------------------------------------------------

function leerIdsClientes(valor) {
  if (!Array.isArray(valor) || !valor.length) throw new ErrorValidacion('Elige al menos un cliente.');
  if (valor.length > MAX_CLIENTES_POR_OPERACION) throw new ErrorValidacion(`Máximo ${MAX_CLIENTES_POR_OPERACION} clientes por operación.`);
  const ids = [...new Set(valor.map(idPositivo))];
  if (ids.some(id => !id)) throw new ErrorValidacion('Hay un cliente con un identificador inválido.');
  return ids;
}

router.post('/campanas/:id/clientes', verificarPermiso('marketing.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const ids = leerIdsClientes(req.body.cliente_ids);
    const etiqueta = validar.texto(req.body.etiqueta, 'La etiqueta', { max: 40 });
    // Que TODOS sean clientes de esta empresa.
    const { rows: propios } = await pool.query(`SELECT count(*)::int AS n FROM clientes WHERE empresa_id = $1 AND id = ANY($2::int[])`, [empresaId, ids]);
    if (propios[0].n !== ids.length) throw new ErrorValidacion('Algún cliente no existe en tu empresa.', 404);
    const { rowCount } = await pool.query(
      `INSERT INTO campana_clientes (campana_id, cliente_id, empresa_id, etiqueta)
       SELECT $1, d.id, $2, $3 FROM unnest($4::int[]) AS d(id) ON CONFLICT (campana_id, cliente_id) DO NOTHING`,
      [campana.id, empresaId, etiqueta, ids]
    );
    res.json({ agregados: rowCount, ya_estaban: ids.length - rowCount });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: campana.id, detalle: { agregados_a_mano: rowCount } });
  } catch (err) {
    responderError(res, err, 'No se pudieron agregar los clientes.');
  }
});

// Cambia el avance (y/o la etiqueta, y/o la nota) de varios clientes a la vez.
router.put('/campanas/:id/clientes', verificarPermiso('marketing.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const ids = leerIdsClientes(req.body.cliente_ids);
    const estado = req.body.estado === undefined ? null : validar.enumerado(req.body.estado, 'estado', ESTADOS_CLIENTE, { requerido: true });
    const cambiaEtiqueta = req.body.etiqueta !== undefined, cambiaNotas = req.body.notas !== undefined;
    if (!estado && !cambiaEtiqueta && !cambiaNotas) throw new ErrorValidacion('No se envió ningún cambio.');

    const valores = [campana.id, empresaId, ids];
    const sets = [];
    if (estado) {
      valores.push(estado);
      const p = `$${valores.length}::varchar`;
      // Cada paso del embudo completa los anteriores (y nunca borra una fecha ya puesta).
      sets.push(`estado = ${p}`,
        `contactado_el = CASE WHEN ${p} IN ('contactado', 'respondio', 'convirtio') THEN COALESCE(contactado_el, now()) ELSE contactado_el END`,
        `respondio_el = CASE WHEN ${p} IN ('respondio', 'convirtio') THEN COALESCE(respondio_el, now()) ELSE respondio_el END`,
        `convirtio_el = CASE WHEN ${p} = 'convirtio' THEN COALESCE(convirtio_el, now()) ELSE convirtio_el END`);
    }
    if (cambiaEtiqueta) { valores.push(validar.texto(req.body.etiqueta, 'La etiqueta', { max: 40 })); sets.push(`etiqueta = $${valores.length}`); }
    if (cambiaNotas) { valores.push(validar.texto(req.body.notas, 'La nota', { max: 250 })); sets.push(`notas = $${valores.length}`); }
    const { rowCount } = await pool.query(
      `UPDATE campana_clientes SET ${sets.join(', ')} WHERE campana_id = $1 AND empresa_id = $2 AND cliente_id = ANY($3::int[])`,
      valores
    );
    res.json({ actualizados: rowCount });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: campana.id, detalle: { clientes: rowCount, ...(estado ? { estado } : {}) } });
  } catch (err) {
    responderError(res, err, 'No se pudieron actualizar los clientes.');
  }
});

router.delete('/campanas/:id/clientes/:clienteId', verificarPermiso('marketing.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const campana = await campanaDeEmpresa(pool, empresaId, req.params.id);
    const clienteId = idPositivo(req.params.clienteId);
    const { rowCount } = clienteId
      ? await pool.query(`DELETE FROM campana_clientes WHERE campana_id = $1 AND cliente_id = $2 AND empresa_id = $3`, [campana.id, clienteId, empresaId])
      : { rowCount: 0 };
    if (!rowCount) throw new ErrorValidacion('Ese cliente no está en la campaña.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'marketing', registroId: campana.id, detalle: { quitado_cliente: clienteId } });
  } catch (err) {
    responderError(res, err, 'No se pudo quitar al cliente.');
  }
});

export default router;
