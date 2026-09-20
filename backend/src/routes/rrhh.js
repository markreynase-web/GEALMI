// src/routes/rrhh.js
// RRHH. La ficha de empleado es el núcleo (este archivo); alrededor cuelgan,
// cada uno en su archivo de src/rrhh/, asistencia (R2), ausencias y
// vacaciones (R3), remuneraciones (R4), legajo de documentos (R5), evaluaciones
// y capacitaciones (R6) y reclutamiento (R7). "Mi asistencia" (/mi) es lo que
// cada trabajador hace con SU ficha, sin ser de RRHH.
//
// Reglas que valen para todo el módulo:
//  * Todo id de empleado que llega en un body pasa por validarEmpleadoDeEmpresa:
//    crearRouterCRUD no comprueba que sea de la empresa del token.
//  * El sueldo solo viaja con rrhh.remuneraciones; los datos de salud, con
//    rrhh.salud (ver 046_rrhh_ficha.sql).
//  * Lo que estima dinero o días (vacaciones, gratificación, CTS) es
//    REFERENCIAL: no fue validado por un contador ni un abogado laboral
//    (ver el aviso en src/rrhh/calculos.js).

import { Router } from 'express';
import { pool } from '../db.js';
import { auth, requireEmpresa, requireModulo } from '../middleware/auth.js';
import { verificarPermiso } from '../middleware/permisos.js';
import { crearRouterCRUD } from '../crudFactory.js';
import { registrarAuditoria } from '../registroAuditoria.js';
import { esDocumentoIdentidadValido, esRucValido, REGIMENES } from '../rrhh/calculos.js';
import {
  ErrorValidacion, responderError, validar, idPositivo, hoyLima, puedeVerSueldos, puedeVerSalud,
  columnasFicha, SQL_ESTADO_EFECTIVO
} from '../rrhh/comun.js';
import { miRouter } from '../rrhh/mi.js';
import { asistenciaRouter } from '../rrhh/asistencia.js';
import { ausenciasRouter, saldoDeVacaciones } from '../rrhh/ausencias.js';
import { remuneracionesRouter } from '../rrhh/remuneraciones.js';
import { documentosRouter } from '../rrhh/documentos.js';
import { evaluacionesRouter, capacitacionesRouter } from '../rrhh/desempeno.js';
import { vacantesRouter, candidatosRouter } from '../rrhh/reclutamiento.js';

const router = Router();
router.use(auth, requireEmpresa, requireModulo('rrhh'));

// Los sub-routers van ANTES de las rutas genéricas de la ficha (/:id).
router.use('/mi', miRouter);
router.use('/asistencia', asistenciaRouter);
router.use('/ausencias', ausenciasRouter);
router.use('/remuneraciones', remuneracionesRouter);
router.use('/documentos', documentosRouter);
router.use('/evaluaciones', evaluacionesRouter);
router.use('/capacitaciones', capacitacionesRouter);
router.use('/vacantes', vacantesRouter);
router.use('/candidatos', candidatosRouter);

const ESTADOS_VALIDOS = ['activo', 'inactivo', 'vacaciones', 'licencia'];

// ---------------------------------------------------------------------------
// Datos del empleador (van impresos en el registro de asistencia)
// ---------------------------------------------------------------------------

