// src/gealmiAiHistorial.js
// Sanitización del historial de chat que manda el cliente a POST
// /api/gealmi-ai/preguntar. Separado de routes/gealmiAi.js a propósito: es
// lógica pura (sin Express, sin el SDK de Anthropic, sin el pool de
// PostgreSQL) -- así se puede importar y probar directo (ver
// tests/gealmi-ai-security.test.js) sin arrastrar el pool de PRODUCCIÓN que
// routes/gealmiAi.js importa vía db.js, y sin construir un cliente de
// Anthropic solo para probar esta función.
//
// El historial lo manda el cliente tal cual (el chat vive en el navegador,
// ver components/gealmiAiWidget.js -- no hay sesión guardada server-side) --
// eso incluye los turnos "assistant", que en un request legítimo son la
// respuesta real que GEALMI AI ya dio, pero que nada impide que alguien
// fabrique a mano llamando a este endpoint directo (envenenamiento de
// historial: simular que "Claude" ya aceptó romper sus reglas). No hay
// forma de verificar server-side que un turno "assistant" sea genuino sin
// guardar sesión (cambio de arquitectura mayor, fuera de este alcance) --
// la mitigación real está en el systemPrompt de routes/gealmiAi.js, que
// trata TODO el contenido de la conversación como datos, nunca como
// instrucciones nuevas. Esta función solo acota el tamaño de cada turno
// (para achicar el margen de cualquier payload de inyección) y descarta lo
// que no tenga la forma esperada.

export const MAX_TURNOS_HISTORIAL = 8; // el chat vive en el navegador; solo se manda un recorte
export const MAX_LONGITUD_TURNO_HISTORIAL = 2000; // tope de costo/abuso por turno

export function sanitizarHistorial(historialCrudo) {
  const historial = Array.isArray(historialCrudo) ? historialCrudo.slice(-MAX_TURNOS_HISTORIAL) : [];
  return historial
    .filter(t => t && (t.rol === 'user' || t.rol === 'assistant') && typeof t.texto === 'string' && t.texto.trim())
    .map(t => ({ role: t.rol, content: t.texto.trim().slice(0, MAX_LONGITUD_TURNO_HISTORIAL) }));
}
