// src/rrhh/asistencia.js
// Registro de asistencia (fase R2). Dos usos:
//   * el trabajador marca desde "Mi asistencia" (routes /mi, ver mi.js), con la
//     hora del SERVIDOR -- no puede poner la hora que quiera;
//   * RRHH consulta el reporte, y carga o corrige a mano (siempre con motivo,
//     y el antes/después queda en Auditoría).
// Las horas trabajadas, el sobretiempo y la tardanza se calculan al leer
// (calculos.js): no se guardan, así no pueden quedar desfasadas de las marcas.

import { Router } from 'express';
import { pool } from '../db.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { calcularJornada, resumenAsistencia, diasCalendario } from './calculos.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, validarEmpleadoDeEmpresa } from './comun.js';

export const asistenciaRouter = Router();

const OFFSET_LIMA = '-05:00'; // Perú no tiene horario de verano: el desfase es fijo.
export const MARCAS = ['entrada', 'salida_refrigerio', 'retorno_refrigerio', 'salida'];
const DIA_MS = 86400000;
const HORAS_MAX_JORNADA = 24;
// Si la última entrada sin salida tiene más de esto, se da por abandonada (se
// olvidó marcar la salida) y una entrada nueva empieza otra jornada.
const HORAS_JORNADA_ABIERTA = 16;

const COLUMNAS = `a.id, a.empleado_id, a.fecha::text AS fecha, a.entrada, a.salida_refrigerio, a.retorno_refrigerio,
  a.salida, a.origen, a.observacion, a.creado_el, a.actualizado_el`;

// "HH:MM" -> esa hora del día `fecha` en Lima (y si queda antes de la marca
// anterior, es del día siguiente: turno que cruza la medianoche).
// "AAAA-MM-DDTHH:MM" sin zona -> hora de Lima. Con zona (Z o ±hh:mm) -> tal cual.
export function aInstante(valor, fecha, anterior, nombre) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const s = String(valor).trim();
  let d;
  if (/^\d{2}:\d{2}$/.test(s)) {
    d = new Date(`${fecha}T${s}:00${OFFSET_LIMA}`);
    if (anterior && d < anterior) d = new Date(d.getTime() + DIA_MS);
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    d = new Date(`${s.length === 16 ? `${s}:00` : s}${OFFSET_LIMA}`);
  } else if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(s)) {
    d = new Date(s);
  } else {
    throw new ErrorValidacion(`${nombre} no es una hora válida (usa HH:MM).`);
  }
  if (Number.isNaN(d.getTime())) throw new ErrorValidacion(`${nombre} no es una hora válida.`);
  return d;
}

const ETIQUETA_MARCA = { entrada: 'La entrada', salida_refrigerio: 'La salida a refrigerio', retorno_refrigerio: 'El regreso del refrigerio', salida: 'La salida' };

export function validarMarcas(body, fecha) {
  const marcas = {};
  let anterior = null;
  for (const m of MARCAS) {
    const d = aInstante(body[m], fecha, anterior, ETIQUETA_MARCA[m]);
    marcas[m] = d;
    if (d) {
      if (anterior && d < anterior) throw new ErrorValidacion(`${ETIQUETA_MARCA[m]} no puede ser anterior a la marca previa.`);
      anterior = d;
    }
  }
  if (!marcas.entrada) throw new ErrorValidacion('La hora de entrada es obligatoria.');
  if (marcas.retorno_refrigerio && !marcas.salida_refrigerio) throw new ErrorValidacion('Hay regreso de refrigerio pero no salida a refrigerio.');
  if (marcas.salida && marcas.salida - marcas.entrada > HORAS_MAX_JORNADA * 3600000) throw new ErrorValidacion(`La jornada no puede pasar de ${HORAS_MAX_JORNADA} horas.`);
  return marcas;
}

// La fila con horas trabajadas / sobretiempo / tardanza ya calculadas.
export function conCalculo(fila, { jornada_horas_dia, hora_entrada }) {
  return { ...fila, ...calcularJornada(fila, { jornada_horas_dia, hora_entrada }) };
}

// ---------------------------------------------------------------------------
// Marcación del propio trabajador
// ---------------------------------------------------------------------------

