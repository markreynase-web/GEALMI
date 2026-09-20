// tests/notificaciones.test.js
// Paso 6 -- notificaciones en base de datos y mensajes entre usuarios. Flujo
// completo contra un servidor real sobre la base de pruebas: enviar a personas,
// un rol, una sucursal o todos; leer y dar "Enterado"; aislamiento entre
// empresas; permisos; y los cuatro avisos automáticos (stock bajo, arqueo con
// diferencia, caja abierta demasiadas horas, vencimientos).
// Cada test arma su propia empresa: así los conteos de "sin leer" no dependen
// de lo que dejó otro test. El servidor de prueba corre el barrido periódico en
// cada consulta (NOTIFICACIONES_REVISION_MIN=0) en vez de cada 10 minutos.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import {
  nuevoContexto, crearEmpresa, crearSucursal, crearUsuario, crearProducto, crearCliente, crearCaja, login, limpiarContexto
} from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

before(async () => { servidor = await iniciarServidorTest({ NOTIFICACIONES_REVISION_MIN: '0' }); });
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

// Quién puede ser parte de una empresa de prueba. sucursal: 2 o 3 = atado a esa sede adicional.
const PERFILES = {
  admin: { rolNombre: 'administrador' },
  gerente: { rolNombre: 'gerente' },
  supervisor: { rolNombre: 'supervisor' },
  ventas1: { rolNombre: 'ventas' },
  ventas2: { rolNombre: 'ventas' },
  inventario: { rolNombre: 'inventario' },
  inactivo: { rolNombre: 'ventas', activo: false },
  ventasSuc2: { rolNombre: 'ventas', sucursal: 2 },
  ventasSuc3: { rolNombre: 'ventas', sucursal: 3 },
  supervisorSuc2: { rolNombre: 'supervisor', sucursal: 2 }
};

async function montarEmpresa(sufijo, quienes) {
  const empresaId = await crearEmpresa(ctx, `notif-${sufijo}`);
  const e = { empresaId, sucursal: {} };
  for (const quien of quienes) {
    const perfil = PERFILES[quien];
    if (perfil.sucursal && !e.sucursal[perfil.sucursal]) e.sucursal[perfil.sucursal] = await crearSucursal(ctx, empresaId, `Sede ${perfil.sucursal}`);
    const cuenta = await crearUsuario(ctx, {
      empresaId, rolNombre: perfil.rolNombre, activo: perfil.activo ?? true,
      sucursalId: perfil.sucursal ? e.sucursal[perfil.sucursal] : null
    });
    e[quien] = { ...cuenta, token: perfil.activo === false ? null : await login(servidor.baseUrl, cuenta.email, cuenta.password) };
  }
  return e;
}

const resumen = async (persona) => (await api('GET', '/api/notificaciones/resumen', { token: persona.token })).cuerpo;

function enviar(remitente, destino, extra = {}) {
  return api('POST', '/api/notificaciones/mensajes', { token: remitente.token, body: { destino, titulo: 'Aviso de prueba', ...extra } });
}

// Los avisos automáticos se crean después de responder la venta/cierre: se espera un instante.
async function esperar(condicion, { intentos = 40, cadaMs = 100 } = {}) {
  for (let i = 0; i < intentos; i++) {
    const valor = await condicion();
    if (valor) return valor;
    await new Promise(r => setTimeout(r, cadaMs));
  }
  return null;
}

const hoy = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Mensajes entre usuarios
// ---------------------------------------------------------------------------

test('un mensaje llega solo a quien va dirigido, sin leer, con su enlace y su marca de importante', async () => {
  const E = await montarEmpresa('basico', ['admin', 'ventas1', 'ventas2']);
  const r = await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, {
    titulo: 'Revisa tu caja', cuerpo: 'Faltó cerrar el turno de ayer', enlace: 'cajas', prioridad: 'alta'
  });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  assert.equal(r.cuerpo.destinatarios, 1);
  assert.match(r.cuerpo.lote, UUID);

  const recibida = await resumen(E.ventas1);
  assert.equal(recibida.no_leidas, 1);
  assert.equal(recibida.pendientes_enterado, 1);
  assert.equal(recibida.recientes.length, 1);
  assert.equal(recibida.importantes.length, 1);
  const n = recibida.recientes[0];
  assert.equal(n.titulo, 'Revisa tu caja');
  assert.equal(n.cuerpo, 'Faltó cerrar el turno de ayer');
  assert.equal(n.enlace, 'cajas');
  assert.equal(n.tipo, 'mensaje');
  assert.equal(n.prioridad, 'alta');
  assert.equal(n.leida, false);
  assert.equal(n.requiere_enterado, true);
  assert.equal(typeof n.remitente_nombre, 'string');

  // Ni el que lo mandó ni otro compañero reciben nada.
  assert.equal((await resumen(E.admin)).no_leidas, 0);
  assert.equal((await resumen(E.ventas2)).no_leidas, 0);

  const lista = await api('GET', '/api/notificaciones', { token: E.ventas1.token });
  assert.equal(lista.status, 200);
  assert.equal(lista.cuerpo.total, 1);
  assert.equal(lista.cuerpo.datos[0].titulo, 'Revisa tu caja');
});

