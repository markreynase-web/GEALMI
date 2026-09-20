// tests/marketing.test.js
// Paso 9 -- Marketing v1 contra un servidor real sobre la base de pruebas:
// la cadena Campaña -> Clientes objetivo -> Venta -> Resultado. Campañas y su
// validación, segmentación por criterios, lista de clientes con su avance,
// atribución de ventas (que es lo que convierte una campaña en un número),
// permisos y aislamiento entre empresas.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import {
  nuevoContexto, crearEmpresa, crearUsuario, crearProducto, crearCliente, login, limpiarContexto
} from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
let A, B, SIN_MODULO;

before(async () => {
  servidor = await iniciarServidorTest();
  A = await montarEmpresa('A', ['admin', 'gerente', 'supervisor', 'ventas', 'consulta'], ['ventas', 'inventario', 'clientes', 'marketing']);
  B = await montarEmpresa('B', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  SIN_MODULO = await montarEmpresa('sin-modulo', ['admin'], ['ventas', 'inventario', 'clientes']);
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

const ROLES = { admin: 'administrador', gerente: 'gerente', supervisor: 'supervisor', ventas: 'ventas', consulta: 'consulta' };
async function montarEmpresa(sufijo, quienes, modulos) {
  const empresaId = await crearEmpresa(ctx, `marketing-${sufijo}`, modulos);
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
async function nuevaCampana(E, extra = {}) {
  const r = await api('POST', '/api/marketing/campanas', { token: E.admin.token, body: { nombre: `Campaña QA ${++contador}`, canal: 'whatsapp', estado: 'activa', presupuesto: 200, ...extra } });
  assert.equal(r.status, 201, JSON.stringify(r.cuerpo));
  return r.cuerpo.id;
}
const detalle = async (E, id) => (await api('GET', `/api/marketing/campanas/${id}`, { token: E.admin.token })).cuerpo;

// Inserta directo una venta pasada (para armar el historial que usan los criterios de segmentación).
async function ventaAntigua(empresaId, clienteId, diasAtras, monto = 100) {
  await pool.query(
    `INSERT INTO ventas (fecha, cliente, cliente_id, producto, cantidad, precio_unitario, monto, empresa_id)
     VALUES ($1, 'QA', $2, 'Producto QA', 1, $3, $3, $4)`,
    [sumar(hoy(), -diasAtras), clienteId, monto, empresaId]
  );
}

// ---------------------------------------------------------------------------
// Campañas
// ---------------------------------------------------------------------------

test('crear, listar, editar y cambiar el estado de una campaña', async () => {
  const id = await nuevaCampana(A, { nombre: 'Verano 2026', descripcion: 'Liquidación', canal: 'correo', fecha_inicio: '2026-12-01', fecha_fin: '2026-12-31', presupuesto: 500, mensaje: 'Hola {nombre}, tenemos ofertas.', estado: 'borrador' });
  const lista = (await api('GET', '/api/marketing/campanas', { token: A.supervisor.token })).cuerpo;
  const c = lista.find(x => x.id === id);
  assert.equal(c.nombre, 'Verano 2026');
  assert.equal(c.canal, 'correo');
  assert.equal(c.estado, 'borrador');
  assert.equal(c.fecha_inicio, '2026-12-01');
  assert.equal(c.presupuesto, 500);
  assert.deepEqual([c.objetivo, c.contactados, c.respuestas, c.conversiones, c.ventas_generadas, c.ingresos], [0, 0, 0, 0, 0, 0]);
  assert.equal(c.retorno, 0, 'con presupuesto y sin ingresos, el retorno es 0');
  assert.equal(c.tasa_conversion, null, 'sin objetivo no hay tasa: "sin dato", no cero');
  assert.equal(c.costo_por_conversion, null);

  const edita = await api('PUT', `/api/marketing/campanas/${id}`, { token: A.gerente.token, body: { nombre: 'Verano 2026 (ampliada)', canal: 'whatsapp', estado: 'activa', presupuesto: 800, fecha_inicio: '2026-12-01', fecha_fin: '2027-01-15' } });
  assert.equal(edita.status, 200, JSON.stringify(edita.cuerpo));
  const d = await detalle(A, id);
  assert.equal(d.nombre, 'Verano 2026 (ampliada)');
  assert.equal(d.presupuesto, 800);
  assert.equal(d.fecha_fin, '2027-01-15');

  const pausa = await api('PUT', `/api/marketing/campanas/${id}/estado`, { token: A.gerente.token, body: { estado: 'pausada' } });
  assert.equal(pausa.status, 200);
  assert.equal((await detalle(A, id)).estado, 'pausada');
  assert.equal((await api('PUT', `/api/marketing/campanas/${id}/estado`, { token: A.admin.token, body: { estado: 'archivada' } })).status, 400);

  const { rows } = await pool.query(`SELECT accion FROM audit_log WHERE empresa_id = $1 AND modulo = 'marketing' AND registro_id = $2`, [A.empresaId, String(id)]);
  assert.ok(rows.some(r => r.accion === 'crear') && rows.some(r => r.accion === 'editar'), 'quedan en Auditoría');
});

test('campaña: datos inválidos se rechazan con un mensaje claro', async () => {
  const casos = [
    [{ nombre: '' }, /nombre/i],
    [{ nombre: 'x'.repeat(200) }, /150 caracteres/],
    [{ canal: 'paloma' }, /canal/],
    [{ estado: 'eterna' }, /estado/],
    [{ presupuesto: -10 }, /presupuesto/i],
    [{ presupuesto: 'mucho' }, /presupuesto/i],
    [{ fecha_inicio: '2026-05-10', fecha_fin: '2026-05-01' }, /anterior/i],
    [{ fecha_inicio: '2026-13-40' }, /fecha válida/i],
    [{ mensaje: 'x'.repeat(1100) }, /1000 caracteres/]
  ];
  for (const [extra, mensaje] of casos) {
    const r = await api('POST', '/api/marketing/campanas', { token: A.admin.token, body: { nombre: 'Prueba', ...extra } });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(r.cuerpo.error, mensaje);
  }
});

test('permisos: el supervisor solo mira, el gerente no elimina, ventas y consulta no entran, y sin módulo tampoco', async () => {
  const id = await nuevaCampana(A);
  assert.equal((await api('GET', '/api/marketing/campanas', { token: A.supervisor.token })).status, 200);
  assert.equal((await api('POST', '/api/marketing/campanas', { token: A.supervisor.token, body: { nombre: 'x' } })).status, 403);
  assert.equal((await api('PUT', `/api/marketing/campanas/${id}`, { token: A.supervisor.token, body: { nombre: 'x' } })).status, 403);
  assert.equal((await api('DELETE', `/api/marketing/campanas/${id}`, { token: A.gerente.token })).status, 403);
  for (const persona of [A.ventas, A.consulta]) {
    assert.equal((await api('GET', '/api/marketing/campanas', { token: persona.token })).status, 403);
    assert.equal((await api('GET', `/api/marketing/campanas/${id}`, { token: persona.token })).status, 403);
  }
  assert.equal((await api('GET', '/api/marketing/campanas')).status, 401);
  assert.equal((await api('GET', '/api/marketing/campanas', { token: SIN_MODULO.admin.token })).status, 403, 'la empresa no tiene el módulo');
  assert.equal((await api('GET', '/api/marketing/campanas-activas', { token: SIN_MODULO.admin.token })).status, 403);
  assert.equal((await api('DELETE', `/api/marketing/campanas/${id}`, { token: A.admin.token })).status, 204);
  assert.equal((await api('GET', `/api/marketing/campanas/${id}`, { token: A.admin.token })).status, 404);
  assert.equal((await api('GET', '/api/marketing/campanas/abc', { token: A.admin.token })).status, 404);
});

test('aislamiento: una empresa no ve, edita, borra ni llena con clientes ajenos las campañas de otra', async () => {
  const idA = await nuevaCampana(A, { nombre: 'Campaña privada de A' });
  const clienteB = await crearCliente(ctx, B.empresaId, 'Cliente de B');
  const clienteA = await crearCliente(ctx, A.empresaId, 'Cliente de A');

  assert.equal((await api('GET', `/api/marketing/campanas/${idA}`, { token: B.admin.token })).status, 404);
  assert.equal((await api('PUT', `/api/marketing/campanas/${idA}`, { token: B.admin.token, body: { nombre: 'Hackeada' } })).status, 404);
  assert.equal((await api('PUT', `/api/marketing/campanas/${idA}/estado`, { token: B.admin.token, body: { estado: 'finalizada' } })).status, 404);
  assert.equal((await api('DELETE', `/api/marketing/campanas/${idA}`, { token: B.admin.token })).status, 404);
  assert.equal((await api('POST', `/api/marketing/campanas/${idA}/clientes`, { token: B.admin.token, body: { cliente_ids: [clienteB] } })).status, 404);
  assert.equal((await api('POST', `/api/marketing/campanas/${idA}/clientes/segmento`, { token: B.admin.token, body: {} })).status, 404);
  assert.ok(!(await api('GET', '/api/marketing/campanas', { token: B.admin.token })).cuerpo.some(c => c.id === idA));
  assert.equal((await detalle(A, idA)).nombre, 'Campaña privada de A');

  // Un cliente de OTRA empresa no entra a mi campaña (y no se agrega nada a medias).
  const mezcla = await api('POST', `/api/marketing/campanas/${idA}/clientes`, { token: A.admin.token, body: { cliente_ids: [clienteA, clienteB] } });
  assert.equal(mezcla.status, 404);
  assert.equal((await detalle(A, idA)).clientes.length, 0, 'ni siquiera el cliente propio quedó agregado');
});

// ---------------------------------------------------------------------------
// Segmentación y lista de clientes objetivo
// ---------------------------------------------------------------------------

async function montarClientes(E) {
  const reciente = await crearCliente(ctx, E.empresaId, 'Reciente Compró Ayer');
  const antiguo = await crearCliente(ctx, E.empresaId, 'Antiguo Hace 120 Días');
  const nunca = await crearCliente(ctx, E.empresaId, 'Nunca Compró');
  const fiel = await crearCliente(ctx, E.empresaId, 'Fiel Gran Comprador');
  await pool.query(`UPDATE clientes SET telefono = '987654321', email = 'reciente@example.com' WHERE id = $1`, [reciente]);
  await pool.query(`UPDATE clientes SET telefono = '911222333' WHERE id = $1`, [antiguo]);
  await pool.query(`UPDATE clientes SET email = 'fiel@example.com', telefono = '955000111' WHERE id = $1`, [fiel]);
  await ventaAntigua(E.empresaId, reciente, 1, 100);
  await ventaAntigua(E.empresaId, antiguo, 120, 300);
  for (const dias of [200, 100, 30]) await ventaAntigua(E.empresaId, fiel, dias, 400);
  await pool.query(`UPDATE clientes SET compras_totales = 100 WHERE id = $1`, [reciente]);
  await pool.query(`UPDATE clientes SET compras_totales = 300 WHERE id = $1`, [antiguo]);
  await pool.query(`UPDATE clientes SET compras_totales = 1200 WHERE id = $1`, [fiel]);
  return { reciente, antiguo, nunca, fiel };
}
const previa = (E, criterios) => api('POST', '/api/marketing/segmento/vista-previa', { token: E.admin.token, body: criterios });
// Los fixtures anteponen "QA-TEST (borrar) " al nombre del cliente: se quita para comparar.
const nombres = (r) => r.cuerpo.muestra.map(m => m.nombre.replace('QA-TEST (borrar) ', '')).sort();

test('segmentación: cada criterio filtra lo que promete, y se combinan', async () => {
  const E = await montarEmpresa('segmentos', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  await montarClientes(E);

  const todos = await previa(E, {});
  assert.equal(todos.cuerpo.total, 4);
  assert.equal(todos.cuerpo.etiqueta, 'Todos los clientes');

  const inactivos = await previa(E, { inactivos_dias: 90 });
  assert.deepEqual(nombres(inactivos), ['Antiguo Hace 120 Días', 'Nunca Compró'], 'sin compras en 90 días, incluido quien nunca compró');
  assert.equal(inactivos.cuerpo.etiqueta, 'Inactivos 90 d');

  assert.deepEqual(nombres(await previa(E, { compras_min: 2 })), ['Fiel Gran Comprador']);
  assert.deepEqual(nombres(await previa(E, { gasto_min: 300 })), ['Antiguo Hace 120 Días', 'Fiel Gran Comprador']);
  assert.deepEqual(nombres(await previa(E, { con_email: true })), ['Fiel Gran Comprador', 'Reciente Compró Ayer']);
  assert.deepEqual(nombres(await previa(E, { con_telefono: true })), ['Antiguo Hace 120 Días', 'Fiel Gran Comprador', 'Reciente Compró Ayer']);
  assert.deepEqual(nombres(await previa(E, { inactivos_dias: 90, con_telefono: true })), ['Antiguo Hace 120 Días'], 'inactivos Y con teléfono');
  assert.deepEqual(nombres(await previa(E, { inactivos_dias: 7, compras_min: 3 })), ['Fiel Gran Comprador'], 'el fiel compró hace 30 días: inactivo a 7 días, y con 3 compras');
  assert.equal((await previa(E, { inactivos_dias: 9999 })).status, 400);

  for (const malo of [{ inactivos_dias: 0 }, { inactivos_dias: 'mucho' }, { compras_min: 0 }, { gasto_min: -5 }, { inactivos_dias: 1.5 }]) {
    assert.equal((await previa(E, malo)).status, 400, JSON.stringify(malo));
  }
  assert.equal((await api('POST', '/api/marketing/segmento/vista-previa', { token: A.ventas.token, body: {} })).status, 403);
});

test('la vista previa de una empresa nunca trae clientes de otra', async () => {
  const E1 = await montarEmpresa('previa-1', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const E2 = await montarEmpresa('previa-2', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  await crearCliente(ctx, E1.empresaId, 'Solo de E1');
  await crearCliente(ctx, E2.empresaId, 'Solo de E2');
  assert.deepEqual(nombres(await previa(E1, {})), ['Solo de E1']);
  assert.deepEqual(nombres(await previa(E2, {})), ['Solo de E2']);
});

test('aplicar un segmento arma la lista, la etiqueta y recuerda los criterios; repetirlo no duplica', async () => {
  const E = await montarEmpresa('aplicar', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const c = await montarClientes(E);
  const id = await nuevaCampana(E);

  const aplica = await api('POST', `/api/marketing/campanas/${id}/clientes/segmento`, { token: E.admin.token, body: { inactivos_dias: 90 } });
  assert.equal(aplica.status, 200, JSON.stringify(aplica.cuerpo));
  assert.equal(aplica.cuerpo.coincidieron, 2);
  assert.equal(aplica.cuerpo.agregados, 2);
  assert.equal(aplica.cuerpo.etiqueta, 'Inactivos 90 d');

  const d = await detalle(E, id);
  assert.deepEqual(d.clientes.map(x => x.cliente_id).sort(), [c.antiguo, c.nunca].sort());
  assert.ok(d.clientes.every(x => x.estado === 'objetivo' && x.etiqueta === 'Inactivos 90 d'));
  assert.equal(d.objetivo, 2);
  assert.equal(d.segmento.inactivos_dias, 90, 'queda registrado con qué criterios se armó');

  const repite = await api('POST', `/api/marketing/campanas/${id}/clientes/segmento`, { token: E.admin.token, body: { inactivos_dias: 90 } });
  assert.equal(repite.cuerpo.agregados, 0);
  assert.equal(repite.cuerpo.ya_estaban, 2);
  const conEtiqueta = await api('POST', `/api/marketing/campanas/${id}/clientes/segmento`, { token: E.admin.token, body: { compras_min: 2, etiqueta: 'VIP' } });
  assert.equal(conEtiqueta.cuerpo.agregados, 1);
  assert.equal((await detalle(E, id)).clientes.find(x => x.cliente_id === c.fiel).etiqueta, 'VIP');
  assert.equal((await api('POST', `/api/marketing/campanas/${id}/clientes/segmento`, { token: E.admin.token, body: { gasto_min: -1 } })).status, 400);
});

test('agregar clientes a mano: valida la lista, ignora repetidos y quitar a uno', async () => {
  const E = await montarEmpresa('manual', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const a = await crearCliente(ctx, E.empresaId, 'Cliente A'), b = await crearCliente(ctx, E.empresaId, 'Cliente B');
  const id = await nuevaCampana(E);
  const url = `/api/marketing/campanas/${id}/clientes`;

  for (const cuerpo of [{}, { cliente_ids: [] }, { cliente_ids: 'todos' }, { cliente_ids: ['abc'] }, { cliente_ids: [0] }, { cliente_ids: [a], etiqueta: 'x'.repeat(50) }]) {
    assert.equal((await api('POST', url, { token: E.admin.token, body: cuerpo })).status, 400, JSON.stringify(cuerpo));
  }
  assert.equal((await api('POST', url, { token: E.admin.token, body: { cliente_ids: [a, 99999999] } })).status, 404, 'un cliente inexistente');

  const ok = await api('POST', url, { token: E.admin.token, body: { cliente_ids: [a, b, a], etiqueta: 'Referidos' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.cuerpo));
  assert.equal(ok.cuerpo.agregados, 2, 'el repetido dentro de la misma lista cuenta una vez');
  assert.equal((await api('POST', url, { token: E.admin.token, body: { cliente_ids: [a] } })).cuerpo.ya_estaban, 1);

  assert.equal((await api('DELETE', `${url}/${a}`, { token: E.admin.token })).status, 204);
  assert.equal((await api('DELETE', `${url}/${a}`, { token: E.admin.token })).status, 404, 'ya no está');
  assert.equal((await api('DELETE', `${url}/abc`, { token: E.admin.token })).status, 404);
  assert.deepEqual((await detalle(E, id)).clientes.map(x => x.cliente_id), [b]);
});

test('el avance de cada cliente: el embudo se completa hacia atrás y los resultados lo reflejan', async () => {
  const E = await montarEmpresa('embudo', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const cs = [];
  for (let i = 1; i <= 5; i++) cs.push(await crearCliente(ctx, E.empresaId, `Cliente ${i}`));
  const id = await nuevaCampana(E, { presupuesto: 100 });
  const url = `/api/marketing/campanas/${id}/clientes`;
  await api('POST', url, { token: E.admin.token, body: { cliente_ids: cs } });
  const cambia = (ids, estado) => api('PUT', url, { token: E.admin.token, body: { cliente_ids: ids, estado } });

  assert.equal((await cambia([cs[0], cs[1], cs[2], cs[3]], 'contactado')).cuerpo.actualizados, 4);
  assert.equal((await cambia([cs[1], cs[2], cs[3]], 'respondio')).cuerpo.actualizados, 3);
  assert.equal((await cambia([cs[2]], 'convirtio')).cuerpo.actualizados, 1);
  assert.equal((await cambia([cs[3]], 'descartado')).cuerpo.actualizados, 1);

  const d = await detalle(E, id);
  const por = Object.fromEntries(d.clientes.map(x => [x.cliente_id, x]));
  assert.equal(por[cs[2]].estado, 'convirtio');
  assert.ok(por[cs[2]].contactado_el && por[cs[2]].respondio_el && por[cs[2]].convirtio_el, 'convertir completa los pasos anteriores');
  assert.ok(por[cs[0]].contactado_el && !por[cs[0]].respondio_el);
  assert.equal(por[cs[4]].estado, 'objetivo');
  assert.equal(d.objetivo, 4, 'el descartado no cuenta como objetivo');
  assert.equal(d.contactados, 3, 'contactados: el que solo se contactó, el que respondió y el que convirtió (el descartado ya no cuenta)');
  assert.equal(d.respuestas, 2);
  assert.equal(d.conversiones, 1);
  assert.equal(d.tasa_conversion, 0.25, '1 de 4');
  assert.equal(d.costo_por_conversion, 100, 'presupuesto 100 entre 1 conversión');

  // Volver a "objetivo" no borra el historial de fechas.
  await cambia([cs[0]], 'objetivo');
  assert.ok((await detalle(E, id)).clientes.find(x => x.cliente_id === cs[0]).contactado_el);

  const etiq = await api('PUT', url, { token: E.admin.token, body: { cliente_ids: [cs[4]], etiqueta: 'Prioridad', notas: 'Llamar el lunes' } });
  assert.equal(etiq.cuerpo.actualizados, 1);
  const c4 = (await detalle(E, id)).clientes.find(x => x.cliente_id === cs[4]);
  assert.equal(c4.etiqueta, 'Prioridad');
  assert.equal(c4.notas, 'Llamar el lunes');
  assert.equal(c4.estado, 'objetivo', 'cambiar solo la etiqueta no toca el avance');

  assert.equal((await api('PUT', url, { token: E.admin.token, body: { cliente_ids: [cs[0]], estado: 'inventado' } })).status, 400);
  assert.equal((await api('PUT', url, { token: E.admin.token, body: { cliente_ids: [cs[0]] } })).status, 400, 'sin ningún cambio');
  assert.equal((await api('PUT', url, { token: E.admin.token, body: { cliente_ids: [], estado: 'contactado' } })).status, 400);
  assert.equal((await api('PUT', url, { token: E.admin.token, body: { cliente_ids: [999999], estado: 'contactado' } })).cuerpo.actualizados, 0, 'un cliente que no está en la lista simplemente no se toca');
});

// ---------------------------------------------------------------------------
// Ventas atribuidas: lo que convierte una campaña en un resultado
// ---------------------------------------------------------------------------

const vender = (E, { clienteId, productoId, campana_id, cantidad = 2, precio = 100, token = E.admin.token }) =>
  api('POST', '/api/ventas', { token, body: { fecha: hoy(), cliente_id: clienteId, producto_id: productoId, cantidad, precio_unitario: precio, ...(campana_id !== undefined ? { campana_id } : {}) } });

test('una venta atribuida suma a la campaña y marca convertido al cliente (esté o no en la lista)', async () => {
  const E = await montarEmpresa('atribucion', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const producto = await crearProducto(ctx, E.empresaId, { nombre: 'Producto QA', stock: 50, precio_unitario: 100 });
  const enLista = await crearCliente(ctx, E.empresaId, 'En la lista'), directo = await crearCliente(ctx, E.empresaId, 'Compró sin estar en la lista');
  const id = await nuevaCampana(E, { presupuesto: 100 });
  await api('POST', `/api/marketing/campanas/${id}/clientes`, { token: E.admin.token, body: { cliente_ids: [enLista] } });

  const v1 = await vender(E, { clienteId: enLista, productoId: producto, campana_id: id });
  assert.equal(v1.status, 201, JSON.stringify(v1.cuerpo));
  assert.equal(v1.cuerpo.campana_id, id);
  const v2 = await vender(E, { clienteId: directo, productoId: producto, campana_id: String(id), cantidad: 1 });
  assert.equal(v2.status, 201, 'el id como texto también sirve (el formulario lo manda así)');
  const sin = await vender(E, { clienteId: enLista, productoId: producto, campana_id: '' });
  assert.equal(sin.status, 201, 'campaña vacía = venta sin campaña');
  assert.equal(sin.cuerpo.campana_id ?? null, null);

  const d = await detalle(E, id);
  assert.equal(d.ventas_generadas, 2);
  assert.equal(d.ingresos, 300, '200 + 100; la venta sin campaña no cuenta');
  assert.equal(d.retorno, 3, 'ingresos 300 sobre presupuesto 100');
  assert.equal(d.ventas.length, 2);
  const por = Object.fromEntries(d.clientes.map(x => [x.cliente_id, x]));
  assert.equal(por[enLista].estado, 'convirtio');
  assert.ok(por[enLista].contactado_el && por[enLista].respondio_el, 'convertir completa el embudo');
  assert.equal(por[directo].estado, 'convirtio', 'quien compró sin estar en la lista se suma como convertido');
  assert.equal(por[directo].etiqueta, 'Venta directa');
  assert.equal(d.conversiones, 2);

  const { rows } = await pool.query(`SELECT detalle FROM audit_log WHERE empresa_id = $1 AND modulo = 'ventas' AND registro_id = $2`, [E.empresaId, String(v1.cuerpo.id)]);
  assert.match(JSON.stringify(rows[0].detalle), new RegExp(`"campana_id":${id}`), 'la auditoría de la venta anota la campaña');

  const sinCampana = (await api('GET', '/api/marketing/campanas', { token: E.admin.token })).cuerpo.find(c => c.id === id);
  assert.equal(sinCampana.ventas_generadas, 2, 'y la lista general lo trae igual');
});

test('no se puede atribuir a una campaña ajena, finalizada o inválida, y nada queda a medias', async () => {
  const producto = await crearProducto(ctx, A.empresaId, { nombre: 'Producto validación', stock: 20, precio_unitario: 100 });
  const cliente = await crearCliente(ctx, A.empresaId, 'Cliente validación');
  const deB = await nuevaCampana(B);
  const finalizada = await nuevaCampana(A, { estado: 'finalizada' });
  const stock = async () => Number((await pool.query('SELECT stock FROM inventario WHERE id = $1', [producto])).rows[0].stock);
  const ventas = async () => (await pool.query('SELECT count(*)::int AS n FROM ventas WHERE cliente_id = $1', [cliente])).rows[0].n;

  const ajena = await vender(A, { clienteId: cliente, productoId: producto, campana_id: deB });
  assert.equal(ajena.status, 404);
  assert.match(ajena.cuerpo.error, /campaña/i);
  const fin = await vender(A, { clienteId: cliente, productoId: producto, campana_id: finalizada });
  assert.equal(fin.status, 400);
  assert.match(fin.cuerpo.error, /finalizada/i);
  assert.equal((await vender(A, { clienteId: cliente, productoId: producto, campana_id: 'abc' })).status, 400);
  assert.equal((await vender(A, { clienteId: cliente, productoId: producto, campana_id: 99999999 })).status, 404);
  assert.equal(await stock(), 20, 'el stock no se descontó');
  assert.equal(await ventas(), 0, 'no se registró ninguna venta');

  // Una empresa sin el módulo de Marketing tampoco puede atribuir (no tiene campañas).
  const prod2 = await crearProducto(ctx, SIN_MODULO.empresaId, { nombre: 'Producto sin módulo', stock: 5, precio_unitario: 100 });
  const cli2 = await crearCliente(ctx, SIN_MODULO.empresaId, 'Cliente sin módulo');
  assert.equal((await vender(SIN_MODULO, { clienteId: cli2, productoId: prod2, campana_id: deB })).status, 404);
  assert.equal((await vender(SIN_MODULO, { clienteId: cli2, productoId: prod2 })).status, 201, 'la venta normal sigue funcionando');
});

test('una campaña con ventas no se elimina (se finaliza) y una vacía sí', async () => {
  const E = await montarEmpresa('borrado', ['admin'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const producto = await crearProducto(ctx, E.empresaId, { nombre: 'Producto borrado', stock: 20, precio_unitario: 100 });
  const cliente = await crearCliente(ctx, E.empresaId, 'Cliente borrado');
  const conVentas = await nuevaCampana(E), vacia = await nuevaCampana(E);
  assert.equal((await vender(E, { clienteId: cliente, productoId: producto, campana_id: conVentas })).status, 201);

  const no = await api('DELETE', `/api/marketing/campanas/${conVentas}`, { token: E.admin.token });
  assert.equal(no.status, 409);
  assert.match(no.cuerpo.error, /finalízala/i);
  assert.equal((await api('PUT', `/api/marketing/campanas/${conVentas}/estado`, { token: E.admin.token, body: { estado: 'finalizada' } })).status, 200);
  assert.equal((await detalle(E, conVentas)).ventas_generadas, 1, 'el resultado se conserva');
  assert.equal((await api('DELETE', `/api/marketing/campanas/${vacia}`, { token: E.admin.token })).status, 204);
});

test('campañas activas para el formulario de ventas: solo las activas, propias, y visibles para quien vende', async () => {
  const E = await montarEmpresa('activas', ['admin', 'ventas', 'consulta'], ['ventas', 'inventario', 'clientes', 'marketing']);
  const activa = await nuevaCampana(E, { nombre: 'Activa uno' });
  await nuevaCampana(E, { nombre: 'Borrador', estado: 'borrador' });
  await nuevaCampana(E, { nombre: 'Finalizada', estado: 'finalizada' });
  await nuevaCampana(E, { nombre: 'Pausada', estado: 'pausada' });
  await nuevaCampana(B, { nombre: 'Activa de otra empresa' });

  const porVentas = await api('GET', '/api/marketing/campanas-activas', { token: E.ventas.token });
  assert.equal(porVentas.status, 200, 'quien registra ventas la ve aunque no tenga marketing.ver');
  assert.deepEqual(porVentas.cuerpo, [{ id: activa, nombre: 'Activa uno' }], 'solo id y nombre, solo las activas, solo las suyas');
  assert.equal((await api('GET', '/api/marketing/campanas-activas', { token: E.consulta.token })).status, 403, 'consulta no registra ventas');
  assert.equal((await api('GET', '/api/marketing/campanas', { token: E.ventas.token })).status, 403, 'pero no ve el resto de Marketing');
});