router.get('/empleador', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT nombre, razon_social, ruc, domicilio_fiscal FROM empresas WHERE id = $1`, [req.usuario.empresa_id]);
    res.json(rows[0] || {});
  } catch (err) {
    responderError(res, err, 'No se pudieron leer los datos del empleador.');
  }
});

router.put('/empleador', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const razon_social = validar.texto(req.body.razon_social, 'La razón social', { max: 200 });
    const domicilio_fiscal = validar.texto(req.body.domicilio_fiscal, 'El domicilio fiscal', { max: 250 });
    const ruc = validar.texto(req.body.ruc, 'El RUC', { max: 11 });
    if (ruc && !esRucValido(ruc)) throw new ErrorValidacion('El RUC no es válido: son 11 dígitos y el último es un dígito verificador.');
    const { rows } = await pool.query(
      `UPDATE empresas SET razon_social = $1, ruc = $2, domicilio_fiscal = $3, actualizado_el = now() WHERE id = $4
       RETURNING nombre, razon_social, ruc, domicilio_fiscal`,
      [razon_social, ruc, domicilio_fiscal, req.usuario.empresa_id]
    );
    res.json(rows[0]);
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: 'empleador', detalle: { razon_social, ruc, domicilio_fiscal } });
  } catch (err) {
    responderError(res, err, 'No se pudieron guardar los datos del empleador.');
  }
});

// Usuarios de la empresa que aún no son la ficha de nadie (para vincularlos).
// ?incluir_de=<id> agrega también al usuario ya vinculado a ESA ficha.
router.get('/usuarios-disponibles', verificarPermiso('rrhh.editar'), async (req, res) => {
  try {
    const incluirDe = req.query.incluir_de ? idPositivo(req.query.incluir_de) : null;
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, u.email
       FROM usuario_empresa ue JOIN usuarios u ON u.id = ue.usuario_id
       WHERE ue.empresa_id = $1 AND ue.activo = true AND u.activo = true
         AND NOT EXISTS (SELECT 1 FROM empleados e WHERE e.empresa_id = $1 AND e.usuario_id = u.id AND ($2::int IS NULL OR e.id <> $2))
       ORDER BY u.nombre`,
      [req.usuario.empresa_id, incluirDe]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer los usuarios.');
  }
});

router.get('/saldo-vacaciones/:empleadoId', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const id = idPositivo(req.params.empleadoId);
    const { rows } = id ? await pool.query(`SELECT id FROM empleados WHERE id = $1 AND empresa_id = $2`, [id, req.usuario.empresa_id]) : { rows: [] };
    if (!rows.length) throw new ErrorValidacion('Empleado no encontrado.', 404);
    res.json(await saldoDeVacaciones(pool, id));
  } catch (err) {
    responderError(res, err, 'No se pudo calcular el saldo de vacaciones.');
  }
});

