// tests/migracion-012-modulos.test.js
// Regresión: migrate.js vuelve a correr TODOS los .sql en cada ejecución, y el bloque de
// 012_empresas.sql que da a la empresa semilla sus módulos iniciales (ventas, inventario,
// clientes, finanzas, rrhh) los volvía a encender en cada "npm run migrate" aunque el super
// admin los hubiera apagado a propósito desde su panel. Solo tiene sentido la PRIMERA vez
// (empresa_modulos recién creada, vacía).
//
// Se ejecuta EL MISMO INSERT que trae el archivo (extraído del .sql, no copiado a mano) dentro
// de una transacción que se revierte, sobre una tabla temporal que tapa a la real: no toca datos
// de nadie ni necesita DDL.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { poolTest as pool } from './helpers/testDb.js';

after(async () => {
  await pool.end();
});

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_012 = fs.readFileSync(path.join(RAIZ, 'migrations', '012_empresas.sql'), 'utf8');
const BLOQUE = SQL_012.match(/INSERT INTO empresa_modulos \(empresa_id, modulo_id\)[\s\S]*?ON CONFLICT DO NOTHING;/);
const INICIALES = ['clientes', 'finanzas', 'inventario', 'rrhh', 'ventas'];

test('el bloque de módulos de 012 existe en el archivo y solo corre cuando ninguna empresa tiene módulos', () => {
  assert.ok(BLOQUE, 'no se encontró el INSERT de empresa_modulos en 012_empresas.sql');
  assert.match(BLOQUE[0], /AND NOT EXISTS \(SELECT 1 FROM empresa_modulos\)/i,
    'sin este filtro, cada migrate vuelve a encender módulos que el super admin apagó en la empresa semilla');
});

async function conTablaTemporal(filasIniciales, fn) {
  const { rows: semilla } = await pool.query('SELECT id FROM empresas ORDER BY id LIMIT 1');
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Una tabla temporal con el mismo nombre tapa a la real durante esta transacción.
    await cliente.query('CREATE TEMP TABLE empresa_modulos (LIKE public.empresa_modulos INCLUDING ALL) ON COMMIT DROP');
    for (const moduloId of filasIniciales) {
      await cliente.query('INSERT INTO empresa_modulos (empresa_id, modulo_id) VALUES ($1, $2)', [semilla[0].id, moduloId]);
    }
    await cliente.query(BLOQUE[0]);
    const { rows } = await cliente.query('SELECT modulo_id FROM empresa_modulos WHERE empresa_id = $1 ORDER BY 1', [semilla[0].id]);
    return fn(rows.map(r => r.modulo_id));
  } finally {
    await cliente.query('ROLLBACK');
    cliente.release();
  }
}

test('con la base ya en uso, volver a correr el bloque NO reactiva los módulos que se apagaron', async () => {
  // La semilla solo tiene "ventas" (apagaron el resto): migrate no debe volver a encenderlos.
  await conTablaTemporal(['ventas'], modulos => {
    assert.deepEqual(modulos, ['ventas']);
  });
  // Ni siquiera si el que queda es otro y "ventas" fue el apagado.
  await conTablaTemporal(['finanzas'], modulos => {
    assert.deepEqual(modulos, ['finanzas']);
  });
});

test('la PRIMERA vez (empresa_modulos vacía) el bloque sí da a la empresa semilla sus módulos iniciales', async () => {
  await conTablaTemporal([], modulos => {
    assert.deepEqual(modulos, INICIALES);
  });
});