test('leer no es enterarse: la importante sigue pendiente hasta dar "Enterado"', async () => {
  const E = await montarEmpresa('enterado', ['admin', 'ventas1']);
  await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: 'Urgente', prioridad: 'alta' });
  const id = (await resumen(E.ventas1)).recientes[0].id;

  const leer = await api('POST', '/api/notificaciones/leer', { token: E.ventas1.token, body: { ids: [id] } });
  assert.equal(leer.cuerpo.actualizadas, 1);
  let r = await resumen(E.ventas1);
  assert.equal(r.no_leidas, 0);
  assert.equal(r.pendientes_enterado, 1, 'leerla no la da por confirmada');
  assert.equal(r.importantes.length, 1);

  const ent = await api('POST', `/api/notificaciones/${id}/enterado`, { token: E.ventas1.token });
  assert.equal(ent.status, 200);
  assert.equal(ent.cuerpo.requiere_enterado, false);
  assert.ok(ent.cuerpo.enterado_el);
  r = await resumen(E.ventas1);
  assert.equal(r.pendientes_enterado, 0);
  assert.deepEqual(r.importantes, []);
});

test('"Enterado" también la da por leída, y "marcar todas" limpia las que faltan', async () => {
  const E = await montarEmpresa('todas', ['admin', 'ventas1']);
  await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: 'Importante', prioridad: 'alta' });
  await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: 'Uno' });
  await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: 'Dos' });
  const importante = (await resumen(E.ventas1)).importantes[0];

  await api('POST', `/api/notificaciones/${importante.id}/enterado`, { token: E.ventas1.token });
  assert.equal((await resumen(E.ventas1)).no_leidas, 2, 'la confirmada ya no cuenta como sin leer');

  const todas = await api('POST', '/api/notificaciones/leer', { token: E.ventas1.token, body: { todas: true } });
  assert.equal(todas.cuerpo.actualizadas, 2);
  assert.equal((await resumen(E.ventas1)).no_leidas, 0);

  const sinLeer = await api('GET', '/api/notificaciones?estado=sin_leer', { token: E.ventas1.token });
  assert.equal(sinLeer.cuerpo.total, 0);
  const todasLista = await api('GET', '/api/notificaciones?estado=todas', { token: E.ventas1.token });
  assert.equal(todasLista.cuerpo.total, 3);
  assert.equal((await api('GET', '/api/notificaciones?estado=inventada', { token: E.ventas1.token })).status, 400);
});

