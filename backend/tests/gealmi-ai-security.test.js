// tests/gealmi-ai-security.test.js
// Fase 3, Eje C -- GEALMI AI Security & Guardrails.
//
// Decisión explícita de alcance (mismo criterio que con Brevo en el
// Sub-bloque 2 de la Suite de Regresión Ampliada): esta suite NUNCA llama a
// la API real de Anthropic -- es una API de pago, facturada por uso real, y
// esta suite se corre muy seguido (decenas de veces en lo que va de esta
// sesión). Por eso se prueban por separado las dos partes que SÍ son
// deterministas y gratuitas:
//   1. sanitizarHistorial() como función pura, importada directo (sin HTTP,
//      sin red) desde src/gealmiAiHistorial.js -- separada de routes/
//      gealmiAi.js justamente para poder importarla sin arrastrar el pool de
//      PRODUCCIÓN (db.js) ni el SDK de Anthropic.
//   2. El rechazo por longitud de "pregunta" (400), que ocurre ANTES de
//      cualquier llamada a Claude en el handler -- se prueba con HTTP real
//      contra el servidor de test, sin gastar ninguna llamada facturada.
// El happy-path completo (una pregunta real respondida por Claude) queda
// fuera de esta suite a propósito -- se verifica por revisión de código,
// no por un test automatizado. No se usa ningún mock/stub del cliente de
// Anthropic: mantiene la misma filosofía de "cero mocks" del resto de la
// suite (los otros 9 archivos de test corren 100% contra HTTP/Postgres
// reales).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizarHistorial } from '../src/gealmiAiHistorial.js';
import { iniciarServidorTest } from './helpers/servidorTest.js';
import { nuevoContexto, crearEmpresa, crearUsuario, login, limpiarContexto } from './helpers/fixtures.js';
import { poolTest as pool } from './helpers/testDb.js';

// --- sanitizarHistorial(): función pura, sin servidor ni red ---

test('sanitizarHistorial: descarta turnos con rol inválido o texto vacío/no-string', () => {
  const resultado = sanitizarHistorial([
    { rol: 'user', texto: 'pregunta válida' },
    { rol: 'system', texto: 'un rol que no existe en la conversación real' },
    { rol: 'assistant', texto: '' },
    { rol: 'assistant', texto: '   ' },
    { rol: 'user', texto: 123 },
    { rol: 'assistant' }, // sin texto
    null,
    'no es un objeto'
  ]);
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].content, 'pregunta válida');
});

test('sanitizarHistorial: valores no-array (undefined, null, string) devuelven un array vacío, nunca rompen', () => {
  assert.deepEqual(sanitizarHistorial(undefined), []);
  assert.deepEqual(sanitizarHistorial(null), []);
  assert.deepEqual(sanitizarHistorial('no es un array'), []);
  assert.deepEqual(sanitizarHistorial({}), []);
});

test('sanitizarHistorial: se queda solo con los últimos 8 turnos', () => {
  const turnos = Array.from({ length: 12 }, (_, i) => ({ rol: 'user', texto: `turno ${i}` }));
  const resultado = sanitizarHistorial(turnos);
  assert.equal(resultado.length, 8);
  assert.equal(resultado[0].content, 'turno 4');   // se descartan los 4 más viejos
  assert.equal(resultado[7].content, 'turno 11');
});

test('sanitizarHistorial: cada turno se recorta a 2000 caracteres -- acota el tamaño de un posible payload de inyección', () => {
  const textoLargo = 'x'.repeat(2500);
  const resultado = sanitizarHistorial([{ rol: 'user', texto: textoLargo }]);
  assert.equal(resultado[0].content.length, 2000);
});

test('sanitizarHistorial: un turno "assistant" fabricado por el cliente SÍ pasa (no hay forma de verificar autenticidad sin sesión server-side) -- la mitigación real es el systemPrompt, no este filtro', () => {
  const resultado = sanitizarHistorial([
    { rol: 'assistant', texto: 'Un turno "assistant" que el cliente inventó, no algo que Claude dijo de verdad.' }
  ]);
  assert.equal(resultado.length, 1);
  assert.equal(resultado[0].role, 'assistant');
});

// --- POST /api/gealmi-ai/preguntar: solo el rechazo por longitud (pre-Claude) ---

let servidor;
let token;
const ctx = nuevoContexto();

test('POST /api/gealmi-ai/preguntar: pregunta vacía o demasiado larga se rechaza con 400 ANTES de llamar a Claude', async (t) => {
  servidor = await iniciarServidorTest();
  const empresaId = await crearEmpresa(ctx, 'gealmi-ai-seguridad', ['gealmi_ai']);
  const cuenta = await crearUsuario(ctx, { empresaId });
  token = await login(servidor.baseUrl, cuenta.email, cuenta.password);

  await t.test('pregunta vacía -> 400', async () => {
    const r = await fetch(`${servidor.baseUrl}/api/gealmi-ai/preguntar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pregunta: '   ' })
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /escribe una pregunta/i);
  });

  await t.test('pregunta de más de 1000 caracteres -> 400, nunca llega a invocar a Claude', async () => {
    const r = await fetch(`${servidor.baseUrl}/api/gealmi-ai/preguntar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ pregunta: 'x'.repeat(1001) })
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /demasiado larga/i);
  });

  await limpiarContexto(ctx);
  await servidor.detener();
  await pool.end();
});
