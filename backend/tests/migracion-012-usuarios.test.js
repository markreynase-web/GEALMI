// tests/migracion-012-usuarios.test.js
// Regresión de un fallo de acceso entre empresas: migrate.js vuelve a correr TODOS
// los .sql en cada ejecución, y el relleno de 012_empresas.sql ("cada usuario
// existente queda de miembro de la empresa semilla") volvía a asociar a TODOS los
// usuarios -- también a los de otras empresas -- a la primera empresa, con su rol
// antiguo, cada vez que alguien corría "npm run migrate".
//
// Se ejecuta EL MISMO INSERT que trae el archivo (extraído del .sql, no copiado a
// mano) dentro de una transacción que se revierte: no toca datos de nadie y no
// necesita DDL (correr migrate.js entero aquí bloquearía tablas mientras otros
// tests las usan).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nuevoContexto, crearEmpresa, crearUsuario, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

const ctx = nuevoContexto();
after(async () => {
  await limpiarContexto(ctx);
  await pool.end();
});

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQL_012 = fs.readFileSync(path.join(RAIZ, 'migrations', '012_empresas.sql'), 'utf8');
const BLOQUE = SQL_012.match(/INSERT INTO usuario_empresa \(usuario_id, empresa_id, rol_id\)[\s\S]*?ON CONFLICT \(usuario_id, empresa_id\) DO NOTHING;/);

test('el relleno de 012 existe en el archivo y trae su filtro', () => {
  assert.ok(BLOQUE, 'no se encontró el INSERT del relleno de usuario_empresa en 012_empresas.sql');
  assert.match(BLOQUE[0], /NOT EXISTS/i, 'sin el filtro, cada migrate re-asocia a todos los usuarios a la empresa semilla');
});

test('volver a correr el relleno NO asocia a la empresa semilla a un usuario que ya es de otra empresa', async () => {
  const empresa = await crearEmpresa(ctx, 'migracion-012', ['ventas']);
  const { usuarioId } = await crearUsuario(ctx, { empresaId: empresa, rolNombre: 'administrador' });
  const { rows: semilla } = await pool.query('SELECT id FROM empresas ORDER BY id LIMIT 1');
  assert.notEqual(semilla[0].id, empresa, 'la empresa de prueba no puede ser la semilla');

  // migrate.js corre 005 antes que 012 (y esa migración rellena usuarios.rol_id desde el rol
  // antiguo; 013 lo vuelve a dejar opcional). Aquí se reproduce ese estado: los dos usuarios
  // tienen rol_id, como los vería el relleno dentro de un migrate completo.
  const { rows: rol } = await pool.query(`SELECT id FROM roles WHERE nombre = 'consulta'`);
  await pool.query('UPDATE usuarios SET rol_id = $1 WHERE id = $2', [rol[0].id, usuarioId]);
  // Un usuario que todavía no pertenece a ninguna empresa (el caso para el que sirve el relleno).
  const { rows: sin } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, activo, rol_id) VALUES ('QA-TEST (borrar) sin empresa', $1, 'x', true, $2) RETURNING id`,
    [`qa-test-012-${Date.now()}@example.invalid`, rol[0].id]
  );
  ctx.usuarioIds.push(sin[0].id);

  // Se acota el relleno a ESTOS dos usuarios: no depende de lo que otros tests tengan a medias en ese instante.
  const relleno = BLOQUE[0].replace('FROM usuarios u', `FROM (SELECT * FROM usuarios WHERE id IN (${usuarioId}, ${sin[0].id})) u`);
  assert.notEqual(relleno, BLOQUE[0], 'no se pudo acotar el relleno a los usuarios de la prueba');

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(relleno);
    const { rows: deEmpresa } = await cliente.query('SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1 ORDER BY 1', [usuarioId]);
    assert.deepEqual(deEmpresa.map(r => r.empresa_id), [empresa], 'el usuario de otra empresa no gana acceso a la empresa semilla');
    const { rows: huerfano } = await cliente.query('SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1', [sin[0].id]);
    assert.deepEqual(huerfano.map(r => r.empresa_id), [semilla[0].id], 'quien no tenía empresa sí queda en la semilla (el propósito original del relleno)');
  } finally {
    await cliente.query('ROLLBACK');
    cliente.release();
  }
});