test('aislamiento: nadie lee, marca ni confirma la notificación de otra persona ni de otra empresa', async () => {
  const A = await montarEmpresa('aislaA', ['admin', 'ventas1', 'ventas2']);
  const B = await montarEmpresa('aislaB', ['admin', 'ventas1']);
  await enviar(A.admin, { tipo: 'usuarios', ids: [A.ventas1.usuarioId] }, { titulo: 'Solo para A1', prioridad: 'alta' });
  const id = (await resumen(A.ventas1)).recientes[0].id;

  for (const intruso of [B.ventas1, B.admin, A.ventas2]) {
    const leer = await api('POST', '/api/notificaciones/leer', { token: intruso.token, body: { ids: [id] } });
    assert.equal(leer.cuerpo.actualizadas, 0, 'no toca filas ajenas');
    const ent = await api('POST', `/api/notificaciones/${id}/enterado`, { token: intruso.token });
    assert.equal(ent.status, 404, 'un id ajeno se ve igual que uno que no existe');
    assert.equal((await api('GET', '/api/notificaciones', { token: intruso.token })).cuerpo.total, 0);
  }
  const intacta = await resumen(A.ventas1);
  assert.equal(intacta.no_leidas, 1);
  assert.equal(intacta.pendientes_enterado, 1);

  // Un envío a "todos" o a un rol de A jamás cruza a B, y los ids de B no sirven desde A.
  const todosA = await enviar(A.admin, { tipo: 'todos' }, { titulo: 'Para todo A' });
  assert.equal(todosA.cuerpo.destinatarios, 2);
  const rolA = await enviar(A.admin, { tipo: 'rol', rol: 'ventas' }, { titulo: 'Rol A' });
  assert.equal(rolA.cuerpo.destinatarios, 2);
  assert.equal((await resumen(B.ventas1)).no_leidas, 0);
  assert.equal((await resumen(B.admin)).no_leidas, 0);
  const cruzado = await enviar(A.admin, { tipo: 'usuarios', ids: [B.ventas1.usuarioId] });
  assert.equal(cruzado.status, 400);
  assert.match(cruzado.cuerpo.error, /no hay destinatarios/i);
  assert.equal((await resumen(B.ventas1)).no_leidas, 0);
});

test('destinos: personas, rol, sucursal y todos (sin el remitente, sin cuentas inactivas)', async () => {
  const E = await montarEmpresa('destinos', ['admin', 'ventas1', 'ventas2', 'ventasSuc2', 'inventario', 'inactivo']);

  const rol = await enviar(E.admin, { tipo: 'rol', rol: 'ventas' }, { titulo: 'Rol ventas' });
  assert.equal(rol.cuerpo.destinatarios, 3, 'ventas1, ventas2 y ventasSuc2; la cuenta inactiva no cuenta');
  assert.equal((await resumen(E.inventario)).no_leidas, 0);

  const sede = await enviar(E.admin, { tipo: 'sucursal', sucursal_id: E.sucursal[2] }, { titulo: 'Solo sede 2' });
  assert.equal(sede.cuerpo.destinatarios, 1);
  assert.equal((await resumen(E.ventasSuc2)).no_leidas, 2, 'rol + sede');
  assert.equal((await resumen(E.ventas1)).no_leidas, 1, 'solo el mensaje del rol');

  const todos = await enviar(E.admin, { tipo: 'todos' }, { titulo: 'Para todos' });
  assert.equal(todos.cuerpo.destinatarios, 4, 'ventas1, ventas2, ventasSuc2 e inventario; ni el remitente ni la cuenta inactiva');
  assert.equal((await resumen(E.admin)).no_leidas, 0, 'el remitente no se avisa a sí mismo');
  assert.equal((await resumen(E.inventario)).no_leidas, 1);

  const varios = await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId, E.ventas2.usuarioId, E.admin.usuarioId] }, { titulo: 'Dos personas' });
  assert.equal(varios.cuerpo.destinatarios, 2, 'incluir al remitente en la lista no lo suma');

  const sinNadie = await enviar(E.admin, { tipo: 'rol', rol: 'rol-que-no-existe' });
  assert.equal(sinNadie.status, 400);
});

test('permisos: solo quien tiene mensajes.enviar manda y consulta lo enviado', async () => {
  const E = await montarEmpresa('permisos', ['admin', 'gerente', 'supervisor', 'ventas1']);
  const destino = { tipo: 'usuarios', ids: [E.ventas1.usuarioId] };

  assert.equal((await api('POST', '/api/notificaciones/mensajes', { body: { destino, titulo: 'x' } })).status, 401);
  for (const [metodo, ruta] of [['POST', '/api/notificaciones/mensajes'], ['GET', '/api/notificaciones/enviados'], ['GET', '/api/notificaciones/destinatarios']]) {
    const r = await api(metodo, ruta, { token: E.ventas1.token, body: { destino, titulo: 'x' } });
    assert.equal(r.status, 403, `${metodo} ${ruta}`);
  }
  for (const quien of [E.admin, E.gerente, E.supervisor]) {
    assert.equal((await enviar(quien, destino)).status, 201);
  }
  // Recibir y leer lo propio no pide permiso.
  assert.equal((await api('GET', '/api/notificaciones/resumen', { token: E.ventas1.token })).status, 200);
});

