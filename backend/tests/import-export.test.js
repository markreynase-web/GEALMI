// tests/import-export.test.js
// Suite de regresión — Sub-bloque 5: Importación / Exportación masiva.
//
// Alcance ajustado tras auditar el código real (con autorización explícita
// del usuario, ver conversación): NO existe ningún endpoint de exportación
// en el backend -- ni GET /export, ni ninguna ruta que devuelva CSV/
// Content-Disposition (confirmado con grep exhaustivo sobre backend/src y
// el frontend). GEALMI solo tiene IMPORTACIÓN de CSV (POST /import, ver
// crudFactory.js). Este archivo cubre exclusivamente lo que sí existe:
// mapeo flexible de encabezados + sanitización, y aislamiento multi-tenant
// estricto durante el import. La ausencia de exportación queda documentada
// como hallazgo de producto para backlog, no como algo a inventar acá.
//
// Mismo representante que crud-critico.test.js (clientes.js): es 100%
// crearRouterCRUD() sin overrides, así que ejercita el import GENÉRICO de
// crudFactory.js, compartido por los ~21 módulos que lo usan.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

let servidor;
let token;
let empresaId;
const ctx = nuevoContexto();

before(async () => {
  servidor = await iniciarServidorTest();
  empresaId = await crearEmpresa(ctx, 'import-export');
  const cuenta = await crearUsuario(ctx, { empresaId });
  token = await login(servidor.baseUrl, cuenta.email, cuenta.password);
});
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

async function importarCsv(csv) {
  const form = new FormData();
  form.append('archivo', new Blob([csv], { type: 'text/csv' }), 'import.csv');
  const r = await fetch(`${servidor.baseUrl}/api/clientes/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // fetch arma el boundary del multipart solo -- nunca fijar Content-Type a mano acá
    body: form
  });
  return { status: r.status, body: await r.json() };
}

test('import CSV: encabezados en distinta caja (Nombre, EMAIL, Fecha_Registro) se mapean e insertan igual que en minúscula', async () => {
  const csv = [
    'Fecha_Registro,Nombre,EMAIL,Telefono,Direccion,Compras_Totales,Notas',
    '2026-01-01,QA-TEST (borrar) mayusculas,qa-mayus@example.invalid,555-1111,,,'
  ].join('\n');

  const { status, body } = await importarCsv(csv);
  assert.equal(status, 200);
  assert.equal(body.insertadas, 1, 'un encabezado en otra caja no debe tratarse como columna desconocida');
  assert.equal(body.errores, 0);

  const { rows } = await pool.query(
    `SELECT nombre, email, telefono FROM clientes WHERE empresa_id = $1 AND nombre = 'QA-TEST (borrar) mayusculas'`,
    [empresaId]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, 'qa-mayus@example.invalid');
  assert.equal(rows[0].telefono, '555-1111');
  ctx.clienteIds.push((await pool.query(
    `SELECT id FROM clientes WHERE empresa_id = $1 AND nombre = 'QA-TEST (borrar) mayusculas'`, [empresaId]
  )).rows[0].id);
});

test('import CSV: espacios en blanco en encabezados y en valores de celda se recortan (trim) antes de guardar', async () => {
  // Encabezados CON espacios (' nombre ', '  email') y valores CON espacios
  // alrededor -- ambos deben llegar limpios a la base.
  const csv = [
    ' fecha_registro , nombre ,  email  ,notas',
    '2026-01-01,  QA-TEST (borrar) con espacios  ,  qa-trim@example.invalid  ,  nota con espacios  '
  ].join('\n');

  const { status, body } = await importarCsv(csv);
  assert.equal(status, 200);
  assert.equal(body.insertadas, 1, 'un encabezado con espacios alrededor no debe tratarse como columna desconocida');

  const { rows } = await pool.query(
    `SELECT id, nombre, email, notas FROM clientes WHERE empresa_id = $1 AND nombre = 'QA-TEST (borrar) con espacios'`,
    [empresaId]
  );
  assert.equal(rows.length, 1, 'el nombre debe quedar SIN espacios sobrantes -- si el trim fallara, la búsqueda exacta de arriba no encontraría la fila');
  assert.equal(rows[0].email, 'qa-trim@example.invalid');
  assert.equal(rows[0].notas, 'nota con espacios');
  ctx.clienteIds.push(rows[0].id);
});

test('import CSV: una columna "empresa_id" en el archivo, apuntando a otra empresa, se ignora -- el registro siempre queda en la empresa de la sesión', async () => {
  const empresaVictima = await crearEmpresa(ctx, 'import-export-victima');

  const csv = [
    'fecha_registro,nombre,empresa_id',
    `2026-01-01,QA-TEST (borrar) intento cruce empresa,${empresaVictima}`
  ].join('\n');

  const { status, body } = await importarCsv(csv);
  assert.equal(status, 200);
  assert.equal(body.insertadas, 1);

  const { rows: propios } = await pool.query(
    `SELECT id, empresa_id FROM clientes WHERE empresa_id = $1 AND nombre = 'QA-TEST (borrar) intento cruce empresa'`,
    [empresaId]
  );
  assert.equal(propios.length, 1, 'el registro debe existir en la empresa REAL de la sesión, sin importar lo que dijera la columna empresa_id del CSV');
  assert.equal(propios[0].empresa_id, empresaId);
  ctx.clienteIds.push(propios[0].id);

  const { rows: enVictima } = await pool.query(
    `SELECT id FROM clientes WHERE empresa_id = $1 AND nombre = 'QA-TEST (borrar) intento cruce empresa'`,
    [empresaVictima]
  );
  assert.equal(enVictima.length, 0, 'cero filtración: la empresa objetivo del intento de inyección no debe recibir nada');
});
