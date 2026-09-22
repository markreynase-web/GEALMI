// js/iconos.js
// Íconos SVG compartidos. "currentColor" hereda el color del elemento que lo
// contiene, así que no necesitan su propio CSS. Retícula de 24px, trazo 1.75
// (mismo criterio que la landing/login: sin emojis como ícono estructural).
//
// ICONO_SPARK es el único que ya existía (Rediseño v3, "Spark" en vez del
// emoji 🤖 para GEALMI AI). Los demás son del Recambio de diseño
// (2026-09-21): reemplazan los emoji que components/sidebar.js y
// components/topbar.js tenían escritos a mano para sus propios ítems fijos
// (Inicio, Notificaciones, Usuarios, la campana, la lupa...). Los íconos de
// los MÓDULOS del catálogo (Ventas 💰, Inventario 📦...) vienen de la tabla
// `modulos` en la base de datos (columna icon, ver migración 012) -- ESOS
// quedan fuera de este archivo a propósito: cambiarlos es un paso de
// backend/migración aparte, no de este archivo.
const wrap = (viewBox, contenido) => `<svg width="20" height="20" viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${contenido}</svg>`;

export const ICONO_SPARK = '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2L11.8 7.4L17 10L11.8 12.6L10 18L8.2 12.6L3 10L8.2 7.4L10 2Z" fill="currentColor"/></svg>';

export const ICONO_HOME = wrap('0 0 24 24', '<path d="M3.5 11 12 4l8.5 7"/><path d="M6 10v9.5h12V10"/><path d="M10 19.5v-5h4v5"/>');
export const ICONO_BELL = wrap('0 0 24 24', '<path d="M6 10.5a6 6 0 0 1 12 0c0 4 1.4 5.6 2 6.5H4c.6-.9 2-2.5 2-6.5Z"/><path d="M10 19.5a2.2 2.2 0 0 0 4 0"/>');
export const ICONO_CLOCK = wrap('0 0 24 24', '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>');
export const ICONO_USER = wrap('0 0 24 24', '<circle cx="12" cy="8.2" r="3.4"/><path d="M4.5 19.8c0-3.5 2.8-5.6 7.5-5.6s7.5 2.1 7.5 5.6"/>');
export const ICONO_BUILDING = wrap('0 0 24 24', '<rect x="4.5" y="3.5" width="10" height="17" rx="1.8"/><path d="M14.5 9.5h3a2 2 0 0 1 2 2v9h-5M8 8h3M8 12h3M8 16h3"/>');
export const ICONO_RECEIPT = wrap('0 0 24 24', '<path d="M6 3.5h12v17l-2.2-1.6L14 20.5l-2-1.6-2 1.6-1.8-1.6L6 20.5Z"/><path d="M8.5 8h7M8.5 11.5h7M8.5 15h4.5"/>');
export const ICONO_KEY = wrap('0 0 24 24', '<circle cx="8" cy="15" r="4"/><path d="M11 12 19 4M16 6l2.5 2.5M14 8l2 2"/>');
export const ICONO_SHIELD = wrap('0 0 24 24', '<path d="M12 3.2 19.5 6v5.6c0 4.4-3 7.6-7.5 9.2-4.5-1.6-7.5-4.8-7.5-9.2V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>');
export const ICONO_LOCK = wrap('0 0 24 24', '<rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.2"/>');
export const ICONO_SEARCH = wrap('0 0 24 24', '<circle cx="10.5" cy="10.5" r="7"/><path d="m20 20-4.4-4.4"/>');
export const ICONO_CHEVRON_DOWN = wrap('0 0 24 24', '<path d="M6 9.5 12 15.5 18 9.5"/>');
export const ICONO_MENU = wrap('0 0 24 24', '<path d="M4 7h16M4 12h16M4 17h16"/>');
export const ICONO_X = wrap('0 0 24 24', '<path d="M6 6l12 12M18 6 6 18"/>');

// Un ícono por tipo de notificación (js/notificaciones.js TIPOS) -- comparten
// esta misma retícula/trazo para que la campana, el aviso fijo y la página
// de notificaciones se vean como un solo sistema.
export const ICONO_MESSAGE = wrap('0 0 24 24', '<path d="M4 5.5h16v11H9.5L5 20.2v-3.7H4z"/><path d="M8.5 9.5h7M8.5 12.5h4"/>');
export const ICONO_PACKAGE = wrap('0 0 24 24', '<path d="M12 3.2 4 7.4v9.2l8 4.2 8-4.2V7.4z"/><path d="m4 7.4 8 4.2 8-4.2M12 11.6v9.2"/>');
export const ICONO_ALARM = wrap('0 0 24 24', '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.5 1.5M9 3h6M4.5 6l1.4-1.4M19.5 6l-1.4-1.4"/>');
export const ICONO_CALENDAR = wrap('0 0 24 24', '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>');
export const ICONO_USERS = wrap('0 0 24 24', '<circle cx="9" cy="8.2" r="3.4"/><path d="M2.8 19.8c0-3.5 2.8-5.6 6.2-5.6s6.2 2.1 6.2 5.6"/><path d="M15.4 4.9a3.4 3.4 0 0 1 0 6.6M18.2 14.6c2 .6 3.2 2.4 3.2 5.2"/>');
export const ICONO_GRID = wrap('0 0 24 24', '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>');