test('validaciones del mensaje: título, largo, prioridad, enlace y destino', async () => {
  const E = await montarEmpresa('valida', ['admin', 'ventas1']);
  const destino = { tipo: 'usuarios', ids: [E.ventas1.usuarioId] };
  const malos = [
    ['sin título', { destino }],
    ['título en blanco', { destino, titulo: '   ' }],
    ['título de 121 caracteres', { destino, titulo: 'x'.repeat(121) }],
    ['cuerpo de 2001 caracteres', { destino, titulo: 'ok', cuerpo: 'x'.repeat(2001) }],
    ['cuerpo que no es texto', { destino, titulo: 'ok', cuerpo: 42 }],
    ['prioridad inventada', { destino, titulo: 'ok', prioridad: 'urgente' }],
    ['enlace javascript:', { destino, titulo: 'ok', enlace: 'javascript:alert(1)' }],
    ['enlace a otro sitio', { destino, titulo: 'ok', enlace: '//evil.example' }],
    ['enlace con URL completa', { destino, titulo: 'ok', enlace: 'https://evil.example' }],
    ['enlace que sube de carpeta', { destino, titulo: 'ok', enlace: '../cajas' }],
    ['enlace con mayúsculas', { destino, titulo: 'ok', enlace: 'Cajas' }],
    ['enlace muy largo', { destino, titulo: 'ok', enlace: 'a'.repeat(41) }],
    ['sin destino', { titulo: 'ok' }],
    ['tipo de destino inventado', { destino: { tipo: 'nadie' }, titulo: 'ok' }],
    ['personas sin elegir', { destino: { tipo: 'usuarios', ids: [] }, titulo: 'ok' }],
    ['ids que no son números', { destino: { tipo: 'usuarios', ids: ['1; DROP TABLE usuarios'] }, titulo: 'ok' }],
    ['rol vacío', { destino: { tipo: 'rol', rol: '' }, titulo: 'ok' }],
    ['sucursal que no es número', { destino: { tipo: 'sucursal', sucursal_id: 'todas' }, titulo: 'ok' }]
  ];
  for (const [nombre, body] of malos) {
    const r = await api('POST', '/api/notificaciones/mensajes', { token: E.admin.token, body });
    assert.equal(r.status, 400, `${nombre}: ${JSON.stringify(r.cuerpo)}`);
  }
  assert.equal((await resumen(E.ventas1)).no_leidas, 0, 'ningún intento inválido llegó a nadie');

  const bueno = await enviar(E.admin, destino, { titulo: 'x'.repeat(120), cuerpo: 'x'.repeat(2000), enlace: 'planes-membresia' });
  assert.equal(bueno.status, 201, JSON.stringify(bueno.cuerpo));
});

test('el texto del mensaje se guarda tal cual: escaparlo al mostrarlo es cosa de la pantalla', async () => {
  const E = await montarEmpresa('xss', ['admin', 'ventas1']);
  const peligroso = '<img src=x onerror=alert(1)>';
  await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: peligroso, cuerpo: '<script>1</script>' });
  const n = (await resumen(E.ventas1)).recientes[0];
  assert.equal(n.titulo, peligroso);
  assert.equal(n.cuerpo, '<script>1</script>');
});

test('la lista de destinatarios: solo gente activa de la empresa; un remitente atado a una sede solo ve su sede y a quien no tiene sede', async () => {
  const E = await montarEmpresa('lista', ['admin', 'ventas1', 'ventasSuc2', 'ventasSuc3', 'supervisorSuc2', 'inactivo']);

  const completa = (await api('GET', '/api/notificaciones/destinatarios', { token: E.admin.token })).cuerpo;
  assert.deepEqual(completa.usuarios.map(u => u.id).sort((a, b) => a - b),
    [E.ventas1, E.ventasSuc2, E.ventasSuc3, E.supervisorSuc2].map(u => u.usuarioId).sort((a, b) => a - b),
    'sin él mismo ni la cuenta inactiva');
  assert.ok(completa.roles.some(r => r.nombre === 'ventas' && r.cantidad === 3));
  assert.equal(completa.sucursales.length, 3);

  const acotada = (await api('GET', '/api/notificaciones/destinatarios', { token: E.supervisorSuc2.token })).cuerpo;
  assert.deepEqual(acotada.usuarios.map(u => u.id).sort((a, b) => a - b),
    [E.admin, E.ventas1, E.ventasSuc2].map(u => u.usuarioId).sort((a, b) => a - b),
    'su sede y quienes no tienen sede fija; no la sede 3');
  assert.deepEqual(acotada.sucursales.map(s => s.id), [E.sucursal[2]]);

  const aTodos = await enviar(E.supervisorSuc2, { tipo: 'todos' }, { titulo: 'Desde la sede 2' });
  assert.equal(aTodos.cuerpo.destinatarios, 3);
  assert.equal((await resumen(E.ventasSuc3)).no_leidas, 0, 'la otra sede no recibe');
  assert.equal((await resumen(E.ventasSuc2)).no_leidas, 1);
});

