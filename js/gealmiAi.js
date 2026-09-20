// js/gealmiAi.js
// Cliente delgado de /api/gealmi-ai (paso 7: GEALMI AI es un módulo con página
// propia -- pages/gealmi-ai.html -- y las conversaciones se guardan en el
// servidor). Mismo patrón de fetch que js/config.js (Authorization: Bearer
// <token de sesión>). Cada función lanza un Error con el mensaje exacto del
// servidor, para que la pantalla lo muestre tal cual.

import { API_BASE_URL } from './apiConfig.js';
import { obtenerSesion } from './sesion.js';

async function llamar(ruta, { metodo = 'GET', cuerpo } = {}) {
  const token = obtenerSesion()?.token;
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/gealmi-ai${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
  }
  let json = null;
  try { json = await res.json(); } catch { /* respuesta sin cuerpo JSON */ }
  if (!res.ok) {
    const error = new Error(json?.error || `No se pudo consultar a GEALMI AI (HTTP ${res.status}).`);
    error.status = res.status;
    throw error;
  }
  return json;
}

export const listarConversaciones = () => llamar('/conversaciones');
export const obtenerConversacion = (id) => llamar(`/conversaciones/${id}`);
export const renombrarConversacion = (id, titulo) => llamar(`/conversaciones/${id}`, { metodo: 'PUT', cuerpo: { titulo } });
export const eliminarConversacion = (id) => llamar(`/conversaciones/${id}`, { metodo: 'DELETE' });

// conversacionId null = abre una conversación nueva. Devuelve
// { conversacion_id, titulo, respuesta, herramientas_usadas }.
export const preguntarGealmiAi = (pregunta, conversacionId = null) =>
  llamar('/preguntar', { metodo: 'POST', cuerpo: { pregunta, ...(conversacionId ? { conversacion_id: conversacionId } : {}) } });
