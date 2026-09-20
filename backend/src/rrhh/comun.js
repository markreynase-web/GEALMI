// src/rrhh/comun.js
// Piezas compartidas por las rutas de RRHH (asistencia, ausencias,
// remuneraciones, documentos, desempeño, reclutamiento): validaciones que
// responden un 400 claro en vez de dejar que la base lo rebote como 500,
// el chequeo de que un empleado pertenece a la empresa, y el SQL del estado
// efectivo de la ficha.
//
// Por qué existe validarEmpleadoDeEmpresa(): crearRouterCRUD no comprueba que
// un `empleado_id` que llega en el body sea de la empresa del token, y en RRHH
// esa es la puerta de entrada a datos de OTRA empresa (asistencia, sueldos,
// exámenes médicos). Toda ruta nueva que reciba un empleado_id pasa por acá.

import { ErrorValidacion, tienePermiso, idPositivo } from '../validacion.js';

// Re-exportadas: todo el código de RRHH sigue importándolas desde acá.
export { ErrorValidacion, responderError, hoyLima, tienePermiso, idPositivo, esFechaISO, validar } from '../validacion.js';

export const puedeVerSueldos = (req) => tienePermiso(req, 'rrhh.remuneraciones');
export const puedeVerSalud = (req) => tienePermiso(req, 'rrhh.salud');

// El empleado tiene que ser de ESTA empresa. Devuelve la fila o lanza 404: se
// responde 404 (no 403) para no confirmar que ese id existe en otra empresa.
export async function validarEmpleadoDeEmpresa(db, empresaId, empleadoId, columnas = 'id, nombre') {
  const id = idPositivo(empleadoId);
  if (!id) throw new ErrorValidacion('empleado_id es requerido.');
  const { rows } = await db.query(`SELECT ${columnas} FROM empleados WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
  if (!rows.length) throw new ErrorValidacion('Empleado no encontrado.', 404);
  return rows[0];
}

// El trabajador que corresponde a este usuario (para "Mi asistencia").
export async function empleadoDelUsuario(db, empresaId, usuarioId) {
  const { rows } = await db.query(
    `SELECT id, nombre, puesto, fecha_contratacion::text AS fecha_contratacion, fecha_cese::text AS fecha_cese, regimen_laboral,
            jornada_horas_dia::float8 AS jornada_horas_dia, to_char(hora_entrada, 'HH24:MI') AS hora_entrada,
            to_char(hora_salida, 'HH24:MI') AS hora_salida, refrigerio_minutos
     FROM empleados WHERE empresa_id = $1 AND usuario_id = $2`,
    [empresaId, usuarioId]
  );
  return rows[0] || null;
}

// Columnas de la ficha tal como salen a la API. Las fechas y horas van como
// texto (AAAA-MM-DD / HH:MM) para no depender de cómo el driver serializa un
// Date. El sueldo solo se LEE de la base si quien pregunta puede verlo
// (rrhh.remuneraciones): para el resto sale null y ni siquiera viaja.
export const columnasFicha = (conSueldo) => `${conSueldo ? 'e.salario' : 'NULL::numeric AS salario'},` + COLUMNAS_FICHA;
const COLUMNAS_FICHA = `
  e.id, e.nombre, e.puesto, e.departamento, e.email, e.telefono, e.estado, e.notas,
  e.fecha_contratacion::text AS fecha_contratacion, e.dni, e.fecha_nacimiento::text AS fecha_nacimiento,
  e.direccion, e.regimen_laboral, e.tipo_contrato, e.fecha_fin_contrato::text AS fecha_fin_contrato,
  e.fecha_cese::text AS fecha_cese, e.jornada_horas_dia::float8 AS jornada_horas_dia,
  to_char(e.hora_entrada, 'HH24:MI') AS hora_entrada, to_char(e.hora_salida, 'HH24:MI') AS hora_salida,
  e.refrigerio_minutos, e.dias_laborables, e.usuario_id, e.contacto_emergencia_nombre, e.contacto_emergencia_telefono,
  e.creado_el, e.actualizado_el`;

// Estado que se MUESTRA: lo que dice la ficha, salvo que hoy (en Lima) el
// trabajador ya esté cesado o tenga una ausencia aprobada vigente. Así no hay
// que acordarse de cambiar "estado" a mano cuando alguien sale de vacaciones.
export const SQL_ESTADO_EFECTIVO = `
  CASE
    WHEN e.fecha_cese IS NOT NULL AND e.fecha_cese <= (now() AT TIME ZONE 'America/Lima')::date THEN 'cesado'
    WHEN EXISTS (
      SELECT 1 FROM ausencias a
      WHERE a.empleado_id = e.id AND a.estado = 'aprobada' AND a.tipo = 'vacaciones'
        AND (now() AT TIME ZONE 'America/Lima')::date BETWEEN a.fecha_inicio AND a.fecha_fin
    ) THEN 'vacaciones'
    WHEN EXISTS (
      SELECT 1 FROM ausencias a
      WHERE a.empleado_id = e.id AND a.estado = 'aprobada' AND a.tipo <> 'vacaciones'
        AND (now() AT TIME ZONE 'America/Lima')::date BETWEEN a.fecha_inicio AND a.fecha_fin
    ) THEN 'licencia'
    ELSE e.estado
  END`;