test('seguimiento del remitente: entregado, leído y enterado por persona; nadie más lo ve', async () => {
  const E = await montarEmpresa('segui', ['admin', 'supervisor', 'ventas1', 'ventas2']);
  const r = await enviar(E.admin, { tipo: 'usuarios', ids: [E.ventas1.usuarioId, E.ventas2.usuarioId] }, { titulo: 'Confirmen', prioridad: 'alta', enlace: 'cajas' });
  const lote = r.cuerpo.lote;

  const estado = async () => (await api('GET', '/api/notificaciones/enviados', { token: E.admin.token })).cuerpo[0];
  let e = await estado();
  assert.equal(e.lote, lote);
  assert.equal(e.titulo, 'Confirmen');
  assert.equal(e.destinatarios, 2);
  assert.deepEqual([e.entregadas, e.leidas, e.enteradas], [0, 0, 0]);

  const id1 = (await resumen(E.ventas1)).recientes[0].id; // consultar = entregada
  e = await estado();
  assert.deepEqual([e.entregadas, e.leidas, e.enteradas], [1, 0, 0]);
  await api('POST', '/api/notificaciones/leer', { token: E.ventas1.token, body: { ids: [id1] } });
  e = await estado();
  assert.deepEqual([e.entregadas, e.leidas, e.enteradas], [1, 1, 0]);
  await api('POST', `/api/notificaciones/${id1}/enterado`, { token: E.ventas1.token });
  await resumen(E.ventas2);
  e = await estado();
  assert.deepEqual([e.entregadas, e.leidas, e.enteradas], [2, 1, 1]);

  const detalle = await api('GET', `/api/notificaciones/enviados/${lote}`, { token: E.admin.token });
  assert.equal(detalle.status, 200);
  assert.equal(detalle.cuerpo.titulo, 'Confirmen');
  assert.equal(detalle.cuerpo.destinatarios.length, 2);
  assert.equal(detalle.cuerpo.destinatarios.filter(d => d.enterado_el).length, 1);
  assert.ok(detalle.cuerpo.destinatarios.every(d => d.entregada_el));

  // Otro con permiso de enviar no ve lo ajeno; un uuid mal formado o inexistente tampoco.
  assert.deepEqual((await api('GET', '/api/notificaciones/enviados', { token: E.supervisor.token })).cuerpo, []);
  assert.equal((await api('GET', `/api/notificaciones/enviados/${lote}`, { token: E.supervisor.token })).status, 404);
  assert.equal((await api('GET', '/api/notificaciones/enviados/no-es-un-uuid', { token: E.admin.token })).status, 404);
  assert.equal((await api('GET', '/api/notificaciones/enviados/00000000-0000-4000-8000-000000000000', { token: E.admin.token })).status, 404);
});

test('una sesión de soporte (super admin impersonando) no puede mandar mensajes', async () => {
  const E = await montarEmpresa('soporte', ['admin', 'ventas1']);
  const tokenSoporte = jwt.sign({
    id: E.admin.usuarioId, nombre: 'Soporte', empresa_id: E.empresaId, rol: 'administrador',
    permisos: ['mensajes.enviar'], impersonando: true
  }, process.env.JWT_SECRET, { expiresIn: 600 });
  const r = await api('POST', '/api/notificaciones/mensajes', {
    token: tokenSoporte, body: { destino: { tipo: 'todos' }, titulo: 'Desde soporte' }
  });
  assert.equal(r.status, 403);
  assert.equal((await resumen(E.ventas1)).no_leidas, 0);
  assert.equal((await api('GET', '/api/notificaciones/resumen', { token: tokenSoporte })).status, 200);
});

