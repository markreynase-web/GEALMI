// src/rrhh/reclutamiento.js
// Reclutamiento (fase R7): vacantes y candidatos con un embudo simple
// (postulado → entrevista → prueba → oferta → contratado / descartado).
// Contratar a un candidato crea SU ficha de empleado en una sola transacción y
// deja el candidato enlazado a ella; si con eso se cubren las plazas, la
// vacante se cierra sola.

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { esDocumentoIdentidadValido, REGIMENES } from './calculos.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, puedeVerSueldos } from './comun.js';

export const vacantesRouter = Router();
export const candidatosRouter = Router();

export const ETAPAS = ['postulado', 'entrevista', 'prueba', 'oferta', 'contratado', 'descartado'];
// A 'contratado' solo se llega por POST /:id/contratar (crea la ficha).
const ETAPAS_EDITABLES = ETAPAS.filter(e => e !== 'contratado');

// ---------------------------------------------------------------------------
// Vacantes
// ---------------------------------------------------------------------------

const COLUMNAS_VAC = `v.id, v.titulo, v.departamento, v.descripcion, v.cantidad, v.estado, v.fecha_publicacion::text AS fecha_publicacion,
  v.fecha_cierre::text AS fecha_cierre, v.creado_el`;

function leerVacante(body) {
  return {
    titulo: validar.texto(body.titulo, 'El título', { max: 150, requerido: true }),
    departamento: validar.texto(body.departamento, 'El departamento', { max: 100 }),
    descripcion: validar.texto(body.descripcion, 'La descripción', { max: 4000 }),
    cantidad: validar.entero(body.cantidad, 'La cantidad', { min: 1, max: 999, porDefecto: 1 }),
    estado: validar.enumerado(body.estado, 'estado', ['abierta', 'pausada', 'cerrada'], { porDefecto: 'abierta' })
  };
}

vacantesRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_VAC},
              count(c.id)::int AS candidatos,
              count(c.id) FILTER (WHERE c.etapa IN ('entrevista', 'prueba', 'oferta'))::int AS en_proceso,
              count(c.id) FILTER (WHERE c.etapa = 'contratado')::int AS contratados
       FROM vacantes v LEFT JOIN candidatos c ON c.vacante_id = v.id
       WHERE v.empresa_id = $1
       GROUP BY v.id ORDER BY (v.estado = 'abierta') DESC, v.fecha_publicacion DESC, v.id DESC LIMIT 500`,
      [req.usuario.empresa_id]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las vacantes.');
  }
});

vacantesRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const v = leerVacante(req.body);
    const { rows } = await pool.query(
      `INSERT INTO vacantes (empresa_id, titulo, departamento, descripcion, cantidad, estado, fecha_cierre)
       VALUES ($1,$2,$3,$4,$5,$6::varchar, CASE WHEN $6::varchar = 'cerrada' THEN CURRENT_DATE END) RETURNING id`,
      [req.usuario.empresa_id, v.titulo, v.departamento, v.descripcion, v.cantidad, v.estado]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `vacante:${rows[0].id}`, detalle: v });
  } catch (err) {
    responderError(res, err, 'No se pudo crear la vacante.');
  }
});

vacantesRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Vacante no encontrada.', 404);
    const v = leerVacante(req.body);
    // Al cerrarla queda la fecha; al reabrirla, se borra.
    const { rowCount } = await pool.query(
      `UPDATE vacantes SET titulo=$1, departamento=$2, descripcion=$3, cantidad=$4, estado=$5::varchar,
         fecha_cierre = CASE WHEN $5::varchar = 'cerrada' THEN COALESCE(fecha_cierre, CURRENT_DATE) ELSE NULL END, actualizado_el=now()
       WHERE id=$6 AND empresa_id=$7`,
      [v.titulo, v.departamento, v.descripcion, v.cantidad, v.estado, id, req.usuario.empresa_id]
    );
    if (!rowCount) throw new ErrorValidacion('Vacante no encontrada.', 404);
    res.json({ id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `vacante:${id}`, detalle: v });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar la vacante.');
  }
});

vacantesRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Vacante no encontrada.', 404);
    const { rows } = await pool.query(`DELETE FROM vacantes WHERE id = $1 AND empresa_id = $2 RETURNING titulo`, [id, req.usuario.empresa_id]);
    if (!rows.length) throw new ErrorValidacion('Vacante no encontrada.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `vacante:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la vacante.');
  }
});

// ---------------------------------------------------------------------------
// Candidatos
// ---------------------------------------------------------------------------

const COLUMNAS_CAND = `c.id, c.vacante_id, c.nombre, c.email, c.telefono, c.dni, c.cv_url, c.fuente, c.etapa, c.pretension_salarial,
  c.notas, c.empleado_id, c.creado_el`;

