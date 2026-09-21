// tests/migracion-012-usuarios.test.js
// Regresión de un fallo de acceso entre empresas: migrate.js vuelve a correr TODOS
// los .sql en cada ejecución, y el relleno de 012_empresas.sql ("cada usuario
// existente queda de miembro de la empresa semilla") volvía a asociar a gente a la
// primera empresa, con su rol antiguo, cada vez que alguien corría "npm run migrate":
//   1. sin filtro, a TODOS los usuarios (también a los de otras empresas);
//   2. con el filtro "no pertenece a ninguna empresa", a quienes quedaron sin empresa
//      (un administrador los quitó -- DELETE /api/usuarios/:id solo borra la membresía --
//      o el super admin eliminó su empresa), que así recuperaban el acceso.
// El relleno solo tiene sentido la PRIMERA vez (usuario_empresa recién creada, vacía).
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

test('el relleno de 012 existe en el archivo y solo corre cuando la tabla de membresías está vacía', () => {
  assert.ok(BLOQUE, 'no se encontró el INSERT del relleno de usuario_empresa en 012_empresas.sql');
  assert.match(BLOQUE[0], /WHERE NOT EXISTS \(SELECT 1 FROM usuario_empresa\)/i,
    'el relleno tiene que correr solo si NO hay ninguna membresía; cualquier filtro más laxo re-asocia gente a la empresa semilla en cada migrate');
});

// migrate.js corre 005 antes que 012 (y esa migración rellena usuarios.rol_id desde el rol
// antiguo; 013 lo vuelve a dejar opcional). Aquí se reproduce ese estado: los usuarios tienen
// rol_id, como los vería el relleno dentro de un migrate completo. Y se acota el relleno a
// ESTOS usuarios para no depender de lo que otros tests tengan a medias en ese instante.
async function prepararUsuarios() {
  const empresa = await crearEmpresa(ctx, 'migracion-012', ['ventas']);
  const { rows: semilla } = await pool.query('SELECT id FROM empresas ORDER BY id LIMIT 1');
  assert.notEqual(semilla[0].id, empresa, 'la empresa de prueba no puede ser la semilla');
  const { rows: rol } = await pool.query(`SELECT id FROM roles WHERE nombre = 'consulta'`);

  // De otra empresa (sigue siendo miembro de ella).
  const { usuarioId: deOtraEmpresa } = await crearUsuario(ctx, { empresaId: empresa, rolNombre: 'administrador' });
  // Quitado de su empresa, tal como lo hace DELETE /api/usuarios/:id: solo se borra la membresía.
  const { usuarioId: quitado } = await crearUsuario(ctx, { empresaId: empresa, rolNombre: 'administrador' });
  await pool.query('DELETE FROM usuario_empresa WHERE usuario_id = $1 AND empresa_id = $2', [quitado, empresa]);
  // Que nunca tuvo empresa (p. ej. la de un usuario cuya empresa se eliminó).
  const { rows: nunca } = await pool.query(
    `INSERT INTO usuarios (nombre, email, password_hash, activo) VALUES ('QA-TEST (borrar) sin empresa', $1, 'x', true) RETURNING id`,
    [`qa-test-012-${Date.now()}@example.invalid`]
  );
  ctx.usuarioIds.push(nunca[0].id);

  const ids = [deOtraEmpresa, quitado, nunca[0].id];
  await pool.query('UPDATE usuarios SET rol_id = $1 WHERE id = ANY($2::int[])', [rol[0].id, ids]);

  const relleno = BLOQUE[0].replace('FROM usuarios u', `FROM (SELECT * FROM usuarios WHERE id IN (${ids.join(', ')})) u`);
  assert.notEqual(relleno, BLOQUE[0], 'no se pudo acotar el relleno a los usuarios de la prueba');
  return { empresa, semilla: semilla[0].id, deOtraEmpresa, quitado, nunca: nunca[0].id, relleno };
}

async function empresasDe(cliente, usuarioId) {
  const { rows } = await cliente.query('SELECT empresa_id FROM usuario_empresa WHERE usuario_id = $1 ORDER BY 1', [usuarioId]);
  return rows.map(r => r.empresa_id);
}

test('volver a correr el relleno con la base ya en uso NO mete a nadie en la empresa semilla (ni al de otra empresa, ni al quitado, ni al sin empresa)', async () => {
  const { empresa, deOtraEmpresa, quitado, nunca, relleno } = await prepararUsuarios();

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(relleno);
    assert.deepEqual(await empresasDe(cliente, deOtraEmpresa), [empresa], 'el usuario de otra empresa no gana acceso a la empresa semilla');
    assert.deepEqual(await empresasDe(cliente, quitado), [], 'a quien un administrador quitó de su empresa no se le devuelve el acceso en otra');
    assert.deepEqual(await empresasDe(cliente, nunca), [], 'una cuenta sin empresa no se re-asocia a la semilla en cada migrate');
  } finally {
    await cliente.query('ROLLBACK');
    cliente.release();
  }
});

test('la PRIMERA vez (usuario_empresa vacía) el relleno sí asocia a los usuarios existentes a la empresa semilla', async () => {
  const { semilla, deOtraEmpresa, quitado, nunca, relleno } = await prepararUsuarios();

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    // Una tabla temporal con el mismo nombre tapa a la real durante esta transacción: aquí
    // "usuario_empresa" está vacía, como en una base que acaba de crearla en 012.
    await cliente.query('CREATE TEMP TABLE usuario_empresa (LIKE public.usuario_empresa INCLUDING ALL) ON COMMIT DROP');
    await cliente.query(relleno);
    for (const id of [deOtraEmpresa, quitado, nunca]) {
      assert.deepEqual(await empresasDe(cliente, id), [semilla], 'en la primera corrida, cada usuario que ya existía queda en la empresa semilla (el propósito original del relleno)');
    }
  } finally {
    await cliente.query('ROLLBACK');
    cliente.release();
  }
});
