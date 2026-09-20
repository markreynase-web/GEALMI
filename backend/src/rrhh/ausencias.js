// src/rrhh/ausencias.js
// Ausencias (fase R3): vacaciones, descansos médicos, licencias y permisos con
// flujo de aprobación. El trabajador las solicita desde "Mi asistencia" (mi.js
// reutiliza insertarAusencia) y RRHH las aprueba, rechaza o carga a mano.
// Solo lo APROBADO cuenta para el saldo de vacaciones y para el estado
// efectivo de la ficha.
//
// El detalle médico (diagnóstico, CITT) es dato de salud: solo se lee o se
// escribe con rrhh.salud. Quien no lo tiene ve la ausencia, pero sin el detalle.

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { notificar, usuariosConPermiso } from '../notificaciones.js';
import { diasCalendario, saldoVacaciones } from './calculos.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, puedeVerSalud, validarEmpleadoDeEmpresa } from './comun.js';

export const ausenciasRouter = Router();

export const TIPOS_AUSENCIA = ['vacaciones', 'descanso_medico', 'licencia', 'permiso'];
const ETIQUETA_TIPO = { vacaciones: 'vacaciones', descanso_medico: 'descanso médico', licencia: 'licencia', permiso: 'permiso' };
const DIAS_MAXIMOS = 366;

const COLUMNAS = `a.id, a.empleado_id, a.tipo, a.fecha_inicio::text AS fecha_inicio, a.fecha_fin::text AS fecha_fin, a.dias, a.con_goce,
  a.estado, a.motivo, a.resuelto_el, a.comentario_resolucion, a.creado_el`;

// Valida lo que el usuario escribió. `permiteSalud`: si puede enviar detalle médico.
export function leerAusencia(body, { permiteSalud }) {
  const tipo = validar.enumerado(body.tipo, 'tipo', TIPOS_AUSENCIA, { requerido: true });
  const fecha_inicio = validar.fecha(body.fecha_inicio, 'La fecha de inicio', { requerido: true });
  const fecha_fin = validar.fecha(body.fecha_fin, 'La fecha de fin', { requerido: true });
  if (fecha_fin < fecha_inicio) throw new ErrorValidacion('La fecha de fin no puede ser anterior a la de inicio.');
  const dias = diasCalendario(fecha_inicio, fecha_fin);
  if (dias > DIAS_MAXIMOS) throw new ErrorValidacion(`Una ausencia no puede pasar de ${DIAS_MAXIMOS} días.`);

  const motivo = validar.texto(body.motivo, 'El motivo', { max: 250 });
  const detalle = validar.texto(body.detalle_medico, 'El detalle médico', { max: 2000 });
  if (detalle && !permiteSalud) throw new ErrorValidacion('El detalle médico requiere el permiso rrhh.salud.', 403);

  // Las vacaciones siempre son con goce; el resto lo decide quien registra (por defecto, con goce).
  const con_goce = tipo === 'vacaciones' ? true : body.con_goce === undefined || body.con_goce === null ? true : body.con_goce === true || body.con_goce === 'true';
  return { tipo, fecha_inicio, fecha_fin, dias, con_goce, motivo, detalle_medico: detalle };
}

async function comprobarCruce(db, empleadoId, inicio, fin, excluirId = null) {
  const { rows } = await db.query(
    `SELECT tipo, fecha_inicio::text AS desde, fecha_fin::text AS hasta FROM ausencias
     WHERE empleado_id = $1 AND estado IN ('pendiente', 'aprobada') AND fecha_inicio <= $3 AND fecha_fin >= $2
       AND ($4::int IS NULL OR id <> $4)
     LIMIT 1`,
    [empleadoId, inicio, fin, excluirId]
  );
  if (rows.length) {
    throw new ErrorValidacion(`Esas fechas se cruzan con otra ausencia (${ETIQUETA_TIPO[rows[0].tipo]} del ${rows[0].desde} al ${rows[0].hasta}).`, 409);
  }
}

