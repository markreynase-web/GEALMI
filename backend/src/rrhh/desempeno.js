// src/rrhh/desempeno.js
// Desempeño (fase R6): evaluaciones con cinco criterios fijos (1 a 5) y
// capacitaciones con sus participantes. El promedio de cada evaluación lo
// calcula la base (columna generada), no se puede desincronizar.

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, validarEmpleadoDeEmpresa } from './comun.js';

export const evaluacionesRouter = Router();
export const capacitacionesRouter = Router();

export const CRITERIOS = ['puntualidad', 'calidad_trabajo', 'trabajo_equipo', 'iniciativa', 'comunicacion'];

// ---------------------------------------------------------------------------
// Evaluaciones
// ---------------------------------------------------------------------------

const COLUMNAS_EVAL = `v.id, v.empleado_id, v.periodo, v.fecha::text AS fecha, v.evaluador_nombre, v.puntualidad, v.calidad_trabajo,
  v.trabajo_equipo, v.iniciativa, v.comunicacion, v.promedio::float8 AS promedio, v.fortalezas, v.oportunidades, v.creado_el`;

function leerEvaluacion(body) {
  const notas = {};
  for (const c of CRITERIOS) notas[c] = validar.entero(body[c], `El criterio "${c.replace(/_/g, ' ')}"`, { min: 1, max: 5, requerido: true });
  return {
    periodo: validar.texto(body.periodo, 'El período', { max: 40, requerido: true }),
    fecha: validar.fecha(body.fecha, 'La fecha') ?? hoyLima(),
    ...notas,
    fortalezas: validar.texto(body.fortalezas, 'Las fortalezas', { max: 2000 }),
    oportunidades: validar.texto(body.oportunidades, 'Las oportunidades de mejora', { max: 2000 })
  };
}

// GET /?empleado_id=
evaluacionesRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_EVAL}, e.nombre AS empleado_nombre
       FROM evaluaciones v JOIN empleados e ON e.id = v.empleado_id
       WHERE v.empresa_id = $1 AND ($2::int IS NULL OR v.empleado_id = $2)
       ORDER BY v.fecha DESC, v.id DESC LIMIT 1000`,
      [req.usuario.empresa_id, empleadoId]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las evaluaciones.');
  }
});

evaluacionesRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const empleado = await validarEmpleadoDeEmpresa(pool, empresaId, req.body.empleado_id);
    const v = leerEvaluacion(req.body);
    const { rows } = await pool.query(
      `INSERT INTO evaluaciones (empresa_id, empleado_id, periodo, fecha, evaluador_id, evaluador_nombre, puntualidad, calidad_trabajo,
                                 trabajo_equipo, iniciativa, comunicacion, fortalezas, oportunidades)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, promedio::float8 AS promedio`,
      [empresaId, empleado.id, v.periodo, v.fecha, req.usuario.id, req.usuario.nombre, v.puntualidad, v.calidad_trabajo, v.trabajo_equipo,
       v.iniciativa, v.comunicacion, v.fortalezas, v.oportunidades]
    );
    res.status(201).json(rows[0]);
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `evaluacion:${rows[0].id}`, detalle: { empleado: empleado.nombre, periodo: v.periodo, promedio: rows[0].promedio } });
  } catch (err) {
    responderError(res, err, 'No se pudo registrar la evaluación.');
  }
});

evaluacionesRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Evaluación no encontrada.', 404);
    const v = leerEvaluacion(req.body);
    const { rows } = await pool.query(
      `UPDATE evaluaciones SET periodo=$1, fecha=$2, puntualidad=$3, calidad_trabajo=$4, trabajo_equipo=$5, iniciativa=$6, comunicacion=$7,
         fortalezas=$8, oportunidades=$9, actualizado_el=now()
       WHERE id=$10 AND empresa_id=$11 RETURNING id, promedio::float8 AS promedio`,
      [v.periodo, v.fecha, v.puntualidad, v.calidad_trabajo, v.trabajo_equipo, v.iniciativa, v.comunicacion, v.fortalezas, v.oportunidades, id, req.usuario.empresa_id]
    );
    if (!rows.length) throw new ErrorValidacion('Evaluación no encontrada.', 404);
    res.json(rows[0]);
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `evaluacion:${id}`, detalle: { periodo: v.periodo, promedio: rows[0].promedio } });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar la evaluación.');
  }
});

evaluacionesRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Evaluación no encontrada.', 404);
    const { rows } = await pool.query(`DELETE FROM evaluaciones WHERE id = $1 AND empresa_id = $2 RETURNING empleado_id, periodo`, [id, req.usuario.empresa_id]);
    if (!rows.length) throw new ErrorValidacion('Evaluación no encontrada.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `evaluacion:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la evaluación.');
  }
});

// ---------------------------------------------------------------------------
// Capacitaciones
// ---------------------------------------------------------------------------

const COLUMNAS_CAP = `c.id, c.nombre, c.proveedor, c.fecha::text AS fecha, c.horas::float8 AS horas, c.costo, c.obligatoria, c.notas, c.creado_el`;

function leerCapacitacion(body) {
  return {
    nombre: validar.texto(body.nombre, 'El nombre', { max: 150, requerido: true }),
    proveedor: validar.texto(body.proveedor, 'El proveedor', { max: 150 }),
    fecha: validar.fecha(body.fecha, 'La fecha') ?? hoyLima(),
    horas: validar.numero(body.horas, 'Las horas', { min: 0, max: 9999, porDefecto: 0 }),
    costo: validar.numero(body.costo, 'El costo', { min: 0, max: 99999999, porDefecto: 0 }),
    obligatoria: body.obligatoria === true || body.obligatoria === 'true',
    notas: validar.texto(body.notas, 'Las notas', { max: 250 })
  };
}

