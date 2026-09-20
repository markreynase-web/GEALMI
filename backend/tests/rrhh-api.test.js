// tests/rrhh-api.test.js
// Paso 8 (RRHH), fases R1, R3, R4 y R5 contra un servidor real sobre la base de
// pruebas: la ficha ampliada, el sueldo y los datos de salud protegidos por
// permiso, las ausencias con su flujo de aprobación, las remuneraciones, el
// legajo de documentos, los avisos de vencimiento y -- en todo -- que una
// empresa nunca toque los datos de otra.
// (Asistencia va en rrhh-asistencia.test.js; desempeño y reclutamiento en
// rrhh-desempeno-reclutamiento.test.js.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
let A, B;

before(async () => {
  servidor = await iniciarServidorTest({ NOTIFICACIONES_REVISION_MIN: '0' });
  A = await montarEmpresa('A', ['admin', 'gerente', 'supervisor', 'ventas1', 'ventas2']);
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

const ROLES = { admin: 'administrador', gerente: 'gerente', supervisor: 'supervisor', ventas1: 'ventas', ventas2: 'ventas' };

async function montarEmpresa(sufijo, quienes) {
  const empresaId = await crearEmpresa(ctx, `rrhh-${sufijo}`, ['rrhh']);
  const e = { empresaId };
  for (const quien of quienes) {
    const cuenta = await crearUsuario(ctx, { empresaId, rolNombre: ROLES[quien] });
    e[quien] = { ...cuenta, token: await login(servidor.baseUrl, cuenta.email, cuenta.password) };
  }
  return e;
}

// Un token con los permisos que se quiera, para un usuario que SÍ es de la empresa.
const conPermisos = (persona, empresaId, permisos) => jwt.sign({
  id: persona.usuarioId, nombre: 'Forjado', empresa_id: empresaId, empresa_nombre: 'QA', rol: 'forjado', permisos
}, process.env.JWT_SECRET, { expiresIn: 600 });

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sumar = (fecha, dias) => { const d = new Date(`${fecha}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

let contador = 0;
async function nuevoEmpleado(E, extra = {}, token = E.admin.token) {
  const r = await api('POST', '/api/rrhh', { token, body: { nombre: `Trabajador QA ${++contador}`, fecha_contratacion: '2024-01-01', salario: 1500, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo;
}
const listaEmpleados = async (persona) => (await api('GET', '/api/rrhh', { token: persona.token })).cuerpo;
const resumenNotificaciones = async (persona) => (await api('GET', '/api/notificaciones/resumen', { token: persona.token })).cuerpo;

// ---------------------------------------------------------------------------
// R1 -- ficha ampliada
// ---------------------------------------------------------------------------

test('la ficha guarda identidad, contrato y jornada, y las fechas/horas salen como texto', async () => {
  const r = await api('POST', '/api/rrhh', {
    token: A.admin.token,
    body: {
      nombre: 'Rosa Quispe', fecha_contratacion: '2025-03-10', puesto: 'Cajera', departamento: 'Ventas', salario: 1800,
      dni: '12345678', fecha_nacimiento: '1994-06-15', direccion: 'Av. Lima 123', regimen_laboral: 'mype_pequena',
      tipo_contrato: 'plazo fijo', fecha_fin_contrato: '2026-03-09', jornada_horas_dia: 6, hora_entrada: '09:00', hora_salida: '16:00',
      refrigerio_minutos: 45, dias_laborables: [1, 2, 3, 4, 5], contacto_emergencia_nombre: 'Juan Quispe', contacto_emergencia_telefono: '999888777'
    }
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  const f = r.cuerpo;
  assert.equal(f.dni, '12345678');
  assert.equal(f.fecha_contratacion, '2025-03-10');
  assert.equal(f.fecha_nacimiento, '1994-06-15');
  assert.equal(f.fecha_fin_contrato, '2026-03-09');
  assert.equal(f.hora_entrada, '09:00');
  assert.equal(f.hora_salida, '16:00');
  assert.equal(f.jornada_horas_dia, 6);
  assert.equal(f.refrigerio_minutos, 45);
  assert.deepEqual(f.dias_laborables, [1, 2, 3, 4, 5]);
  assert.equal(f.regimen_laboral, 'mype_pequena');
  assert.equal(Number(f.salario), 1800, 'el administrador ve el sueldo');
  assert.equal(f.estado_efectivo, 'activo');

  const fila = (await listaEmpleados(A.admin)).find(x => x.id === f.id);
  assert.equal(fila.contacto_emergencia_nombre, 'Juan Quispe');
  assert.equal(fila.fecha_contratacion, '2025-03-10');
});

test('una ficha sin los campos nuevos toma la jornada legal por defecto', async () => {
  const f = await nuevoEmpleado(A, { nombre: 'Solo lo básico' });
  assert.equal(f.jornada_horas_dia, 8);
  assert.equal(f.refrigerio_minutos, 60);
  assert.deepEqual(f.dias_laborables, [1, 2, 3, 4, 5, 6]);
  assert.equal(f.regimen_laboral, 'general');
  assert.equal(f.dni, null);
  assert.equal(f.usuario_id, null);
});

test('datos inválidos se rechazan con 400 y un mensaje claro', async () => {
  const casos = [
    [{ nombre: '' }, /nombre/i],
    [{ fecha_contratacion: '' }, /contrataci/i],
    [{ fecha_contratacion: '2025-02-30' }, /fecha válida/i],
    [{ dni: '123' }, /documento/i],
    [{ estado: 'jubilado' }, /estado/i],
    [{ salario: -5 }, /salario/i],
    [{ salario: 'mucho' }, /salario/i],
    [{ regimen_laboral: 'inventado' }, /regimen/i],
    [{ fecha_fin_contrato: '2023-01-01' }, /fin de contrato/i],
    [{ fecha_cese: '2023-01-01' }, /cese/i],
    [{ jornada_horas_dia: 20 }, /jornada/i],
    [{ hora_entrada: '25:00' }, /HH:MM/],
    [{ refrigerio_minutos: 500 }, /refrigerio/i],
    [{ dias_laborables: [0, 8] }, /días laborables/i],
    [{ dias_laborables: [] }, /días laborables/i],
    [{ fecha_nacimiento: '2999-01-01' }, /nacimiento/i],
    [{ nombre: 'x'.repeat(300) }, /200 caracteres/]
  ];
  for (const [extra, mensaje] of casos) {
    const r = await api('POST', '/api/rrhh', { token: A.admin.token, body: { nombre: 'Prueba', fecha_contratacion: '2024-01-01', ...extra } });
    assert.equal(r.status, 400, `${JSON.stringify(extra)} -> ${r.status} ${JSON.stringify(r.cuerpo)}`);
    assert.match(r.cuerpo.error, mensaje, JSON.stringify(extra));
  }
});

test('el documento de identidad no se repite dentro de la empresa (pero sí entre empresas)', async () => {
  await nuevoEmpleado(A, { dni: '40404040' });
  const repetido = await api('POST', '/api/rrhh', { token: A.admin.token, body: { nombre: 'Otro', fecha_contratacion: '2024-01-01', dni: '40404040' } });
  assert.equal(repetido.status, 409);
  assert.match(repetido.cuerpo.error, /documento/i);
  const minusculas = await api('POST', '/api/rrhh', { token: A.admin.token, body: { nombre: 'Otro', fecha_contratacion: '2024-01-01', dni: 'ab123456x' } });
  assert.equal(minusculas.status, 201);
  assert.equal(minusculas.cuerpo.dni, 'AB123456X', 'se guarda en mayúsculas');
  const dup = await api('POST', '/api/rrhh', { token: A.admin.token, body: { nombre: 'Otro', fecha_contratacion: '2024-01-01', dni: 'AB123456X' } });
  assert.equal(dup.status, 409, 'mayúsculas y minúsculas son el mismo documento');
  const otraEmpresa = await api('POST', '/api/rrhh', { token: B.admin.token, body: { nombre: 'Otro', fecha_contratacion: '2024-01-01', dni: '40404040' } });
  assert.equal(otraEmpresa.status, 201, 'cada empresa tiene su propio universo de trabajadores');
});

test('vincular un usuario a la ficha: solo de la misma empresa y solo a una ficha', async () => {
  const f1 = await nuevoEmpleado(A);
  const f2 = await nuevoEmpleado(A);

  const antes = await api('GET', '/api/rrhh/usuarios-disponibles', { token: A.admin.token });
  assert.equal(antes.status, 200);
  assert.ok(antes.cuerpo.some(u => u.id === A.ventas1.usuarioId), 'ventas1 aún no es la ficha de nadie');

  const vincula = await api('PUT', `/api/rrhh/${f1.id}`, { token: A.admin.token, body: { usuario_id: A.ventas1.usuarioId } });
  assert.equal(vincula.status, 200, JSON.stringify(vincula.cuerpo));
  assert.equal(vincula.cuerpo.usuario_id, A.ventas1.usuarioId);
  assert.ok(vincula.cuerpo.usuario_email, 'la ficha muestra el correo del usuario vinculado');

  const despues = await api('GET', '/api/rrhh/usuarios-disponibles', { token: A.admin.token });
  assert.ok(!despues.cuerpo.some(u => u.id === A.ventas1.usuarioId), 'ya no está disponible');
  const conActual = await api('GET', `/api/rrhh/usuarios-disponibles?incluir_de=${f1.id}`, { token: A.admin.token });
  assert.ok(conActual.cuerpo.some(u => u.id === A.ventas1.usuarioId), 'pero sí para editar esa misma ficha');

  const segunda = await api('PUT', `/api/rrhh/${f2.id}`, { token: A.admin.token, body: { usuario_id: A.ventas1.usuarioId } });
  assert.equal(segunda.status, 409, 'un usuario no puede ser dos trabajadores');

  const ajeno = await api('PUT', `/api/rrhh/${f2.id}`, { token: A.admin.token, body: { usuario_id: B.admin.usuarioId } });
  assert.equal(ajeno.status, 400, 'un usuario de otra empresa no se puede vincular');
  assert.match(ajeno.cuerpo.error, /no pertenece a tu empresa/i);

  const desvincula = await api('PUT', `/api/rrhh/${f1.id}`, { token: A.admin.token, body: { usuario_id: null } });
  assert.equal(desvincula.status, 200);
  assert.equal(desvincula.cuerpo.usuario_id, null);
  // Queda libre para el resto de los tests.
});

// ---------------------------------------------------------------------------
// Sueldo y salud: se protegen por permiso
// ---------------------------------------------------------------------------

test('sin rrhh.remuneraciones el sueldo ni viaja, y no se puede fijar ni cambiar', async () => {
  const f = await nuevoEmpleado(A, { salario: 2500, puesto: 'Analista' });

  const supervisor = (await listaEmpleados(A.supervisor)).find(x => x.id === f.id);
  assert.equal(supervisor.salario, null, 'el supervisor ve al trabajador pero no su sueldo');
  assert.equal(supervisor.puesto, 'Analista');
  const gerente = (await listaEmpleados(A.gerente)).find(x => x.id === f.id);
  assert.equal(Number(gerente.salario), 2500, 'el gerente sí');

  const sinSueldos = conPermisos(A.gerente, A.empresaId, ['rrhh.ver', 'rrhh.crear', 'rrhh.editar']);
  const cambiaPuesto = await api('PUT', `/api/rrhh/${f.id}`, { token: sinSueldos, body: { puesto: 'Jefa de análisis' } });
  assert.equal(cambiaPuesto.status, 200, 'editar lo demás sí se puede');
  assert.equal(cambiaPuesto.cuerpo.salario, null);
  const mismoSueldo = await api('PUT', `/api/rrhh/${f.id}`, { token: sinSueldos, body: { puesto: 'Jefa', salario: 2500 } });
  assert.equal(mismoSueldo.status, 200, 'reenviar el mismo sueldo (como hace la edición en línea) no es un cambio');
  const vacio = await api('PUT', `/api/rrhh/${f.id}`, { token: sinSueldos, body: { puesto: 'Jefa', salario: '' } });
  assert.equal(vacio.status, 200);
  const cambiaSueldo = await api('PUT', `/api/rrhh/${f.id}`, { token: sinSueldos, body: { salario: 9999 } });
  assert.equal(cambiaSueldo.status, 403);
  assert.match(cambiaSueldo.cuerpo.error, /rrhh\.remuneraciones/);
  const creaConSueldo = await api('POST', '/api/rrhh', { token: sinSueldos, body: { nombre: 'Nuevo', fecha_contratacion: '2024-01-01', salario: 3000 } });
  assert.equal(creaConSueldo.status, 403);
  const creaSinSueldo = await api('POST', '/api/rrhh', { token: sinSueldos, body: { nombre: 'Nuevo sin sueldo', fecha_contratacion: '2024-01-01' } });
  assert.equal(creaSinSueldo.status, 201);
  assert.equal(creaSinSueldo.cuerpo.salario, null);

  const importa = await api('POST', '/api/rrhh/import', { token: sinSueldos });
  assert.equal(importa.status, 403, 'el CSV trae sueldos: misma regla');

  const real = (await listaEmpleados(A.admin)).find(x => x.id === f.id);
  assert.equal(Number(real.salario), 2500, 'el sueldo real no se tocó');
});

test('cada cambio de sueldo deja historial, y el historial pide rrhh.remuneraciones', async () => {
  const f = await nuevoEmpleado(A, { salario: 1500 });
  const sube = await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { salario: 1800, motivo_salario: 'Aumento por desempeño' } });
  assert.equal(sube.status, 200);
  assert.equal(Number(sube.cuerpo.salario), 1800);

  const h = await api('GET', `/api/rrhh/remuneraciones/historial/${f.id}`, { token: A.gerente.token });
  assert.equal(h.status, 200);
  assert.equal(h.cuerpo.length, 2);
  assert.equal(h.cuerpo[0].motivo, 'Aumento por desempeño');
  assert.equal(Number(h.cuerpo[0].sueldo_anterior), 1500);
  assert.equal(Number(h.cuerpo[0].sueldo_nuevo), 1800);
  assert.equal(h.cuerpo[1].motivo, 'Contratación');
  assert.equal(h.cuerpo[1].sueldo_anterior, null);

  assert.equal((await api('GET', `/api/rrhh/remuneraciones/historial/${f.id}`, { token: A.supervisor.token })).status, 403);
  assert.equal((await api('GET', `/api/rrhh/remuneraciones/historial/${f.id}`, { token: A.ventas1.token })).status, 403);
});

test('estado efectivo: cese y ausencias aprobadas vigentes mandan sobre el estado escrito', async () => {
  const cesado = await nuevoEmpleado(A);
  const futuro = await nuevoEmpleado(A);
  const deVacaciones = await nuevoEmpleado(A);
  const conLicencia = await nuevoEmpleado(A);
  const pendiente = await nuevoEmpleado(A);

  assert.equal((await api('PUT', `/api/rrhh/${cesado.id}`, { token: A.admin.token, body: { fecha_cese: sumar(hoy(), -1) } })).cuerpo.estado_efectivo, 'cesado');
  assert.equal((await api('PUT', `/api/rrhh/${futuro.id}`, { token: A.admin.token, body: { fecha_cese: sumar(hoy(), 30) } })).cuerpo.estado_efectivo, 'activo', 'un cese futuro aún no aplica');

  const v = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: deVacaciones.id, tipo: 'vacaciones', fecha_inicio: sumar(hoy(), -1), fecha_fin: sumar(hoy(), 5) } });
  assert.equal(v.status, 201, JSON.stringify(v.cuerpo));
  const l = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: conLicencia.id, tipo: 'licencia', fecha_inicio: hoy(), fecha_fin: hoy(), motivo: 'Trámite' } });
  assert.equal(l.status, 201);
  const p = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: pendiente.id, tipo: 'vacaciones', fecha_inicio: hoy(), fecha_fin: sumar(hoy(), 5), estado: 'pendiente' } });
  assert.equal(p.status, 201);

  const lista = await listaEmpleados(A.admin);
  const de = (f) => lista.find(x => x.id === f.id).estado_efectivo;
  assert.equal(de(deVacaciones), 'vacaciones');
  assert.equal(de(conLicencia), 'licencia');
  assert.equal(de(pendiente), 'activo', 'una solicitud pendiente todavía no cuenta');
  assert.equal(lista.find(x => x.id === deVacaciones.id).estado, 'activo', 'el estado escrito no se toca');
});

test('un trabajador con historial no se puede eliminar; sin historial sí', async () => {
  const conHistorial = await nuevoEmpleado(A);
  await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: conHistorial.id, tipo: 'permiso', fecha_inicio: hoy(), fecha_fin: hoy() } });
  const no = await api('DELETE', `/api/rrhh/${conHistorial.id}`, { token: A.admin.token });
  assert.equal(no.status, 409);
  assert.match(no.cuerpo.error, /fecha de cese/i);

  const limpio = await nuevoEmpleado(A, { salario: 1000 });
  const si = await api('DELETE', `/api/rrhh/${limpio.id}`, { token: A.admin.token });
  assert.equal(si.status, 204, 'solo tenía el sueldo inicial: se puede borrar');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM historial_salarial WHERE empleado_id = $1', [limpio.id]);
  assert.equal(rows[0].n, 0, 'su historial de sueldo se fue con él');

  assert.equal((await api('DELETE', `/api/rrhh/${conHistorial.id}`, { token: A.gerente.token })).status, 403, 'el gerente no tiene rrhh.eliminar');
});

// ---------------------------------------------------------------------------
// Una empresa nunca toca los datos de otra
// ---------------------------------------------------------------------------

test('aislamiento entre empresas: ningún recurso de RRHH acepta el empleado de otra empresa', async () => {
  const deA = await nuevoEmpleado(A, { nombre: 'Trabajadora de A' });
  const tokenB = B.admin.token;
  const ajeno = { empleado_id: deA.id };

  const intentos = [
    ['POST', '/api/rrhh/asistencia', { ...ajeno, fecha: hoy(), entrada: '08:00', observacion: 'x' }],
    ['POST', '/api/rrhh/ausencias', { ...ajeno, tipo: 'permiso', fecha_inicio: hoy(), fecha_fin: hoy() }],
    ['POST', '/api/rrhh/remuneraciones', { ...ajeno, periodo: '2026-01' }],
    ['POST', '/api/rrhh/documentos', { ...ajeno, tipo: 'cv', nombre: 'CV' }],
    ['POST', '/api/rrhh/evaluaciones', { ...ajeno, periodo: '2026-S1', puntualidad: 3, calidad_trabajo: 3, trabajo_equipo: 3, iniciativa: 3, comunicacion: 3 }],
    ['POST', '/api/rrhh/capacitaciones', { nombre: 'Curso', participantes: [deA.id] }]
  ];
  for (const [metodo, ruta, body] of intentos) {
    const r = await api(metodo, ruta, { token: tokenB, body });
    assert.equal(r.status, 404, `${metodo} ${ruta} -> ${r.status} ${JSON.stringify(r.cuerpo)}`);
  }
  assert.equal((await api('PUT', `/api/rrhh/${deA.id}`, { token: tokenB, body: { puesto: 'Hackeado' } })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/${deA.id}`, { token: tokenB })).status, 404);
  assert.equal((await api('GET', `/api/rrhh/saldo-vacaciones/${deA.id}`, { token: tokenB })).status, 404);
  assert.equal((await api('GET', `/api/rrhh/remuneraciones/beneficios/${deA.id}`, { token: tokenB })).status, 404);
  assert.equal((await api('GET', `/api/rrhh/remuneraciones/historial/${deA.id}`, { token: tokenB })).status, 404);
  assert.equal((await api('PUT', `/api/rrhh/${deA.id}`, { token: tokenB, body: { usuario_id: A.ventas2.usuarioId } })).status, 404);

  assert.ok(!(await listaEmpleados(B.admin)).some(x => x.id === deA.id), 'la lista de B no trae a la de A');
  const suPuesto = (await listaEmpleados(A.admin)).find(x => x.id === deA.id);
  assert.notEqual(suPuesto.puesto, 'Hackeado');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM capacitaciones WHERE empresa_id = $1', [B.empresaId]);
  assert.equal(rows[0].n, 0, 'la capacitación rechazada no dejó nada a medias');
});

