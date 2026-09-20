// tests/helpers/anthropicFalso.js
// Servidor HTTP local que hace de API de Anthropic (POST /v1/messages) para los
// tests de GEALMI AI. El SDK lee ANTHROPIC_BASE_URL del entorno, así que basta
// arrancar el servidor de prueba con esa variable apuntando acá: el código de
// producción no cambia ni sabe que está hablando con un falso.
//
// Por qué un falso y no la API real: es de pago (cada llamada se factura) y la
// suite se corre decenas de veces. Por qué un falso HTTP y no un mock del
// cliente: el cliente real del SDK sigue corriendo (serialización, headers,
// errores), solo el otro extremo de la red es simulado -- y desde acá se puede
// inspeccionar EXACTAMENTE qué le mandó el backend al modelo (historial, tools,
// system prompt).

import http from 'node:http';

export function textoDe(contenido) {
  if (typeof contenido === 'string') return contenido;
  return (contenido || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

export function respuestaTexto(texto) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'text', text: texto }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 }
  };
}

export function respuestaHerramienta(nombre, input = {}, id = 'toolu_test_1') {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
    content: [{ type: 'tool_use', id, name: nombre, input }], stop_reason: 'tool_use', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 }
  };
}

// Por defecto contesta "Respuesta simulada a: <última pregunta>"; después de un
// tool_result contesta "Listo.". Cada test puede reemplazar el comportamiento con
// responder(fn), donde fn(cuerpo, numeroDePeticion) devuelve { status, cuerpo }.
function porDefecto(cuerpo) {
  const ultimo = cuerpo.messages?.at(-1);
  if (Array.isArray(ultimo?.content) && ultimo.content.some(b => b.type === 'tool_result')) {
    return { status: 200, cuerpo: respuestaTexto('Listo.') };
  }
  return { status: 200, cuerpo: respuestaTexto(`Respuesta simulada a: ${textoDe(ultimo?.content)}`) };
}

export async function iniciarAnthropicFalso() {
  const peticiones = [];
  let manejador = porDefecto;
  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (c) => partes.push(c));
    req.on('end', () => {
      let cuerpo = {};
      try { cuerpo = JSON.parse(Buffer.concat(partes).toString() || '{}'); } catch { /* cuerpo inválido: se ve como {} */ }
      peticiones.push(cuerpo);
      const { status, cuerpo: salida } = manejador(cuerpo, peticiones.length);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(salida));
    });
  });
  await new Promise((resolver) => servidor.listen(0, '127.0.0.1', resolver));
  const { port } = servidor.address();
  return {
    url: `http://127.0.0.1:${port}`,
    peticiones,
    responder(fn) { manejador = fn; },
    restaurar() { manejador = porDefecto; },
    detener: () => new Promise((resolver) => servidor.close(resolver))
  };
}