function leerCandidato(body) {
  const dni = validar.texto(body.dni, 'El documento', { max: 12 });
  if (dni && !esDocumentoIdentidadValido(dni)) throw new ErrorValidacion('El documento debe tener entre 8 y 12 letras o números.');
  return {
    nombre: validar.texto(body.nombre, 'El nombre', { max: 200, requerido: true }),
    email: validar.texto(body.email, 'El correo', { max: 200 }),
    telefono: validar.texto(body.telefono, 'El teléfono', { max: 60 }),
    dni: dni ? dni.toUpperCase() : null,
    cv_url: validar.https(body.cv_url, 'El enlace del CV'),
    fuente: validar.texto(body.fuente, 'La fuente', { max: 60 }),
    pretension_salarial: validar.numero(body.pretension_salarial, 'La pretensión salarial', { min: 0, max: 99999999 }),
    notas: validar.texto(body.notas, 'Las notas', { max: 2000 })
  };
}

async function vacanteDeEmpresa(db, empresaId, vacanteId) {
  const id = idPositivo(vacanteId);
  if (!id) throw new ErrorValidacion('vacante_id es requerido.');
  const { rows } = await db.query(`SELECT id, titulo, departamento, cantidad FROM vacantes WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
  if (!rows.length) throw new ErrorValidacion('Vacante no encontrada.', 404);
  return rows[0];
}

// GET /?vacante_id=&etapa=   (la pretensión salarial es dato de remuneración: solo con rrhh.remuneraciones)
candidatosRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    let vacanteId = null;
    if (req.query.vacante_id !== undefined && req.query.vacante_id !== '') {
      vacanteId = idPositivo(req.query.vacante_id);
      if (!vacanteId) throw new ErrorValidacion('vacante_id no es válido.');
    }
    const etapa = validar.enumerado(req.query.etapa || null, 'etapa', ETAPAS);
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS_CAND}, v.titulo AS vacante_titulo
       FROM candidatos c JOIN vacantes v ON v.id = c.vacante_id
       WHERE c.empresa_id = $1 AND ($2::int IS NULL OR c.vacante_id = $2) AND ($3::varchar IS NULL OR c.etapa = $3)
       ORDER BY c.creado_el DESC, c.id DESC LIMIT 2000`,
      [req.usuario.empresa_id, vacanteId, etapa]
    );
    const conSueldos = puedeVerSueldos(req);
    res.json(rows.map(r => (conSueldos ? r : { ...r, pretension_salarial: null })));
  } catch (err) {
    responderError(res, err, 'No se pudieron leer los candidatos.');
  }
});

candidatosRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const vacante = await vacanteDeEmpresa(pool, empresaId, req.body.vacante_id);
    const c = leerCandidato(req.body);
    const etapa = validar.enumerado(req.body.etapa, 'etapa', ETAPAS_EDITABLES, { porDefecto: 'postulado' });
    const { rows } = await pool.query(
      `INSERT INTO candidatos (empresa_id, vacante_id, nombre, email, telefono, dni, cv_url, fuente, etapa, pretension_salarial, notas)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [empresaId, vacante.id, c.nombre, c.email, c.telefono, c.dni, c.cv_url, c.fuente, etapa, c.pretension_salarial, c.notas]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `candidato:${rows[0].id}`, detalle: { vacante: vacante.titulo, nombre: c.nombre, etapa } });
  } catch (err) {
    responderError(res, err, 'No se pudo registrar al candidato.');
  }
});

candidatosRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Candidato no encontrado.', 404);
    const { rows: actual } = await pool.query(`SELECT etapa FROM candidatos WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
    if (!actual.length) throw new ErrorValidacion('Candidato no encontrado.', 404);
    if (actual[0].etapa === 'contratado') throw new ErrorValidacion('Este candidato ya fue contratado: su ficha de empleado es la que se edita.', 409);

    const c = leerCandidato(req.body);
    if (req.body.etapa === 'contratado') throw new ErrorValidacion('Para contratarlo usa la acción "Contratar": crea su ficha de empleado.');
    const etapa = validar.enumerado(req.body.etapa, 'etapa', ETAPAS_EDITABLES, { porDefecto: actual[0].etapa });
    await pool.query(
      `UPDATE candidatos SET nombre=$1, email=$2, telefono=$3, dni=$4, cv_url=$5, fuente=$6, etapa=$7, pretension_salarial=$8, notas=$9, actualizado_el=now()
       WHERE id=$10 AND empresa_id=$11`,
      [c.nombre, c.email, c.telefono, c.dni, c.cv_url, c.fuente, etapa, c.pretension_salarial, c.notas, id, empresaId]
    );
    res.json({ id, etapa });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `candidato:${id}`, detalle: { etapa: { antes: actual[0].etapa, despues: etapa } } });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar al candidato.');
  }
});

candidatosRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Candidato no encontrado.', 404);
    const { rows } = await pool.query(`DELETE FROM candidatos WHERE id = $1 AND empresa_id = $2 RETURNING nombre, etapa`, [id, req.usuario.empresa_id]);
    if (!rows.length) throw new ErrorValidacion('Candidato no encontrado.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `candidato:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar al candidato.');
  }
});

// POST /:id/contratar  { fecha_contratacion?, salario?, puesto?, departamento?, regimen_laboral?, tipo_contrato? }
// Crea la ficha del trabajador con los datos del candidato y lo marca 'contratado'.
candidatosRouter.post('/:id/contratar', verificarPermiso('rrhh.crear'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Candidato no encontrado.', 404);

    const fecha_contratacion = validar.fecha(req.body.fecha_contratacion, 'La fecha de contratación') ?? hoyLima();
    const salario = validar.numero(req.body.salario, 'El salario', { min: 0, max: 99999999, porDefecto: 0 });
    if (salario > 0 && !puedeVerSueldos(req)) throw new ErrorValidacion('Fijar un sueldo requiere el permiso rrhh.remuneraciones.', 403);
    const regimen = validar.enumerado(req.body.regimen_laboral, 'regimen_laboral', REGIMENES, { porDefecto: 'general' });
    const tipoContrato = validar.texto(req.body.tipo_contrato, 'El tipo de contrato', { max: 40 });

    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT c.*, v.titulo AS vacante_titulo, v.departamento AS vacante_departamento, v.id AS v_id, v.cantidad AS v_cantidad
       FROM candidatos c JOIN vacantes v ON v.id = c.vacante_id
       WHERE c.id = $1 AND c.empresa_id = $2 FOR UPDATE OF c`,
      [id, empresaId]
    );
    if (!rows.length) throw new ErrorValidacion('Candidato no encontrado.', 404);
    const c = rows[0];
    if (c.etapa === 'contratado' || c.empleado_id) throw new ErrorValidacion('Este candidato ya fue contratado.', 409);
    if (c.etapa === 'descartado') throw new ErrorValidacion('Este candidato fue descartado: muévelo a otra etapa antes de contratarlo.', 409);

    const puesto = validar.texto(req.body.puesto, 'El puesto', { max: 150 }) ?? c.vacante_titulo;
    const departamento = validar.texto(req.body.departamento, 'El departamento', { max: 100 }) ?? c.vacante_departamento;

    let empleadoId;
    try {
      const ins = await cliente.query(
        `INSERT INTO empleados (empresa_id, fecha_contratacion, nombre, puesto, departamento, salario, email, telefono, dni, regimen_laboral, tipo_contrato)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [empresaId, fecha_contratacion, c.nombre, puesto, departamento, salario, c.email, c.telefono, c.dni, regimen, tipoContrato]
      );
      empleadoId = ins.rows[0].id;
    } catch (err) {
      if (err?.code === '23505') throw new ErrorValidacion('Ya existe un trabajador con ese documento de identidad.', 409);
      throw err;
    }
    if (salario > 0) {
      await cliente.query(
        `INSERT INTO historial_salarial (empresa_id, empleado_id, sueldo_anterior, sueldo_nuevo, vigente_desde, motivo, registrado_por)
         VALUES ($1,$2,NULL,$3,$4,'Contratación',$5)`,
        [empresaId, empleadoId, salario, fecha_contratacion, req.usuario.id]
      );
    }
    await cliente.query(`UPDATE candidatos SET etapa = 'contratado', empleado_id = $1, actualizado_el = now() WHERE id = $2`, [empleadoId, id]);

    // Si ya se cubrieron las plazas, la vacante se cierra sola.
    const { rows: cont } = await cliente.query(`SELECT count(*)::int AS n FROM candidatos WHERE vacante_id = $1 AND etapa = 'contratado'`, [c.v_id]);
    const cerrada = cont[0].n >= c.v_cantidad;
    if (cerrada) {
      await cliente.query(`UPDATE vacantes SET estado = 'cerrada', fecha_cierre = COALESCE(fecha_cierre, CURRENT_DATE), actualizado_el = now() WHERE id = $1 AND estado <> 'cerrada'`, [c.v_id]);
    }
    await cliente.query('COMMIT');
    res.status(201).json({ empleado_id: empleadoId, vacante_cerrada: cerrada });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `empleado:${empleadoId}`, detalle: { contratado_desde_candidato: id, nombre: c.nombre, puesto, fecha_contratacion } });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudo contratar al candidato.');
  } finally {
    cliente.release();
  }
});
