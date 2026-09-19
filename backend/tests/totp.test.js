// tests/totp.test.js
// Nivel 3 -- 2FA. Funciones puras de src/totp.js: el algoritmo contra los
// vectores OFICIALES del RFC 6238 (Apéndice B) y el RFC 4648 (base32), más
// cifrado del secreto y códigos de recuperación. No toca base ni servidor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codificarBase32, decodificarBase32, generarSecreto, codigoTotp, verificarCodigoTotp, pasoDeTiempo, urlOtpauth,
  cifradoDisponible, cifrarSecreto, descifrarSecreto,
  generarCodigosRecuperacion, normalizarCodigoRecuperacion, hashCodigoRecuperacion, PASO_SEGUNDOS
} from '../src/totp.js';

const CLAVE_A = 'a'.repeat(64);
const CLAVE_B = 'b'.repeat(64);
// Secreto del RFC 6238: la cadena ASCII "12345678901234567890".
const SECRETO_RFC = codificarBase32(Buffer.from('12345678901234567890'));

test('base32: vectores del RFC 4648 (sin relleno) y ida y vuelta', () => {
  const vectores = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [texto, esperado] of Object.entries(vectores)) {
    assert.equal(codificarBase32(Buffer.from(texto)), esperado);
    assert.equal(decodificarBase32(esperado).toString(), texto);
  }
  assert.equal(SECRETO_RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const aleatorio = generarSecreto();
  assert.match(aleatorio, /^[A-Z2-7]{32}$/, '20 bytes = 32 caracteres base32');
  assert.throws(() => decodificarBase32('AB1!'), /inválido/);
});

test('TOTP: vectores oficiales del RFC 6238 (SHA-1, últimos 6 dígitos)', () => {
  // El RFC publica 8 dígitos; los 6 dígitos son el mismo valor módulo 10^6.
  const vectores = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']
  ];
  for (const [segundos, esperado] of vectores) {
    assert.equal(codigoTotp(SECRETO_RFC, segundos * 1000), esperado, `T=${segundos}`);
  }
});

test('verificarCodigoTotp: acepta el intervalo actual y ±1, rechaza ±2, y devuelve el paso', () => {
  const ahora = 1234567890 * 1000;
  const paso = pasoDeTiempo(ahora);
  assert.equal(verificarCodigoTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora), { ahoraMs: ahora }), paso);
  assert.equal(verificarCodigoTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora - PASO_SEGUNDOS * 1000), { ahoraMs: ahora }), paso - 1);
  assert.equal(verificarCodigoTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora + PASO_SEGUNDOS * 1000), { ahoraMs: ahora }), paso + 1);
  assert.equal(verificarCodigoTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora - 2 * PASO_SEGUNDOS * 1000), { ahoraMs: ahora }), null);
  assert.equal(verificarCodigoTotp(SECRETO_RFC, codigoTotp(SECRETO_RFC, ahora + 2 * PASO_SEGUNDOS * 1000), { ahoraMs: ahora }), null);
});

test('verificarCodigoTotp: formato inválido siempre null; tolera espacios; otro secreto no coincide', () => {
  const ahora = 59 * 1000;
  for (const malo of ['', '12345', '1234567', 'abcdef', '28708a', null, undefined, {}]) {
    assert.equal(verificarCodigoTotp(SECRETO_RFC, malo, { ahoraMs: ahora }), null, `debería rechazar ${JSON.stringify(malo)}`);
  }
  assert.notEqual(verificarCodigoTotp(SECRETO_RFC, '287 082', { ahoraMs: ahora }), null, 'las apps muestran "287 082" con espacio');
  assert.equal(verificarCodigoTotp(generarSecreto(), '287082', { ahoraMs: ahora }), null);
});

test('urlOtpauth: formato que leen las apps autenticadoras, con el correo codificado', () => {
  const url = urlOtpauth({ secreto: 'ABCDEFGH', email: 'ana+ventas@empresa.pe' });
  assert.equal(url, 'otpauth://totp/GEALMI%3Aana%2Bventas%40empresa.pe?secret=ABCDEFGH&issuer=GEALMI&algorithm=SHA1&digits=6&period=30');
});

test('cifrado del secreto: ida y vuelta, IV distinto cada vez, y falla si se altera o la clave es otra', () => {
  process.env.TOTP_ENCRYPTION_KEY = CLAVE_A;
  assert.equal(cifradoDisponible(), true);

  const secreto = generarSecreto();
  const c1 = cifrarSecreto(secreto);
  const c2 = cifrarSecreto(secreto);
  assert.notEqual(c1, c2, 'mismo secreto, distinto IV -> distinto texto cifrado');
  assert.ok(!c1.includes(secreto), 'el secreto nunca aparece en claro');
  assert.equal(descifrarSecreto(c1), secreto);

  const [v, iv, tag, datos] = c1.split(':');
  const dañado = Buffer.from(datos, 'base64'); dañado[0] ^= 1;
  assert.throws(() => descifrarSecreto([v, iv, tag, dañado.toString('base64')].join(':')), 'GCM detecta la alteración');
  assert.throws(() => descifrarSecreto('basura'), /Formato/);

  process.env.TOTP_ENCRYPTION_KEY = CLAVE_B;
  assert.throws(() => descifrarSecreto(c1), 'otra clave no puede descifrar');
});

test('cifrado: sin clave (o mal formada) queda deshabilitado en vez de guardar en claro', () => {
  for (const mala of [undefined, '', 'corta', 'z'.repeat(64)]) {
    if (mala === undefined) delete process.env.TOTP_ENCRYPTION_KEY; else process.env.TOTP_ENCRYPTION_KEY = mala;
    assert.equal(cifradoDisponible(), false, `clave ${JSON.stringify(mala)}`);
    assert.throws(() => cifrarSecreto('X'), /no está configurada/);
    assert.throws(() => hashCodigoRecuperacion('ABCDE12345'), /no está configurada/);
  }
});

test('códigos de recuperación: formato, unicidad, normalización y HMAC determinista', () => {
  process.env.TOTP_ENCRYPTION_KEY = CLAVE_A;
  const codigos = generarCodigosRecuperacion(10);
  assert.equal(codigos.length, 10);
  assert.equal(new Set(codigos).size, 10, 'sin repetidos');
  for (const c of codigos) assert.match(c, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, 'sin 0/O/1/I/L');

  const [codigo] = codigos;
  assert.equal(normalizarCodigoRecuperacion(` ${codigo.toLowerCase()} `), codigo.replace('-', ''));
  const hash = hashCodigoRecuperacion(normalizarCodigoRecuperacion(codigo));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashCodigoRecuperacion(normalizarCodigoRecuperacion(codigo.toLowerCase())));
  assert.notEqual(hash, hashCodigoRecuperacion(normalizarCodigoRecuperacion(codigos[1])));
  assert.ok(!hash.includes(codigo.replace('-', '')), 'el hash no contiene el código');

  process.env.TOTP_ENCRYPTION_KEY = CLAVE_B;
  assert.notEqual(hashCodigoRecuperacion(normalizarCodigoRecuperacion(codigo)), hash, 'la clave del servidor forma parte del hash');
});