// Acepta [12, 15] o [{ empleado_id, asistio, certificado_url }] y devuelve la
// lista normalizada -- o null si no vino (= "no tocar los participantes").
function leerParticipantes(valor) {
  if (valor === undefined) return null;
  if (!Array.isArray(valor)) throw new ErrorValidacion('participantes debe ser una lista.');
  if (valor.length > 500) throw new ErrorValidacion('Demasiados participantes.');
  const vistos = new Set();
  return valor.map((p) => {
    const objeto = typeof p === 'object' && p !== null ? p : { empleado_id: p };
    const empleado_id = idPositivo(objeto.empleado_id);
    if (!empleado_id) throw new ErrorValidacion('Cada participante necesita un empleado_id válido.');
    if (vistos.has(empleado_id)) throw new ErrorValidacion('Hay un participante repetido.');
    vistos.add(empleado_id);
    return { empleado_id, asistio: objeto.asistio === true || objeto.asistio === 'true', certificado_url: validar.https(objeto.certificado_url, 'El enlace del certificado') };
  });
}

// Que TODOS los participantes sean trabajadores de esta empresa.
async function comprobarParticipantes(db, empresaId, participantes) {
  if (!participantes?.length) return;
  const ids = participantes.map(p => p.empleado_id);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM empleados WHERE empresa_id = $1 AND id = ANY($2::int[])`, [empresaId, ids]);
  if (rows[0].n !== ids.length) throw new ErrorValidacion('Algún participante no es un trabajador de tu empresa.', 404);
}

async function guardarParticipantes(cliente, empresaId, capacitacionId, participantes) {
  await cliente.query(`DELETE FROM capacitacion_participantes WHERE capacitacion_id = $1`, [capacitacionId]);
  for (const p of participantes) {
    await cliente.query(
      `INSERT INTO capacitacion_participantes (capacitacion_id, empleado_id, empresa_id, asistio, certificado_url) VALUES ($1,$2,$3,$4,$5)`,
      [capacitacionId, p.empleado_id, empresaId, p.asistio, p.certificado_url]
    );
  }
}

// GET /?empleado_id=   (con empleado_id: solo las que ese trabajador tomó/tiene asignadas)
capacitacionesRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_CAP},
              (SELECT count(*)::int FROM capacitacion_participantes p WHERE p.capacitacion_id = c.id) AS participantes,
              (SELECT count(*)::int FROM capacitacion_participantes p WHERE p.capacitacion_id = c.id AND p.asistio) AS asistentes
       FROM capacitaciones c
       WHERE c.empresa_id = $1
         AND ($2::int IS NULL OR EXISTS (SELECT 1 FROM capacitacion_participantes p WHERE p.capacitacion_id = c.id AND p.empleado_id = $2))
       ORDER BY c.fecha DESC, c.id DESC LIMIT 1000`,
      [req.usuario.empresa_id, empleadoId]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las capacitaciones.');
  }
});

capacitacionesRouter.get('/:id', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    const { rows } = await pool.query(`SELECT ${COLUMNAS_CAP} FROM capacitaciones c WHERE c.id = $1 AND c.empresa_id = $2`, [id, req.usuario.empresa_id]);
    if (!rows.length) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    const { rows: participantes } = await pool.query(
      `SELECT p.empleado_id, e.nombre, p.asistio, p.certificado_url
       FROM capacitacion_participantes p JOIN empleados e ON e.id = p.empleado_id
       WHERE p.capacitacion_id = $1 ORDER BY e.nombre`,
      [id]
    );
    res.json({ ...rows[0], participantes });
  } catch (err) {
    responderError(res, err, 'No se pudo leer la capacitación.');
  }
});

capacitacionesRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const c = leerCapacitacion(req.body);
    const participantes = leerParticipantes(req.body.participantes) || [];
    await comprobarParticipantes(cliente, empresaId, participantes);
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO capacitaciones (empresa_id, nombre, proveedor, fecha, horas, costo, obligatoria, notas) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [empresaId, c.nombre, c.proveedor, c.fecha, c.horas, c.costo, c.obligatoria, c.notas]
    );
    await guardarParticipantes(cliente, empresaId, rows[0].id, participantes);
    await cliente.query('COMMIT');
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `capacitacion:${rows[0].id}`, detalle: { ...c, participantes: participantes.length } });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudo registrar la capacitación.');
  } finally {
    cliente.release();
  }
});

capacitacionesRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    const c = leerCapacitacion(req.body);
    const participantes = leerParticipantes(req.body.participantes);
    await comprobarParticipantes(cliente, empresaId, participantes);
    await cliente.query('BEGIN');
    const { rowCount } = await cliente.query(
      `UPDATE capacitaciones SET nombre=$1, proveedor=$2, fecha=$3, horas=$4, costo=$5, obligatoria=$6, notas=$7, actualizado_el=now()
       WHERE id=$8 AND empresa_id=$9`,
      [c.nombre, c.proveedor, c.fecha, c.horas, c.costo, c.obligatoria, c.notas, id, empresaId]
    );
    if (!rowCount) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    if (participantes) await guardarParticipantes(cliente, empresaId, id, participantes);
    await cliente.query('COMMIT');
    res.json({ id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `capacitacion:${id}`, detalle: { ...c, participantes: participantes ? participantes.length : 'sin cambios' } });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudo actualizar la capacitación.');
  } finally {
    cliente.release();
  }
});

capacitacionesRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    const { rows } = await pool.query(`DELETE FROM capacitaciones WHERE id = $1 AND empresa_id = $2 RETURNING nombre, fecha::text AS fecha`, [id, req.usuario.empresa_id]);
    if (!rows.length) throw new ErrorValidacion('Capacitación no encontrada.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `capacitacion:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la capacitación.');
  }
});