test('límite de envíos: a los 20 mensajes en 10 minutos el siguiente se rechaza', async () => {
  const E = await montarEmpresa('limite', ['supervisor', 'ventas1']);
  for (let i = 1; i <= 20; i++) {
    const r = await enviar(E.supervisor, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] }, { titulo: `Mensaje ${i}` });
    assert.equal(r.status, 201, `el ${i} debería pasar`);
  }
  assert.equal((await enviar(E.supervisor, { tipo: 'usuarios', ids: [E.ventas1.usuarioId] })).status, 429);
});

test('si se borra a alguien: sus notificaciones se van con él, y lo que mandó queda con el nombre congelado', async () => {
  const E = await montarEmpresa('borrado', ['admin', 'ventas1', 'ventas2']);
  await enviar(E.admin, { tipo: 'todos' }, { titulo: 'Para dos' });
  assert.equal((await resumen(E.ventas2)).no_leidas, 1);

  await pool.query(`DELETE FROM usuario_empresa WHERE usuario_id = $1`, [E.admin.usuarioId]);
  await pool.query(`DELETE FROM usuarios WHERE id = $1`, [E.admin.usuarioId]);
  const { rows } = await pool.query(`SELECT remitente_id, remitente_nombre FROM notificaciones WHERE usuario_id = $1`, [E.ventas2.usuarioId]);
  assert.equal(rows.length, 1, 'la notificación del que recibe sigue ahí');
  assert.equal(rows[0].remitente_id, null);
  assert.ok(rows[0].remitente_nombre, 'con el nombre de quien la mandó');

  await pool.query(`DELETE FROM usuario_empresa WHERE usuario_id = $1`, [E.ventas1.usuarioId]);
  await pool.query(`DELETE FROM usuarios WHERE id = $1`, [E.ventas1.usuarioId]);
  const { rows: propias } = await pool.query(`SELECT 1 FROM notificaciones WHERE usuario_id = $1`, [E.ventas1.usuarioId]);
  assert.equal(propias.length, 0, 'sin la persona no queda nada suyo');
});

// ---------------------------------------------------------------------------
// Avisos automáticos
// ---------------------------------------------------------------------------

test('stock bajo al vender: avisa a quien repone, una vez por día, y "Sin stock" al llegar a cero', async () => {
  const E = await montarEmpresa('stock', ['admin', 'ventas1', 'inventario']);
  const clienteId = await crearCliente(ctx, E.empresaId);
  const productoId = await crearProducto(ctx, E.empresaId, { nombre: 'Leche', stock: 10, precio_unitario: 100 });
  await pool.query(`UPDATE inventario SET stock_minimo = 5 WHERE id = $1`, [productoId]);
  const vender = (cantidad) => api('POST', '/api/ventas', {
    token: E.ventas1.token,
    body: { fecha: hoy(), cliente_id: clienteId, producto_id: productoId, cantidad, precio_unitario: 100 }
  });

  assert.equal((await vender(3)).status, 201); // quedan 7: sobre el mínimo
  assert.equal((await vender(3)).status, 201); // quedan 4: bajo el mínimo
  const bajo = await esperar(async () => (await resumen(E.admin)).recientes.find(n => n.tipo === 'stock_bajo'));
  assert.ok(bajo, 'el administrador debería recibir el aviso');
  assert.match(bajo.titulo, /Stock bajo: .*Leche/);
  assert.match(bajo.cuerpo, /Quedan 4 unidad/);
  assert.match(bajo.cuerpo, /mínimo configurado es 5/);
  assert.equal(bajo.enlace, 'inventario');
  assert.equal(bajo.prioridad, 'normal');
  assert.ok(await esperar(async () => (await resumen(E.inventario)).recientes.find(n => n.tipo === 'stock_bajo')), 'y el de inventario');
  assert.equal((await resumen(E.ventas1)).no_leidas, 0, 'quien vende pero no repone no recibe el aviso');

  assert.equal((await vender(1)).status, 201); // quedan 3: el mismo día no repite
  await new Promise(r => setTimeout(r, 400));
  const repetidas = (await api('GET', '/api/notificaciones', { token: E.admin.token })).cuerpo.datos.filter(n => n.tipo === 'stock_bajo');
  assert.equal(repetidas.length, 1);

  assert.equal((await vender(3)).status, 201); // quedan 0
  const agotado = await esperar(async () => (await resumen(E.admin)).recientes.find(n => /^Sin stock/.test(n.titulo)));
  assert.ok(agotado, 'al agotarse hay un aviso más fuerte');
  assert.equal(agotado.prioridad, 'alta');
});

