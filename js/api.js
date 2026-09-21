// js/api.js
// Cliente HTTP genérico: habla con /api/{modulo} para cualquier módulo
// (ventas, inventario, clientes...). Toda función que falla (red caída,
// backend apagado, error del servidor) devuelve null en vez de lanzar,
// así el resto de la app puede caer a modo local sin romperse.

import { obtenerSesion, cerrarSesion } from './sesion.js';

function headerAuth() {
  const sesion = obtenerSesion();
  return sesion?.token ? { Authorization: `Bearer ${sesion.token}` } : {};
}

// Sub-bloque B1 (Fase 3, Eje B): antes, un 401 se trataba exactamente
// igual que "el backend está apagado" -- pedirJSON() devolvía null en
// silencio y cada módulo se quedaba sin datos, sin decirle al usuario por
// qué ni limpiar el token vencido. Esto centraliza la reacción: se limpia
// la sesión y se manda a login con un mensaje claro, una sola vez (para
// cualquier llamada que use pedirJSON() o importarCSV()).
function manejarSesionVencida() {
  cerrarSesion();
  // Con o sin extensión: el sitio se sirve como /pages/login (cleanUrls), pero
  // un marcador viejo o un servidor sin URLs limpias aún llega a login.html.
  if (!/\/login(\.html)?$/.test(location.pathname)) {
    location.replace('login?expirado=true');
  }
}

// Guarda el mensaje del último error de escritura (crear/editar/borrar) para
// que quien llamó pueda mostrarlo tal cual viene del backend -- ej. "Stock
// insuficiente: quedan 3 unidad(es) de Plumones". listarRegistros() sigue
// devolviendo null en silencio (así el modo local sigue funcionando si el
// backend está apagado), pero crear/editar necesitan el motivo exacto.
let ultimoError = null;
export function ultimoErrorAPI() {
  return ultimoError;
}

async function pedirJSON(baseUrl, path, opciones = {}) {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { 'Content-Type': 'application/json', ...headerAuth() },
      ...opciones
    });
    if (res.status === 401) {
      manejarSesionVencida();
      return null;
    }
    if (!res.ok) {
      const cuerpo = await res.json().catch(() => ({}));
      if (res.status === 403) throw new Error(cuerpo.error || 'No tienes permiso para esto.');
      throw new Error(cuerpo.error || `HTTP ${res.status}`);
    }
    ultimoError = null;
    if (res.status === 204) return true;
    return await res.json();
  } catch (err) {
    ultimoError = err.message;
    console.warn(`API ${path} no disponible:`, err.message);
    return null;
  }
}

// Un GET cualquiera a la API con la sesión del usuario: si vence, limpia la sesión y manda a
// login (igual que el resto de este archivo). Devuelve null si algo falla.
export function obtenerJSON(baseUrl, path) {
  return pedirJSON(baseUrl, path);
}

export async function backendDisponible(baseUrl) {
  const r = await pedirJSON(baseUrl, '/salud');
  return !!r;
}

export function listarRegistros(baseUrl, modulo, { desde, hasta } = {}) {
  const qs = new URLSearchParams();
  if (desde) qs.set('desde', desde);
  if (hasta) qs.set('hasta', hasta);
  const query = qs.toString() ? `?${qs}` : '';
  return pedirJSON(baseUrl, `/${modulo}${query}`);
}

// Buscar-mientras-escribís (ver componentes/comboboxBusqueda.js): a
// diferencia de listarRegistros(), que trae todo el módulo, esto pide al
// backend solo lo que coincide con `termino` (ver ?buscar= en
// crudFactory.js) -- pensado para módulos con cientos/miles de filas donde
// cargar todo al frontend para filtrar en JS ya no escala.
export function buscarRegistros(baseUrl, modulo, termino, limite = 20) {
  const qs = new URLSearchParams({ buscar: termino, limite: String(limite) });
  return pedirJSON(baseUrl, `/${modulo}?${qs}`);
}

export function crearRegistro(baseUrl, modulo, datos) {
  return pedirJSON(baseUrl, `/${modulo}`, { method: 'POST', body: JSON.stringify(datos) });
}

export function actualizarRegistro(baseUrl, modulo, id, datos) {
  return pedirJSON(baseUrl, `/${modulo}/${id}`, { method: 'PUT', body: JSON.stringify(datos) });
}

export function eliminarRegistro(baseUrl, modulo, id) {
  return pedirJSON(baseUrl, `/${modulo}/${id}`, { method: 'DELETE' });
}

export async function importarCSV(baseUrl, modulo, file) {
  const formData = new FormData();
  formData.append('archivo', file);
  try {
    const res = await fetch(`${baseUrl}/${modulo}/import`, { method: 'POST', body: formData, headers: headerAuth() });
    if (res.status === 401) {
      manejarSesionVencida();
      return null;
    }
    const cuerpo = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(cuerpo.error || `HTTP ${res.status}`);
    return cuerpo;
  } catch (err) {
    console.warn('Import CSV al backend falló:', err.message);
    return null;
  }
}
