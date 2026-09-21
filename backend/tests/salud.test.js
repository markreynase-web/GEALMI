// tests/salud.test.js
// Las dos rutas de salud contra un servidor real:
//   * /api/salud     -> el proceso está vivo (no toca la base; lo usan el frontend y Render);
//   * /api/salud/db  -> además responde a una consulta real (lo usa el monitor externo).
// Y el caso importante para un monitor: con la base CAÍDA, /api/salud/db responde
// 503 (para que avise) mientras /api/salud sigue en 200.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { poolTest as pool } from './helpers/testDb.js';

after(async () => { await pool.end(); });

test('/api/salud responde sin sesión y sin tocar la base', async () => {
  const servidor = await iniciarServidorTest();
  try {
    const r = await fetch(`${servidor.baseUrl}/api/salud`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true });
  } finally { await servidor.detener(); }
});

test('/api/salud/db consulta la base, no pide sesión y no se guarda en ninguna caché', async () => {
  const servidor = await iniciarServidorTest();
  try {
    const r = await fetch(`${servidor.baseUrl}/api/salud/db`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') || '', /no-store/);
    const cuerpo = await r.json();
    assert.equal(cuerpo.ok, true);
    assert.equal(cuerpo.base_de_datos, 'ok');
    assert.equal(typeof cuerpo.respuesta_ms, 'number');
    assert.deepEqual(Object.keys(cuerpo).sort(), ['base_de_datos', 'ok', 'respuesta_ms'], 'no expone nada más de la base ni del servidor');

    // Los monitores gratuitos suelen preguntar con HEAD.
    const head = await fetch(`${servidor.baseUrl}/api/salud/db`, { method: 'HEAD' });
    assert.equal(head.status, 200);

    // Muchas consultas seguidas (un monitor, más alguien insistiendo) siguen respondiendo bien.
    const rafaga = await Promise.all(Array.from({ length: 40 }, () => fetch(`${servidor.baseUrl}/api/salud/db`).then(x => x.status)));
    assert.ok(rafaga.every(s => s === 200), 'una ráfaga no debe agotar la conexión a la base');
  } finally { await servidor.detener(); }
});

test('con la base de datos caída, /api/salud/db responde 503 sin detalles y /api/salud sigue en 200', async () => {
  // Un servidor apuntado a un puerto donde no escucha nadie: la conexión se rechaza al instante.
  const servidor = await iniciarServidorTest({ DATABASE_URL: 'postgresql://nadie:nada@127.0.0.1:9/inexistente', PGSSL: 'false' });
  try {
    const vivo = await fetch(`${servidor.baseUrl}/api/salud`);
    assert.equal(vivo.status, 200, 'el proceso sigue vivo');

    const r = await fetch(`${servidor.baseUrl}/api/salud/db`);
    assert.equal(r.status, 503);
    const cuerpo = await r.json();
    assert.deepEqual(cuerpo, { ok: false, base_de_datos: 'sin_respuesta' });
    assert.doesNotMatch(JSON.stringify(cuerpo), /127\.0\.0\.1|ECONNREFUSED|nadie|inexistente/, 'ni el host ni el usuario ni el error de la base salen en la respuesta');

    const head = await fetch(`${servidor.baseUrl}/api/salud/db`, { method: 'HEAD' });
    assert.equal(head.status, 503, 'con HEAD también avisa');
  } finally { await servidor.detener(); }
});