test('sin stock mínimo configurado no hay aviso (stock_minimo = 0 significa "nunca lo definieron")', async () => {
  const E = await montarEmpresa('sinmin', ['admin', 'ventas1']);
  const clienteId = await crearCliente(ctx, E.empresaId);
  const productoId = await crearProducto(ctx, E.empresaId, { nombre: 'Suelto', stock: 2, precio_unitario: 100 });
  const r = await api('POST', '/api/ventas', {
    token: E.ventas1.token,
    body: { fecha: hoy(), cliente_id: clienteId, producto_id: productoId, cantidad: 2, precio_unitario: 100 }
  });
  assert.equal(r.status, 201);
  await new Promise(res => setTimeout(res, 500));
  assert.equal((await resumen(E.admin)).no_leidas, 0);
});

test('arqueo con diferencia: avisa a quienes administran cajas (menos a quien cerró) y solo si hay diferencia', async () => {
  const E = await montarEmpresa('arqueo', ['admin', 'gerente', 'ventas1']);
  const cajaId = await crearCaja(ctx, E.empresaId, { nombre: 'Caja 1' });

  const abrir = await api('POST', `/api/cajas/${cajaId}/turnos`, { token: E.ventas1.token, body: { monto_apertura: 100 } });
  assert.equal(abrir.status, 201, JSON.stringify(abrir.cuerpo));
  const cerrar = await api('PUT', `/api/cajas/turnos/${abrir.cuerpo.id}/cerrar`, { token: E.gerente.token, body: { monto_cierre_declarado: 90 } });
  assert.equal(cerrar.status, 200, JSON.stringify(cerrar.cuerpo));
  assert.equal(Number(cerrar.cuerpo.diferencia), -10);

  const aviso = await esperar(async () => (await resumen(E.admin)).recientes.find(n => n.tipo === 'arqueo_diferencia'));
  assert.ok(aviso, 'el administrador debería recibirlo');
  assert.match(aviso.titulo, /Arqueo con diferencia: .*Caja 1/);
  assert.match(aviso.cuerpo, /Declaró S\/ 90\.00/);
  assert.match(aviso.cuerpo, /esperaba S\/ 100\.00/);
  assert.match(aviso.cuerpo, /faltan S\/ 10\.00/);
  assert.equal(aviso.prioridad, 'alta');
  assert.equal(aviso.enlace, 'cajas');
  assert.equal((await resumen(E.gerente)).no_leidas, 0, 'quien cerró ya vio el resultado');
  assert.equal((await resumen(E.ventas1)).no_leidas, 0, 'un cajero no administra cajas');

  // Un cierre exacto no genera aviso.
  const abrir2 = await api('POST', `/api/cajas/${cajaId}/turnos`, { token: E.ventas1.token, body: { monto_apertura: 50 } });
  const cerrar2 = await api('PUT', `/api/cajas/turnos/${abrir2.cuerpo.id}/cerrar`, { token: E.gerente.token, body: { monto_cierre_declarado: 50 } });
  assert.equal(Number(cerrar2.cuerpo.diferencia), 0);
  await new Promise(r => setTimeout(r, 500));
  const arqueos = (await api('GET', '/api/notificaciones', { token: E.admin.token })).cuerpo.datos.filter(n => n.tipo === 'arqueo_diferencia');
  assert.equal(arqueos.length, 1);

  // Sobrante: el mensaje dice "sobran".
  const abrir3 = await api('POST', `/api/cajas/${cajaId}/turnos`, { token: E.ventas1.token, body: { monto_apertura: 20 } });
  await api('PUT', `/api/cajas/turnos/${abrir3.cuerpo.id}/cerrar`, { token: E.gerente.token, body: { monto_cierre_declarado: 25.5 } });
  const sobra = await esperar(async () => (await resumen(E.admin)).recientes.find(n => /sobran S\/ 5\.50/.test(n.cuerpo || '')));
  assert.ok(sobra);
});

