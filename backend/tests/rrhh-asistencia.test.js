// tests/rrhh-asistencia.test.js
// Paso 8 (RRHH), fase R2 -- registro de asistencia contra un servidor real:
// la marcación del propio trabajador (con la hora del servidor, en orden, sin
// doble marca), la carga y corrección manual por RRHH (con motivo y rastro en
// Auditoría), y el reporte con horas, sobretiempo, tardanza y el aviso de
// semanas sobre 48 horas.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
let A, B;

before(async () => {
  servidor = await iniciarServidorTest();
  A = await montarEmpresa('A', ['admin', 'gerente', 'supervisor', 'ventas1', 'ventas2', 'ventas3']);
  B = await montarEmpresa('B', ['admin']);
});
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function api(metodo, ruta, { token, body } = {}) {
  const r = await fetch(`${servidor.baseUrl}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || metodo === 'GET' ? undefined : JSON.stringify(body)
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}

const ROLES = { admin: 'administrador', gerente: 'gerente', supervisor: 'supervisor', ventas1: 'ventas', ventas2: 'ventas', ventas3: 'ventas' };
async function montarEmpresa(sufijo, quienes) {
  const empresaId = await crearEmpresa(ctx, `asistencia-${sufijo}`, ['rrhh']);
  const e = { empresaId };
  for (const quien of quienes) {
    const cuenta = await crearUsuario(ctx, { empresaId, rolNombre: ROLES[quien] });
    e[quien] = { ...cuenta, token: await login(servidor.baseUrl, cuenta.email, cuenta.password) };
  }
  return e;
}

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sumar = (fecha, dias) => { const d = new Date(`${fecha}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };

let contador = 0;
async function nuevoEmpleado(E, extra = {}) {
  const r = await api('POST', '/api/rrhh', {
    token: E.admin.token,
    body: { nombre: `Asistente QA ${++contador}`, fecha_contratacion: '2024-01-01', salario: 1500, hora_entrada: '08:00', jornada_horas_dia: 8, ...extra }
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo;
}
const marcar = (persona, tipo, extra = {}) => api('POST', '/api/rrhh/mi/marcar', { token: persona.token, body: { tipo, ...extra } });
const hoyDe = (persona) => api('GET', '/api/rrhh/mi/hoy', { token: persona.token });
const reporte = (persona, consulta = '') => api('GET', `/api/rrhh/asistencia${consulta}`, { token: persona.token });

// ---------------------------------------------------------------------------
// Marcación del propio trabajador
// ---------------------------------------------------------------------------

test('el ciclo completo del día: entrada, refrigerio, regreso y salida, en ese orden', async () => {
  const f = await nuevoEmpleado(A, { usuario_id: A.ventas1.usuarioId });

  const inicio = await hoyDe(A.ventas1);
  assert.equal(inicio.status, 200);
  assert.equal(inicio.cuerpo.empleado.id, f.id);
  assert.equal(inicio.cuerpo.fecha, hoy());
  assert.equal(inicio.cuerpo.registro, null);
  assert.deepEqual(inicio.cuerpo.acciones, ['entrada']);

  const entra = await marcar(A.ventas1, 'entrada');
  assert.equal(entra.status, 200, JSON.stringify(entra.cuerpo));
  assert.ok(entra.cuerpo.registro.entrada);
  assert.equal(entra.cuerpo.registro.origen, 'marcacion');
  assert.deepEqual(entra.cuerpo.acciones, ['salida_refrigerio', 'salida']);

  const sale = await marcar(A.ventas1, 'salida_refrigerio');
  assert.deepEqual(sale.cuerpo.acciones, ['retorno_refrigerio']);
  const antesDeVolver = await marcar(A.ventas1, 'salida');
  assert.equal(antesDeVolver.status, 409, 'no se puede irse en medio del refrigerio');
  assert.match(antesDeVolver.cuerpo.error, /refrigerio/i);

  const vuelve = await marcar(A.ventas1, 'retorno_refrigerio');
  assert.deepEqual(vuelve.cuerpo.acciones, ['salida']);
  const termina = await marcar(A.ventas1, 'salida');
  assert.equal(termina.status, 200);
  assert.deepEqual(termina.cuerpo.acciones, []);
  assert.equal(termina.cuerpo.registro.completo, true);
  assert.equal(termina.cuerpo.registro.refrigerio_marcado, true);
  assert.equal(termina.cuerpo.registro.minutos_tardanza >= 0, true);

  const otraVez = await marcar(A.ventas1, 'entrada');
  assert.equal(otraVez.status, 409);
  assert.match(otraVez.cuerpo.error, /completaste/i);

  const { rows } = await pool.query('SELECT fecha::text AS fecha, origen FROM asistencias WHERE empleado_id = $1', [f.id]);
  assert.equal(rows.length, 1, 'una sola fila por día');
  assert.equal(rows[0].fecha, hoy());
  await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('la hora la pone el servidor: lo que mande el cliente se ignora', async () => {
  const f = await nuevoEmpleado(A, { usuario_id: A.ventas2.usuarioId });
  const antes = Date.now();
  const r = await marcar(A.ventas2, 'entrada', { entrada: '2020-01-01T00:00:00Z', fecha: '2020-01-01', empleado_id: 999999 });
  assert.equal(r.status, 200);
  const marca = new Date(r.cuerpo.registro.entrada).getTime();
  assert.ok(marca >= antes - 2000 && marca <= Date.now() + 2000, 'la entrada es la hora real, no la que se mandó');
  assert.equal(r.cuerpo.registro.fecha, hoy());
  assert.equal(r.cuerpo.registro.empleado_id, f.id, 'y a nombre de SU ficha, no de la que se mandó');
  await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('marcas fuera de orden o repetidas se rechazan con 409', async () => {
  const f = await nuevoEmpleado(A, { usuario_id: A.ventas3.usuarioId });
  assert.equal((await marcar(A.ventas3, 'entrada', {})).status, 200);
  const dup = await marcar(A.ventas3, 'entrada');
  assert.equal(dup.status, 409);
  assert.match(dup.cuerpo.error, /ya marcaste tu entrada/i);
  const regresoSinSalida = await marcar(A.ventas3, 'retorno_refrigerio');
  assert.equal(regresoSinSalida.status, 409);
  assert.match(regresoSinSalida.cuerpo.error, /salida a refrigerio/i);
  assert.equal((await marcar(A.ventas3, 'salida_refrigerio')).status, 200);
  assert.equal((await marcar(A.ventas3, 'salida_refrigerio')).status, 409, 'el refrigerio se sale una sola vez');
  const raro = await marcar(A.ventas3, 'almuerzo');
  assert.equal(raro.status, 400);
  assert.equal((await api('POST', '/api/rrhh/mi/marcar', { token: A.ventas3.token, body: {} })).status, 400);
  await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('salida sin haber marcado entrada: 409 con mensaje claro', async () => {
  const E = await montarEmpresa('sin-entrada', ['admin', 'ventas1']);
  await nuevoEmpleado(E, { usuario_id: E.ventas1.usuarioId });
  const r = await marcar(E.ventas1, 'salida');
  assert.equal(r.status, 409);
  assert.match(r.cuerpo.error, /primero marca tu entrada/i);
});

test('dos toques simultáneos en "Entrada": solo uno cuenta', async () => {
  const E = await montarEmpresa('doble', ['admin', 'ventas1']);
  const f = await nuevoEmpleado(E, { usuario_id: E.ventas1.usuarioId });
  const [x, y] = await Promise.all([marcar(E.ventas1, 'entrada'), marcar(E.ventas1, 'entrada')]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM asistencias WHERE empleado_id = $1', [f.id]);
  assert.equal(rows[0].n, 1);
});

test('sin ficha vinculada no se puede marcar; cesado tampoco; con cese futuro sí', async () => {
  const E = await montarEmpresa('cese', ['admin', 'ventas1', 'ventas2']);
  const sin = await marcar(E.ventas1, 'entrada');
  assert.equal(sin.status, 404);
  assert.equal(sin.cuerpo.codigo, 'sin_ficha');

  const cesado = await nuevoEmpleado(E, { usuario_id: E.ventas1.usuarioId, fecha_cese: sumar(hoy(), -1) });
  const r = await marcar(E.ventas1, 'entrada');
  assert.equal(r.status, 403);
  assert.match(r.cuerpo.error, /cesada/i);
  assert.ok(cesado.id);

  await nuevoEmpleado(E, { usuario_id: E.ventas2.usuarioId, fecha_cese: sumar(hoy(), 20) });
  assert.equal((await marcar(E.ventas2, 'entrada')).status, 200, 'aún le quedan días de trabajo');
});

test('una entrada olvidada de hace días no bloquea la de hoy; un turno de noche cierra SU jornada', async () => {
  const E = await montarEmpresa('abierta', ['admin', 'ventas1', 'ventas2']);
  const olvido = await nuevoEmpleado(E, { usuario_id: E.ventas1.usuarioId });
  const noche = await nuevoEmpleado(E, { usuario_id: E.ventas2.usuarioId });

  // Marcó entrada hace 30 horas y nunca la salida: quedó abandonada.
  await pool.query(
    `INSERT INTO asistencias (empresa_id, empleado_id, fecha, entrada) VALUES ($1,$2,$3, now() - interval '30 hours')`,
    [E.empresaId, olvido.id, sumar(hoy(), -2)]
  );
  const nueva = await marcar(E.ventas1, 'entrada');
  assert.equal(nueva.status, 200, 'la jornada abandonada no impide empezar la de hoy');
  assert.equal(nueva.cuerpo.registro.fecha, hoy());

  // Turno de noche: entró ayer (hace 10 horas) y marca su salida hoy.
  const { rows: ins } = await pool.query(
    `INSERT INTO asistencias (empresa_id, empleado_id, fecha, entrada)
     VALUES ($1,$2,(now() AT TIME ZONE 'America/Lima' - interval '10 hours')::date, now() - interval '10 hours') RETURNING id`,
    [E.empresaId, noche.id]
  );
  const sale = await marcar(E.ventas2, 'salida');
  assert.equal(sale.status, 200);
  assert.equal(sale.cuerpo.registro.id, ins[0].id, 'la salida se anota en la jornada que estaba abierta');
  assert.equal(sale.cuerpo.registro.completo, true);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM asistencias WHERE empleado_id = $1', [noche.id]);
  assert.equal(rows[0].n, 1, 'no se creó una fila nueva');
});

// ---------------------------------------------------------------------------
// Carga y corrección por RRHH
// ---------------------------------------------------------------------------

test('carga manual: calcula horas, sobretiempo y tardanza, y deja rastro con el motivo', async () => {
  const f = await nuevoEmpleado(A, { hora_entrada: '08:00', jornada_horas_dia: 8 });
  const fecha = sumar(hoy(), -3);
  const r = await api('POST', '/api/rrhh/asistencia', {
    token: A.admin.token,
    body: { empleado_id: f.id, fecha, entrada: '08:10', salida_refrigerio: '13:00', retorno_refrigerio: '14:00', salida: '19:30', observacion: 'Olvidó marcar; lo confirmó su jefe' }
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));

  const rep = await reporte(A.admin, `?desde=${fecha}&hasta=${fecha}&empleado_id=${f.id}`);
  assert.equal(rep.status, 200);
  assert.equal(rep.cuerpo.filas.length, 1);
  const fila = rep.cuerpo.filas[0];
  assert.equal(fila.origen, 'manual');
  assert.equal(fila.observacion, 'Olvidó marcar; lo confirmó su jefe');
  assert.equal(fila.minutos_trabajados, 620, '08:10 a 19:30 menos 1 h de refrigerio');
  assert.equal(fila.minutos_sobretiempo, 140);
  assert.equal(fila.minutos_tardanza, 10);
  assert.equal(fila.hora_entrada_pactada, '08:00');
  assert.equal(fila.completo, true);
  assert.equal(rep.cuerpo.resumen[0].tardanzas, 1);
  assert.equal(rep.cuerpo.resumen[0].minutos_sobretiempo, 140);

  const { rows } = await pool.query(`SELECT detalle FROM audit_log WHERE empresa_id = $1 AND modulo = 'rrhh' AND registro_id = $2 AND accion = 'crear'`, [A.empresaId, `asistencia:${r.cuerpo.id}`]);
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows[0].detalle), /Olvidó marcar/);
});

test('carga manual: un turno que cruza la medianoche cuenta como una sola jornada', async () => {
  const f = await nuevoEmpleado(A, { hora_entrada: '22:00' });
  const fecha = sumar(hoy(), -5);
  const r = await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: { empleado_id: f.id, fecha, entrada: '22:00', salida: '06:00', observacion: 'Turno de noche' } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const fila = (await reporte(A.admin, `?desde=${fecha}&hasta=${fecha}&empleado_id=${f.id}`)).cuerpo.filas[0];
  assert.equal(fila.minutos_trabajados, 480);
  assert.equal(fila.minutos_sobretiempo, 0);
  assert.equal(fila.refrigerio_marcado, false, 'el reporte señala que no hubo refrigerio marcado');
});

test('carga manual: exige motivo, fecha pasada, marcas en orden y una sola fila por día', async () => {
  const f = await nuevoEmpleado(A);
  const fecha = sumar(hoy(), -10);
  const base = { empleado_id: f.id, fecha, entrada: '08:00', salida: '17:00', observacion: 'Ajuste' };
  const casos = [
    [{ observacion: '' }, 400, /motivo/i],
    [{ observacion: undefined }, 400, /motivo/i],
    [{ fecha: sumar(hoy(), 3) }, 400, /futura/i],
    [{ fecha: '2026-02-31' }, 400, /fecha válida/i],
    [{ entrada: '' }, 400, /entrada/i],
    [{ entrada: '8:00' }, 400, /hora válida/i],
    [{ entrada: '25:00' }, 400, /hora válida/i],
    [{ retorno_refrigerio: '14:00' }, 400, /salida a refrigerio/i],
    [{ entrada: `${fecha}T17:00`, salida: `${fecha}T09:00` }, 400, /anterior/i],
    [{ observacion: 'x'.repeat(300) }, 400, /250 caracteres/]
  ];
  for (const [extra, status, mensaje] of casos) {
    const r = await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: { ...base, ...extra } });
    assert.equal(r.status, status, `${JSON.stringify(extra)} -> ${JSON.stringify(r.cuerpo)}`);
    assert.match(r.cuerpo.error, mensaje);
  }
  assert.equal((await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: base })).status, 201);
  const dup = await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: base });
  assert.equal(dup.status, 409);
  assert.match(dup.cuerpo.error, /edítalo/i);
});

test('corregir y eliminar: con motivo, con rastro del antes y el después, y con permisos distintos', async () => {
  const f = await nuevoEmpleado(A);
  const fecha = sumar(hoy(), -12);
  const crea = await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: { empleado_id: f.id, fecha, entrada: '08:00', salida: '15:00', observacion: 'Carga inicial' } });
  const id = crea.cuerpo.id;

  const sinMotivo = await api('PUT', `/api/rrhh/asistencia/${id}`, { token: A.admin.token, body: { entrada: '08:00', salida: '17:00' } });
  assert.equal(sinMotivo.status, 400);

  const corrige = await api('PUT', `/api/rrhh/asistencia/${id}`, { token: A.gerente.token, body: { entrada: '08:00', salida: '17:00', observacion: 'Se fue a las 5, no a las 3' } });
  assert.equal(corrige.status, 200, JSON.stringify(corrige.cuerpo));
  const fila = (await reporte(A.admin, `?desde=${fecha}&hasta=${fecha}&empleado_id=${f.id}`)).cuerpo.filas[0];
  assert.equal(fila.minutos_trabajados, 540);
  assert.equal(fila.observacion, 'Se fue a las 5, no a las 3');

  const { rows } = await pool.query(`SELECT detalle FROM audit_log WHERE empresa_id = $1 AND registro_id = $2 AND accion = 'editar'`, [A.empresaId, `asistencia:${id}`]);
  assert.equal(rows.length, 1);
  const detalle = typeof rows[0].detalle === 'string' ? JSON.parse(rows[0].detalle) : rows[0].detalle;
  assert.ok(detalle.antes && detalle.despues, 'quedan el antes y el después');
  assert.match(String(detalle.antes.salida), /T20:00:00/, 'la salida vieja era 15:00 en Lima (20:00 UTC)');

  assert.equal((await api('DELETE', `/api/rrhh/asistencia/${id}`, { token: A.gerente.token })).status, 403, 'borrar exige rrhh.eliminar');
  assert.equal((await api('DELETE', `/api/rrhh/asistencia/${id}`, { token: A.admin.token })).status, 204);
  assert.equal((await api('DELETE', `/api/rrhh/asistencia/${id}`, { token: A.admin.token })).status, 404);
  const { rows: rastro } = await pool.query(`SELECT 1 FROM audit_log WHERE empresa_id = $1 AND registro_id = $2 AND accion = 'eliminar'`, [A.empresaId, `asistencia:${id}`]);
  assert.equal(rastro.length, 1, 'aunque se borre, queda constancia');
});

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------

