// tests/api-key-hash.test.js
// La API pública ya no paga bcrypt (~60 ms de CPU) en cada petición: las keys se guardan
// con SHA-256, las llaves antiguas guardadas con bcrypt siguen funcionando y pasan solas a
// SHA-256 en su primer uso válido, y el limitador de peticiones ya no crece sin límite.
//   1) unidad: el hash y la verificación;
//   2) unidad: el limitador (ventana, barrido de lo vencido, tope duro de claves);
//   3) servidor real: creación, llave antigua, llave equivocada, revocada y límites.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { hashDeApiKey, verificarApiKey, esHashSha256, esHashBcrypt } from '../src/apiKeyHash.js';
import { permitir, _paraPruebas as limitador } from '../src/rateLimiter.js';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

const ctx = nuevoContexto();
let servidor;

before(async () => { servidor = await iniciarServidorTest(); });
after(async () => {
  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});

const nuevaKey = () => `gealmi_${crypto.randomBytes(20).toString('hex')}`;
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1) El hash y la verificación
// ---------------------------------------------------------------------------

test('hashDeApiKey: formato sha256:<64 hex>, estable, distinto por key y sin la key adentro', () => {
  const key = nuevaKey();
  const hash = hashDeApiKey(key);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash.length, 71, 'cabe de sobra en key_hash VARCHAR(255)');
  assert.equal(hash, hashDeApiKey(key));
  assert.notEqual(hash, hashDeApiKey(nuevaKey()));
  assert.ok(!hash.includes(key.slice(7)), 'de la huella no se recupera la key');
  assert.equal(esHashSha256(hash), true);
  assert.equal(esHashBcrypt(hash), false);
});

test('verificarApiKey con SHA-256: acepta la key exacta y nada más', async () => {
  const key = nuevaKey();
  const hash = hashDeApiKey(key);
  assert.deepEqual(await verificarApiKey(key, hash), { valida: true, hashNuevo: null });
  assert.equal((await verificarApiKey(`${key}0`, hash)).valida, false, 'con un carácter de más');
  assert.equal((await verificarApiKey(key.slice(0, -1), hash)).valida, false, 'con un carácter de menos');
  assert.equal((await verificarApiKey(`${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`, hash)).valida, false, 'con el último carácter cambiado');
  assert.equal((await verificarApiKey(hash, hash)).valida, false, 'quien tuviera la huella (la base) no puede usarla como si fuera la key');
  assert.equal((await verificarApiKey('', hash)).valida, false);
});

test('verificarApiKey con una llave antigua en bcrypt: la acepta y pide re-guardarla como SHA-256', async () => {
  const key = nuevaKey();
  const antiguo = bcrypt.hashSync(key, 4);
  assert.equal(esHashBcrypt(antiguo), true);
  const bien = await verificarApiKey(key, antiguo);
  assert.equal(bien.valida, true);
  assert.equal(bien.hashNuevo, hashDeApiKey(key), 'el hash nuevo es el SHA-256 de esa misma key');
  const mal = await verificarApiKey(nuevaKey(), antiguo);
  assert.deepEqual(mal, { valida: false, hashNuevo: null }, 'una key equivocada no se mejora ni se acepta');
});

test('verificarApiKey: un formato de hash desconocido, vacío o truncado nunca se acepta ni lanza', async () => {
  const key = nuevaKey();
  for (const guardado of [null, undefined, '', 'texto', key, 'sha256:', 'sha256:abc', 'md5:d41d8cd98f00b204e9800998ecf8427e', '$2y$', '$1$salt$hash']) {
    const r = await verificarApiKey(key, guardado);
    assert.equal(r.valida, false, `hash guardado: ${JSON.stringify(guardado)}`);
    assert.equal(r.hashNuevo, null);
  }
});

// ---------------------------------------------------------------------------
// 2) El limitador de peticiones
// ---------------------------------------------------------------------------

test('limitador: deja pasar hasta el máximo, bloquea, y vuelve a dejar pasar al vencer la ventana', async () => {
  limitador.reiniciar();
  const opciones = { maxIntentos: 3, ventanaMs: 120 };
  assert.deepEqual([1, 2, 3].map(() => permitir('a', opciones)), [true, true, true]);
  assert.equal(permitir('a', opciones), false);
  assert.equal(permitir('a', opciones), false, 'los intentos bloqueados no extienden la ventana');
  assert.equal(permitir('b', opciones), true, 'otra clave tiene su propio contador');
  await esperar(160);
  assert.equal(permitir('a', opciones), true, 'pasada la ventana, vuelve a permitir');
});

