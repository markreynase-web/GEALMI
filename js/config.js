// js/config.js
// Fase A (multi-tenant): antes leía config/company.json, un archivo estático
// (un despliegue = una empresa). Ahora branding + módulos habilitados salen
// de la base de datos, scoped a la empresa activa del usuario logueado --
// se piden a GET /api/empresa/actual una vez que hay sesión. Sin sesión
// (ej. pages/login.html antes de loguearse) no hay empresa que resolver, así
// que se devuelve el default sin tocar la red -- apiBaseUrl es la única
// pieza que sigue disponible siempre porque ahora es una constante fija
// (ver js/apiConfig.js), no algo que dependa de la empresa.
//
// Se cachea en memoria porque no cambia durante la sesión y varias páginas/
// funciones lo consultan (sidebar, branding, título de la pestaña, etc.).

import { API_BASE_URL } from './apiConfig.js';
import { haySesionActiva, obtenerSesion } from './sesion.js';

const CONFIG_POR_DEFECTO = {
  bizName: 'Mi proyecto de datos',
  logo: 'PD',
  colorPrimario: null,
  apiBaseUrl: API_BASE_URL,
  modules: []
};

let cache = null;

// Deriva un tono más oscuro (para --ochre-deep, el que usan hover/estados
// activos) a partir del color primario elegido -- así el super admin solo
// escoge UN color por empresa y el resto sale coherente, sin pedir dos.
function oscurecer(hex, factor = 0.78) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return '#' + [r, g, b].map(c => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('');
}

// Personalización de marca por empresa (opt-in, la pone el super admin):
// sobreescribe --ochre/--ochre-deep y --brand/--brand-deep (el botón
// primario de toda la app, .btn-ochre en css/base.css, lee de ahí).
//
// Arreglo del Recambio de diseño (2026-09-21): antes esto TAMBIÉN
// sobreescribía --coral/--coral-deep, porque .btn-ochre leía de --coral por
// un nombre de clase que quedó de un diseño anterior. Eso mezclaba dos cosas
// que no deberían compartir variable: el color de marca de una empresa Y el
// color de "peligro" (eliminar, egresos, KPI en rojo) -- una empresa que
// elegía, por ejemplo, un azul, terminaba con sus botones de eliminar en
// azul también. Ahora --coral se queda SIEMPRE en rojo, sin importar el
// color de marca.
//
// Sin color guardado (o si llega mal formado), no se toca nada y quedan
// los colores de GEALMI de siempre.
function aplicarTema(config) {
  const raiz = document.documentElement.style;
  if (config.colorPrimario && /^#[0-9a-fA-F]{6}$/.test(config.colorPrimario)) {
    const oscuro = oscurecer(config.colorPrimario);
    raiz.setProperty('--ochre', config.colorPrimario);
    raiz.setProperty('--ochre-deep', oscuro);
    raiz.setProperty('--brand', config.colorPrimario);
    raiz.setProperty('--brand-deep', oscuro);
    raiz.setProperty('--teal', config.colorPrimario);
    raiz.setProperty('--teal-deep', oscuro);
    raiz.setProperty('--teal-strong', oscuro);
  } else {
    raiz.removeProperty('--ochre');
    raiz.removeProperty('--ochre-deep');
    raiz.removeProperty('--brand');
    raiz.removeProperty('--brand-deep');
    raiz.removeProperty('--teal');
    raiz.removeProperty('--teal-deep');
    raiz.removeProperty('--teal-strong');
  }
}

export async function cargarConfigEmpresa() {
  if (cache) return cache;

  if (!haySesionActiva()) {
    cache = CONFIG_POR_DEFECTO;
    aplicarTema(cache);
    return cache;
  }

  try {
    const token = obtenerSesion()?.token;
    const res = await fetch(`${API_BASE_URL}/empresa/actual`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    cache = { ...CONFIG_POR_DEFECTO, ...json };
  } catch (err) {
    console.warn('No se pudo cargar la información de la empresa, usando valores por defecto.', err);
    cache = CONFIG_POR_DEFECTO;
  }
  aplicarTema(cache);
  return cache;
}

export function modulosHabilitados(config) {
  return (config.modules || []).filter(m => m.enabled);
}

export function buscarModulo(config, id) {
  return (config.modules || []).find(m => m.id === id) || null;
}