test('sin el módulo rrhh contratado o sin permiso, la API responde 403', async () => {
  const sinModulo = await crearEmpresa(ctx, 'rrhh-sin-modulo', ['ventas']);
  const u = await crearUsuario(ctx, { empresaId: sinModulo, rolNombre: 'administrador' });
  const token = await login(servidor.baseUrl, u.email, u.password);
  assert.equal((await api('GET', '/api/rrhh', { token })).status, 403);
  assert.equal((await api('GET', '/api/rrhh/mi/hoy', { token })).status, 403, 'tampoco el autoservicio');
  assert.equal((await api('GET', '/api/rrhh', { token: A.ventas1.token })).status, 403, 'el rol ventas no tiene rrhh.ver');
  assert.equal((await api('GET', '/api/rrhh')).status, 401);
});

// ---------------------------------------------------------------------------
// R3 -- ausencias y vacaciones
// ---------------------------------------------------------------------------

test('flujo completo: el trabajador solicita, RRHH aprueba, y todos reciben su aviso', async () => {
  const f = await nuevoEmpleado(A, { fecha_contratacion: '2023-01-01', usuario_id: A.ventas1.usuarioId });
  const inicio = sumar(hoy(), 20), fin = sumar(hoy(), 24);

  const pide = await api('POST', '/api/rrhh/mi/ausencias', { token: A.ventas1.token, body: { tipo: 'vacaciones', fecha_inicio: inicio, fecha_fin: fin, motivo: 'Viaje familiar' } });
  assert.equal(pide.status, 201, JSON.stringify(pide.cuerpo));
  assert.equal(pide.cuerpo.estado, 'pendiente');
  const id = pide.cuerpo.id;

  await esperar(300);
  const avisoAdmin = (await resumenNotificaciones(A.admin)).recientes.find(n => /Solicitud de vacaciones/.test(n.titulo));
  assert.ok(avisoAdmin, 'RRHH recibe la solicitud');
  assert.match(avisoAdmin.titulo, new RegExp(f.nombre));
  assert.equal(avisoAdmin.tipo, 'rrhh');
  assert.equal((await resumenNotificaciones(A.ventas2)).recientes.some(n => /Solicitud de vacaciones/.test(n.titulo)), false, 'y nadie más');

  const saldoAntes = (await api('GET', `/api/rrhh/saldo-vacaciones/${f.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(saldoAntes.dias_tomados, 0, 'pendiente todavía no descuenta');
  assert.equal(saldoAntes.dias_pendientes_aprobacion, 5);

  assert.equal((await api('PUT', `/api/rrhh/ausencias/${id}/resolver`, { token: A.ventas1.token, body: { estado: 'aprobada' } })).status, 403, 'nadie se aprueba a sí mismo sin permiso');
  const aprueba = await api('PUT', `/api/rrhh/ausencias/${id}/resolver`, { token: A.admin.token, body: { estado: 'aprobada', comentario: 'Buen viaje' } });
  assert.equal(aprueba.status, 200);

  await esperar(300);
  const avisoTrabajador = (await resumenNotificaciones(A.ventas1)).recientes.find(n => /fue aprobada/.test(n.titulo));
  assert.ok(avisoTrabajador, 'el trabajador se entera');
  assert.match(avisoTrabajador.cuerpo, /Buen viaje/);

  const saldoDespues = (await api('GET', `/api/rrhh/saldo-vacaciones/${f.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(saldoDespues.dias_tomados, 5);
  assert.equal(saldoDespues.saldo, Number((saldoDespues.dias_ganados - 5).toFixed(2)));
  assert.match(saldoDespues.referencial, /contador/i);

  const mias = (await api('GET', '/api/rrhh/mi/ausencias', { token: A.ventas1.token })).cuerpo;
  assert.equal(mias.find(a => a.id === id).estado, 'aprobada');
  assert.equal((await api('GET', '/api/rrhh/mi/saldo-vacaciones', { token: A.ventas1.token })).cuerpo.dias_tomados, 5);

  assert.equal((await api('PUT', `/api/rrhh/ausencias/${id}/resolver`, { token: A.admin.token, body: { estado: 'rechazada' } })).status, 409, 'una aprobada no se rechaza (solo se cancela)');
  assert.equal((await api('DELETE', `/api/rrhh/mi/ausencias/${id}`, { token: A.ventas1.token })).status, 404, 'ya aprobada: el trabajador no la puede retirar');
  assert.equal((await api('PUT', `/api/rrhh/ausencias/${id}/resolver`, { token: A.admin.token, body: { estado: 'cancelada' } })).status, 200);
  assert.equal((await api('GET', `/api/rrhh/saldo-vacaciones/${f.id}`, { token: A.admin.token })).cuerpo.dias_tomados, 0, 'cancelada: los días vuelven al saldo');
  // Libera el vínculo para otros tests.
  await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('las fechas de una ausencia no se pueden cruzar con otra del mismo trabajador', async () => {
  const f = await nuevoEmpleado(A);
  const base = { empleado_id: f.id, tipo: 'vacaciones', fecha_inicio: sumar(hoy(), 40), fecha_fin: sumar(hoy(), 45) };
  assert.equal((await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: base })).status, 201);
  const cruza = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { ...base, tipo: 'permiso', fecha_inicio: sumar(hoy(), 45), fecha_fin: sumar(hoy(), 46) } });
  assert.equal(cruza.status, 409);
  assert.match(cruza.cuerpo.error, /se cruzan/i);
  const pegada = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { ...base, tipo: 'permiso', fecha_inicio: sumar(hoy(), 46), fecha_fin: sumar(hoy(), 46) } });
  assert.equal(pegada.status, 201, 'el día siguiente sí');

  // Dos solicitudes idénticas a la vez: solo una pasa.
  const otro = await nuevoEmpleado(A);
  const b = { empleado_id: otro.id, tipo: 'permiso', fecha_inicio: sumar(hoy(), 60), fecha_fin: sumar(hoy(), 60) };
  const [x, y] = await Promise.all([
    api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: b }),
    api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: b })
  ]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
});