test('caja abierta demasiadas horas: avisa a quien la abrió y a quienes administran cajas, una sola vez', async () => {
  const E = await montarEmpresa('cajaabierta', ['admin', 'ventas1', 'ventas2']);
  const cajaVieja = await crearCaja(ctx, E.empresaId, { nombre: 'Caja vieja' });
  const cajaNueva = await crearCaja(ctx, E.empresaId, { nombre: 'Caja nueva' });
  await pool.query(
    `INSERT INTO turnos_caja (caja_id, empresa_id, usuario_apertura_id, monto_apertura, fecha_apertura)
     VALUES ($1, $2, $3, 0, now() - interval '13 hours 30 minutes'), ($4, $2, $3, 0, now() - interval '2 hours')`,
    [cajaVieja, E.empresaId, E.ventas1.usuarioId, cajaNueva]
  );

  const deAdmin = await esperar(async () => (await resumen(E.admin)).recientes.filter(n => n.tipo === 'caja_abierta'));
  assert.equal(deAdmin.length, 1, 'solo la caja de 13 horas y media, no la de 2');
  assert.match(deAdmin[0].titulo, /Caja abierta hace más de 13 horas: .*Caja vieja/);
  assert.equal(deAdmin[0].prioridad, 'alta');
  assert.equal(deAdmin[0].enlace, 'cajas');

  const deCajero = (await resumen(E.ventas1)).recientes.filter(n => n.tipo === 'caja_abierta');
  assert.equal(deCajero.length, 1, 'quien la abrió también');
  assert.equal((await resumen(E.ventas2)).no_leidas, 0, 'otro cajero no');

  await resumen(E.admin); // otra consulta = otro barrido: no duplica
  const total = (await api('GET', '/api/notificaciones', { token: E.admin.token })).cuerpo.datos.filter(n => n.tipo === 'caja_abierta');
  assert.equal(total.length, 1);
});

test('vencimientos: un solo aviso por día con lo que vence en la semana; no cuenta lo lejano ni lo sin stock', async () => {
  const E = await montarEmpresa('vence', ['admin', 'inventario', 'ventas1']);
  const pronto = await crearProducto(ctx, E.empresaId, { nombre: 'Yogur', stock: 5 });
  const tambienPronto = await crearProducto(ctx, E.empresaId, { nombre: 'Queso', stock: 2 });
  const lejano = await crearProducto(ctx, E.empresaId, { nombre: 'Arroz', stock: 5 });
  const sinStock = await crearProducto(ctx, E.empresaId, { nombre: 'Pan', stock: 0 });
  await pool.query(`UPDATE inventario SET fecha_vencimiento = CURRENT_DATE + 3 WHERE id = ANY($1::int[])`, [[pronto, tambienPronto, sinStock]]);
  await pool.query(`UPDATE inventario SET fecha_vencimiento = CURRENT_DATE + 30 WHERE id = $1`, [lejano]);

  const aviso = await esperar(async () => (await resumen(E.admin)).recientes.find(n => n.tipo === 'vencimientos'));
  assert.ok(aviso);
  assert.match(aviso.titulo, /^2 productos vencen en los próximos 7 días$/);
  assert.match(aviso.cuerpo, /Yogur/);
  assert.match(aviso.cuerpo, /Queso/);
  assert.doesNotMatch(aviso.cuerpo, /Arroz/);
  assert.doesNotMatch(aviso.cuerpo, /Pan/);
  assert.equal(aviso.enlace, 'inventario');
  assert.ok((await resumen(E.inventario)).recientes.find(n => n.tipo === 'vencimientos'), 'también quien repone');
  assert.equal((await resumen(E.ventas1)).no_leidas, 0);

  await resumen(E.admin);
  const total = (await api('GET', '/api/notificaciones', { token: E.admin.token })).cuerpo.datos.filter(n => n.tipo === 'vencimientos');
  assert.equal(total.length, 1, 'el mismo día no se repite');
});

test('las notificaciones de hace más de 90 días se borran solas', async () => {
  const E = await montarEmpresa('retencion', ['admin']);
  await pool.query(
    `INSERT INTO notificaciones (empresa_id, usuario_id, tipo, titulo, creada_el)
     VALUES ($1, $2, 'mensaje', 'Vieja', now() - interval '100 days'), ($1, $2, 'mensaje', 'Reciente', now() - interval '1 day')`,
    [E.empresaId, E.admin.usuarioId]
  );
  await resumen(E.admin); // el barrido corre en esta consulta
  const { rows } = await pool.query(`SELECT titulo FROM notificaciones WHERE empresa_id = $1 ORDER BY titulo`, [E.empresaId]);
  assert.deepEqual(rows.map(r => r.titulo), ['Reciente']);
});