test('limitador: las claves vencidas se barren solas (no quedan para siempre)', async () => {
  limitador.reiniciar();
  for (let i = 0; i < 300; i++) permitir(`falsa-${i}`, { maxIntentos: 1, ventanaMs: 10 });
  assert.equal(limitador.tamano(), 300);
  await esperar(40);
  // El barrido corre cada BARRER_CADA llamadas: se completa el ciclo con una clave que sí sigue viva.
  for (let i = 0; i < limitador.BARRER_CADA; i++) permitir('viva', { maxIntentos: 1e9, ventanaMs: 60000 });
  assert.ok(limitador.tamano() <= 2, `quedaron ${limitador.tamano()} entradas; solo debía seguir la clave viva`);
  assert.equal(permitir('viva', { maxIntentos: 1e9, ventanaMs: 60000 }), true);
});

test('limitador: tope duro de claves, y lo más reciente sigue contando', () => {
  limitador.reiniciar();
  const ventana = 10 * 60 * 1000;
  for (let i = 0; i < limitador.MAX_CLAVES + 200; i++) permitir(`inventada-${i}`, { maxIntentos: 5, ventanaMs: ventana });
  assert.ok(limitador.tamano() <= limitador.MAX_CLAVES + 1, `el mapa llegó a ${limitador.tamano()} entradas`);
  // La última clave inventada no fue descartada: su contador sigue funcionando.
  const ultima = `inventada-${limitador.MAX_CLAVES + 199}`;
  assert.deepEqual([1, 2, 3, 4].map(() => permitir(ultima, { maxIntentos: 5, ventanaMs: ventana })), [true, true, true, true]);
  assert.equal(permitir(ultima, { maxIntentos: 5, ventanaMs: ventana }), false, 'con 5 intentos ya anotados (1 al inventarla + 4), el sexto se bloquea');
  limitador.reiniciar();
});

// ---------------------------------------------------------------------------
// 3) Contra un servidor real
// ---------------------------------------------------------------------------

async function empresaConApi(sufijo) {
  const empresaId = await crearEmpresa(ctx, sufijo);
  const { rows } = await pool.query(`SELECT id FROM planes WHERE nombre = 'Profesional'`);
  await pool.query('UPDATE empresas SET plan_id = $1 WHERE id = $2', [rows[0].id, empresaId]);
  const admin = await crearUsuario(ctx, { empresaId });
  return { empresaId, token: await login(servidor.baseUrl, admin.email, admin.password), usuarioId: admin.usuarioId };
}

async function crearKeyPorApi(token) {
  const r = await fetch(`${servidor.baseUrl}/api/api-keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ nombre: 'Prueba SHA-256' })
  });
  assert.equal(r.status, 201);
  return r.json();
}

const llamar = (key) => fetch(`${servidor.baseUrl}/api/v1/inventario`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.status);

// Inserta directo una llave "de antes": guardada con bcrypt (costo bajo: la prueba solo necesita el formato).
async function insertarLlaveAntigua(empresaId, key, { activa = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO api_keys (empresa_id, nombre, prefijo, key_hash, activa) VALUES ($1, 'Llave antigua', $2, $3, $4) RETURNING id`,
    [empresaId, key.slice(0, 'gealmi_'.length + 12), bcrypt.hashSync(key, 4), activa]
  );
  return rows[0].id;
}
const hashEnBase = async (id) => (await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [id])).rows[0].key_hash;

test('una key nueva se guarda con SHA-256 (nunca en claro ni con bcrypt) y funciona', async () => {
  const { empresaId, token } = await empresaConApi('hash-nueva');
  const creada = await crearKeyPorApi(token);
  const guardado = await hashEnBase(creada.id);
  assert.equal(guardado, hashDeApiKey(creada.key));
  assert.ok(!guardado.includes(creada.key.slice(7)));

  assert.equal(await llamar(creada.key), 200);
  assert.equal(await llamar(`${creada.key.slice(0, -1)}${creada.key.endsWith('0') ? '1' : '0'}`), 401, 'mismo prefijo, otra cola');
  assert.equal(await llamar(creada.key.slice(0, 19)), 401, 'solo el prefijo (lo único que muestra la pantalla de API keys) no sirve');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM api_keys WHERE empresa_id = $1', [empresaId]);
  assert.equal(rows[0].n, 1);
});

