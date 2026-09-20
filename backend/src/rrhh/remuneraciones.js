// src/rrhh/remuneraciones.js
// Remuneraciones (fase R4). Es un REGISTRO: lo que se le paga a cada
// trabajador mes a mes, su historial de aumentos y una estimación referencial
// de gratificación y CTS. NO es una planilla electrónica ni calcula AFP/ONP/
// renta de 5.ª categoría -- eso lo hace el contador (ver aviso en calculos.js).
//
// Todo este router exige rrhh.remuneraciones (administrador y gerente por
// defecto), además del permiso de la acción (crear/editar/eliminar).

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { estimarBeneficios } from './calculos.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, validarEmpleadoDeEmpresa } from './comun.js';

export const remuneracionesRouter = Router();
remuneracionesRouter.use(verificarPermiso('rrhh.remuneraciones'));

const COLUMNAS = `r.id, r.empleado_id, r.periodo, r.sueldo_base, r.bonificaciones, r.horas_extra, r.descuentos, r.neto,
  r.estado, r.fecha_pago::text AS fecha_pago, r.notas, r.creado_el`;

function validarPeriodo(v) {
  const s = validar.texto(v, 'El período', { requerido: true, max: 7 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new ErrorValidacion('El período debe tener el formato AAAA-MM.');
  return s;
}

function leerMontos(body, { sueldoPorDefecto = null } = {}) {
  const monto = (campo, nombre, porDefecto = 0) => validar.numero(body[campo], nombre, { min: 0, max: 99999999, porDefecto });
  return {
    sueldo_base: sueldoPorDefecto !== null && (body.sueldo_base === undefined || body.sueldo_base === '' || body.sueldo_base === null)
      ? sueldoPorDefecto : monto('sueldo_base', 'El sueldo base'),
    bonificaciones: monto('bonificaciones', 'Las bonificaciones'),
    horas_extra: monto('horas_extra', 'Las horas extra'),
    descuentos: monto('descuentos', 'Los descuentos'),
    estado: validar.enumerado(body.estado, 'estado', ['pendiente', 'pagado'], { porDefecto: 'pendiente' }),
    fecha_pago: validar.fecha(body.fecha_pago, 'La fecha de pago'),
    notas: validar.texto(body.notas, 'Las notas', { max: 250 })
  };
}

// GET /?periodo=AAAA-MM&empleado_id=
remuneracionesRouter.get('/', async (req, res) => {
  try {
    const periodo = req.query.periodo ? validarPeriodo(req.query.periodo) : null;
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS}, e.nombre AS empleado_nombre
       FROM remuneraciones r JOIN empleados e ON e.id = r.empleado_id
       WHERE r.empresa_id = $1 AND ($2::varchar IS NULL OR r.periodo = $2) AND ($3::int IS NULL OR r.empleado_id = $3)
       ORDER BY r.periodo DESC, e.nombre LIMIT 2000`,
      [req.usuario.empresa_id, periodo, empleadoId]
    );
    const total = rows.reduce((s, r) => s + Number(r.neto), 0);
    res.json({ filas: rows, total_neto: Math.round(total * 100) / 100 });
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las remuneraciones.');
  }
});

remuneracionesRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const empleado = await validarEmpleadoDeEmpresa(pool, empresaId, req.body.empleado_id, 'id, nombre, salario');
    const periodo = validarPeriodo(req.body.periodo);
    const m = leerMontos(req.body, { sueldoPorDefecto: Number(empleado.salario) || 0 });
    const { rows } = await pool.query(
      `INSERT INTO remuneraciones (empresa_id, empleado_id, periodo, sueldo_base, bonificaciones, horas_extra, descuentos, estado, fecha_pago, notas, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [empresaId, empleado.id, periodo, m.sueldo_base, m.bonificaciones, m.horas_extra, m.descuentos, m.estado, m.fecha_pago, m.notas, req.usuario.id]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `remuneracion:${rows[0].id}`, detalle: { empleado: empleado.nombre, periodo, ...m } });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'Ese trabajador ya tiene una remuneración registrada en ese período.' });
    responderError(res, err, 'No se pudo registrar la remuneración.');
  }
});

