// tests/api-publica.test.js
// Nivel 3 del roadmap -- "Exportación de datos + API pública", Parte B.
// Dos superficies bajo prueba: /api/api-keys (gestión, JWT de sesión normal)
// y /api/v1/* (la API pública en sí, autenticada con la API key).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, crearProducto, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
const ctx = nuevoContexto();

before(async () => { servidor = await iniciarServidorTest(); });
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function asignarPlan(empresaId, nombrePlan) {
  const { rows } = await pool.query('SELECT id FROM planes WHERE nombre = $1', [nombrePlan]);
  await pool.query('UPDATE empresas SET plan_id = $1 WHERE id = $2', [rows[0].id, empresaId]);
}

async function crearEmpresaConAdmin(sufijo, nombrePlan) {
  const empresaId = await crearEmpresa(ctx, sufijo);
  if (nombrePlan) await asignarPlan(empresaId, nombrePlan);
  const admin = await crearUsuario(ctx, { empresaId });
  const token = await login(servidor.baseUrl, admin.email, admin.password);
  return { empresaId, token };
}

async function crearApiKey(token, nombre = 'Integración de prueba') {
  const r = await fetch(`${servidor.baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nombre })
  });
  assert.equal(r.status, 201, `crearApiKey() esperaba 201, recibió ${r.status}`);
  return r.json();
}

test('POST /api/api-keys: empresa sin plan con acceso_api (Básico) se rechaza con 403, sin crear ninguna fila', async () => {
  const { empresaId, token } = await crearEmpresaConAdmin('sin-acceso', 'Básico');

  const r = await fetch(`${servidor.baseUrl}/api/api-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ nombre: 'No debería crearse' })
  });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /plan actual no incluye acceso/i);

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM api_keys WHERE empresa_id = $1', [empresaId]);
  assert.equal(rows[0].n, 0);
});

test('POST /api/api-keys: plan Profesional crea la key y devuelve el valor completo UNA vez', async () => {
  const { token } = await crearEmpresaConAdmin('con-acceso', 'Profesional');

  const body = await crearApiKey(token, 'Integración con mi contador');
  assert.ok(body.key.startsWith('gealmi_'), `la key debe empezar con "gealmi_", recibió: ${body.key}`);
  assert.equal(body.key.length, 'gealmi_'.length + 40);
  assert.equal(body.nombre, 'Integración con mi contador');
  assert.equal(body.activa, true);
  assert.equal(body.key_hash, undefined, 'la respuesta nunca debe incluir key_hash');
});

test('GET /api/api-keys: lista las keys de la empresa sin exponer key_hash ni la key completa', async () => {
  const { token } = await crearEmpresaConAdmin('listar', 'Profesional');
  await crearApiKey(token, 'Key A');
  await crearApiKey(token, 'Key B');

  const r = await fetch(`${servidor.baseUrl}/api/api-keys`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  const lista = await r.json();
  assert.equal(lista.length, 2);
  for (const fila of lista) {
    assert.equal(fila.key_hash, undefined);
    assert.equal(fila.key, undefined);
    assert.ok(fila.prefijo.startsWith('gealmi_'));
  }
});

test('DELETE /api/api-keys/:id: revoca la key (activa=false); revocarla de nuevo da 404', async () => {
  const { token } = await crearEmpresaConAdmin('revocar', 'Profesional');
  const key = await crearApiKey(token, 'Para revocar');

  const r1 = await fetch(`${servidor.baseUrl}/api/api-keys/${key.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(r1.status, 200);

  const { rows } = await pool.query('SELECT activa FROM api_keys WHERE id = $1', [key.id]);
  assert.equal(rows[0].activa, false);

  const r2 = await fetch(`${servidor.baseUrl}/api/api-keys/${key.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(r2.status, 404, 'revocar una key ya revocada debe dar 404, no 200 de nuevo');
});

test('GET /api/v1/inventario: sin API key -> 401', async () => {
  const r = await fetch(`${servidor.baseUrl}/api/v1/inventario`);
  assert.equal(r.status, 401);
});

test('GET /api/v1/inventario: API key inválida/inexistente -> 401', async () => {
  const r = await fetch(`${servidor.baseUrl}/api/v1/inventario`, {
    headers: { Authorization: 'Bearer gealmi_00000000000000000000000000000000000000' }
  });
  assert.equal(r.status, 401);
});

test('GET /api/v1/inventario: con key válida -> 200 { datos, meta }, filtra por empresa y respeta paginación', async () => {
  const { empresaId, token } = await crearEmpresaConAdmin('publica-datos', 'Profesional');
  const key = await crearApiKey(token, 'Lectura de inventario');

  for (let i = 0; i < 3; i++) await crearProducto(ctx, empresaId, { nombre: `Producto público ${i}` });

  const r = await fetch(`${servidor.baseUrl}/api/v1/inventario?limite=2`, {
    headers: { Authorization: `Bearer ${key.key}` }
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.datos.length, 2);
  assert.equal(body.meta.total, 3);
  assert.equal(body.meta.limite, 2);
  assert.equal(body.meta.paginasTotales, 2);
  assert.ok(body.datos.every(fila => fila.empresa_id === empresaId));
});

test('GET /api/v1/inventario: una key nunca ve datos de otra empresa', async () => {
  const empresaA = await crearEmpresaConAdmin('aislamiento-a', 'Profesional');
  const empresaB = await crearEmpresaConAdmin('aislamiento-b', 'Profesional');
  const keyA = await crearApiKey(empresaA.token, 'Key empresa A');

  await crearProducto(ctx, empresaA.empresaId, { nombre: 'Producto de A' });
  await crearProducto(ctx, empresaB.empresaId, { nombre: 'Producto de B' });

  const r = await fetch(`${servidor.baseUrl}/api/v1/inventario`, {
    headers: { Authorization: `Bearer ${keyA.key}` }
  });
  const body = await r.json();
  assert.ok(body.datos.every(fila => fila.empresa_id === empresaA.empresaId), 'la key de A no debe devolver filas de B');
});

test('GET /api/v1/inventario: key revocada -> 401', async () => {
  const { token } = await crearEmpresaConAdmin('revocada-publica', 'Profesional');
  const key = await crearApiKey(token, 'Para revocar antes de usar');
  await fetch(`${servidor.baseUrl}/api/api-keys/${key.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });

  const r = await fetch(`${servidor.baseUrl}/api/v1/inventario`, {
    headers: { Authorization: `Bearer ${key.key}` }
  });
  assert.equal(r.status, 401);
});

test('GET /api/v1/inventario: la empresa baja a un plan sin acceso_api -> la key existente pasa a dar 403', async () => {
  const { empresaId, token } = await crearEmpresaConAdmin('downgrade', 'Profesional');
  const key = await crearApiKey(token, 'Key que va a perder acceso');

  const rAntes = await fetch(`${servidor.baseUrl}/api/v1/inventario`, { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(rAntes.status, 200, 'con Profesional, la key debe funcionar antes del downgrade');

  await asignarPlan(empresaId, 'Básico');

  const rDespues = await fetch(`${servidor.baseUrl}/api/v1/inventario`, { headers: { Authorization: `Bearer ${key.key}` } });
  assert.equal(rDespues.status, 403, 'una vez sin acceso_api, la MISMA key ya no debe pasar -- se revalida en cada request, no solo al crearla');
});