test('fechas y tipos inválidos de una ausencia', async () => {
  const f = await nuevoEmpleado(A);
  const casos = [
    [{ tipo: 'sabatico' }, /tipo/],
    [{ fecha_fin: sumar(hoy(), -5) }, /anterior/],
    [{ fecha_inicio: '2026-13-01' }, /fecha válida/],
    [{ fecha_fin: sumar(hoy(), 800) }, /366/],
    [{ motivo: 'x'.repeat(300) }, /250 caracteres/]
  ];
  for (const [extra, mensaje] of casos) {
    const r = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'permiso', fecha_inicio: hoy(), fecha_fin: hoy(), ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.cuerpo.error, mensaje);
  }
  assert.equal((await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { tipo: 'permiso', fecha_inicio: hoy(), fecha_fin: hoy() } })).status, 400, 'falta el empleado');
});

test('pedir más vacaciones de las ganadas avisa pero no bloquea, y el trabajador puede retirar la suya', async () => {
  const f = await nuevoEmpleado(A, { fecha_contratacion: sumar(hoy(), -35), usuario_id: A.ventas2.usuarioId });
  const pide = await api('POST', '/api/rrhh/mi/ausencias', { token: A.ventas2.token, body: { tipo: 'vacaciones', fecha_inicio: sumar(hoy(), 10), fecha_fin: sumar(hoy(), 24) } });
  assert.equal(pide.status, 201);
  assert.match(pide.cuerpo.aviso, /más días de los que tienes/i);

  const retira = await api('DELETE', `/api/rrhh/mi/ausencias/${pide.cuerpo.id}`, { token: A.ventas2.token });
  assert.equal(retira.status, 204);
  const { rows } = await pool.query('SELECT estado FROM ausencias WHERE id = $1', [pide.cuerpo.id]);
  assert.equal(rows[0].estado, 'cancelada');

  // Otra persona no puede retirar la solicitud ajena.
  const g = await nuevoEmpleado(A, { usuario_id: A.ventas1.usuarioId });
  const suya = await api('POST', '/api/rrhh/mi/ausencias', { token: A.ventas1.token, body: { tipo: 'permiso', fecha_inicio: sumar(hoy(), 30), fecha_fin: sumar(hoy(), 30) } });
  assert.equal(suya.status, 201);
  assert.equal((await api('DELETE', `/api/rrhh/mi/ausencias/${suya.cuerpo.id}`, { token: A.ventas2.token })).status, 404);
  assert.equal((await api('DELETE', `/api/rrhh/mi/ausencias/${suya.cuerpo.id}`, { token: A.ventas1.token })).status, 204);
  await api('PUT', `/api/rrhh/${f.id}`, { token: A.admin.token, body: { usuario_id: null } });
  await api('PUT', `/api/rrhh/${g.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('"Mi asistencia" exige estar vinculado a una ficha, y nunca acepta el id de otro trabajador', async () => {
  const sinVincular = await api('GET', '/api/rrhh/mi/hoy', { token: A.ventas1.token });
  assert.equal(sinVincular.status, 404);
  assert.equal(sinVincular.cuerpo.codigo, 'sin_ficha');

  const yo = await nuevoEmpleado(A, { usuario_id: A.ventas1.usuarioId });
  const otro = await nuevoEmpleado(A, { usuario_id: A.ventas2.usuarioId });
  // Aunque el body traiga el empleado de otro, la ausencia se crea para SU ficha.
  const r = await api('POST', '/api/rrhh/mi/ausencias', { token: A.ventas1.token, body: { empleado_id: otro.id, tipo: 'permiso', fecha_inicio: sumar(hoy(), 50), fecha_fin: sumar(hoy(), 50) } });
  assert.equal(r.status, 201);
  const { rows } = await pool.query('SELECT empleado_id FROM ausencias WHERE id = $1', [r.cuerpo.id]);
  assert.equal(rows[0].empleado_id, yo.id);
  await api('PUT', `/api/rrhh/${yo.id}`, { token: A.admin.token, body: { usuario_id: null } });
  await api('PUT', `/api/rrhh/${otro.id}`, { token: A.admin.token, body: { usuario_id: null } });
});

test('el detalle médico de un descanso solo lo ve y lo escribe quien tiene rrhh.salud', async () => {
  const f = await nuevoEmpleado(A);
  const fechas = { fecha_inicio: sumar(hoy(), 70), fecha_fin: sumar(hoy(), 72) };

  const sinSalud = await api('POST', '/api/rrhh/ausencias', { token: A.gerente.token, body: { empleado_id: f.id, tipo: 'descanso_medico', ...fechas, detalle_medico: 'Diagnóstico X' } });
  assert.equal(sinSalud.status, 403, 'el gerente no tiene rrhh.salud');
  assert.match(sinSalud.cuerpo.error, /rrhh\.salud/);

  const conSalud = await api('POST', '/api/rrhh/ausencias', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'descanso_medico', ...fechas, motivo: 'Reposo', detalle_medico: 'Diagnóstico secreto ZZ9' } });
  assert.equal(conSalud.status, 201);

  const paraAdmin = (await api('GET', `/api/rrhh/ausencias?empleado_id=${f.id}`, { token: A.admin.token })).cuerpo.find(a => a.id === conSalud.cuerpo.id);
  assert.equal(paraAdmin.detalle_medico, 'Diagnóstico secreto ZZ9');
  const paraGerente = (await api('GET', `/api/rrhh/ausencias?empleado_id=${f.id}`, { token: A.gerente.token })).cuerpo.find(a => a.id === conSalud.cuerpo.id);
  assert.equal(paraGerente.detalle_medico, null, 've la ausencia y el motivo, pero no el diagnóstico');
  assert.equal(paraGerente.motivo, 'Reposo');

  // El gerente puede editar fechas sin borrar (ni ver) el detalle.
  const edita = await api('PUT', `/api/rrhh/ausencias/${conSalud.cuerpo.id}`, { token: A.gerente.token, body: { tipo: 'descanso_medico', fecha_inicio: fechas.fecha_inicio, fecha_fin: sumar(hoy(), 73), motivo: 'Reposo' } });
  assert.equal(edita.status, 200, JSON.stringify(edita.cuerpo));
  const sigue = (await api('GET', `/api/rrhh/ausencias?empleado_id=${f.id}`, { token: A.admin.token })).cuerpo.find(a => a.id === conSalud.cuerpo.id);
  assert.equal(sigue.detalle_medico, 'Diagnóstico secreto ZZ9');
  assert.equal(sigue.dias, 4);

  // El diagnóstico tampoco viaja al registro de auditoría.
  const { rows } = await pool.query(`SELECT detalle FROM audit_log WHERE empresa_id = $1 AND modulo = 'rrhh' AND registro_id = $2`, [A.empresaId, `ausencia:${conSalud.cuerpo.id}`]);
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes('ZZ9'), 'Auditoría no guarda el diagnóstico');
});

// ---------------------------------------------------------------------------
// R4 -- remuneraciones
// ---------------------------------------------------------------------------

test('remuneraciones: el neto lo calcula la base, un período por trabajador, y pide rrhh.remuneraciones', async () => {
  const f = await nuevoEmpleado(A, { salario: 2000 });
  const crea = await api('POST', '/api/rrhh/remuneraciones', { token: A.admin.token, body: { empleado_id: f.id, periodo: '2026-03', bonificaciones: 300, horas_extra: 120.5, descuentos: 250.25 } });
  assert.equal(crea.status, 201, JSON.stringify(crea.cuerpo));

  const lista = (await api('GET', '/api/rrhh/remuneraciones?periodo=2026-03', { token: A.admin.token })).cuerpo;
  const fila = lista.filas.find(r => r.id === crea.cuerpo.id);
  assert.equal(Number(fila.sueldo_base), 2000, 'sin sueldo_base toma el de la ficha');
  assert.equal(Number(fila.neto), 2170.25);
  assert.equal(fila.estado, 'pendiente');

  const repite = await api('POST', '/api/rrhh/remuneraciones', { token: A.admin.token, body: { empleado_id: f.id, periodo: '2026-03' } });
  assert.equal(repite.status, 409);

  const paga = await api('PUT', `/api/rrhh/remuneraciones/${crea.cuerpo.id}`, { token: A.admin.token, body: { sueldo_base: 2000, bonificaciones: 0, horas_extra: 0, descuentos: 0, estado: 'pagado', fecha_pago: '2026-03-31' } });
  assert.equal(paga.status, 200);
  const despues = (await api('GET', `/api/rrhh/remuneraciones?empleado_id=${f.id}`, { token: A.gerente.token })).cuerpo.filas[0];
  assert.equal(despues.estado, 'pagado');
  assert.equal(despues.fecha_pago, '2026-03-31');
  assert.equal(Number(despues.neto), 2000);

  for (const persona of [A.supervisor, A.ventas1]) {
    assert.equal((await api('GET', '/api/rrhh/remuneraciones', { token: persona.token })).status, 403);
  }
  const sinRem = conPermisos(A.gerente, A.empresaId, ['rrhh.ver', 'rrhh.crear', 'rrhh.editar', 'rrhh.eliminar']);
  assert.equal((await api('POST', '/api/rrhh/remuneraciones', { token: sinRem, body: { empleado_id: f.id, periodo: '2026-04' } })).status, 403, 'crear también exige rrhh.remuneraciones');
  assert.equal((await api('DELETE', `/api/rrhh/remuneraciones/${crea.cuerpo.id}`, { token: A.gerente.token })).status, 403, 'y eliminar exige rrhh.eliminar');
  assert.equal((await api('DELETE', `/api/rrhh/remuneraciones/${crea.cuerpo.id}`, { token: A.admin.token })).status, 204);
});

test('remuneraciones: períodos y montos inválidos, y generar el mes sin duplicar', async () => {
  const conSueldo = await nuevoEmpleado(A, { salario: 1200, fecha_contratacion: '2025-01-01' });
  const sinSueldo = await nuevoEmpleado(A, { salario: 0, fecha_contratacion: '2025-01-01' });
  const posterior = await nuevoEmpleado(A, { salario: 1200, fecha_contratacion: '2030-01-01' });
  const cesado = await nuevoEmpleado(A, { salario: 1200, fecha_contratacion: '2020-01-01', fecha_cese: '2026-08-15' });

  for (const periodo of ['2026-13', '2026-3', 'marzo', '']) {
    const r = await api('POST', '/api/rrhh/remuneraciones', { token: A.admin.token, body: { empleado_id: conSueldo.id, periodo } });
    assert.equal(r.status, 400, `período "${periodo}"`);
  }
  const negativo = await api('POST', '/api/rrhh/remuneraciones', { token: A.admin.token, body: { empleado_id: conSueldo.id, periodo: '2026-05', descuentos: -1 } });
  assert.equal(negativo.status, 400);

  const genera = await api('POST', '/api/rrhh/remuneraciones/generar', { token: A.admin.token, body: { periodo: '2026-09' } });
  assert.equal(genera.status, 200);
  const septiembre = (await api('GET', '/api/rrhh/remuneraciones?periodo=2026-09', { token: A.admin.token })).cuerpo.filas;
  const ids = septiembre.map(r => r.empleado_id);
  assert.ok(ids.includes(conSueldo.id), 'quien tiene sueldo y estaba activo');
  assert.ok(!ids.includes(sinSueldo.id), 'sin sueldo no se genera');
  assert.ok(!ids.includes(posterior.id), 'no había sido contratado todavía');
  assert.ok(!ids.includes(cesado.id), 'ya había cesado antes del mes');
  const otraVez = await api('POST', '/api/rrhh/remuneraciones/generar', { token: A.admin.token, body: { periodo: '2026-09' } });
  assert.equal(otraVez.cuerpo.creadas, 0, 'generar dos veces no duplica');
});

test('beneficios estimados: llevan su aviso de referencia y respetan el régimen', async () => {
  const general = await nuevoEmpleado(A, { salario: 1800, fecha_contratacion: '2020-01-01', regimen_laboral: 'general' });
  const micro = await nuevoEmpleado(A, { salario: 1800, fecha_contratacion: '2020-01-01', regimen_laboral: 'mype_micro' });
  const g = (await api('GET', `/api/rrhh/remuneraciones/beneficios/${general.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(g.aplica, true);
  assert.match(g.referencial, /REFERENCIAL/);
  assert.ok(g.gratificacion.periodo && g.cts.periodo);
  const m = (await api('GET', `/api/rrhh/remuneraciones/beneficios/${micro.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(m.aplica, false);
  assert.equal(m.cts.monto, 0);
  assert.equal((await api('GET', `/api/rrhh/remuneraciones/beneficios/${general.id}`, { token: A.supervisor.token })).status, 403);
});

// ---------------------------------------------------------------------------
// R5 -- legajo de documentos
// ---------------------------------------------------------------------------

test('documentos: solo enlaces https, con fechas coherentes', async () => {
  const f = await nuevoEmpleado(A);
  const ok = await api('POST', '/api/rrhh/documentos', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'contrato', nombre: 'Contrato 2026', url: 'https://drive.google.com/file/d/abc', fecha_emision: '2026-01-01', fecha_vencimiento: '2026-12-31' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.cuerpo));

  const malos = [
    [{ url: 'javascript:alert(1)' }, /https/],
    [{ url: 'http://inseguro.example.com/x' }, /https/],
    [{ url: 'data:text/html,<script>1</script>' }, /https/],
    [{ url: 'esto no es un enlace' }, /enlace/],
    [{ tipo: 'foto' }, /tipo/],
    [{ nombre: '' }, /nombre/i],
    [{ fecha_emision: '2026-05-01', fecha_vencimiento: '2026-01-01' }, /vencimiento/]
  ];
  for (const [extra, mensaje] of malos) {
    const r = await api('POST', '/api/rrhh/documentos', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'cv', nombre: 'CV', ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.cuerpo.error, mensaje);
  }
  const lista = (await api('GET', `/api/rrhh/documentos?empleado_id=${f.id}`, { token: A.supervisor.token })).cuerpo;
  assert.equal(lista.length, 1);
  assert.equal(lista[0].fecha_vencimiento, '2026-12-31');
});

test('documentos: el examen médico es invisible e intocable sin rrhh.salud', async () => {
  const f = await nuevoEmpleado(A);
  const medico = await api('POST', '/api/rrhh/documentos', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'examen_medico', nombre: 'Examen ocupacional', url: 'https://example.com/examen', fecha_vencimiento: sumar(hoy(), 200) } });
  assert.equal(medico.status, 201);
  const comun = await api('POST', '/api/rrhh/documentos', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'dni', nombre: 'DNI', url: 'https://example.com/dni' } });
  assert.equal(comun.status, 201);

  const paraGerente = (await api('GET', `/api/rrhh/documentos?empleado_id=${f.id}`, { token: A.gerente.token })).cuerpo;
  assert.deepEqual(paraGerente.map(d => d.tipo), ['dni'], 'el gerente no ve el examen médico');
  const paraAdmin = (await api('GET', `/api/rrhh/documentos?empleado_id=${f.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(paraAdmin.length, 2);

  const edita = await api('PUT', `/api/rrhh/documentos/${medico.cuerpo.id}`, { token: A.gerente.token, body: { tipo: 'examen_medico', nombre: 'Cambiado' } });
  assert.equal(edita.status, 404, 'para el gerente ese documento no existe');
  assert.equal((await api('DELETE', `/api/rrhh/documentos/${medico.cuerpo.id}`, { token: A.gerente.token })).status, 403, 'el gerente ni siquiera tiene rrhh.eliminar');
  const conEliminar = conPermisos(A.gerente, A.empresaId, ['rrhh.ver', 'rrhh.crear', 'rrhh.editar', 'rrhh.eliminar']);
  assert.equal((await api('DELETE', `/api/rrhh/documentos/${medico.cuerpo.id}`, { token: conEliminar })).status, 404, 'con eliminar pero sin salud, tampoco lo ve');
  const crea =await api('POST', '/api/rrhh/documentos', { token: A.gerente.token, body: { empleado_id: f.id, tipo: 'examen_medico', nombre: 'Otro', url: 'https://example.com/x' } });
  assert.equal(crea.status, 404);
  const disfraza = await api('PUT', `/api/rrhh/documentos/${comun.cuerpo.id}`, { token: A.gerente.token, body: { tipo: 'examen_medico', nombre: 'DNI' } });
  assert.equal(disfraza.status, 404, 'tampoco se puede convertir uno común en médico');
  assert.equal((await api('DELETE', `/api/rrhh/documentos/${medico.cuerpo.id}`, { token: A.admin.token })).status, 204);
});

test('documentos: filtro por vencimiento y marca de vencido', async () => {
  const f = await nuevoEmpleado(A);
  const crear = (nombre, dias) => api('POST', '/api/rrhh/documentos', { token: A.admin.token, body: { empleado_id: f.id, tipo: 'certificado', nombre, url: 'https://example.com/c', fecha_vencimiento: sumar(hoy(), dias) } });
  await crear('Vencido', -3);
  await crear('Pronto', 10);
  await crear('Lejano', 400);
  const todos = (await api('GET', `/api/rrhh/documentos?empleado_id=${f.id}`, { token: A.admin.token })).cuerpo;
  assert.equal(todos.find(d => d.nombre === 'Vencido').vencido, true);
  assert.equal(todos.find(d => d.nombre === 'Pronto').vencido, false);
  const porVencer = (await api('GET', `/api/rrhh/documentos?empleado_id=${f.id}&vence_en=30`, { token: A.admin.token })).cuerpo;
  assert.deepEqual(porVencer.map(d => d.nombre).sort(), ['Pronto', 'Vencido']);
  assert.equal((await api('GET', '/api/rrhh/documentos?vence_en=abc', { token: A.admin.token })).status, 400);
});

// ---------------------------------------------------------------------------
// Datos del empleador y panel
// ---------------------------------------------------------------------------

test('datos del empleador: el RUC se valida y solo lo edita quien puede editar', async () => {
  const mal = await api('PUT', '/api/rrhh/empleador', { token: A.admin.token, body: { razon_social: 'Mi Empresa SAC', ruc: '20131312956' } });
  assert.equal(mal.status, 400);
  assert.match(mal.cuerpo.error, /RUC/);
  const ok = await api('PUT', '/api/rrhh/empleador', { token: A.admin.token, body: { razon_social: 'Mi Empresa SAC', ruc: '20131312955', domicilio_fiscal: 'Jr. Cusco 456, Lima' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  const lee = await api('GET', '/api/rrhh/empleador', { token: A.supervisor.token });
  assert.equal(lee.status, 200);
  assert.equal(lee.cuerpo.ruc, '20131312955');
  assert.equal(lee.cuerpo.razon_social, 'Mi Empresa SAC');
  assert.equal((await api('PUT', '/api/rrhh/empleador', { token: A.supervisor.token, body: { ruc: '' } })).status, 403);
  const borra = await api('PUT', '/api/rrhh/empleador', { token: A.admin.token, body: { razon_social: '', ruc: '', domicilio_fiscal: '' } });
  assert.equal(borra.cuerpo.ruc, null, 'se puede dejar en blanco');
  // El de la otra empresa no cambió.
  assert.equal((await api('GET', '/api/rrhh/empleador', { token: B.admin.token })).cuerpo.ruc, null);
});

test('el resumen de RRHH junta lo que hay que mirar hoy', async () => {
  const E = await montarEmpresa('resumen', ['admin', 'gerente']);
  const a = await nuevoEmpleado(E, { fecha_contratacion: '2024-01-01', fecha_fin_contrato: sumar(hoy(), 12), nombre: 'Contrato por vencer' });
  const b = await nuevoEmpleado(E, { fecha_nacimiento: `1990-${hoy().slice(5, 7)}-15`, nombre: 'Cumpleañero' });
  await nuevoEmpleado(E, { fecha_cese: sumar(hoy(), -2), nombre: 'Ya se fue' });
  await api('POST', '/api/rrhh/ausencias', { token: E.admin.token, body: { empleado_id: b.id, tipo: 'permiso', fecha_inicio: hoy(), fecha_fin: hoy() } });
  await api('POST', '/api/rrhh/ausencias', { token: E.admin.token, body: { empleado_id: a.id, tipo: 'vacaciones', fecha_inicio: sumar(hoy(), 90), fecha_fin: sumar(hoy(), 92), estado: 'pendiente' } });
  await api('POST', '/api/rrhh/documentos', { token: E.admin.token, body: { empleado_id: a.id, tipo: 'certificado', nombre: 'Vencido', url: 'https://example.com/v', fecha_vencimiento: sumar(hoy(), -1) } });
  await api('POST', '/api/rrhh/documentos', { token: E.admin.token, body: { empleado_id: a.id, tipo: 'examen_medico', nombre: 'Examen', url: 'https://example.com/e', fecha_vencimiento: sumar(hoy(), 5) } });

  const r = (await api('GET', '/api/rrhh/resumen', { token: E.admin.token })).cuerpo;
  assert.equal(r.empleados.total, 3);
  assert.equal(r.empleados.cesados, 1);
  assert.equal(r.empleados.activos, 1, 'uno de los tres está de permiso hoy: figura "licencia"');
  assert.deepEqual(r.contratos_por_vencer.map(c => c.nombre), ['Contrato por vencer']);
  assert.equal(r.contratos_por_vencer[0].dias_restantes, 12);
  assert.equal(r.ausencias_pendientes, 1);
  assert.deepEqual(r.ausentes_hoy.map(x => x.nombre), ['Cumpleañero']);
  assert.deepEqual(r.cumpleanos_mes.map(x => x.nombre), ['Cumpleañero']);
  assert.equal(r.documentos.vencidos, 1);
  assert.equal(r.documentos.por_vencer, 1, 'el administrador cuenta también el examen médico');
  const gerente = (await api('GET', '/api/rrhh/resumen', { token: E.gerente.token })).cuerpo;
  assert.equal(gerente.documentos.por_vencer, 0, 'el gerente no cuenta el examen médico');
});

// ---------------------------------------------------------------------------
// Avisos de vencimiento (campana)
// ---------------------------------------------------------------------------

test('avisos: contratos y documentos por vencer llegan en UN resumen; el examen médico solo a quien tiene rrhh.salud', async () => {
  const E = await montarEmpresa('avisos', ['admin', 'gerente', 'supervisor']);
  const f = await nuevoEmpleado(E, { nombre: 'Marta Avisos', fecha_fin_contrato: sumar(hoy(), 10) });
  await api('POST', '/api/rrhh/documentos', { token: E.admin.token, body: { empleado_id: f.id, tipo: 'certificado', nombre: 'Certificado SST', url: 'https://example.com/c', fecha_vencimiento: sumar(hoy(), 5) } });
  await api('POST', '/api/rrhh/documentos', { token: E.admin.token, body: { empleado_id: f.id, tipo: 'examen_medico', nombre: 'Examen', url: 'https://example.com/e', fecha_vencimiento: sumar(hoy(), 6) } });

  const admin = (await resumenNotificaciones(E.admin)).recientes.filter(n => n.tipo === 'rrhh');
  const general = admin.find(n => /por vencer/.test(n.titulo) && !/médico/.test(n.titulo));
  assert.ok(general, 'el administrador recibe el resumen general');
  assert.match(general.cuerpo, /Contrato de Marta Avisos/);
  assert.match(general.cuerpo, /Certificado SST/);
  assert.doesNotMatch(general.cuerpo, /Examen/, 'el resumen general jamás nombra un examen médico');
  assert.ok(admin.find(n => /médico/.test(n.titulo)), 'y el aviso de salud, porque tiene rrhh.salud');

  const gerente = (await resumenNotificaciones(E.gerente)).recientes.filter(n => n.tipo === 'rrhh');
  assert.ok(gerente.find(n => /por vencer/.test(n.titulo) && !/médico/.test(n.titulo)), 'el gerente (rrhh.editar) recibe el general');
  assert.equal(gerente.some(n => /médico/.test(n.titulo)), false, 'pero no el de salud');
  assert.equal((await resumenNotificaciones(E.supervisor)).recientes.filter(n => n.tipo === 'rrhh').length, 0, 'el supervisor solo ve, no administra');

  // Volver a consultar no repite el aviso de la semana.
  await resumenNotificaciones(E.admin);
  await resumenNotificaciones(E.admin);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM notificaciones WHERE usuario_id = $1 AND tipo = 'rrhh'`, [E.admin.usuarioId]);
  assert.equal(rows[0].n, 2, 'un aviso general y uno de salud, no más');
});