test('el reporte marca las semanas que pasan de 48 horas y respeta el filtro por trabajador', async () => {
  const f = await nuevoEmpleado(A, { nombre: 'Trabajador de sobrecarga' });
  const otro = await nuevoEmpleado(A, { nombre: 'Trabajador tranquilo' });
  const dow = (new Date(`${hoy()}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = lunes
  const lunes = sumar(hoy(), -dow - 7); // el lunes de la semana pasada

  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/api/rrhh/asistencia', {
      token: A.admin.token,
      body: { empleado_id: f.id, fecha: sumar(lunes, i), entrada: '08:00', salida_refrigerio: '13:00', retorno_refrigerio: '14:00', salida: '19:00', observacion: 'Semana de inventario' }
    });
    assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  }
  await api('POST', '/api/rrhh/asistencia', { token: A.admin.token, body: { empleado_id: otro.id, fecha: lunes, entrada: '08:00', salida: '17:00', observacion: 'Un día' } });

  const rep = (await reporte(A.admin, `?desde=${lunes}&hasta=${sumar(lunes, 6)}`)).cuerpo;
  const suyo = rep.resumen.find(r => r.empleado_id === f.id);
  assert.equal(suyo.dias, 6);
  assert.equal(suyo.minutos_trabajados, 6 * 600);
  assert.equal(suyo.semanas_sobre_el_limite.length, 1, '60 h en la semana: pasa las 48');
  assert.equal(suyo.semanas_sobre_el_limite[0].minutos, 3600);
  assert.equal(rep.resumen.find(r => r.empleado_id === otro.id).semanas_sobre_el_limite.length, 0);
  assert.equal(suyo.nombre, 'Trabajador de sobrecarga');

  const solo = (await reporte(A.admin, `?desde=${lunes}&hasta=${sumar(lunes, 6)}&empleado_id=${otro.id}`)).cuerpo;
  assert.deepEqual(solo.resumen.map(r => r.empleado_id), [otro.id]);
  assert.equal(solo.filas.length, 1);
});

test('el reporte trae los datos del empleador para imprimir el registro', async () => {
  const E = await montarEmpresa('empleador', ['admin']);
  await api('PUT', '/api/rrhh/empleador', { token: E.admin.token, body: { razon_social: 'Comercial Andina SAC', ruc: '20131312955', domicilio_fiscal: 'Av. Perú 100' } });
  const r = (await reporte(E.admin)).cuerpo;
  assert.equal(r.empleador.razon_social, 'Comercial Andina SAC');
  assert.equal(r.empleador.ruc, '20131312955');
  assert.equal(r.empleador.domicilio_fiscal, 'Av. Perú 100');
  assert.equal(r.hasta, hoy());
  assert.equal(r.desde, `${hoy().slice(0, 8)}01`, 'por defecto, lo que va del mes');
});

test('el reporte valida el rango y los filtros', async () => {
  assert.equal((await reporte(A.admin, '?desde=2026-05-10&hasta=2026-05-01')).status, 400);
  assert.equal((await reporte(A.admin, '?desde=2024-01-01&hasta=2026-01-01')).status, 400, 'más de un año');
  assert.equal((await reporte(A.admin, '?desde=ayer')).status, 400);
  assert.equal((await reporte(A.admin, '?empleado_id=abc')).status, 400);
});

test('permisos: marcar es para cualquiera con ficha; ver el reporte, para RRHH; cargar, solo con crear', async () => {
  const f = await nuevoEmpleado(A);
  assert.equal((await reporte(A.ventas1)).status, 403, 'el rol ventas no ve el reporte de todos');
  assert.equal((await reporte(A.supervisor)).status, 200);
  const carga = await api('POST', '/api/rrhh/asistencia', { token: A.supervisor.token, body: { empleado_id: f.id, fecha: sumar(hoy(), -20), entrada: '08:00', observacion: 'x' } });
  assert.equal(carga.status, 403, 'el supervisor solo mira');
  assert.equal((await api('GET', '/api/rrhh/asistencia')).status, 401);
});

test('aislamiento: el reporte y las correcciones de una empresa no alcanzan a otra', async () => {
  const deB = await nuevoEmpleado(B, { nombre: 'Trabajador de B' });
  const fecha = sumar(hoy(), -2);
  const crea = await api('POST', '/api/rrhh/asistencia', { token: B.admin.token, body: { empleado_id: deB.id, fecha, entrada: '08:00', salida: '17:00', observacion: 'Carga en B' } });
  assert.equal(crea.status, 201);

  const deA = (await reporte(A.admin, `?desde=${fecha}&hasta=${fecha}`)).cuerpo;
  assert.ok(!deA.filas.some(x => x.empleado_id === deB.id), 'A no ve las filas de B');
  assert.equal((await reporte(A.admin, `?desde=${fecha}&hasta=${fecha}&empleado_id=${deB.id}`)).cuerpo.filas.length, 0);
  assert.equal((await api('PUT', `/api/rrhh/asistencia/${crea.cuerpo.id}`, { token: A.admin.token, body: { entrada: '01:00', observacion: 'ataque' } })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/asistencia/${crea.cuerpo.id}`, { token: A.admin.token })).status, 404);
  const intacta = (await reporte(B.admin, `?desde=${fecha}&hasta=${fecha}`)).cuerpo.filas[0];
  assert.equal(intacta.minutos_trabajados, 540);
});