async function jornadaAbierta(db, empleadoId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNAS} FROM asistencias a
     WHERE a.empleado_id = $1 AND a.entrada IS NOT NULL AND a.salida IS NULL
       AND a.entrada > now() - make_interval(hours => $2)
     ORDER BY a.entrada DESC LIMIT 1`,
    [empleadoId, HORAS_JORNADA_ABIERTA]
  );
  return rows[0] || null;
}

// Qué marcas puede hacer ahora, según lo que ya marcó en la jornada.
export function accionesPermitidas(registro) {
  if (!registro) return ['entrada'];
  if (registro.salida) return [];
  if (registro.salida_refrigerio && !registro.retorno_refrigerio) return ['retorno_refrigerio'];
  if (!registro.salida_refrigerio) return ['salida_refrigerio', 'salida'];
  return ['salida'];
}

export async function estadoDelDia(db, empleado) {
  const hoy = hoyLima();
  let registro = await jornadaAbierta(db, empleado.id);
  if (!registro) {
    // La jornada de hoy o, si acaba de cerrar un turno de noche (su fecha es la de
    // ayer), esa: así no se le vuelve a ofrecer "Entrada" recién terminada su jornada.
    const { rows } = await db.query(
      `SELECT ${COLUMNAS} FROM asistencias a
       WHERE a.empleado_id = $1 AND (a.fecha = $2 OR a.entrada > now() - make_interval(hours => $3))
       ORDER BY a.entrada DESC NULLS LAST LIMIT 1`,
      [empleado.id, hoy, HORAS_JORNADA_ABIERTA]
    );
    registro = rows[0] || null;
  }
  const { rows: aus } = await db.query(
    `SELECT tipo, fecha_inicio::text AS desde, fecha_fin::text AS hasta FROM ausencias
     WHERE empleado_id = $1 AND estado = 'aprobada' AND $2::date BETWEEN fecha_inicio AND fecha_fin LIMIT 1`,
    [empleado.id, hoy]
  );
  return {
    fecha: hoy,
    hora_servidor: new Date().toISOString(),
    empleado: {
      id: empleado.id, nombre: empleado.nombre, puesto: empleado.puesto, jornada_horas_dia: empleado.jornada_horas_dia,
      hora_entrada: empleado.hora_entrada, hora_salida: empleado.hora_salida, refrigerio_minutos: empleado.refrigerio_minutos
    },
    registro: registro ? conCalculo(registro, empleado) : null,
    acciones: accionesPermitidas(registro),
    ausencia_hoy: aus[0] || null
  };
}

export async function marcar(empleado, tipo, usuarioId) {
  if (!MARCAS.includes(tipo)) throw new ErrorValidacion(`tipo debe ser uno de: ${MARCAS.join(', ')}.`);
  const hoy = hoyLima();
  if (empleado.fecha_cese && empleado.fecha_cese <= hoy) throw new ErrorValidacion('Tu ficha figura como cesada: ya no puedes marcar asistencia.', 403);

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Bloquea la ficha: dos toques casi simultáneos (doble clic, dos pestañas) se ejecutan uno tras otro.
    await cliente.query('SELECT id FROM empleados WHERE id = $1 FOR UPDATE', [empleado.id]);
    const abierta = await jornadaAbierta(cliente, empleado.id);

    if (tipo === 'entrada') {
      if (abierta) throw new ErrorValidacion('Ya marcaste tu entrada. Marca tu salida antes de empezar otra jornada.', 409);
      const { rows: delDia } = await cliente.query('SELECT 1 FROM asistencias WHERE empleado_id = $1 AND fecha = $2', [empleado.id, hoy]);
      if (delDia.length) throw new ErrorValidacion('Ya completaste tu jornada de hoy.', 409);
      await cliente.query(
        `INSERT INTO asistencias (empresa_id, empleado_id, fecha, entrada, origen, registrado_por)
         VALUES ((SELECT empresa_id FROM empleados WHERE id = $1), $1, $2, now(), 'marcacion', $3)`,
        [empleado.id, hoy, usuarioId]
      );
    } else {
      if (!abierta) throw new ErrorValidacion('Primero marca tu entrada.', 409);
      if (!accionesPermitidas(abierta).includes(tipo)) {
        const motivo = tipo === 'salida' && abierta.salida_refrigerio && !abierta.retorno_refrigerio
          ? 'Marca tu regreso del refrigerio antes de la salida.'
          : tipo === 'retorno_refrigerio' && !abierta.salida_refrigerio
            ? 'Primero marca tu salida a refrigerio.'
            : `${ETIQUETA_MARCA[tipo]} ya está marcada.`;
        throw new ErrorValidacion(motivo, 409);
      }
      // `tipo` viene de la lista fija MARCAS (validada arriba): seguro de interpolar.
      await cliente.query(`UPDATE asistencias SET ${tipo} = now(), actualizado_el = now() WHERE id = $1`, [abierta.id]);
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  return estadoDelDia(pool, empleado);
}

// ---------------------------------------------------------------------------
// Reporte y corrección por RRHH
// ---------------------------------------------------------------------------

// GET /?desde=&hasta=&empleado_id=  (por defecto, lo que va del mes)
asistenciaRouter.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const hoy = hoyLima();
    const desde = validar.fecha(req.query.desde, 'desde') ?? `${hoy.slice(0, 8)}01`;
    const hasta = validar.fecha(req.query.hasta, 'hasta') ?? hoy;
    if (hasta < desde) throw new ErrorValidacion('"hasta" no puede ser anterior a "desde".');
    if (diasCalendario(desde, hasta) > 366) throw new ErrorValidacion('El rango no puede pasar de un año.');
    let empleadoId = null;
    if (req.query.empleado_id !== undefined && req.query.empleado_id !== '') {
      empleadoId = idPositivo(req.query.empleado_id);
      if (!empleadoId) throw new ErrorValidacion('empleado_id no es válido.');
    }

    const { rows } = await pool.query(
      `SELECT ${COLUMNAS}, e.nombre, e.dni, e.jornada_horas_dia::float8 AS jornada_horas_dia, to_char(e.hora_entrada, 'HH24:MI') AS hora_entrada
       FROM asistencias a JOIN empleados e ON e.id = a.empleado_id
       WHERE a.empresa_id = $1 AND a.fecha BETWEEN $2 AND $3 AND ($4::int IS NULL OR a.empleado_id = $4)
       ORDER BY a.fecha DESC, e.nombre, a.id LIMIT 5000`,
      [empresaId, desde, hasta, empleadoId]
    );
    const filas = rows.map(({ nombre, dni, jornada_horas_dia, hora_entrada, ...fila }) => ({
      ...conCalculo(fila, { jornada_horas_dia, hora_entrada }), nombre, dni, hora_entrada_pactada: hora_entrada, jornada_horas_dia
    }));
    const nombres = new Map(rows.map(r => [r.empleado_id, { nombre: r.nombre, dni: r.dni }]));
    const resumen = resumenAsistencia(filas).map(r => ({ ...r, ...nombres.get(r.empleado_id) })).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));

    const { rows: emp } = await pool.query(`SELECT nombre, razon_social, ruc, domicilio_fiscal FROM empresas WHERE id = $1`, [empresaId]);
    res.json({ desde, hasta, filas, resumen, empleador: emp[0] || null });
  } catch (err) {
    responderError(res, err, 'No se pudo leer el registro de asistencia.');
  }
});

// Campos que RRHH puede cargar/corregir: las cuatro marcas y el motivo (obligatorio).
function leerCarga(body, fecha) {
  const marcas = validarMarcas(body, fecha);
  const observacion = validar.texto(body.observacion, 'El motivo', { max: 250, requerido: true });
  return { ...marcas, observacion };
}

function noEsFuturo(fecha) {
  if (fecha > hoyLima()) throw new ErrorValidacion('No se puede registrar asistencia de una fecha futura.');
}

asistenciaRouter.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const empleado = await validarEmpleadoDeEmpresa(pool, empresaId, req.body.empleado_id);
    const fecha = validar.fecha(req.body.fecha, 'fecha', { requerido: true });
    noEsFuturo(fecha);
    const c = leerCarga(req.body, fecha);
    const { rows } = await pool.query(
      `INSERT INTO asistencias (empresa_id, empleado_id, fecha, entrada, salida_refrigerio, retorno_refrigerio, salida, origen, observacion, registrado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) RETURNING id`,
      [empresaId, empleado.id, fecha, c.entrada, c.salida_refrigerio, c.retorno_refrigerio, c.salida, c.observacion, req.usuario.id]
    );
    res.status(201).json({ id: rows[0].id });
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: `asistencia:${rows[0].id}`, detalle: { empleado: empleado.nombre, fecha, ...c } });
  } catch (err) {
    if (err?.code === '23505') return res.status(409).json({ error: 'Ese trabajador ya tiene un registro ese día: edítalo en vez de crear otro.' });
    responderError(res, err, 'No se pudo registrar la asistencia.');
  }
});

asistenciaRouter.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Registro no encontrado.', 404);
    const { rows: antesRows } = await pool.query(`SELECT ${COLUMNAS} FROM asistencias a WHERE a.id = $1 AND a.empresa_id = $2`, [id, empresaId]);
    if (!antesRows.length) throw new ErrorValidacion('Registro no encontrado.', 404);
    const antes = antesRows[0];
    const c = leerCarga(req.body, antes.fecha);
    await pool.query(
      `UPDATE asistencias SET entrada=$1, salida_refrigerio=$2, retorno_refrigerio=$3, salida=$4, origen='manual',
         observacion=$5, registrado_por=$6, actualizado_el=now()
       WHERE id=$7 AND empresa_id=$8`,
      [c.entrada, c.salida_refrigerio, c.retorno_refrigerio, c.salida, c.observacion, req.usuario.id, id, empresaId]
    );
    res.json({ id });
    registrarAuditoria(pool, {
      usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: `asistencia:${id}`,
      detalle: { fecha: antes.fecha, antes: { entrada: antes.entrada, salida_refrigerio: antes.salida_refrigerio, retorno_refrigerio: antes.retorno_refrigerio, salida: antes.salida, origen: antes.origen }, despues: c }
    });
  } catch (err) {
    responderError(res, err, 'No se pudo corregir la asistencia.');
  }
});

asistenciaRouter.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Registro no encontrado.', 404);
    const { rows } = await pool.query(`DELETE FROM asistencias WHERE id = $1 AND empresa_id = $2 RETURNING empleado_id, fecha::text AS fecha, entrada, salida, origen`, [id, empresaId]);
    if (!rows.length) throw new ErrorValidacion('Registro no encontrado.', 404);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: `asistencia:${id}`, detalle: { eliminado: rows[0] } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar el registro.');
  }
});