// Crea la ausencia cuidando que no se cruce con otra del mismo trabajador. La
// ficha se bloquea durante la transacción: dos solicitudes simultáneas no
// pueden colarse las dos.
export async function insertarAusencia(empresaId, empleadoId, datos, { estado, usuarioId }) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT id FROM empleados WHERE id = $1 FOR UPDATE', [empleadoId]);
    await comprobarCruce(cliente, empleadoId, datos.fecha_inicio, datos.fecha_fin);
    const aprobada = estado === 'aprobada';
    const { rows } = await cliente.query(
      `INSERT INTO ausencias (empresa_id, empleado_id, tipo, fecha_inicio, fecha_fin, dias, con_goce, estado, motivo, detalle_medico,
                              solicitado_por, resuelto_por, resuelto_el)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [empresaId, empleadoId, datos.tipo, datos.fecha_inicio, datos.fecha_fin, datos.dias, datos.con_goce, estado, datos.motivo, datos.detalle_medico,
       usuarioId, aprobada ? usuarioId : null, aprobada ? new Date() : null]
    );
    await cliente.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

export async function saldoDeVacaciones(db, empleadoId) {
  const { rows: fichas } = await db.query(
    `SELECT regimen_laboral, fecha_contratacion::text AS fecha_contratacion, fecha_cese::text AS fecha_cese FROM empleados WHERE id = $1`,
    [empleadoId]
  );
  if (!fichas.length) return null;
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(dias) FILTER (WHERE estado = 'aprobada'), 0)::int AS tomados,
            COALESCE(SUM(dias) FILTER (WHERE estado = 'pendiente'), 0)::int AS pendientes
     FROM ausencias WHERE empleado_id = $1 AND tipo = 'vacaciones'`,
    [empleadoId]
  );
  const f = fichas[0];
  return {
    ...saldoVacaciones({ regimen: f.regimen_laboral, fecha_contratacion: f.fecha_contratacion, fecha_cese: f.fecha_cese, dias_tomados: rows[0].tomados, hoy: hoyLima() }),
    dias_pendientes_aprobacion: rows[0].pendientes
  };
}

// Avisos (best-effort: nunca tumban la operación; se llaman DESPUÉS de responder).
export async function avisarSolicitud(empresaId, { ausenciaId, empleadoNombre, datos, solicitanteId }) {
  try {
    const destinatarios = await usuariosConPermiso(pool, empresaId, 'rrhh.editar', { excluirUsuarioId: solicitanteId });
    await notificar(pool, {
      empresaId, usuarioIds: destinatarios, tipo: 'rrhh', enlace: 'rrhh',
      titulo: `Solicitud de ${ETIQUETA_TIPO[datos.tipo]}: ${empleadoNombre}`,
      cuerpo: `Del ${datos.fecha_inicio} al ${datos.fecha_fin} (${datos.dias} día${datos.dias === 1 ? '' : 's'}). Revísala en RRHH → Ausencias.`,
      clave: `ausencia_solicitud:${ausenciaId}`
    });
  } catch (err) {
    console.error('No se pudo avisar la solicitud de ausencia:', err.message);
  }
}

async function avisarResolucion(empresaId, ausencia, estado, comentario, actor) {
  try {
    const { rows } = await pool.query(`SELECT usuario_id FROM empleados WHERE id = $1 AND empresa_id = $2`, [ausencia.empleado_id, empresaId]);
    const destino = rows[0]?.usuario_id;
    if (!destino || destino === actor?.id) return;
    const verbo = { aprobada: 'aprobada', rechazada: 'rechazada', cancelada: 'cancelada' }[estado];
    await notificar(pool, {
      empresaId, usuarioIds: [destino], tipo: 'rrhh', enlace: 'mi-asistencia', prioridad: estado === 'rechazada' ? 'alta' : 'normal',
      titulo: `Tu solicitud de ${ETIQUETA_TIPO[ausencia.tipo]} fue ${verbo}`,
      cuerpo: `Del ${ausencia.fecha_inicio} al ${ausencia.fecha_fin}.${comentario ? ` Comentario: ${comentario}` : ''}`,
      clave: `ausencia_resuelta:${ausencia.id}:${estado}`
    });
  } catch (err) {
    console.error('No se pudo avisar la resolución de la ausencia:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Rutas de RRHH
// ---------------------------------------------------------------------------

// GET /?estado=&tipo=&empleado_id=&desde=&hasta=
ausenciasRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const estado = validar.enumerado(req.query.estado || null, 'estado', ['pendiente', 'aprobada', 'rechazada', 'cancelada']);
    const tipo = validar.enumerado(req.query.tipo || null, 'tipo', TIPOS_AUSENCIA);
    const desde = validar.fecha(req.query.desde, 'desde');
    const hasta = validar.fecha(req.query.hasta, 'hasta');
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }
    const { rows } = await pool.query(
      `SELECT ${COLUMNAS}, e.nombre AS empleado_nombre,
              CASE WHEN $7::boolean THEN a.detalle_medico ELSE NULL END AS detalle_medico
       FROM ausencias a JOIN empleados e ON e.id = a.empleado_id
       WHERE a.empresa_id = $1 AND ($2::varchar IS NULL OR a.estado = $2) AND ($3::varchar IS NULL OR a.tipo = $3)
         AND ($4::int IS NULL OR a.empleado_id = $4)
         AND ($5::date IS NULL OR a.fecha_fin >= $5) AND ($6::date IS NULL OR a.fecha_inicio <= $6)
       ORDER BY (a.estado = 'pendiente') DESC, a.fecha_inicio DESC, a.id DESC LIMIT 1000`,
      [empresaId, estado, tipo, empleadoId, desde, hasta, puedeVerSalud(req)]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer las ausencias.');
  }
});

ausenciasRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const empleado = await validarEmpleadoDeEmpresa(pool, empresaId, req.body.empleado_id);
    const datos = leerAusencia(req.body, { permiteSalud: puedeVerSalud(req) });
    // Lo que RRHH carga a mano suele ser algo ya decidido: nace aprobado salvo que pida lo contrario.
    const estado = validar.enumerado(req.body.estado, 'estado', ['pendiente', 'aprobada'], { porDefecto: 'aprobada' });
    const id = await insertarAusencia(empresaId, empleado.id, datos, { estado, usuarioId: req.usuario.id });
    res.status(201).json({ id });
    const { detalle_medico, ...auditable } = datos; // el diagnóstico no viaja al registro de auditoría
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `ausencia:${id}`, detalle: { empleado: empleado.nombre, estado, ...auditable } });
  } catch (err) {
    responderError(res, err, 'No se pudo registrar la ausencia.');
  }
});

ausenciasRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(`SELECT ${COLUMNAS} FROM ausencias a WHERE a.id = $1 AND a.empresa_id = $2 FOR UPDATE`, [id, empresaId]);
    if (!rows.length) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    const antes = rows[0];
    if (!['pendiente', 'aprobada'].includes(antes.estado)) throw new ErrorValidacion(`Una ausencia ${antes.estado} ya no se puede editar.`, 409);
    await cliente.query('SELECT id FROM empleados WHERE id = $1 FOR UPDATE', [antes.empleado_id]);

    const datos = leerAusencia(req.body, { permiteSalud: puedeVerSalud(req) });
    await comprobarCruce(cliente, antes.empleado_id, datos.fecha_inicio, datos.fecha_fin, id);
    // El detalle médico solo se toca si quien edita puede verlo (y lo mandó).
    const tocaDetalle = puedeVerSalud(req) && req.body.detalle_medico !== undefined;
    await cliente.query(
      `UPDATE ausencias SET tipo=$1, fecha_inicio=$2, fecha_fin=$3, dias=$4, con_goce=$5, motivo=$6,
         detalle_medico = CASE WHEN $7::boolean THEN $8 ELSE detalle_medico END, actualizado_el=now()
       WHERE id=$9 AND empresa_id=$10`,
      [datos.tipo, datos.fecha_inicio, datos.fecha_fin, datos.dias, datos.con_goce, datos.motivo, tocaDetalle, datos.detalle_medico, id, empresaId]
    );
    await cliente.query('COMMIT');
    res.json({ id });
    const { detalle_medico, ...auditable } = datos;
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `ausencia:${id}`, detalle: { antes, despues: auditable } });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudo actualizar la ausencia.');
  } finally {
    cliente.release();
  }
});

// Cambios de estado: pendiente → aprobada | rechazada | cancelada, y aprobada → cancelada.
const TRANSICIONES = { pendiente: ['aprobada', 'rechazada', 'cancelada'], aprobada: ['cancelada'] };

ausenciasRouter.put('/:id/resolver', verificarPermiso('rrhh.editar'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    const estado = validar.enumerado(req.body.estado, 'estado', ['aprobada', 'rechazada', 'cancelada'], { requerido: true });
    const comentario = validar.texto(req.body.comentario, 'El comentario', { max: 250 });

    await cliente.query('BEGIN');
    const { rows } = await cliente.query(`SELECT ${COLUMNAS} FROM ausencias a WHERE a.id = $1 AND a.empresa_id = $2 FOR UPDATE`, [id, empresaId]);
    if (!rows.length) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    const ausencia = rows[0];
    if (!(TRANSICIONES[ausencia.estado] || []).includes(estado)) {
      throw new ErrorValidacion(`Una ausencia ${ausencia.estado} no puede pasar a ${estado}.`, 409);
    }
    if (estado === 'aprobada') {
      await cliente.query('SELECT id FROM empleados WHERE id = $1 FOR UPDATE', [ausencia.empleado_id]);
      await comprobarCruce(cliente, ausencia.empleado_id, ausencia.fecha_inicio, ausencia.fecha_fin, id);
    }
    await cliente.query(
      `UPDATE ausencias SET estado=$1, resuelto_por=$2, resuelto_el=now(), comentario_resolucion=$3, actualizado_el=now() WHERE id=$4 AND empresa_id=$5`,
      [estado, req.usuario.id, comentario, id, empresaId]
    );
    await cliente.query('COMMIT');
    res.json({ id, estado });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `ausencia:${id}`, detalle: { estado: { antes: ausencia.estado, despues: estado }, comentario } });
    avisarResolucion(empresaId, ausencia, estado, comentario, req.usuario);
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    responderError(res, err, 'No se pudo resolver la ausencia.');
  } finally {
    cliente.release();
  }
});

ausenciasRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    const { rows } = await pool.query(
      `DELETE FROM ausencias WHERE id = $1 AND empresa_id = $2 RETURNING empleado_id, tipo, fecha_inicio::text AS fecha_inicio, fecha_fin::text AS fecha_fin, estado`,
      [id, req.usuario.empresa_id]
    );
    if (!rows.length) throw new ErrorValidacion('Ausencia no encontrada.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `ausencia:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar la ausencia.');
  }
});