// Íconos de RRHH (Recambio de diseño, 2026-09-21): reemplazan los emoji que
// pages/rrhh.html y js/rrhh/*.js tenían escritos a mano (KPIs, botones de los
// modales, "Vista Ejecutiva/Operativa"). Las flechas de texto sueltas (→) y el
// check simple (✓) NO se tocan -- son glifos tipográficos, no pictogramas de
// color, y ya es el patrón que usa el resto de la app (ej. "Ver →" de Inicio).
export const ICONO_CHART_BAR = wrap('0 0 24 24', '<path d="M4 20V11M10 20V4M16 20v-7M22 20V8"/>');
export const ICONO_ARCHIVE = wrap('0 0 24 24', '<rect x="3" y="4.5" width="18" height="4.5" rx="1.2"/><path d="M4.5 9v9a1.5 1.5 0 0 0 1.5 1.5h12A1.5 1.5 0 0 0 19.5 18V9"/><path d="M10 13.5h4"/>');
export const ICONO_TRENDING_UP = wrap('0 0 24 24', '<path d="m3.5 17 5.8-5.8 4 4L20.5 8"/><path d="M15 8h5.5v5.5"/>');
export const ICONO_DOOR = wrap('0 0 24 24', '<path d="M6 3.5h9v17H6z"/><path d="M15 3.5 19 5v14l-4 1.5M11.5 12v.01"/>');
export const ICONO_ALERT_TRIANGLE = wrap('0 0 24 24', '<path d="M12 3.5 22 20.5H2z"/><path d="M12 9.5v5M12 17.5h.01"/>');
export const ICONO_INBOX = wrap('0 0 24 24', '<path d="M4 12h4.2l1.4 2.8h4.8l1.4-2.8H20"/><path d="M5 5h14l1.5 7v7a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19v-7z"/>');
export const ICONO_BRIEFCASE = wrap('0 0 24 24', '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5M3 12.5h18"/>');
export const ICONO_EDIT = wrap('0 0 24 24', '<path d="M4 20h4.2L19 9.2a2 2 0 0 0 0-2.8l-1.4-1.4a2 2 0 0 0-2.8 0L4 15.8z"/><path d="m13 6 3.5 3.5"/>');
export const ICONO_STAR = wrap('0 0 24 24', '<path d="m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>');
export const ICONO_GRADUATION = wrap('0 0 24 24', '<path d="m2 8 10-4 10 4-10 4z"/><path d="M6 10.5V16c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-5.5M22 8v6.5"/>');
export const ICONO_DOLLAR = wrap('0 0 24 24', '<circle cx="12" cy="12" r="8.5"/><path d="M12 6.5v11M15 9a3 3 0 0 0-3-1.5c-1.8 0-3 1-3 2.3 0 3 6 1.4 6 4.3 0 1.4-1.4 2.4-3 2.4a3.4 3.4 0 0 1-3-1.6"/>');
export const ICONO_EXTERNAL_LINK = wrap('0 0 24 24', '<path d="M9.5 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5"/><path d="M14 4h6v6M20 4l-9.5 9.5"/>');
export const ICONO_MEGAPHONE = wrap('0 0 24 24', '<path d="M3 10v4a1 1 0 0 0 1 1h2l7 4V5L6 9H4a1 1 0 0 0-1 1Z"/><path d="M18 8.5a5 5 0 0 1 0 7M21 6a8.5 8.5 0 0 1 0 12"/>');
export const ICONO_USER_CHECK = wrap('0 0 24 24', '<circle cx="9" cy="8.2" r="3.4"/><path d="M2.8 19.8c0-3.5 2.8-5.6 6.2-5.6s6.2 2.1 6.2 5.6"/><path d="m15.5 12.5 2 2 3.5-4"/>');
export const ICONO_CHECK_FILLED = wrap('0 0 24 24', '<circle cx="12" cy="12" r="8.5"/><path d="m8.2 12.3 2.6 2.6 5-5.4"/>');
export const ICONO_FOLDER = wrap('0 0 24 24', '<path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18Z"/>');
export const ICONO_UMBRELLA = wrap('0 0 24 24', '<path d="M12 3v2"/><path d="M3 13c0-5 4-9 9-9s9 4 9 9"/><path d="M12 13v8"/><path d="M9 21h6"/><path d="M5 17c1.5-1.2 3-1.8 4-1.8"/>');
export const ICONO_HOURGLASS = wrap('0 0 24 24', '<path d="M6 3.5h12M6 20.5h12"/><path d="M7 3.5v3.2c0 2 1.8 3.3 5 5.3 3.2 2 5 3.3 5 5.3v3.2M17 3.5v3.2c0 2-1.8 3.3-5 5.3-3.2 2-5 3.3-5 5.3v3.2"/>');
