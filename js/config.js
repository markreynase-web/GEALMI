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
// sobreescribe --ochre/--ochre-deep Y --coral/--coral-deep.
//
// El botón primario de toda la app (.btn-ochre, en css/base.css) en
// realidad usa --coral/--coral-deep, no --ochre -- el nombre de la clase
// quedó de un diseño anterior y nunca se actualizó. Sin sobreescribir
// --coral también, el color elegido no se veía en ningún botón real (solo
// en detalles menores: bordes de foco, la pestaña "activo", el widget de
// GEALMI AI) -- por eso "no se notaba en la interfaz".
//
// Aviso: --coral también se usa para indicadores de "peligro/negativo"
// (botones de eliminar, KPIs en rojo, la flecha de tendencia hacia abajo).
// Con el color de marca puesto, esos indicadores usan ese mismo color en
// vez de rojo -- es el trade-off de que ambos usos compartan una sola
// variable en el CSS actual; separarlos en dos variables distintas es un
// cambio más grande que se puede hacer después si hace falta.
//
// Sin color guardado (o si llega mal formado), no se toca nada y quedan
// los colores de GEALMI de siempre.
function aplicarTema(config) {
  const raiz = document.documentElement.style;
  if (config.colorPrimario && /^#[0-9a-fA-F]{6}$/.test(config.colorPrimario)) {
    const oscuro = oscurecer(config.colorPrimario);
    raiz.setProperty('--ochre', config.colorPrimario);
    raiz.setProperty('--ochre-deep', oscuro);
    raiz.setProperty('--coral', config.colorPrimario);
    raiz.setProperty('--coral-deep', oscuro);
  } else {
    raiz.removeProperty('--ochre');
    raiz.removeProperty('--ochre-deep');
    raiz.removeProperty('--coral');
    raiz.removeProperty('--coral-deep');
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
