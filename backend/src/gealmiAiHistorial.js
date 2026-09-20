// src/gealmiAiHistorial.js
// Arma el historial que se le manda al modelo a partir de los mensajes
// GUARDADOS de una conversación (tabla gealmi_ai_mensajes, migración 045).
// Separado de routes/gealmiAi.js a propósito: es lógica pura (sin Express, sin
// el SDK de Anthropic, sin el pool) -- así se importa y se prueba directo (ver
// tests/gealmi-ai-security.test.js) sin arrastrar db.js.
//
// Antes el cliente mandaba su propio historial (el chat vivía en el navegador) y
// eso incluía turnos "assistant" que nadie podía verificar: alguien podía
// fabricarlos a mano para simular que "Claude" ya aceptó romper sus reglas
// (envenenamiento de historial). Ahora el servidor lee SU copia de la
// conversación y el campo `historial` que mande un cliente se ignora: ese
// vector deja de existir. El systemPrompt sigue tratando todo el contenido de la
// conversación como datos, nunca como instrucciones (defensa en profundidad).

export const MAX_MENSAJES_HISTORIAL = 12; // 6 turnos: suficiente contexto sin disparar el costo por pregunta
export const MAX_LONGITUD_MENSAJE_HISTORIAL = 3000; // una respuesta larga previa no necesita viajar completa

// filas: mensajes de la conversación en orden cronológico ({ rol, texto }).
export function armarHistorialModelo(filas) {
  const lista = Array.isArray(filas) ? filas.slice(-MAX_MENSAJES_HISTORIAL) : [];
  return lista
    .filter(f => f && (f.rol === 'user' || f.rol === 'assistant') && typeof f.texto === 'string' && f.texto.trim())
    .map(f => ({ role: f.rol, content: f.texto.trim().slice(0, MAX_LONGITUD_MENSAJE_HISTORIAL) }));
}

// Título de una conversación nueva: la primera pregunta, en una línea y acotada.
export function tituloDesdePregunta(pregunta, max = 60) {
  const limpio = String(pregunta ?? '').replace(/\s+/g, ' ').trim();
  if (!limpio) return 'Nueva conversación';
  return limpio.length > max ? `${limpio.slice(0, max - 1).trimEnd()}…` : limpio;
}
