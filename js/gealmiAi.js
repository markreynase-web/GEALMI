// js/gealmiAi.js
// Fase D: cliente delgado para el endpoint de GEALMI AI. Mismo patrón de
// fetch que js/config.js (Authorization: Bearer <token de sesión>).

import { API_BASE_URL } from './apiConfig.js';
import { obtenerSesion } from './sesion.js';

// historial: [{ rol:'user'|'assistant', texto:'...' }, ...] -- lo arma y
// mantiene components/gealmiAiWidget.js, en memoria del navegador (no se
// persiste, ver decisión de "generación en vivo" en el plan de Fase D).
export async function preguntarGealmiAi(pregunta, historial = []) {
  const token = obtenerSesion()?.token;
  const res = await fetch(`${API_BASE_URL}/gealmi-ai/preguntar`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ pregunta, historial })
  });

  let json = null;
  try { json = await res.json(); } catch { /* respuesta sin cuerpo JSON */ }

  if (!res.ok) {
    throw new Error(json?.error || `No se pudo consultar a GEALMI AI (HTTP ${res.status}).`);
  }
  return json; // { respuesta, herramientas_usadas }
}
