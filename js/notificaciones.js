// js/notificaciones.js
// Cliente de /api/notificaciones (paso 6 del backlog): la campana de la barra
// superior, el aviso fijo de las importantes y la pantalla "Notificaciones"
// leen todo de acá. Guarda el último resumen en memoria y avisa a quien se
// suscriba cuando cambia -- así la campana, el badge del menú y el aviso fijo
// siempre muestran lo mismo sin pedirlo cada uno por su lado.
//
// Entrega: no hay conexión en vivo (Render gratis duerme al servicio y no
// mantiene sockets). Se consulta GET /resumen cada ~30 s mientras la pestaña
// se ve, y al volver a ella. Si el servidor todavía no tiene la migración 044
// (o no responde), la consulta falla en silencio y la página sigue como si no
// hubiera novedades: la campana nunca debe romper una pantalla.

import { obtenerSesion, haySesionActiva, estaImpersonando } from './sesion.js';

const INTERVALO_MS = 30000;

export const TIPOS = {
  mensaje: { icono: '💬', clase: 'mensaje', etiqueta: 'Mensaje' },
  stock_bajo: { icono: '📦', clase: 'stock', etiqueta: 'Inventario' },
  arqueo_diferencia: { icono: '🧾', clase: 'caja', etiqueta: 'Caja' },
  caja_abierta: { icono: '⏰', clase: 'caja', etiqueta: 'Caja' },
  vencimientos: { icono: '📅', clase: 'vence', etiqueta: 'Vencimientos' },
  rrhh: { icono: '👥', clase: 'rrhh', etiqueta: 'RRHH' }
};
export const tipoDe = (tipo) => TIPOS[tipo] || { icono: '🔔', clase: 'otro', etiqueta: 'Aviso' };

let apiBase = null;
let estado = { no_leidas: 0, pendientes_enterado: 0, importantes: [], recientes: [] };
const oyentes = new Set();
let iniciado = false;
let consultando = false;
let detenido = false;

export function estadoActual() { return estado; }

// fn se llama de inmediato con el estado actual y cada vez que cambia.
export function suscribir(fn) {
  oyentes.add(fn);
  fn(estado);
  return () => oyentes.delete(fn);
}

function avisar() {
  oyentes.forEach(fn => { try { fn(estado); } catch (err) { console.error('Notificaciones:', err); } });
}

// Nunca lanza: devuelve { ok, status, datos }. Un 401 detiene el sondeo (la
// sesión venció; ya lo resuelven las llamadas normales de cada página).
async function llamar(ruta, { metodo = 'GET', cuerpo } = {}) {
  const sesion = obtenerSesion();
  if (!sesion?.token || !apiBase) return { ok: false, status: 0, datos: null };
  try {
    const res = await fetch(`${apiBase}/notificaciones${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sesion.token}` },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      // Un clic en una notificación marca "leída" y navega enseguida: sin esto el pedido se cancelaría al cambiar de página.
      keepalive: metodo !== 'GET'
    });
    if (res.status === 401) detenido = true;
    return { ok: res.ok, status: res.status, datos: await res.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, datos: { error: 'No se pudo conectar con el servidor.' } };
  }
}

const mensajeDeError = (r, porDefecto) => r.datos?.error || porDefecto;

// ---------- Sondeo ----------

export async function consultar() {
  if (consultando || detenido || !haySesionActiva()) return;
  consultando = true;
  try {
    const r = await llamar('/resumen');
    if (r.ok && r.datos) {
      estado = r.datos;
      avisar();
    }
  } finally {
    consultando = false;
  }
}

export function iniciarSondeo(apiBaseUrl) {
  apiBase = apiBaseUrl;
  // Una sesión de soporte lleva el id del super admin: no tiene notificaciones propias.
  if (iniciado || !haySesionActiva() || estaImpersonando()) return;
  iniciado = true;
  consultar();
  setInterval(() => { if (document.visibilityState === 'visible') consultar(); }, INTERVALO_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') consultar(); });
}

// ---------- Acciones sobre las propias ----------

export async function marcarLeidas(ids) {
  const r = await llamar('/leer', { metodo: 'POST', cuerpo: { ids } });
  if (r.ok) consultar();
  return r.ok;
}

export async function marcarTodasLeidas() {
  const r = await llamar('/leer', { metodo: 'POST', cuerpo: { todas: true } });
  if (r.ok) consultar();
  return r.ok;
}

export async function confirmarEnterado(id) {
  const r = await llamar(`/${id}/enterado`, { metodo: 'POST' });
  if (r.ok) consultar();
  return r.ok;
}

// estado: 'todas' | 'sin_leer' | 'importantes'. Devuelve { total, pagina, limite, datos } o null.
export async function listar({ estado: filtro = 'todas', pagina = 1, limite = 20 } = {}) {
  const r = await llamar(`?estado=${encodeURIComponent(filtro)}&pagina=${pagina}&limite=${limite}`);
  return r.ok ? r.datos : null;
}

// ---------- Mensajes entre usuarios ----------

export async function listarDestinatarios() {
  const r = await llamar('/destinatarios');
  return r.ok ? r.datos : null;
}

// Devuelve { ok, datos|error }: el formulario muestra el motivo exacto que dio el servidor.
export async function enviarMensaje(payload) {
  const r = await llamar('/mensajes', { metodo: 'POST', cuerpo: payload });
  return r.ok ? { ok: true, datos: r.datos } : { ok: false, error: mensajeDeError(r, 'No se pudo enviar el mensaje.') };
}

export async function listarEnviados() {
  const r = await llamar('/enviados');
  return r.ok ? r.datos : null;
}

export async function detalleEnviado(lote) {
  const r = await llamar(`/enviados/${encodeURIComponent(lote)}`);
  return r.ok ? r.datos : null;
}

// ---------- Presentación ----------

export function tiempoRelativo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(min) || min < 1) return 'Justo ahora';
  if (min < 60) return `Hace ${min} minuto${min === 1 ? '' : 's'}`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `Hace ${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.floor(horas / 24);
  return `Hace ${dias} día${dias === 1 ? '' : 's'}`;
}

export function fechaCorta(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
}
