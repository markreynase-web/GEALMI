// tests/inicio.test.js
// El resumen de Inicio (GET /api/inicio/resumen y /finanzas-serie) contra un servidor
// real: que los números coincidan con lo que Inicio calculaba antes bajando los
// listados completos, que respete permisos, módulos contratados, sucursal y empresa,
// y que las series del gráfico cubran cada período.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearSucursal, crearUsuario, crearCliente, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();
let A, B;

before(async () => {
  servidor = await iniciarServidorTest();
  A = await montarEmpresa('A', ['ventas', 'inventario', 'clientes', 'finanzas']);
  B = await montarEmpresa('B', ['ventas', 'inventario', 'clientes', 'finanzas']);
  await cargarDatos(A);
  // La empresa B tiene sus propios números, distintos y grandes: si se filtrara algo entre empresas se notaría.
  await pool.query(`INSERT INTO ventas (fecha, cliente, producto, cantidad, precio_unitario, monto, empresa_id) VALUES ($1, 'B', 'Producto de B', 1, 99999, 99999, $2)`, [hoy(), B.empresaId]);
  await pool.query(`INSERT INTO finanzas (fecha, tipo, categoria, concepto, monto, empresa_id) VALUES ($1, 'ingreso', 'X', 'B', 88888, $2)`, [hoy(), B.empresaId]);
});
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function api(metodo, ruta, { token } = {}) {
  const r = await fetch(`${servidor.baseUrl}${ruta}`, { method: metodo, headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, cuerpo: await r.json().catch(() => ({})) };
}

async function montarEmpresa(sufijo, modulos) {
  const empresaId = await crearEmpresa(ctx, `inicio-${sufijo}`, modulos);
  const cuenta = await crearUsuario(ctx, { empresaId, rolNombre: 'administrador' });
  const { rows } = await pool.query('SELECT id FROM sucursales WHERE empresa_id = $1 AND principal = true', [empresaId]);
  return { empresaId, admin: { ...cuenta, token: await login(servidor.baseUrl, cuenta.email, cuenta.password) }, sucursalPrincipal: rows[0].id };
}

const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const sumar = (fecha, dias) => { const d = new Date(`${fecha}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
const inicioDeMes = (fecha, meses = 0) => { const [a, m] = fecha.split('-').map(Number); return new Date(Date.UTC(a, m - 1 + meses, 1)).toISOString().slice(0, 10); };
const enElMesAnterior = () => sumar(inicioDeMes(hoy()), -10);   // siempre cae en el mes anterior
const haceDosMeses = () => sumar(inicioDeMes(hoy(), -1), -10);  // siempre cae en el mes previo al anterior

const conPermisos = (empresa, permisos, extra = {}) => jwt.sign({
  id: empresa.admin.usuarioId, nombre: 'Forjado', empresa_id: empresa.empresaId, empresa_nombre: 'QA', rol: 'forjado', permisos, ...extra
}, process.env.JWT_SECRET, { expiresIn: 600 });

async function venta(empresaId, fecha, producto, monto, sucursalId = null) {
  await pool.query(
    `INSERT INTO ventas (fecha, cliente, producto, cantidad, precio_unitario, monto, empresa_id, sucursal_id) VALUES ($1, 'QA', $2, 1, $3, $3, $4, $5)`,
    [fecha, producto, monto, empresaId, sucursalId]
  );
}
async function movimiento(empresaId, fecha, tipo, monto, sucursalId = null) {
  await pool.query(
    `INSERT INTO finanzas (fecha, tipo, categoria, concepto, monto, empresa_id, sucursal_id) VALUES ($1, $2, 'QA', 'QA', $3, $4, $5)`,
    [fecha, tipo, monto, empresaId, sucursalId]
  );
}
async function producto(empresa, nombre, { stock, stockMinimo, vence = null, sucursalId }) {
  const { rows } = await pool.query(
    `INSERT INTO inventario (fecha_registro, empresa_id, nombre, categoria, stock, stock_minimo, precio_unitario, fecha_vencimiento, sucursal_id)
     VALUES (CURRENT_DATE, $1, $2, 'general', $3, $4, 10, $5, $6) RETURNING id`,
    [empresa.empresaId, `QA-TEST (borrar) ${nombre}`, stock, stockMinimo, vence, sucursalId ?? empresa.sucursalPrincipal]
  );
  ctx.productoIds.push(rows[0].id);
}

// Datos conocidos de la empresa A: cada test compara contra estas cifras.
async function cargarDatos(E) {
  const h = hoy();
  await venta(E.empresaId, h, 'Aceite', 100);
  await venta(E.empresaId, h, 'Arroz', 250);
  await venta(E.empresaId, h, '   ', 5);                       // sin nombre de producto: "Sin dato"
  await venta(E.empresaId, enElMesAnterior(), 'Aceite', 400);
  await venta(E.empresaId, haceDosMeses(), 'Sal', 50);

  await producto(E, 'Alerta baja', { stock: 2, stockMinimo: 5 });
  await producto(E, 'Agotado sin minimo', { stock: 0, stockMinimo: 0 });
  await producto(E, 'Normal', { stock: 50, stockMinimo: 5 });
  await producto(E, 'Vence en 10 dias', { stock: 10, stockMinimo: 1, vence: sumar(h, 10) });
  await producto(E, 'Vence en 40 dias', { stock: 10, stockMinimo: 1, vence: sumar(h, 40) });
  await producto(E, 'Vencido hace 20 dias', { stock: 10, stockMinimo: 1, vence: sumar(h, -20) });
  await producto(E, 'Vencido hace 60 dias', { stock: 10, stockMinimo: 1, vence: sumar(h, -60) });

  const compras = [900, 700, 500, 300, 100, 50];
  for (const [i, total] of compras.entries()) {
    const id = await crearCliente(ctx, E.empresaId, `Cliente ${i + 1}`);
    await pool.query('UPDATE clientes SET compras_totales = $1 WHERE id = $2', [total, id]);
  }

  await movimiento(E.empresaId, h, 'ingreso', 1000);
  await movimiento(E.empresaId, h, 'egreso', 300);
  await movimiento(E.empresaId, enElMesAnterior(), 'ingreso', 500);
  await movimiento(E.empresaId, enElMesAnterior(), 'egreso', 800);
  await movimiento(E.empresaId, haceDosMeses(), 'ingreso', 200);

  await crearUsuario(ctx, { empresaId: E.empresaId, rolNombre: 'ventas', activo: false }); // un usuario desactivado
}

const resumen = async (empresa, token = empresa.admin.token) => (await api('GET', '/api/inicio/resumen', { token }));
const sinPrefijo = (nombre) => nombre.replace('QA-TEST (borrar) ', '');

// ---------------------------------------------------------------------------

test('ventas: total del mes, cantidad, mes anterior, histórico y top de productos', async () => {
  const { status, cuerpo } = await resumen(A);
  assert.equal(status, 200, JSON.stringify(cuerpo));
  const v = cuerpo.ventas;
  assert.equal(v.total_mes, 355);
  assert.equal(v.cantidad_mes, 3);
  assert.equal(v.total_mes_anterior, 400);
  assert.equal(v.total_historico, 805);
  assert.deepEqual(v.top_productos, [
    { nombre: 'Aceite', monto: 500 }, { nombre: 'Arroz', monto: 250 }, { nombre: 'Sal', monto: 50 }, { nombre: 'Sin dato', monto: 5 }
  ]);
  assert.equal(cuerpo.hoy, hoy());
});

test('inventario: alertas (lo más agotado primero), vencimientos en la ventana de ±30 días y conteos', async () => {
  const i = (await resumen(A)).cuerpo.inventario;
  assert.equal(i.total, 7);
  assert.equal(i.alertas_total, 2, 'stock <= mínimo: la de stock 2 con mínimo 5 y la agotada');
  assert.deepEqual(i.alertas.map(a => sinPrefijo(a.nombre)), ['Agotado sin minimo', 'Alerta baja']);
  assert.equal(i.alertas[1].stock, 2);
  assert.equal(i.alertas[1].stock_minimo, 5);
  assert.deepEqual(i.vencimientos.map(v => [sinPrefijo(v.nombre), v.dias]), [['Vencido hace 20 dias', -20], ['Vence en 10 dias', 10]]);
  assert.equal(i.vencimientos[1].fecha_vencimiento, sumar(hoy(), 10));
});

test('clientes: total y los 5 que más compraron', async () => {
  const c = (await resumen(A)).cuerpo.clientes;
  assert.equal(c.total, 6);
  assert.deepEqual(c.top.map(x => [sinPrefijo(x.nombre), x.compras_totales]), [
    ['Cliente 1', 900], ['Cliente 2', 700], ['Cliente 3', 500], ['Cliente 4', 300], ['Cliente 5', 100]
  ]);
});

test('finanzas: ingresos, egresos, neto de este mes y del anterior, y la serie del año ya incluida', async () => {
  const f = (await resumen(A)).cuerpo.finanzas;
  assert.equal(f.ingresos, 1700);
  assert.equal(f.egresos, 1100);
  assert.equal(f.neto_mes, 700);
  assert.equal(f.neto_mes_anterior, -300);
  assert.equal(f.serie.modo, 'anio');
  assert.equal(f.serie.granularidad, 'mes');
  const actual = f.serie.puntos.find(p => p.clave === hoy().slice(0, 7));
  assert.deepEqual(actual, { clave: hoy().slice(0, 7), ingresos: 1000, egresos: 300 });
  assert.deepEqual(f.serie.puntos.map(p => p.clave), [...f.serie.puntos.map(p => p.clave)].sort(), 'ordenada');
  assert.ok(f.serie.puntos.every(p => p.clave.startsWith(hoy().slice(0, 4))), 'solo el año en curso');
});

test('usuarios: activos y total de la empresa', async () => {
  const u = (await resumen(A)).cuerpo.usuarios;
  assert.equal(u.total, 2, 'el administrador y el desactivado');
  assert.equal(u.activos, 1);
});

test('los números coinciden con lo que Inicio calculaba antes bajando los listados completos', async () => {
  const [ventas, finanzas, clientes] = await Promise.all([
    api('GET', '/api/ventas', { token: A.admin.token }), api('GET', '/api/finanzas', { token: A.admin.token }), api('GET', '/api/clientes', { token: A.admin.token })
  ]);
  const suma = (filas, campo) => filas.reduce((s, f) => s + Number(f[campo]), 0);
  const { cuerpo } = await resumen(A);
  assert.equal(cuerpo.ventas.total_historico, suma(ventas.cuerpo, 'monto'));
  assert.equal(cuerpo.finanzas.ingresos, suma(finanzas.cuerpo.filter(f => f.tipo === 'ingreso'), 'monto'));
  assert.equal(cuerpo.finanzas.egresos, suma(finanzas.cuerpo.filter(f => f.tipo === 'egreso'), 'monto'));
  assert.equal(cuerpo.clientes.total, clientes.cuerpo.length);
});

test('aislamiento: cada empresa ve solo lo suyo', async () => {
  const b = (await resumen(B)).cuerpo;
  assert.equal(b.ventas.total_historico, 99999);
  assert.equal(b.finanzas.ingresos, 88888);
  assert.equal(b.clientes.total, 0);
  assert.equal(b.inventario.total, 0);
  assert.deepEqual(b.ventas.top_productos.map(p => p.nombre), ['Producto de B']);
  const a = (await resumen(A)).cuerpo;
  assert.ok(a.ventas.total_historico < 99999 && a.finanzas.ingresos < 88888, 'nada de B se filtra en A');
});

// ---------------------------------------------------------------------------
// Acceso
// ---------------------------------------------------------------------------

test('cada sección exige su permiso: lo que la sesión no puede ver no viene en la respuesta', async () => {
  const soloVentas = (await resumen(A, conPermisos(A, ['ventas.ver']))).cuerpo;
  assert.deepEqual(Object.keys(soloVentas).filter(k => ['ventas', 'inventario', 'clientes', 'finanzas', 'usuarios'].includes(k)), ['ventas']);
  const ventasYUsuarios = (await resumen(A, conPermisos(A, ['ventas.ver', 'usuarios.ver']))).cuerpo;
  assert.ok(ventasYUsuarios.ventas && ventasYUsuarios.usuarios && !ventasYUsuarios.finanzas);
  const nada = (await resumen(A, conPermisos(A, ['gealmi_ai.ver']))).cuerpo;
  assert.equal(nada.ventas, undefined);
  assert.equal(nada.finanzas, undefined);
  assert.equal(nada.usuarios, undefined);
});

test('una sección de un módulo que la empresa no contrató no viene, aunque el rol tenga el permiso', async () => {
  const E = await montarEmpresa('sin-finanzas', ['ventas', 'clientes']);
  const { cuerpo } = await resumen(E);
  assert.ok(cuerpo.ventas && cuerpo.clientes);
  assert.equal(cuerpo.finanzas, undefined, 'el administrador tiene finanzas.ver, pero la empresa no contrató Finanzas');
  assert.equal(cuerpo.inventario, undefined);
  assert.equal((await api('GET', '/api/inicio/finanzas-serie', { token: E.admin.token })).status, 403);
});

test('sin sesión 401; con la membresía desactivada 403', async () => {
  assert.equal((await api('GET', '/api/inicio/resumen')).status, 401);
  assert.equal((await api('GET', '/api/inicio/finanzas-serie')).status, 401);

  const E = await montarEmpresa('membresia', ['ventas']);
  const otro = await crearUsuario(ctx, { empresaId: E.empresaId, rolNombre: 'administrador' });
  const token = await login(servidor.baseUrl, otro.email, otro.password);
  assert.equal((await api('GET', '/api/inicio/resumen', { token })).status, 200);
  await pool.query('UPDATE usuario_empresa SET activo = false WHERE usuario_id = $1 AND empresa_id = $2', [otro.usuarioId, E.empresaId]);
  const r = await api('GET', '/api/inicio/resumen', { token });
  assert.equal(r.status, 403, 'un token todavía vigente no basta si su acceso a la empresa ya no está activo');
  assert.match(r.cuerpo.error, /acceso/i);
});

test('un usuario atado a una sucursal solo ve las cifras de su sucursal', async () => {
  const E = await montarEmpresa('sucursal', ['ventas', 'inventario', 'clientes', 'finanzas']);
  const otraSucursal = await crearSucursal(ctx, E.empresaId, 'Sede 2');
  const h = hoy();
  await venta(E.empresaId, h, 'Producto P', 100, E.sucursalPrincipal);
  await venta(E.empresaId, h, 'Producto S', 40, otraSucursal);
  await movimiento(E.empresaId, h, 'ingreso', 700, E.sucursalPrincipal);
  await movimiento(E.empresaId, h, 'ingreso', 30, otraSucursal);
  await producto(E, 'De la principal', { stock: 1, stockMinimo: 5, sucursalId: E.sucursalPrincipal });
  await producto(E, 'De la sede 2', { stock: 1, stockMinimo: 5, sucursalId: otraSucursal });

  const todo = (await resumen(E)).cuerpo;
  assert.equal(todo.ventas.total_historico, 140);
  assert.equal(todo.finanzas.ingresos, 730);
  assert.equal(todo.inventario.total, 2);
  assert.equal(todo.sucursal_restringida, false);

  const restringido = (await resumen(E, conPermisos(E, ['ventas.ver', 'finanzas.ver', 'inventario.ver'], { sucursal_id: otraSucursal }))).cuerpo;
  assert.equal(restringido.sucursal_restringida, true);
  assert.equal(restringido.ventas.total_historico, 40);
  assert.deepEqual(restringido.ventas.top_productos.map(p => p.nombre), ['Producto S']);
  assert.equal(restringido.finanzas.ingresos, 30);
  assert.equal(restringido.inventario.total, 1);
  assert.deepEqual(restringido.inventario.alertas.map(a => sinPrefijo(a.nombre)), ['De la sede 2']);
  const serie = (await api('GET', '/api/inicio/finanzas-serie?modo=30d', { token: conPermisos(E, ['finanzas.ver'], { sucursal_id: otraSucursal }) })).cuerpo;
  assert.equal(serie.puntos.reduce((s, p) => s + p.ingresos, 0), 30, 'la serie del gráfico también respeta la sucursal');
});

// ---------------------------------------------------------------------------
// Serie del gráfico
// ---------------------------------------------------------------------------

const serie = (empresa, consulta) => api('GET', `/api/inicio/finanzas-serie${consulta}`, { token: empresa.admin.token });

test('serie de finanzas: últimos 30 días por día, 6 meses por mes y año en curso por mes', async () => {
  const E = await montarEmpresa('series', ['finanzas']);
  const h = hoy();
  await movimiento(E.empresaId, h, 'ingreso', 100);
  await movimiento(E.empresaId, h, 'egreso', 40);
  await movimiento(E.empresaId, sumar(h, -10), 'ingreso', 60);
  await movimiento(E.empresaId, sumar(h, -20), 'egreso', 25);
  await movimiento(E.empresaId, sumar(h, -100), 'ingreso', 500); // fuera de 30 días, dentro de 6 meses
  await movimiento(E.empresaId, sumar(h, -400), 'ingreso', 999); // fuera de todo salvo un rango personalizado

  const d30 = (await serie(E, '?modo=30d')).cuerpo;
  assert.equal(d30.granularidad, 'dia');
  assert.deepEqual(d30.puntos, [
    { clave: sumar(h, -20), ingresos: 0, egresos: 25 }, { clave: sumar(h, -10), ingresos: 60, egresos: 0 }, { clave: h, ingresos: 100, egresos: 40 }
  ]);

  const m6 = (await serie(E, '?modo=6m')).cuerpo;
  assert.equal(m6.granularidad, 'mes');
  assert.equal(m6.puntos.reduce((s, p) => s + p.ingresos, 0), 660, '100 + 60 + 500; el de hace 400 días queda fuera');
  assert.ok(m6.puntos.every(p => /^\d{4}-\d{2}$/.test(p.clave)));

  const porDefecto = (await serie(E, '')).cuerpo;
  assert.equal(porDefecto.modo, 'anio');

  const corto = (await serie(E, `?modo=personalizado&desde=${sumar(h, -30)}&hasta=${h}`)).cuerpo;
  assert.equal(corto.granularidad, 'dia', '30 días: se dibuja por día');
  assert.equal(corto.puntos.length, 3);
  const largo = (await serie(E, `?modo=personalizado&desde=${sumar(h, -450)}&hasta=${h}`)).cuerpo;
  assert.equal(largo.granularidad, 'mes', 'más de 45 días: se dibuja por mes');
  assert.equal(largo.puntos.reduce((s, p) => s + p.ingresos, 0), 1659);
});

test('serie de finanzas: valida el período', async () => {
  const h = hoy();
  const casos = [
    ['?modo=inventado', /modo/],
    ['?modo=personalizado', /desde/],
    [`?modo=personalizado&desde=${h}`, /hasta/],
    [`?modo=personalizado&desde=${h}&hasta=${sumar(h, -5)}`, /anterior/],
    ['?modo=personalizado&desde=ayer&hasta=hoy', /fecha válida/],
    [`?modo=personalizado&desde=${sumar(h, -3000)}&hasta=${h}`, /5 años/]
  ];
  for (const [consulta, mensaje] of casos) {
    const r = await serie(A, consulta);
    assert.equal(r.status, 400, consulta);
    assert.match(r.cuerpo.error, mensaje);
  }
});

test('una empresa sin ningún dato recibe ceros y listas vacías, no errores', async () => {
  const E = await montarEmpresa('vacia', ['ventas', 'inventario', 'clientes', 'finanzas']);
  const c = (await resumen(E)).cuerpo;
  assert.deepEqual([c.ventas.total_mes, c.ventas.total_historico, c.ventas.cantidad_mes], [0, 0, 0]);
  assert.deepEqual(c.ventas.top_productos, []);
  assert.deepEqual([c.inventario.total, c.inventario.alertas_total], [0, 0]);
  assert.deepEqual(c.clientes, { total: 0, top: [], tendencia: new Array(14).fill(0), recientes: [] });
  assert.deepEqual([c.finanzas.ingresos, c.finanzas.egresos, c.finanzas.neto_mes], [0, 0, 0]);
  assert.deepEqual(c.finanzas.serie.puntos, []);
  assert.deepEqual(c.usuarios, { activos: 1, total: 1 });
});

test('ventas: tendencia diaria, por categoría y recientes (rediseño de Inicio)', async () => {
  const c = (await resumen(A)).cuerpo;
  // 14 días, terminando hoy; el último valor es lo vendido HOY (100 + 250 + 5, ver cargarDatos).
  assert.equal(c.ventas.tendencia.length, 14);
  assert.equal(c.ventas.tendencia.at(-1), 355);
  // ningún día de cargarDatos() vende más de 400 en un solo día -- 8 de los 14 son "hoy y cerca" con 0.
  assert.ok(c.ventas.tendencia.slice(0, -1).every(v => v === 0 || v === 400));

  // cargarDatos() no asigna categoria -- todo cae en el bucket "Sin categoría", por el total del MES actual
  // (100+250+5 de hoy; el de enElMesAnterior() no cuenta).
  assert.deepEqual(c.ventas.por_categoria, [{ categoria: 'Sin categoría', monto: 355 }]);

  assert.ok(c.ventas.recientes.length >= 3 && c.ventas.recientes.length <= 6);
  assert.ok(c.ventas.recientes.some(v => v.producto === 'Aceite' && v.monto === 100));
});

test('clientes: tendencia diaria y recientes (por última compra, requiere ventas.ver)', async () => {
  const cliente = await crearCliente(ctx, A.empresaId, 'Reciente');
  await pool.query(
    `INSERT INTO ventas (fecha, cliente, cliente_id, producto, cantidad, precio_unitario, monto, empresa_id) VALUES ($1,'Reciente',$2,'Café',1,30,30,$3)`,
    [hoy(), cliente, A.empresaId]
  );
  try {
    const c = (await resumen(A)).cuerpo;
    assert.equal(c.clientes.tendencia.length, 14);
    assert.ok(c.clientes.tendencia.at(-1) >= 1, 'el cliente creado hoy cuenta en el último día de la tendencia');
    const fila = c.clientes.recientes.find(r => r.id === cliente);
    assert.ok(fila, 'el cliente con una compra hoy aparece en recientes');
    assert.equal(fila.compras, 1);
    assert.equal(fila.ultima_compra, hoy());

    // Sin ventas.ver no hay forma honesta de saber "última compra" -- recientes no viene.
    const soloClientes = conPermisos(A, ['clientes.ver']);
    const c2 = (await resumen(A, soloClientes)).cuerpo;
    assert.equal(c2.clientes.recientes, undefined);
  } finally {
    await pool.query('DELETE FROM ventas WHERE cliente_id = $1', [cliente]);
  }
});

test('mapa de sucursales: solo aparece con más de una sucursal activa', async () => {
  const solaUnaSucursal = (await resumen(A)).cuerpo; // A solo tiene la "principal" del backfill
  assert.equal(solaUnaSucursal.sucursales, undefined);

  const extra = await crearSucursal(ctx, A.empresaId, 'Sur');
  await movimiento(A.empresaId, hoy(), 'ingreso', 500, extra);
  await movimiento(A.empresaId, enElMesAnterior(), 'ingreso', 200, extra);
  try {
    const c = (await resumen(A)).cuerpo;
    assert.ok(Array.isArray(c.sucursales) && c.sucursales.length >= 2);
    const sur = c.sucursales.find(s => s.id === extra);
    assert.equal(sur.neto_mes, 500);
    assert.equal(sur.neto_mes_anterior, 200);
  } finally {
    await pool.query('DELETE FROM finanzas WHERE sucursal_id = $1', [extra]);
  }
});