test('una llave antigua (bcrypt) sigue funcionando y pasa a SHA-256 en su primer uso válido', async () => {
  const { empresaId } = await empresaConApi('hash-antigua');
  const key = nuevaKey();
  const id = await insertarLlaveAntigua(empresaId, key);
  assert.match(await hashEnBase(id), /^\$2[aby]\$/, 'arranca en bcrypt');

  assert.equal(await llamar(key), 200, 'la llave que ya entregaste sigue sirviendo');
  let hash = await hashEnBase(id);
  for (let i = 0; i < 20 && !esHashSha256(hash); i++) { await esperar(100); hash = await hashEnBase(id); }
  assert.equal(hash, hashDeApiKey(key), 'tras usarla bien, quedó guardada como SHA-256');
  assert.equal(await llamar(key), 200, 'y sigue sirviendo, ahora por el camino rápido');
});

test('una llave antigua con la cola equivocada da 401 y NO se modifica; una revocada tampoco se mejora', async () => {
  const { empresaId } = await empresaConApi('hash-antigua-mal');
  const key = nuevaKey();
  const id = await insertarLlaveAntigua(empresaId, key);
  const original = await hashEnBase(id);
  const equivocada = `${key.slice(0, -1)}${key.endsWith('0') ? '1' : '0'}`;
  assert.equal(await llamar(equivocada), 401);
  assert.equal(await hashEnBase(id), original, 'un intento fallido no toca el hash guardado');

  const revocada = nuevaKey();
  const idRevocada = await insertarLlaveAntigua(empresaId, revocada, { activa: false });
  assert.equal(await llamar(revocada), 401, 'revocada: 401 aunque la key sea la correcta');
  assert.match(await hashEnBase(idRevocada), /^\$2[aby]\$/, 'y no se migra');
});

test('el límite de 120 por minuto cuenta las peticiones de la key VÁLIDA: la 121 recibe 429', async () => {
  const { token } = await empresaConApi('hash-limite');
  const { key } = await crearKeyPorApi(token);
  const estados = [];
  for (let ronda = 0; ronda < 7; ronda++) {
    const lote = ronda < 6 ? 20 : 1; // 121 en total, de 20 en 20 para no tardar
    estados.push(...await Promise.all(Array.from({ length: lote }, () => llamar(key))));
  }
  assert.equal(estados.length, 121);
  assert.equal(estados.filter(s => s === 200).length, 120);
  assert.equal(estados.filter(s => s === 429).length, 1);
});

test('llaves inventadas: siempre 401 (sin 429 y sin llenar la memoria del limitador), aunque se repitan', async () => {
  const falsa = nuevaKey();
  const estados = [];
  for (let ronda = 0; ronda < 7; ronda++) estados.push(...await Promise.all(Array.from({ length: 20 }, () => llamar(falsa))));
  assert.equal(estados.length, 140, 'más que el límite de 120 por minuto');
  assert.ok(estados.every(s => s === 401), 'antes, la repetición de una misma llave falsa terminaba en 429 y cada llave falsa dejaba una entrada de memoria');
});

test('verificaciones bcrypt limitadas por prefijo: nadie puede usar las llaves antiguas para saturar la CPU', async () => {
  const { empresaId } = await empresaConApi('hash-tope-bcrypt');
  const key = nuevaKey();
  await insertarLlaveAntigua(empresaId, key);
  const prefijoConocido = key.slice(0, 'gealmi_'.length + 12);
  // Mismo prefijo, colas inventadas: solo las primeras 20 llegan a costar un bcrypt.
  const intentos = Array.from({ length: 25 }, () => `${prefijoConocido}${crypto.randomBytes(14).toString('hex')}`.slice(0, 47));
  const estados = await Promise.all(intentos.map(llamar));
  assert.equal(estados.filter(s => s === 401).length, 20);
  assert.equal(estados.filter(s => s === 429).length, 5);
});
