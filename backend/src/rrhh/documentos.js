// src/rrhh/documentos.js
// Legajo digital (fase R5): los documentos de cada trabajador como ENLACES
// (Drive, OneDrive...), con fecha de vencimiento para avisar antes de que
// caduquen. GEALMI no guarda archivos.
//
// El examen médico es dato de salud: quien no tiene rrhh.salud ni lo ve en la
// lista ni puede crearlo, editarlo o borrarlo (para él ese documento "no
// existe": 404, no 403, para no confirmar que está).

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { ErrorValidacion, responderError, validar, idPositivo, puedeVerSalud, validarEmpleadoDeEmpresa } from './comun.js';

export const documentosRouter = Router();

export const TIPOS_DOCUMENTO = ['contrato', 'dni', 'cv', 'certificado', 'examen_medico', 'antecedentes', 'declaracion_jurada', 'otro'];
const TIPO_SENSIBLE = 'examen_medico';

const COLUMNAS = `d.id, d.empleado_id, d.tipo, d.nombre, d.url, d.fecha_emision::text AS fecha_emision,
  d.fecha_vencimiento::text AS fecha_vencimiento, d.notas, d.creado_el`;

function leerDocumento(body) {
  const fecha_emision = validar.fecha(body.fecha_emision, 'La fecha de emisión');
  const fecha_vencimiento = validar.fecha(body.fecha_vencimiento, 'La fecha de vencimiento');
  if (fecha_emision && fecha_vencimiento && fecha_vencimiento < fecha_emision) {
    throw new ErrorValidacion('El vencimiento no puede ser anterior a la emisión.');
  }
  return {
    tipo: validar.enumerado(body.tipo, 'tipo', TIPOS_DOCUMENTO, { requerido: true }),
    nombre: validar.texto(body.nombre, 'El nombre', { max: 150, requerido: true }),
    url: validar.https(body.url, 'El enlace'),
    fecha_emision, fecha_vencimiento,
    notas: validar.texto(body.notas, 'Las notas', { max: 250 })
  };
}

const sinPermisoSalud = (req, tipo) => {
  if (tipo === TIPO_SENSIBLE && !puedeVerSalud(req)) throw new ErrorValidacion('Documento no encontrado.', 404);
};

// GET /?empleado_id=&vence_en=30   (vence_en: vencidos o que vencen en N días)
documentosRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }
    const venceEn = req.query.vence_en === undefined || req.query.vence_en === ''
      ? null : validar.entero(req.query.vence_en, 'vence_en', { min: 0, max: 3650 });
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS}, e.nombre AS empleado_nombre,
              (d.fecha_vencimiento IS NOT NULL AND d.fecha_vencimiento < (now() AT TIME ZONE 'America/Lima')::date) AS vencido
       FROM documentos_empleado d JOIN empleados e ON e.id = d.empleado_id
       WHERE d.empresa_id = $1 AND ($2::int IS NULL OR d.empleado_id = $2)
         AND ($3::int IS NULL OR d.fecha_vencimiento <= (now() AT TIME ZONE 'America/Lima')::date + $3::int)
         AND ($4::boolean OR d.tipo <> $5)
       ORDER BY d.fecha_vencimiento NULLS LAST, d.id DESC LIMIT 2000`,
      [req.usuario.empresa_id, empleadoId, venceEn, puedeVerSalud(req), TIPO_SENSIBLE]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer los documentos.');
  }
});

documentosRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const empleado = await validarEmpleadoDeEmpresa(pool, empresaId, req.body.empleado_id);
    const d = leerDocumento(req.body);
    sinPermisoSalud(req, d.tipo);
    const { rows } = await pool.query(
      `INSERT INTO documentos_empleado (empresa_id, empleado_id, tipo, nombre, url, fecha_emision, fecha_vencimiento, notas, subido_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [empresaId, empleado.id, d.tipo, d.nombre, d.url, d.fecha_emision, d.fecha_vencimiento, d.notas, req.usuario.id]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `documento:${rows[0].id}`, detalle: { empleado: empleado.nombre, tipo: d.tipo, nombre: d.nombre } });
  } catch (err) {
    responderError(res, err, 'No se pudo registrar el documento.');
  }
});

async function documentoPropio(req) {
  const id = idPositivo(req.params.id);
  if (!id) throw new ErrorValidacion('Documento no encontrado.', 404);
  const { rows } = await pool.query(`SELECT ${COLUMNAS} FROM documentos_empleado d WHERE d.id = $1 AND d.empresa_id = $2`, [id, req.usuario.empresa_id]);
  if (!rows.length) throw new ErrorValidacion('Documento no encontrado.', 404);
  sinPermisoSalud(req, rows[0].tipo);
  return rows[0];
}

documentosRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const antes = await documentoPropio(req);
    const d = leerDocumento(req.body);
    sinPermisoSalud(req, d.tipo); // tampoco se puede "convertir" un documento común en médico sin permiso
    await pool.query(
      `UPDATE documentos_empleado SET tipo=$1, nombre=$2, url=$3, fecha_emision=$4, fecha_vencimiento=$5, notas=$6, actualizado_el=now()
       WHERE id=$7 AND empresa_id=$8`,
      [d.tipo, d.nombre, d.url, d.fecha_emision, d.fecha_vencimiento, d.notas, antes.id, req.usuario.empresa_id]
    );
    res.json({ id: antes.id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `documento:${antes.id}`, detalle: { antes: { tipo: antes.tipo, nombre: antes.nombre, fecha_vencimiento: antes.fecha_vencimiento }, despues: { tipo: d.tipo, nombre: d.nombre, fecha_vencimiento: d.fecha_vencimiento } } });
  } catch (err) {
    responderError(res, err, 'No se pudo actualizar el documento.');
  }
});

documentosRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const doc = await documentoPropio(req);
    await pool.query(`DELETE FROM documentos_empleado WHERE id = $1 AND empresa_id = $2`, [doc.id, req.usuario.empresa_id]);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `documento:${doc.id}`, detalle: { eliminado: { empleado_id: doc.empleado_id, tipo: doc.tipo, nombre: doc.nombre } } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar el documento.');
  }
});