// Crea, para un mes, la remuneración pendiente de cada trabajador que estuvo
// activo en él y aún no la tiene (con su sueldo actual como base). Se usa como
// punto de partida: después se ajustan bonificaciones y descuentos a mano.
remuneracionesRouter.post('/generar', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const periodo = validarPeriodo(req.body.periodo);
    const inicio = `${periodo}-01`;
    const { rowCount } = await pool.query(
      `INSERT INTO remuneraciones (empresa_id, empleado_id, periodo, sueldo_base, registrado_por)
       SELECT e.empresa_id, e.id, $2, e.salario, $3
       FROM empleados e
       WHERE e.empresa_id = $1 AND e.salario > 0
         AND e.fecha_contratacion < ($4::date + interval '1 month')
         AND (e.fecha_cese IS NULL OR e.fecha_cese >= $4::date)
       ON CONFLICT (empleado_id, periodo) DO NOTHING`,
      [empresaId, periodo, req.usuario.id, inicio]
    );
    res.json({ creadas: rowCount });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `remuneraciones:${periodo}`, detalle: { generadas: rowCount, periodo } });
  } catch (err) {
    responderError(res, err, 'No se pudieron generar las remuneraciones.');
  }
});

remuneracionesRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Remuneración no encontrada.', 404);
    const { rows: antesRows } = await pool.query(`SELECT ${COLUMNAS} FROM remuneraciones r WHERE r.id = $1 AND r.empresa_id = $2`, [id, empresaId]);
    if (!antesRows.length) throw new ErrorValidacion('Remuneración no encontrada.', 404);
    const m = leerMontos(req.body);
    await pool.query(
      `UPDATE remuneraciones SET sueldo_base=$1, bonificaciones=$2, horas_extra=$3, descuentos=$4, estado=$5, fecha_pago=$6, notas=$7,
         registrado_por=$8, actualizado_el=now() WHERE id=$9 AND empresa_id=$10`,
      [m.sueldo_base, m.bonificaciones, m.horas_extra, m.descuentos, m.estado, m.fecha_pago, m.notas, req.usuario.id, id, empresaId]
    );
    res.json({ id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `remuneracion:${id}`, detalle: { antes: antesRows[0], despues: m } });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar la remuneración.');
  }
});

remuneracionesRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Remuneración no encontrada.', 404);
    const { rows } = await pool.query(
      `DELETE FROM remuneraciones WHERE id = $1 AND empresa_id = $2 RETURNING empleado_id, periodo, neto, estado`,
      [id, req.usuario.empresa_id]
    );
    if (!rows.length) throw new ErrorValidacion('Remuneración no encontrada.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `remuneracion:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la remuneración.');
  }
});

// Historial de sueldos de un trabajador (cada cambio de la ficha deja una fila).
remuneracionesRouter.get('/historial/:empleadoId', async (req, res) => {
  try {
    const empleado = await validarEmpleadoDeEmpresa(pool, req.usuario.empresa_id, req.params.empleadoId);
    const { rows } = await pool.query(
      `SELECT id, sueldo_anterior, sueldo_nuevo, vigente_desde::text AS vigente_desde, motivo, creado_el
       FROM historial_salarial WHERE empleado_id = $1 ORDER BY vigente_desde DESC, id DESC LIMIT 200`,
      [empleado.id]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudo leer el historial de sueldos.');
  }
});

// Gratificación y CTS estimadas de un trabajador (REFERENCIAL: ver calculos.js).
remuneracionesRouter.get('/beneficios/:empleadoId', async (req, res) => {
  try {
    const empleado = await validarEmpleadoDeEmpresa(
      pool, req.usuario.empresa_id, req.params.empleadoId,
      `id, nombre, salario, regimen_laboral, fecha_contratacion::text AS fecha_contratacion, fecha_cese::text AS fecha_cese`
    );
    res.json({
      empleado: empleado.nombre,
      ...estimarBeneficios({
        salario: empleado.salario, regimen: empleado.regimen_laboral,
        fecha_contratacion: empleado.fecha_contratacion, fecha_cese: empleado.fecha_cese, hoy: hoyLima()
      })
    });
  } catch (err) {
    responderError(res, err, 'No se pudieron estimar los beneficios.');
  }
});