// Panel de RRHH: lo que hay que mirar hoy.
router.get('/resumen', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    // Consultas en serie (no Promise.all): el pool es de 10 conexiones y esto se llama al abrir la página.
    const { rows: conteo } = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE efectivo = 'activo')::int AS activos,
              count(*) FILTER (WHERE efectivo = 'cesado')::int AS cesados
       FROM (SELECT ${SQL_ESTADO_EFECTIVO} AS efectivo FROM empleados e WHERE e.empresa_id = $1) t`,
      [empresaId]
    );
    const { rows: contratos } = await pool.query(
      `SELECT e.id, e.nombre, e.fecha_fin_contrato::text AS fecha_fin_contrato,
              (e.fecha_fin_contrato - (now() AT TIME ZONE 'America/Lima')::date) AS dias_restantes
       FROM empleados e
       WHERE e.empresa_id = $1 AND e.fecha_fin_contrato IS NOT NULL AND (e.fecha_cese IS NULL OR e.fecha_cese > (now() AT TIME ZONE 'America/Lima')::date)
         AND e.fecha_fin_contrato <= (now() AT TIME ZONE 'America/Lima')::date + 30
       ORDER BY e.fecha_fin_contrato LIMIT 50`,
      [empresaId]
    );
    const { rows: pendientes } = await pool.query(`SELECT count(*)::int AS n FROM ausencias WHERE empresa_id = $1 AND estado = 'pendiente'`, [empresaId]);
    const { rows: ausentes } = await pool.query(
      `SELECT e.nombre, a.tipo, a.fecha_fin::text AS hasta
       FROM ausencias a JOIN empleados e ON e.id = a.empleado_id
       WHERE a.empresa_id = $1 AND a.estado = 'aprobada' AND (now() AT TIME ZONE 'America/Lima')::date BETWEEN a.fecha_inicio AND a.fecha_fin
       ORDER BY e.nombre LIMIT 50`,
      [empresaId]
    );
    // El examen médico es dato de salud: solo cuenta para quien puede verlo.
    const { rows: docs } = await pool.query(
      `SELECT count(*) FILTER (WHERE fecha_vencimiento < (now() AT TIME ZONE 'America/Lima')::date)::int AS vencidos,
              count(*) FILTER (WHERE fecha_vencimiento >= (now() AT TIME ZONE 'America/Lima')::date)::int AS por_vencer
       FROM documentos_empleado
       WHERE empresa_id = $1 AND fecha_vencimiento IS NOT NULL AND fecha_vencimiento <= (now() AT TIME ZONE 'America/Lima')::date + 30
         AND ($2::boolean OR tipo <> 'examen_medico')`,
      [empresaId, puedeVerSalud(req)]
    );
    const { rows: cumples } = await pool.query(
      `SELECT e.nombre, extract(day FROM e.fecha_nacimiento)::int AS dia
       FROM empleados e
       WHERE e.empresa_id = $1 AND e.fecha_nacimiento IS NOT NULL AND (e.fecha_cese IS NULL OR e.fecha_cese > (now() AT TIME ZONE 'America/Lima')::date)
         AND extract(month FROM e.fecha_nacimiento) = extract(month FROM (now() AT TIME ZONE 'America/Lima')::date)
       ORDER BY dia, e.nombre LIMIT 50`,
      [empresaId]
    );
    res.json({
      empleados: conteo[0], contratos_por_vencer: contratos, ausencias_pendientes: pendientes[0].n,
      ausentes_hoy: ausentes, documentos: docs[0], cumpleanos_mes: cumples
    });
  } catch (err) {
    responderError(res, err, 'No se pudo armar el resumen de RRHH.');
  }
});

// ---------------------------------------------------------------------------
// Ficha de empleado
// ---------------------------------------------------------------------------

function leerDias(v) {
  if (v === undefined || v === null || v === '') return [1, 2, 3, 4, 5, 6];
  const lista = Array.isArray(v) ? v : String(v).split(',');
  const dias = [...new Set(lista.map(Number))];
  if (!dias.length || dias.some(d => !Number.isInteger(d) || d < 1 || d > 7)) {
    throw new ErrorValidacion('Los días laborables deben ser números del 1 (lunes) al 7 (domingo).');
  }
  return dias.sort((a, b) => a - b);
}

// Cada campo de la ficha con su validación. `usuario_id` y `salario` van aparte
// (necesitan la base de datos o un permiso).
const CAMPOS = {
  fecha_contratacion: (v) => validar.fecha(v, 'La fecha de contratación', { requerido: true }),
  nombre: (v) => validar.texto(v, 'El nombre', { max: 200, requerido: true }),
  puesto: (v) => validar.texto(v, 'El puesto', { max: 150 }),
  departamento: (v) => validar.texto(v, 'El departamento', { max: 100 }),
  email: (v) => validar.texto(v, 'El correo', { max: 200 }),
  telefono: (v) => validar.texto(v, 'El teléfono', { max: 60 }),
  estado: (v) => validar.enumerado(v, 'estado', ESTADOS_VALIDOS, { porDefecto: 'activo' }),
  notas: (v) => validar.texto(v, 'Las notas', { max: 2000 }),
  dni: (v) => {
    const s = validar.texto(v, 'El documento de identidad', { max: 12 });
    if (s && !esDocumentoIdentidadValido(s)) throw new ErrorValidacion('El documento de identidad debe tener entre 8 y 12 letras o números.');
    return s ? s.toUpperCase() : null;
  },
  fecha_nacimiento: (v) => {
    const f = validar.fecha(v, 'La fecha de nacimiento');
    if (f && (f > hoyLima() || f < '1900-01-01')) throw new ErrorValidacion('La fecha de nacimiento no es válida.');
    return f;
  },
  direccion: (v) => validar.texto(v, 'La dirección', { max: 250 }),
  regimen_laboral: (v) => validar.enumerado(v, 'regimen_laboral', REGIMENES, { porDefecto: 'general' }),
  tipo_contrato: (v) => validar.texto(v, 'El tipo de contrato', { max: 40 }),
  fecha_fin_contrato: (v) => validar.fecha(v, 'El fin de contrato'),
  fecha_cese: (v) => validar.fecha(v, 'La fecha de cese'),
  jornada_horas_dia: (v) => validar.numero(v, 'Las horas de jornada', { min: 0.5, max: 12, porDefecto: 8 }),
  hora_entrada: (v) => validar.hora(v, 'La hora de entrada'),
  hora_salida: (v) => validar.hora(v, 'La hora de salida'),
  refrigerio_minutos: (v) => validar.entero(v, 'El refrigerio', { min: 0, max: 240, porDefecto: 60 }),
  dias_laborables: leerDias,
  contacto_emergencia_nombre: (v) => validar.texto(v, 'El contacto de emergencia', { max: 150 }),
  contacto_emergencia_telefono: (v) => validar.texto(v, 'El teléfono de emergencia', { max: 60 })
};

// POST: todos los campos (los que no vinieron toman su valor por defecto).
// PUT: solo los que vinieron -- una columna ausente del body no se toca.
function leerFicha(body, { esEdicion }) {
  const datos = {};
  for (const [campo, leer] of Object.entries(CAMPOS)) {
    if (esEdicion && body[campo] === undefined) continue;
    datos[campo] = leer(body[campo]);
  }
  return datos;
}

// Reglas entre campos, ya con los valores finales (los nuevos o, si no vinieron, los actuales).
function validarFechasFicha(f) {
  if (f.fecha_fin_contrato && f.fecha_contratacion && f.fecha_fin_contrato < f.fecha_contratacion) {
    throw new ErrorValidacion('El fin de contrato no puede ser anterior a la fecha de contratación.');
  }
  if (f.fecha_cese && f.fecha_contratacion && f.fecha_cese < f.fecha_contratacion) {
    throw new ErrorValidacion('La fecha de cese no puede ser anterior a la fecha de contratación.');
  }
}

// El usuario que se vincula debe ser miembro ACTIVO de esta empresa y no estar
// ya vinculado a otra ficha.
async function validarUsuarioVinculable(db, empresaId, valor, empleadoId) {
  if (valor === undefined || valor === null || valor === '') return null;
  const usuarioId = idPositivo(valor);
  if (!usuarioId) throw new ErrorValidacion('usuario_id no es válido.');
  const { rows } = await db.query(`SELECT 1 FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2 AND activo = true`, [usuarioId, empresaId]);
  if (!rows.length) throw new ErrorValidacion('Ese usuario no pertenece a tu empresa.');
  const { rows: ya } = await db.query(
    `SELECT 1 FROM empleados WHERE empresa_id = $1 AND usuario_id = $2 AND ($3::int IS NULL OR id <> $3)`,
    [empresaId, usuarioId, empleadoId]
  );
  if (ya.length) throw new ErrorValidacion('Ese usuario ya está vinculado a otro trabajador.', 409);
  return usuarioId;
}

async function leerFichaCompleta(db, empresaId, id, conSueldo) {
  const { rows } = await db.query(
    `SELECT ${columnasFicha(conSueldo)}, ${SQL_ESTADO_EFECTIVO} AS estado_efectivo, u.email AS usuario_email
     FROM empleados e LEFT JOIN usuarios u ON u.id = e.usuario_id
     WHERE e.id = $1 AND e.empresa_id = $2`,
    [id, empresaId]
  );
  return rows[0] || null;
}

const mensajeDuplicado = (err) => {
  if (err?.code !== '23505') return null;
  return /dni/.test(err.constraint || '') ? 'Ya hay un trabajador con ese documento de identidad.' : 'Ese usuario ya está vinculado a otro trabajador.';
};

router.get('/', verificarPermiso('rrhh.ver'), async (req, res) => {
  try {
    const desde = validar.fecha(req.query.desde, 'desde');
    const hasta = validar.fecha(req.query.hasta, 'hasta');
    const buscar = typeof req.query.buscar === 'string' ? req.query.buscar.trim() : '';
    const { rows } = await pool.query(
      `SELECT ${columnasFicha(puedeVerSueldos(req))}, ${SQL_ESTADO_EFECTIVO} AS estado_efectivo, u.email AS usuario_email
       FROM empleados e LEFT JOIN usuarios u ON u.id = e.usuario_id
       WHERE e.empresa_id = $1 AND ($2::date IS NULL OR e.fecha_contratacion >= $2) AND ($3::date IS NULL OR e.fecha_contratacion <= $3)
         AND ($4 = '' OR unaccent(e.nombre) ILIKE unaccent($5) OR e.dni ILIKE $5 OR unaccent(coalesce(e.puesto, '')) ILIKE unaccent($5))
       ORDER BY e.fecha_contratacion DESC, e.id DESC LIMIT 5000`,
      [req.usuario.empresa_id, desde, hasta, buscar, `%${buscar}%`]
    );
    res.json(rows);
  } catch (err) {
    responderError(res, err, 'No se pudieron leer los empleados.');
  }
});

router.post('/', verificarPermiso('rrhh.crear'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const datos = leerFicha(req.body, { esEdicion: false });
    validarFechasFicha(datos);
    datos.usuario_id = await validarUsuarioVinculable(cliente, empresaId, req.body.usuario_id, null);

    const salario = validar.numero(req.body.salario, 'El salario', { min: 0, max: 99999999, porDefecto: 0 });
    if (salario > 0 && !puedeVerSueldos(req)) throw new ErrorValidacion('Fijar un sueldo requiere el permiso rrhh.remuneraciones.', 403);
    datos.salario = salario;

    const columnas = Object.keys(datos);
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `INSERT INTO empleados (${columnas.join(', ')}, empresa_id) VALUES (${columnas.map((_, i) => `$${i + 1}`).join(', ')}, $${columnas.length + 1}) RETURNING id`,
      [...columnas.map(c => datos[c]), empresaId]
    );
    const id = rows[0].id;
    if (salario > 0) {
      await cliente.query(
        `INSERT INTO historial_salarial (empresa_id, empleado_id, sueldo_anterior, sueldo_nuevo, vigente_desde, motivo, registrado_por)
         VALUES ($1,$2,NULL,$3,$4,'Contratación',$5)`,
        [empresaId, id, salario, datos.fecha_contratacion, req.usuario.id]
      );
    }
    await cliente.query('COMMIT');
    res.status(201).json(await leerFichaCompleta(pool, empresaId, id, puedeVerSueldos(req)));
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'crear', modulo: 'rrhh', registroId: id, detalle: datos });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    const dup = mensajeDuplicado(err);
    if (dup) return res.status(409).json({ error: dup });
    responderError(res, err, 'No se pudo registrar el empleado.');
  } finally {
    cliente.release();
  }
});

router.put('/:id', verificarPermiso('rrhh.editar'), async (req, res) => {
  const cliente = await pool.connect();
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Empleado no encontrado.', 404);

    await cliente.query('BEGIN');
    const { rows: antesRows } = await cliente.query(
      `SELECT e.*, e.fecha_contratacion::text AS fc, e.fecha_fin_contrato::text AS ffc, e.fecha_cese::text AS fce
       FROM empleados e WHERE e.id = $1 AND e.empresa_id = $2 FOR UPDATE`,
      [id, empresaId]
    );
    if (!antesRows.length) throw new ErrorValidacion('Empleado no encontrado.', 404);
    const antes = antesRows[0];

    const datos = leerFicha(req.body, { esEdicion: true });
    validarFechasFicha({
      fecha_contratacion: datos.fecha_contratacion ?? antes.fc,
      fecha_fin_contrato: 'fecha_fin_contrato' in datos ? datos.fecha_fin_contrato : antes.ffc,
      fecha_cese: 'fecha_cese' in datos ? datos.fecha_cese : antes.fce
    });
    if (req.body.usuario_id !== undefined) datos.usuario_id = await validarUsuarioVinculable(cliente, empresaId, req.body.usuario_id, id);

    // Sueldo: '', null o sin enviar = no se toca. Solo cambia con rrhh.remuneraciones (y deja historial).
    let nuevoSueldo = null;
    if (req.body.salario !== undefined && req.body.salario !== null && req.body.salario !== '') {
      const s = validar.numero(req.body.salario, 'El salario', { min: 0, max: 99999999 });
      if (s !== Number(antes.salario)) {
        if (!puedeVerSueldos(req)) throw new ErrorValidacion('Cambiar el sueldo requiere el permiso rrhh.remuneraciones.', 403);
        nuevoSueldo = s;
        datos.salario = s;
      }
    }
    if (!Object.keys(datos).length) throw new ErrorValidacion('No se envió ningún campo para actualizar.');

    const columnas = Object.keys(datos);
    await cliente.query(
      `UPDATE empleados SET ${columnas.map((c, i) => `${c} = $${i + 1}`).join(', ')}, actualizado_el = now()
       WHERE id = $${columnas.length + 1} AND empresa_id = $${columnas.length + 2}`,
      [...columnas.map(c => datos[c]), id, empresaId]
    );
    if (nuevoSueldo !== null) {
      const motivo = validar.texto(req.body.motivo_salario, 'El motivo del cambio de sueldo', { max: 200 }) || 'Actualización de la ficha';
      await cliente.query(
        `INSERT INTO historial_salarial (empresa_id, empleado_id, sueldo_anterior, sueldo_nuevo, vigente_desde, motivo, registrado_por)
         VALUES ($1,$2,$3,$4,(now() AT TIME ZONE 'America/Lima')::date,$5,$6)`,
        [empresaId, id, antes.salario, nuevoSueldo, motivo, req.usuario.id]
      );
    }
    await cliente.query('COMMIT');

    res.json(await leerFichaCompleta(pool, empresaId, id, puedeVerSueldos(req)));
    const cambios = {};
    for (const c of Object.keys(datos)) {
      const previo = c === 'fecha_contratacion' ? antes.fc : c === 'fecha_fin_contrato' ? antes.ffc : c === 'fecha_cese' ? antes.fce : antes[c];
      if (String(previo ?? '') !== String(datos[c] ?? '')) cambios[c] = { antes: previo, despues: datos[c] };
    }
    registrarAuditoria(pool, {
      usuario: req.usuario, accion: 'editar', modulo: 'rrhh', registroId: id,
      detalle: Object.keys(cambios).length ? cambios : 'Sin cambios en los valores (se guardó igual).'
    });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    const dup = mensajeDuplicado(err);
    if (dup) return res.status(409).json({ error: dup });
    responderError(res, err, 'No se pudo actualizar el empleado.');
  } finally {
    cliente.release();
  }
});

// Un trabajador con historial (asistencia, ausencias, pagos, legajo, evaluaciones...) NO se
// borra: ese historial es un registro laboral que debe conservarse. Se le pone fecha de cese.
router.delete('/:id', verificarPermiso('rrhh.eliminar'), async (req, res) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const id = idPositivo(req.params.id);
    if (!id) throw new ErrorValidacion('Empleado no encontrado.', 404);
    const { rows: fichas } = await pool.query(`SELECT * FROM empleados WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
    if (!fichas.length) throw new ErrorValidacion('Empleado no encontrado.', 404);

    const { rows: uso } = await pool.query(
      `SELECT (SELECT count(*) FROM asistencias WHERE empleado_id = $1)::int AS asistencia,
              (SELECT count(*) FROM ausencias WHERE empleado_id = $1)::int AS ausencias,
              (SELECT count(*) FROM remuneraciones WHERE empleado_id = $1)::int AS remuneraciones,
              (SELECT count(*) FROM documentos_empleado WHERE empleado_id = $1)::int AS documentos,
              (SELECT count(*) FROM evaluaciones WHERE empleado_id = $1)::int AS evaluaciones,
              (SELECT count(*) FROM capacitacion_participantes WHERE empleado_id = $1)::int AS capacitaciones`,
      [id]
    );
    const conHistorial = Object.entries(uso[0]).filter(([, n]) => n > 0).map(([tipo, n]) => `${n} de ${tipo}`);
    if (conHistorial.length) {
      throw new ErrorValidacion(`No se puede eliminar: tiene registros (${conHistorial.join(', ')}). Ponle una fecha de cese en su ficha para conservar el historial.`, 409);
    }
    await pool.query(`DELETE FROM empleados WHERE id = $1 AND empresa_id = $2`, [id, empresaId]);
    res.status(204).end();
    registrarAuditoria(pool, { usuario: req.usuario, accion: 'eliminar', modulo: 'rrhh', registroId: id, detalle: { eliminado: { ...fichas[0], salario: undefined } } });
  } catch (err) {
    responderError(res, err, 'No se pudo eliminar el empleado.');
  }
});

// La importación por CSV trae la columna de sueldo: la misma regla que en POST/PUT.
router.post('/import', (req, res, next) => (
  puedeVerSueldos(req) ? next() : res.status(403).json({ error: 'Importar empleados incluye sueldos: requiere el permiso rrhh.remuneraciones.' })
));

// Solo se usa para /import (el resto de las rutas de la ficha están arriba).
router.use(crearRouterCRUD({
  tabla: 'empleados',
  modulo: 'rrhh',
  columnas: ['fecha_contratacion', 'nombre', 'puesto', 'departamento', 'salario', 'email', 'telefono', 'estado', 'notas'],
  camposRequeridos: ['fecha_contratacion', 'nombre'],
  camposNumericos: ['salario'],
  columnaFecha: 'fecha_contratacion',
  valoresPorDefecto: { salario: 0, estado: 'activo' }
}));

export default router;
