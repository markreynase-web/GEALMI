// src/rrhh/mi.js
// "Mi asistencia": lo que cada trabajador hace con SU propia ficha, sin ser de
// RRHH -- marcar entrada/salida/refrigerio, ver su historial y su saldo de
// vacaciones, y pedir o cancelar una ausencia.
//
// No pide ningún permiso rrhh.*: cualquier rol (ventas, inventario...) puede
// marcar su asistencia. La puerta es otra -- que su usuario esté VINCULADO a
// una ficha de empleado de esta empresa (empleados.usuario_id). Todo se busca a
// partir de ESE vínculo, nunca de un id que mande el cliente, así nadie puede
// marcar ni pedir nada a nombre de otra persona.

import { Router } from 'express';
import { pool } from '../db.js';
import { diasCalendario, resumenAsistencia } from './calculos.js';
import { ErrorValidacion, responderError, validar, idPositivo, hoyLima, empleadoDelUsuario } from './comun.js';
import { estadoDelDia, marcar, conCalculo } from './asistencia.js';
import { leerAusencia, insertarAusencia, saldoDeVacaciones, avisarSolicitud } from './ausencias.js';

export const miRouter = Router();

// Resuelve la ficha del usuario logueado (o responde 404 con un mensaje que
// el frontend reconoce por `codigo` para mostrar "no estás vinculado").
miRouter.use(async (req, res, next) => {
  try {
    const empleado = await empleadoDelUsuario(pool, req.usuario.empresa_id, req.usuario.id);
    if (!empleado) {
      return res.status(404).json({ error: 'Tu usuario no está vinculado a una ficha de trabajador. Pídele a RRHH que la vincule.', codigo: 'sin_ficha' });
    }
    req.empleado = empleado;
    next();
  } catch (err) {
    responderError(res, err, 'No se pudo leer tu ficha.');
  }
});

miRouter.get('/hoy', async (req, res) => {
  try {
    res.json(await estadoDelDia(pool, req.empleado));
  } catch (err) {
    responderError(res, err, 'No se pudo leer tu asistencia de hoy.');
  }
});

miRouter.post('/marcar', async (req, res) => {
  try {
    res.json(await marcar(req.empleado, req.body?.tipo, req.usuario.id));
  } catch (err) {
    responderError(res, err, 'No se pudo registrar tu marca.');
  }
});

// GET /historial?desde=&hasta=  (por defecto, lo que va del mes)
miRouter.get('/historial', async (req, res) => {
  try {
    const hoy = hoyLima();
    const desde = validar.fecha(req.query.desde, 'desde') ?? `${hoy.slice(0, 8)}01`;
    const hasta = validar.fecha(req.query.hasta, 'hasta') ?? hoy;
    if (hasta < desde) throw new ErrorValidacion('"hasta" no puede ser anterior a "desde".');
    if (diasCalendario(desde, hasta) > 366) throw new ErrorValidacion('El rango no puede pasar de un año.');
    const { rows } = await pool.query(
      `SELECT a.id, a.empleado_id, a.fecha::text AS fecha, a.entrada, a.salida_refrigerio, a.retorno_refrigerio, a.salida, a.origen, a.observacion
       FROM asistencias a WHERE a.empleado_id = $1 AND a.fecha BETWEEN $2 AND $3 ORDER BY a.fecha DESC LIMIT 400`,
      [req.empleado.id, desde, hasta]
    );
    const filas = rows.map(r => conCalculo(r, req.empleado));
    res.json({ desde, hasta, filas, resumen: resumenAsistencia(filas)[0] || null });
  } catch (err) {
    responderError(res, err, 'No se pudo leer tu historial.');
  }
});

miRouter.get('/saldo-vacaciones', async (req, res) => {
  try {
    res.json(await saldoDeVacaciones(pool, req.empleado.id));
  } catch (err) {
    responderError(res, err, 'No se pudo calcular tu saldo de vacaciones.');
  }
});

// Sus propias ausencias. El detalle médico es SUYO: lo puede leer.
miRouter.get('/ausencias', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, tipo, fecha_inicio::text AS fecha_inicio, fecha_fin::text AS fecha_fin, dias, con_goce, estado, motivo,
              comentario_resolucion, creado_el
       FROM ausencias WHERE empleado_id = $1 ORDER BY fecha_inicio DESC, id DESC LIMIT 200`,
      [req.empleado.id]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer tus ausencias.');
  }
});

// Solicitar una ausencia: siempre nace 'pendiente' (la aprueba RRHH), y el
// trabajador solo puede pedirla para SÍ mismo.
miRouter.post('/ausencias', async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const datos = leerAusencia(req.body, { permiteSalud: true });
    const id = await insertarAusencia(empresaId, req.empleado.id, datos, { estado: 'pendiente', usuarioId: req.usuario.id });

    // Si pide más vacaciones de las que le quedan, se le avisa (no se bloquea:
    // el saldo es referencial y RRHH decide al aprobar).
    let aviso = null;
    if (datos.tipo === 'vacaciones') {
      const saldo = await saldoDeVacaciones(pool, req.empleado.id);
      if (saldo && saldo.saldo - saldo.dias_pendientes_aprobacion < 0) {
        aviso = `Pediste más días de los que tienes ganados hoy (saldo estimado: ${saldo.saldo} día(s)). RRHH decidirá al revisarla.`;
      }
    }
    res.status(201).json({ id, estado: 'pendiente', aviso });
    avisarSolicitud(empresaId, { ausenciaId: id, empleadoNombre: req.empleado.nombre, datos, solicitanteId: req.usuario.id });
  } catch (err) {
    responderError(res, err, 'No se pudo registrar tu solicitud.');
  }
});

// Cancelar su propia solicitud mientras siga pendiente.
miRouter.delete('/ausencias/:id', async (req, res) => {
  try {
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Solicitud no encontrada.', 404);
    const { rowCount } = await pool.query(
      `UPDATE ausencias SET estado = 'cancelada', actualizado_el = now()
       WHERE id = $1 AND empleado_id = $2 AND estado = 'pendiente'`,
      [id, req.empleado.id]
    );
    if (!rowCount) throw new ErrorValidacion('No se encontró una solicitud pendiente tuya con ese número.', 404);
    res.status(204).end();
  } catch (err) {
    responderError(res, err, 'No se pudo cancelar la solicitud.');
  }
});
