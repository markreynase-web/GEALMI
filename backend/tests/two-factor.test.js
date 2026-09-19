// tests/two-factor.test.js
// Nivel 3 -- 2FA (TOTP). Flujo completo contra un servidor real sobre la base
// de pruebas: activar desde Seguridad, el paso extra del login, códigos de
// recuperación, límite de intentos, desactivar, restablecer por un admin y
// las salvaguardas (plan, sesión de soporte, super admin, clave del servidor).
// Cada test crea sus propias cuentas: los límites de intentos son por cuenta.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, limpiarContexto, PASSWORD_QA } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';
import { codigoTotp, PASO_SEGUNDOS } from '../src/totp.js';

const CLAVE_TEST = 'c'.repeat(64);
let servidor;
const ctx = nuevoContexto();

before(async () => { servidor = await iniciarServidorTest({ TOTP_ENCRYPTION_KEY: CLAVE_TEST }); });
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function api(metodo, ruta, { token, body, base = servidor.baseUrl } = {}) {
  const r = await fetch(`${base}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || metodo === 'GET' ? undefined : JSON.stringify(body)
  });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}

async function asignarPlan(empresaId, nombrePlan) {
  const { rows } = await pool.query('SELECT id FROM planes WHERE nombre = $1', [nombrePlan]);
  await pool.query('UPDATE empresas SET plan_id = $1 WHERE id = $2', [rows[0].id, empresaId]);
}

const loginPaso1 = (cuenta) => api('POST', '/api/auth/login', { body: { email: cuenta.email, password: cuenta.password } });

async function cuentaConPlan(sufijo, { plan = 'Empresarial', rolNombre = 'administrador' } = {}) {
  const empresaId = await crearEmpresa(ctx, sufijo);
  await asignarPlan(empresaId, plan);
  const cuenta = await crearUsuario(ctx, { empresaId, rolNombre });
  const { cuerpo } = await loginPaso1(cuenta);
  return { empresaId, cuenta, token: cuerpo.token };
}

// Hace de "celular": inicia y activa el 2FA de una sesión ya abierta.
async function activar2FA(token) {
  const ini = await api('POST', '/api/2fa/iniciar', { token });
  assert.equal(ini.status, 200, `iniciar: ${JSON.stringify(ini.cuerpo)}`);
  const act = await api('POST', '/api/2fa/activar', { token, body: { codigo: codigoTotp(ini.cuerpo.secreto) } });
  assert.equal(act.status, 200, `activar: ${JSON.stringify(act.cuerpo)}`);
  return { secreto: ini.cuerpo.secreto, codigos: act.cuerpo.codigosRecuperacion };
}

// El código con el que se activó ya se consumió: para entrar hace falta el
// del intervalo siguiente (el servidor tolera ±1).
const siguiente = (secreto) => codigoTotp(secreto, Date.now() + PASO_SEGUNDOS * 1000);

function codigoIncorrecto(secreto) {
  const validos = new Set([-2, -1, 0, 1, 2].map(d => codigoTotp(secreto, Date.now() + d * PASO_SEGUNDOS * 1000)));
  for (let n = 0; n < 1000; n++) {
    const c = String(n).padStart(6, '0');
    if (!validos.has(c)) return c;
  }
}

async function esperarAuditoria(empresaId, accion) {
  for (let i = 0; i < 30; i++) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM audit_log WHERE empresa_id = $1 AND accion = $2', [empresaId, accion]);
    if (rows[0].n) return rows[0].n;
    await new Promise(r => setTimeout(r, 100));
  }
  return 0;
}

test('GET /api/2fa/estado: Básico no lo incluye, Empresarial sí; la respuesta nunca trae secretos', async () => {
  const basica = await cuentaConPlan('2fa-estado-basico', { plan: 'Básico' });
  const rBasica = await api('GET', '/api/2fa/estado', { token: basica.token });
  assert.equal(rBasica.status, 200);
  assert.deepEqual(rBasica.cuerpo, { activado: false, planIncluye: false, servidorConfigurado: true, disponible: false, codigosRestantes: 0 });

  const empresarial = await cuentaConPlan('2fa-estado-empresarial');
  const rEmp = await api('GET', '/api/2fa/estado', { token: empresarial.token });
  assert.equal(rEmp.cuerpo.disponible, true);
  assert.equal(rEmp.cuerpo.activado, false);

  assert.equal((await api('GET', '/api/2fa/estado')).status, 401, 'sin sesión, no');
});

test('POST /api/2fa/iniciar: un plan sin 2FA recibe 403 y no se guarda ningún secreto', async () => {
  const { cuenta, token } = await cuentaConPlan('2fa-iniciar-basico', { plan: 'Básico' });
  const r = await api('POST', '/api/2fa/iniciar', { token });
  assert.equal(r.status, 403);
  assert.match(r.cuerpo.error, /plan actual no incluye/i);
  const { rows } = await pool.query('SELECT totp_secreto_cifrado FROM usuarios WHERE id = $1', [cuenta.usuarioId]);
  assert.equal(rows[0].totp_secreto_cifrado, null);
});

test('activar: el secreto se guarda cifrado, el pendiente no protege nada, y solo un código correcto lo enciende', async () => {
  const { empresaId, cuenta, token } = await cuentaConPlan('2fa-activar');

  const ini = await api('POST', '/api/2fa/iniciar', { token });
  assert.equal(ini.status, 200);
  assert.match(ini.cuerpo.secreto, /^[A-Z2-7]{32}$/);
  assert.ok(ini.cuerpo.otpauthUrl.startsWith('otpauth://totp/GEALMI'));
  assert.ok(ini.cuerpo.otpauthUrl.includes(`secret=${ini.cuerpo.secreto}`));

  const { rows: pendiente } = await pool.query('SELECT totp_secreto_cifrado, totp_activado_el FROM usuarios WHERE id = $1', [cuenta.usuarioId]);
  assert.ok(pendiente[0].totp_secreto_cifrado.startsWith('v1:'), 'formato cifrado');
  assert.ok(!pendiente[0].totp_secreto_cifrado.includes(ini.cuerpo.secreto), 'el secreto nunca está en claro en la base');
  assert.equal(pendiente[0].totp_activado_el, null);

  // Mientras no se confirme con un código, el login sigue igual que siempre.
  const rLibre = await loginPaso1(cuenta);
  assert.ok(rLibre.cuerpo.token && !rLibre.cuerpo.requiere2FA, 'un secreto pendiente no exige código');

  const rMal = await api('POST', '/api/2fa/activar', { token, body: { codigo: codigoIncorrecto(ini.cuerpo.secreto) } });
  assert.equal(rMal.status, 400);
  const rSinCodigo = await api('POST', '/api/2fa/activar', { token, body: {} });
  assert.equal(rSinCodigo.status, 400);

  const rBien = await api('POST', '/api/2fa/activar', { token, body: { codigo: codigoTotp(ini.cuerpo.secreto) } });
  assert.equal(rBien.status, 200);
  const codigos = rBien.cuerpo.codigosRecuperacion;
  assert.equal(codigos.length, 10);
  for (const c of codigos) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);

  const { rows: guardados } = await pool.query('SELECT codigo_hash FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [cuenta.usuarioId]);
  assert.equal(guardados.length, 10);
  for (const g of guardados) assert.ok(!codigos.includes(g.codigo_hash), 'en la base solo hay hashes, nunca el código en claro');

  assert.equal((await api('POST', '/api/2fa/activar', { token, body: { codigo: siguiente(ini.cuerpo.secreto) } })).status, 409, 'no se activa dos veces');
  assert.equal((await api('POST', '/api/2fa/iniciar', { token })).status, 409, 'ni se reinicia estando activo');

  const estado = await api('GET', '/api/2fa/estado', { token });
  assert.equal(estado.cuerpo.activado, true);
  assert.equal(estado.cuerpo.codigosRestantes, 10);
  assert.ok(!JSON.stringify(estado.cuerpo).includes(ini.cuerpo.secreto));
  assert.ok(await esperarAuditoria(empresaId, 'activar_2fa') >= 1, 'activar el 2FA queda en Auditoría');
});

test('login con 2FA: se pide el código, el desafío no sirve como sesión, y un código correcto entra', async () => {
  const { cuenta, token } = await cuentaConPlan('2fa-login');
  const { secreto } = await activar2FA(token);

  const r1 = await loginPaso1(cuenta);
  assert.equal(r1.status, 200);
  assert.equal(r1.cuerpo.requiere2FA, true);
  assert.ok(r1.cuerpo.desafioToken);
  assert.equal(r1.cuerpo.token, undefined, 'con la contraseña sola NO se entrega sesión');
  assert.equal(r1.cuerpo.empresas, undefined, 'ni se revelan sus empresas');
  assert.equal(jwt.decode(r1.cuerpo.desafioToken).tipo, 'desafio2fa');

  const desafioToken = r1.cuerpo.desafioToken;
  assert.equal((await api('GET', '/api/usuarios', { token: desafioToken })).status, 401, 'el desafío no abre ningún router de datos');

  const rMal = await api('POST', '/api/auth/login/2fa', { body: { desafioToken, codigo: codigoIncorrecto(secreto) } });
  assert.equal(rMal.status, 401);
  assert.equal(rMal.cuerpo.error, 'Código incorrecto.');
  assert.equal((await api('POST', '/api/auth/login/2fa', { body: { desafioToken } })).status, 400, 'sin código, 400');
  assert.equal((await api('POST', '/api/auth/login/2fa', { body: { desafioToken: 'basura', codigo: '123456' } })).status, 401);

  const rBien = await api('POST', '/api/auth/login/2fa', { body: { desafioToken, codigo: siguiente(secreto) } });
  assert.equal(rBien.status, 200);
  assert.ok(rBien.cuerpo.token);
  const rMe = await api('GET', '/api/auth/me', { token: rBien.cuerpo.token });
  assert.equal(rMe.cuerpo.usuario.id, cuenta.usuarioId);

  // Un token de sesión normal no sirve como "desafío".
  const rConSesion = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: rBien.cuerpo.token, codigo: siguiente(secreto) } });
  assert.equal(rConSesion.status, 401);
});

test('cada código sirve UNA sola vez: reusar uno ya aceptado se rechaza', async () => {
  const { cuenta, token } = await cuentaConPlan('2fa-replay');
  const { secreto } = await activar2FA(token);

  const codigo = siguiente(secreto);
  const d1 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  assert.equal((await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d1, codigo } })).status, 200);

  const d2 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const rRepetido = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d2, codigo } });
  assert.equal(rRepetido.status, 401);
  assert.match(rRepetido.cuerpo.error, /ya se usó/i);

  // El código con el que se ACTIVÓ tampoco se puede usar para entrar.
  const d3 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const rActivacion = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d3, codigo: codigoTotp(secreto) } });
  assert.equal(rActivacion.status, 401);
});

test('código de recuperación: entra una vez (sin importar mayúsculas ni guion), queda auditado y descuenta uno', async () => {
  const { empresaId, cuenta, token } = await cuentaConPlan('2fa-recuperacion');
  const { codigos } = await activar2FA(token);

  const escrito = codigos[0].toLowerCase().replace('-', '');
  const d1 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const rBien = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d1, codigoRecuperacion: escrito } });
  assert.equal(rBien.status, 200);
  assert.ok(rBien.cuerpo.token);

  const d2 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const rReuso = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d2, codigoRecuperacion: codigos[0] } });
  assert.equal(rReuso.status, 401, 'un código de recuperación no se reusa');

  const d3 = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const rOtro = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: d3, codigoRecuperacion: 'AAAAA-AAAAA' } });
  assert.equal(rOtro.status, 401);

  const estado = await api('GET', '/api/2fa/estado', { token: rBien.cuerpo.token });
  assert.equal(estado.cuerpo.codigosRestantes, 9);
  assert.ok(await esperarAuditoria(empresaId, 'usar_cod_recup') >= 1, 'entrar con un código de recuperación deja rastro');
});

test('límite de intentos: a los 5 fallos se bloquea, incluso con el código correcto', async () => {
  const { cuenta, token } = await cuentaConPlan('2fa-limite');
  const { secreto } = await activar2FA(token);
  const desafioToken = (await loginPaso1(cuenta)).cuerpo.desafioToken;

  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/auth/login/2fa', { body: { desafioToken, codigo: codigoIncorrecto(secreto) } });
    assert.equal(r.status, 401, `intento ${i + 1}`);
  }
  const rBloqueado = await api('POST', '/api/auth/login/2fa', { body: { desafioToken, codigo: siguiente(secreto) } });
  assert.equal(rBloqueado.status, 429);
});

test('con varias empresas: primero el código, después el selector de empresa de siempre', async () => {
  const { empresaId, cuenta, token } = await cuentaConPlan('2fa-multi-a');
  const empresaB = await crearEmpresa(ctx, '2fa-multi-b');
  const { rows: rol } = await pool.query("SELECT id FROM roles WHERE nombre = 'administrador'");
  await pool.query('INSERT INTO usuario_empresa (usuario_id, empresa_id, rol_id, activo) VALUES ($1, $2, $3, true)', [cuenta.usuarioId, empresaB, rol[0].id]);
  const { secreto } = await activar2FA(token);

  const r1 = await loginPaso1(cuenta);
  assert.equal(r1.cuerpo.requiere2FA, true);
  assert.equal(r1.cuerpo.preAuthToken, undefined, 'el selector de empresa viene DESPUÉS del código');

  const r2 = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: r1.cuerpo.desafioToken, codigo: siguiente(secreto) } });
  assert.equal(r2.status, 200);
  assert.equal(r2.cuerpo.requiereSeleccionEmpresa, true);
  assert.equal(r2.cuerpo.empresas.length, 2);

  const r3 = await api('POST', '/api/auth/login/empresa', { body: { preAuthToken: r2.cuerpo.preAuthToken, empresa_id: empresaB } });
  assert.equal(r3.status, 200);
  assert.equal(jwt.decode(r3.cuerpo.token).empresa_id, empresaB);
  assert.notEqual(empresaB, empresaId);
});

test('un preAuthToken pedido ANTES de activar el 2FA no sirve para saltarse el código', async () => {
  const { empresaId, cuenta } = await cuentaConPlan('2fa-preauth-a');
  const empresaB = await crearEmpresa(ctx, '2fa-preauth-b');
  const { rows: rol } = await pool.query("SELECT id FROM roles WHERE nombre = 'administrador'");
  await pool.query('INSERT INTO usuario_empresa (usuario_id, empresa_id, rol_id, activo) VALUES ($1, $2, $3, true)', [cuenta.usuarioId, empresaB, rol[0].id]);

  // Con el 2FA apagado, el login normal de una cuenta con dos empresas entrega un preAuthToken.
  const antes = await loginPaso1(cuenta);
  assert.equal(antes.cuerpo.requiereSeleccionEmpresa, true);
  const preAuthViejo = antes.cuerpo.preAuthToken;

  // La persona entra (otro login) y activa el 2FA.
  const otro = await loginPaso1(cuenta);
  const sesion = await api('POST', '/api/auth/login/empresa', { body: { preAuthToken: otro.cuerpo.preAuthToken, empresa_id: empresaId } });
  assert.equal(sesion.status, 200, 'sin 2FA activo, el selector funciona como siempre');
  const { secreto } = await activar2FA(sesion.cuerpo.token);

  // El token viejo (sin mfa) ya no vale: habría dado sesión sin pedir el código.
  const rBypass = await api('POST', '/api/auth/login/empresa', { body: { preAuthToken: preAuthViejo, empresa_id: empresaId } });
  assert.equal(rBypass.status, 401);
  assert.equal(rBypass.cuerpo.token, undefined);

  // El camino legítimo (con el código) sí llega, y su preAuthToken lleva mfa.
  const desafio = (await loginPaso1(cuenta)).cuerpo.desafioToken;
  const conCodigo = await api('POST', '/api/auth/login/2fa', { body: { desafioToken: desafio, codigo: siguiente(secreto) } });
  assert.equal(jwt.decode(conCodigo.cuerpo.preAuthToken).mfa, true);
  const rOk = await api('POST', '/api/auth/login/empresa', { body: { preAuthToken: conCodigo.cuerpo.preAuthToken, empresa_id: empresaB } });
  assert.equal(rOk.status, 200);
});

test('desactivar: pide contraseña Y código; con algo mal no cambia nada; al lograrlo se borra todo', async () => {
  const { cuenta, token } = await cuentaConPlan('2fa-desactivar');
  assert.equal((await api('POST', '/api/2fa/desactivar', { token, body: { password: PASSWORD_QA, codigo: '123456' } })).status, 409, 'sin 2FA activo no hay qué desactivar');
  const { secreto } = await activar2FA(token);

  assert.equal((await api('POST', '/api/2fa/desactivar', { token, body: { codigo: siguiente(secreto) } })).status, 400, 'sin contraseña');
  const rPassMal = await api('POST', '/api/2fa/desactivar', { token, body: { password: 'OtraClave123', codigo: siguiente(secreto) } });
  assert.equal(rPassMal.status, 403, 'nunca 401: en el frontend un 401 significa sesión vencida y cerraría la sesión');
  assert.equal(rPassMal.cuerpo.error, 'Contraseña incorrecta.');
  const rCodigoMal = await api('POST', '/api/2fa/desactivar', { token, body: { password: PASSWORD_QA, codigo: codigoIncorrecto(secreto) } });
  assert.equal(rCodigoMal.status, 403);
  assert.equal((await api('GET', '/api/2fa/estado', { token })).cuerpo.activado, true, 'sigue activo tras los intentos fallidos');

  // La contraseña mal NO gastó el código: este sigue sirviendo.
  const rBien = await api('POST', '/api/2fa/desactivar', { token, body: { password: PASSWORD_QA, codigo: siguiente(secreto) } });
  assert.equal(rBien.status, 200);

  const { rows } = await pool.query('SELECT totp_secreto_cifrado, totp_activado_el, totp_ultimo_paso FROM usuarios WHERE id = $1', [cuenta.usuarioId]);
  assert.deepEqual(rows[0], { totp_secreto_cifrado: null, totp_activado_el: null, totp_ultimo_paso: null });
  const { rows: codigos } = await pool.query('SELECT count(*)::int AS n FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [cuenta.usuarioId]);
  assert.equal(codigos[0].n, 0);

  const rLogin = await loginPaso1(cuenta);
  assert.ok(rLogin.cuerpo.token && !rLogin.cuerpo.requiere2FA, 'ya no pide código');
});

test('bajar de plan NO apaga el 2FA ya activado (sigue exigido y se puede desactivar)', async () => {
  const { empresaId, cuenta, token } = await cuentaConPlan('2fa-downgrade');
  const { secreto } = await activar2FA(token);
  await asignarPlan(empresaId, 'Básico');

  assert.equal((await loginPaso1(cuenta)).cuerpo.requiere2FA, true, 'la protección se mantiene');
  const estado = await api('GET', '/api/2fa/estado', { token });
  assert.equal(estado.cuerpo.activado, true);
  assert.equal(estado.cuerpo.disponible, false);
  assert.equal(estado.cuerpo.planIncluye, false);

  const rDes = await api('POST', '/api/2fa/desactivar', { token, body: { password: PASSWORD_QA, codigo: siguiente(secreto) } });
  assert.equal(rDes.status, 200, 'desactivarlo siempre se puede, sin importar el plan');
});

test('restablecer 2FA (admin): apaga el de otra persona de SU empresa, queda auditado y nunca toca a otras empresas ni a uno mismo', async () => {
  const admin = await cuentaConPlan('2fa-reset');
  const otraEmpresa = await cuentaConPlan('2fa-reset-ajena');
  const ventas = await crearUsuario(ctx, { empresaId: admin.empresaId, rolNombre: 'ventas' });
  const tokenVentas = (await loginPaso1(ventas)).cuerpo.token;
  const { secreto } = await activar2FA(tokenVentas);

  const lista = await api('GET', '/api/usuarios', { token: admin.token });
  const fila = lista.cuerpo.find(u => u.id === ventas.usuarioId);
  assert.equal(fila.tiene_2fa, true);
  assert.equal(lista.cuerpo.find(u => u.id === admin.cuenta.usuarioId).tiene_2fa, false);
  const crudo = JSON.stringify(lista.cuerpo);
  assert.ok(!crudo.includes('totp_secreto') && !crudo.includes(secreto), 'la lista nunca expone secretos');

  assert.equal((await api('POST', `/api/usuarios/${ventas.usuarioId}/reset-2fa`, { token: tokenVentas })).status, 403, 'sin usuarios.editar, no');
  assert.equal((await api('POST', `/api/usuarios/${admin.cuenta.usuarioId}/reset-2fa`, { token: admin.token })).status, 400, 'a uno mismo, no');
  assert.equal((await api('POST', `/api/usuarios/${ventas.usuarioId}/reset-2fa`, { token: otraEmpresa.token })).status, 404, 'otra empresa: ni confirma que existe');
  assert.equal((await api('POST', '/api/usuarios/abc/reset-2fa', { token: admin.token })).status, 400);
  assert.equal((await loginPaso1(ventas)).cuerpo.requiere2FA, true, 'los intentos rechazados no cambiaron nada');

  const r = await api('POST', `/api/usuarios/${ventas.usuarioId}/reset-2fa`, { token: admin.token });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.teniaActivo, true);
  const rLogin = await loginPaso1(ventas);
  assert.ok(rLogin.cuerpo.token && !rLogin.cuerpo.requiere2FA);
  const { rows: codigos } = await pool.query('SELECT count(*)::int AS n FROM codigos_recuperacion_2fa WHERE usuario_id = $1', [ventas.usuarioId]);
  assert.equal(codigos[0].n, 0);
  assert.ok(await esperarAuditoria(admin.empresaId, 'reset_2fa') >= 1);

  const rDeNuevo = await api('POST', `/api/usuarios/${ventas.usuarioId}/reset-2fa`, { token: admin.token });
  assert.equal(rDeNuevo.status, 200);
  assert.equal(rDeNuevo.cuerpo.teniaActivo, false, 'idempotente');
});

test('super admin: fuera del 2FA en esta versión (su login no se desafía y no usa estas rutas)', async () => {
  const email = `qa-test-2fa-superadmin-${Date.now()}@example.invalid`;
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, activo, es_super_admin, totp_activado_el, totp_secreto_cifrado)
     VALUES ('QA-TEST (borrar) superadmin 2fa', $1, $2, true, true, now(), 'v1:x:y:z') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD_QA, 10)]
  );
  ctx.usuarioIds.push(rows[0].id);

  const rLogin = await api('POST', '/api/auth/login', { body: { email, password: PASSWORD_QA } });
  assert.ok(rLogin.cuerpo.token && !rLogin.cuerpo.requiere2FA);
  assert.equal((await api('GET', '/api/2fa/estado', { token: rLogin.cuerpo.token })).status, 401, 'sin empresa, no entra a rutas de empresa');
});

test('sesión de soporte (super admin impersonando): no puede tocar el 2FA de nadie', async () => {
  const email = `qa-test-2fa-soporte-${Date.now()}@example.invalid`;
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, activo, es_super_admin) VALUES ('QA-TEST (borrar) soporte 2fa', $1, $2, true, true) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD_QA, 10)]
  );
  ctx.usuarioIds.push(rows[0].id);
  const tokenSuper = (await api('POST', '/api/auth/login', { body: { email, password: PASSWORD_QA } })).cuerpo.token;

  const empresaId = await crearEmpresa(ctx, '2fa-soporte');
  await asignarPlan(empresaId, 'Empresarial');
  const rImpersonar = await api('POST', `/api/superadmin/empresas/${empresaId}/impersonar`, { token: tokenSuper, body: { motivo: 'Prueba QA de 2FA' } });
  assert.equal(rImpersonar.status, 200);
  const tokenSoporte = rImpersonar.cuerpo.token;

  for (const [metodo, ruta] of [['GET', '/api/2fa/estado'], ['POST', '/api/2fa/iniciar'], ['POST', '/api/2fa/activar'], ['POST', '/api/2fa/desactivar']]) {
    assert.equal((await api(metodo, ruta, { token: tokenSoporte, body: {} })).status, 403, `${metodo} ${ruta}`);
  }
});

test('sin TOTP_ENCRYPTION_KEY el 2FA queda apagado (503) y el login normal no se ve afectado', async () => {
  const sinClave = await iniciarServidorTest({ TOTP_ENCRYPTION_KEY: null });
  try {
    const empresaId = await crearEmpresa(ctx, '2fa-sin-clave');
    await asignarPlan(empresaId, 'Empresarial');
    const cuenta = await crearUsuario(ctx, { empresaId });
    const rLogin = await api('POST', '/api/auth/login', { base: sinClave.baseUrl, body: { email: cuenta.email, password: cuenta.password } });
    assert.ok(rLogin.cuerpo.token, 'el login sigue funcionando');

    const estado = await api('GET', '/api/2fa/estado', { base: sinClave.baseUrl, token: rLogin.cuerpo.token });
    assert.equal(estado.cuerpo.servidorConfigurado, false);
    assert.equal(estado.cuerpo.disponible, false);
    const rIniciar = await api('POST', '/api/2fa/iniciar', { base: sinClave.baseUrl, token: rLogin.cuerpo.token });
    assert.equal(rIniciar.status, 503);
    const { rows } = await pool.query('SELECT totp_secreto_cifrado FROM usuarios WHERE id = $1', [cuenta.usuarioId]);
    assert.equal(rows[0].totp_secreto_cifrado, null, 'nunca se guarda un secreto sin poder cifrarlo');
  } finally {
    await sinClave.detener();
  }
});
