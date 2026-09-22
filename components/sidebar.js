// components/sidebar.js
// Reemplaza a components/nav.js (menú horizontal) por el sidebar vertical
// fijo del nuevo diseño. Mismo criterio de antes: un módulo con
// baseDeDatos:true solo aparece si el usuario tiene "{modulo}.ver"; los
// módulos deshabilitados en config/company.json ni siquiera se agregan al DOM.
//
// Agrega una sección fija "Administración" con Usuarios y Auditoría (Fase 6,
// renombrada de "Configuración" en el Rediseño v3): esas dos SÍ están
// conectadas a endpoints reales del backend (/api/usuarios, /api/auditoria)
// y solo se muestran si el usuario tiene "usuarios.ver" / "auditoria.ver".
// No hay una sección "Reportes" todavía -- decidimos no ponerla hasta tener
// algo real detrás, para no dejar un link muerto en el menú.

import { modulosHabilitados, buscarModulo } from '../js/config.js';
import { tienePermiso, tieneAlgunPermiso, haySesionActiva } from '../js/sesion.js';
import { escapeHtml, urlLimpia } from '../js/utils.js';
import { ICONO_SPARK, ICONO_HOME, ICONO_BELL, ICONO_CLOCK, ICONO_USER, ICONO_BUILDING, ICONO_RECEIPT, ICONO_KEY, ICONO_SHIELD, ICONO_LOCK, ICONO_MENU, ICONO_X } from '../js/iconos.js';

// Grupo de sidebar por id de módulo (Rediseño v3). Client-side a propósito:
// la tabla `modulos` no tiene columna de categoría y no vale la pena una
// migración para algo puramente presentacional. Un módulo nuevo que no
// aparezca acá cae en 'gestion' por defecto (ver el reduce más abajo).
const GRUPO_POR_MODULO = {
  ventas: 'gestion', compras: 'gestion', inventario: 'gestion', clientes: 'gestion',
  finanzas: 'gestion', postventa: 'gestion', produccion: 'gestion', repuestos: 'gestion', marketing: 'gestion',
  agenda: 'gestion', tratamientos: 'gestion', planes_tratamiento: 'gestion', seguros_dentales: 'gestion',
  recetas_opticas: 'gestion', ordenes_laboratorio: 'gestion', seguros_vision: 'gestion',
  rrhh: 'recursos', vehiculos: 'recursos'
};
const GRUPOS_ORDEN = [
  { id: 'gestion', label: 'Gestión' },
  { id: 'recursos', label: 'Recursos' }
];

// Orden dentro de cada grupo (Recambio de diseño, 2026-09-21): antes salían
// en el orden que devolviera /api/empresa/actual (alfabético por id de
// módulo -- "Clientes" antes que "Ventas"). El núcleo del negocio
// (Ventas -> Inventario -> Clientes -> Finanzas, el mismo orden que ya usa
// la landing) va primero; un módulo que no aparezca acá se queda al final,
// en el orden en que llegó.
const ORDEN_DENTRO_DEL_GRUPO = ['ventas', 'inventario', 'clientes', 'finanzas', 'rrhh'];
function ordenarModulos(modulos) {
  return modulos
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const pa = ORDEN_DENTRO_DEL_GRUPO.indexOf(a.m.id), pb = ORDEN_DENTRO_DEL_GRUPO.indexOf(b.m.id);
      if (pa === -1 && pb === -1) return a.i - b.i; // ninguno tiene prioridad: se queda el orden original
      if (pa === -1) return 1;
      if (pb === -1) return -1;
      return pa - pb;
    })
    .map(({ m }) => m);
}

const CLAVE_COLAPSADO = 'gealmi_sidebar_colapsado';

// Chevron del botón de colapsar -- apunta a la izquierda ("contraer") por
// defecto; css/layout.css lo rota 180° cuando .sidebar tiene .colapsado, en
// vez de cambiar el ícono a mano en cada toggle.
const ICONO_CHEVRON = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M9 2.5L4.5 7L9 11.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// m.icon puede ser un SVG de confianza (los ítems fijos de este archivo, ver
// js/iconos.js) o un emoji suelto (los módulos del catálogo, tabla `modulos`
// en la base de datos -- ver la nota al inicio del archivo): un SVG entra tal
// cual, cualquier otra cosa se trata como texto y se escapa.
function itemHtml(m, activo) {
  const icono = typeof m.icon === 'string' && m.icon.startsWith('<svg') ? m.icon : escapeHtml(m.icon || '•');
  return `
    <a class="sidebar-item${activo ? ' active' : ''}" href="${m.href}" title="${escapeHtml(m.label)}">
      <span class="sidebar-icon">${icono}</span>
      <span>${m.label}</span>
      ${m.badgeId ? `<span class="sidebar-badge" id="${m.badgeId}" hidden></span>` : ''}
    </a>`;
}

export function renderSidebar(config, paginaActualId) {
  const cont = document.getElementById('sidebar');
  if (!cont) return;

  const sinSesion = !haySesionActiva();
  // "Mi asistencia" (paso 8): cualquier persona de una empresa con RRHH contratado
  // puede marcar su asistencia, sin permiso rrhh.* -- solo hace falta que su
  // usuario esté vinculado a una ficha (la pantalla lo explica si no).
  const conRrhh = !sinSesion && modulosHabilitados(config).some(m => m.id === 'rrhh');

  const modulosPrincipales = modulosHabilitados(config).filter(m => {
    // GEALMI AI tiene su propia entrada fija al pie del menú (ver
    // gealmiAiEntradaHtml): sin este filtro caería también en la rama de abajo
    // (baseDeDatos:false = "módulo libre, mostrar siempre") y aparecería dos
    // veces, y sin respetar el permiso gealmi_ai.ver.
    if (m.id === 'gealmi_ai') return false;
    if (!m.baseDeDatos) return true;
    if (sinSesion) return true; // el guard de app.js ya redirige a login antes si el módulo lo exige
    return tienePermiso(`${m.id}.ver`);
  });

  const seccionAdmin = [];
  if (sinSesion || tieneAlgunPermiso('usuarios')) {
    seccionAdmin.push({ id: 'usuarios', label: 'Usuarios', icon: ICONO_USER, href: 'usuarios' });
  }
  // Sub-fase F: Sucursales y Cajas, mismo criterio que Usuarios/Auditoría --
  // no dependen de un módulo contratado (empresa_modulos), son transversales
  // y se gatean solo por permiso (ver backend/src/routes/sucursales.js y
  // cajas.js, que a propósito no usan requireModulo()).
  if (sinSesion || tieneAlgunPermiso('sucursales')) {
    seccionAdmin.push({ id: 'sucursales', label: 'Sucursales', icon: ICONO_BUILDING, href: 'sucursales' });
  }
  if (sinSesion || tieneAlgunPermiso('cajas')) {
    seccionAdmin.push({ id: 'cajas', label: 'Cajas', icon: ICONO_RECEIPT, href: 'cajas' });
  }
  // API pública (Nivel 3): también transversal, gateada por permiso -- el
  // acceso real lo decide el plan de la empresa (planes.acceso_api), que el
  // backend revalida en cada request (ver backend/src/routes/apiKeys.js).
  if (sinSesion || tieneAlgunPermiso('api_keys')) {
    seccionAdmin.push({ id: 'api-keys', label: 'API pública', icon: ICONO_KEY, href: 'api-keys' });
  }
  if (sinSesion || tieneAlgunPermiso('auditoria')) {
    seccionAdmin.push({ id: 'auditoria', label: 'Auditoría', icon: ICONO_SHIELD, href: 'auditoria' });
  }
  // Seguridad de la PROPIA cuenta (verificación en dos pasos): para cualquier
  // persona con sesión, sin permiso de rol -- la pantalla misma explica si su
  // plan lo incluye.
  seccionAdmin.push({ id: 'seguridad', label: 'Seguridad', icon: ICONO_LOCK, href: 'seguridad' });

  // Agrupa los módulos habilitados según GRUPO_POR_MODULO, preservando el
  // orden de GRUPOS_ORDEN -- un grupo sin módulos simplemente no se pinta.
  const modulosPorGrupo = new Map(GRUPOS_ORDEN.map(g => [g.id, []]));
  modulosPrincipales.forEach(m => {
    const grupoId = GRUPO_POR_MODULO[m.id] || 'gestion';
    modulosPorGrupo.get(grupoId).push(m);
  });
  const gruposHtml = GRUPOS_ORDEN
    .filter(g => modulosPorGrupo.get(g.id).length)
    .map(g => `
      <div class="sidebar-group">
        <div class="sidebar-group-label">${g.label}</div>
        ${ordenarModulos(modulosPorGrupo.get(g.id)).map(m => itemHtml({ ...m, href: urlLimpia(m.page) }, m.id === paginaActualId)).join('')}
      </div>`)
    .join('');

  asegurarFavicon();

  cont.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-brand">
        <a href="../" title="Ir a la página principal"><img class="mark" src="../assets/brand/gealmi-mark-white.svg" alt="GEALMI"></a>
        <div class="sidebar-brand-text">
          <input class="biz-name" id="bizName" value="${escapeHtml(config.bizName || 'Gestor de Datos Empresariales')}" />
          <div class="sidebar-subtitle" id="sidebarSubtitle"></div>
        </div>
        <button type="button" class="sidebar-collapse-btn" id="btnColapsarSidebar" title="Contraer menú" aria-label="Contraer menú">${ICONO_CHEVRON}</button>
        <button type="button" class="sidebar-close-btn" id="btnCerrarSidebarMovil" aria-label="Cerrar menú">${ICONO_X}</button>
      </div>
      <nav class="sidebar-nav">
        ${!sinSesion ? `
          <div class="sidebar-group">
            <div class="sidebar-group-label">Principal</div>
            ${itemHtml({ id: 'inicio', label: 'Inicio', icon: ICONO_HOME, href: 'inicio' }, paginaActualId === 'inicio')}
            ${itemHtml({ id: 'notificaciones', label: 'Notificaciones', icon: ICONO_BELL, href: 'notificaciones', badgeId: 'badgeMenuNotif' }, paginaActualId === 'notificaciones')}
            ${conRrhh ? itemHtml({ id: 'mi-asistencia', label: 'Mi asistencia', icon: ICONO_CLOCK, href: 'mi-asistencia' }, paginaActualId === 'mi-asistencia') : ''}
          </div>` : ''}
        ${gruposHtml}
        ${seccionAdmin.length ? `
          <div class="sidebar-group">
            <div class="sidebar-group-label">Administración</div>
            ${seccionAdmin.map(m => itemHtml(m, m.id === paginaActualId)).join('')}
          </div>` : ''}
      </nav>
      ${gealmiAiEntradaHtml(config, paginaActualId)}
      <div class="sidebar-footer" id="sidebarFooter"></div>
    </div>
  `;

  renderSidebarFooter();
  asegurarControlesMovil();
  aplicarEstadoColapsado();
}

// Entrada fija de GEALMI AI al pie del sidebar (Rediseño v3): módulo habilitado
// por la empresa Y permiso del usuario, para que no aparezca una entrada que
// lleva a algo que ese usuario/empresa no tiene. Desde el paso 7 es un enlace a
// pages/gealmi-ai.html (antes abría un chat flotante en la misma página).
function gealmiAiEntradaHtml(config, paginaActualId) {
  const habilitado = !!buscarModulo(config, 'gealmi_ai') && tienePermiso('gealmi_ai.ver');
  if (!habilitado) return '';
  return `
    <a class="sidebar-gealmi-ai${paginaActualId === 'gealmi_ai' ? ' active' : ''}" href="gealmi-ai" title="Abrir GEALMI AI">
      <div class="sidebar-gealmi-ai-icon">${ICONO_SPARK}</div>
      <div class="sidebar-footer-info">
        <div class="sidebar-footer-nombre">GEALMI AI</div>
        <div class="sidebar-footer-rol">Asistente empresarial</div>
      </div>
      <span class="sidebar-gealmi-ai-chevron">›</span>
    </a>`;
}

// Colapsar/expandir el sidebar en desktop (v3): estado persistido en
// localStorage porque esto NO es una SPA -- cada página carga de cero y
// renderSidebar() corre de nuevo, así que sin persistencia el sidebar
// "saltaría" a expandido en cada clic de navegación.
function aplicarEstadoColapsado() {
  const sidebar = document.getElementById('sidebar');
  const btn = document.getElementById('btnColapsarSidebar');
  if (!sidebar || !btn) return;

  function pintar(colapsado) {
    sidebar.classList.toggle('colapsado', colapsado);
    btn.title = colapsado ? 'Expandir menú' : 'Contraer menú';
    btn.setAttribute('aria-label', btn.title);
  }

  pintar(localStorage.getItem(CLAVE_COLAPSADO) === '1');
  btn.addEventListener('click', () => {
    const colapsado = !sidebar.classList.contains('colapsado');
    localStorage.setItem(CLAVE_COLAPSADO, colapsado ? '1' : '0');
    pintar(colapsado);
  });
}

// Ícono de pestaña del navegador -- se agrega una sola vez por página, acá
// en vez de tener que repetir <link rel="icon"> en las 11 páginas que usan
// el sidebar (login.html y privacidad.html, que no usan el sidebar, lo
// declaran directo en su <head>).
function asegurarFavicon() {
  if (document.querySelector('link[rel="icon"]')) return;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = '../assets/brand/gealmi-icon.svg';
  link.type = 'image/svg+xml';
  document.head.appendChild(link);
}

// Botón hamburguesa (topbar) + overlay oscuro (body), para el menú tipo
// drawer en celular (ver @media max-width:640px en css/layout.css). Se
// generan una sola vez desde acá -- así no hay que agregar este mismo
// bloque de HTML a mano en las 11 páginas que usan el sidebar.
function asegurarControlesMovil() {
  if (!document.getElementById('btnMenuMovil')) {
    const topbar = document.querySelector('.topbar');
    if (topbar) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'btnMenuMovil';
      btn.className = 'sidebar-toggle-movil';
      btn.setAttribute('aria-label', 'Abrir menú');
      btn.innerHTML = ICONO_MENU;
      topbar.prepend(btn);
      btn.addEventListener('click', () => toggleSidebarMovil(true));
    }
  }

  // Botón "X" dentro del cajón (junto a la marca, ver la maqueta del menú
  // móvil): antes solo se podía cerrar tocando fuera (el overlay). renderSidebar()
  // vuelve a crear este botón en cada llamada -- se conecta una sola vez, no una
  // por llamada, para no apilar listeners si algo re-renderiza el sidebar.
  const btnCerrar = document.getElementById('btnCerrarSidebarMovil');
  if (btnCerrar && !btnCerrar.dataset.conectado) {
    btnCerrar.dataset.conectado = '1';
    btnCerrar.addEventListener('click', () => toggleSidebarMovil(false));
  }

  if (!document.getElementById('sidebarOverlayMovil')) {
    const overlay = document.createElement('div');
    overlay.id = 'sidebarOverlayMovil';
    overlay.className = 'sidebar-overlay-movil';
    overlay.addEventListener('click', () => toggleSidebarMovil(false));
    document.body.appendChild(overlay);
  }

  // Escape cierra el cajón desde cualquier parte -- un solo listener por página
  // (document.body no se vuelve a crear entre llamadas, por eso el dataset acá).
  if (!document.body.dataset.escCajonMovil) {
    document.body.dataset.escCajonMovil = '1';
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && document.getElementById('sidebar')?.classList.contains('abierto')) toggleSidebarMovil(false);
    });
  }
}

function toggleSidebarMovil(abrir) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebarOverlayMovil');
  if (!sidebar || !overlay) return;
  sidebar.classList.toggle('abierto', abrir);
  overlay.classList.toggle('activo', abrir);
  document.body.classList.toggle('sidebar-movil-abierto', abrir);
  // El foco sigue a la acción: entra al botón de cerrar al abrir, vuelve al
  // botón hamburguesa al cerrar -- así quien navega con teclado nunca lo pierde
  // detrás del cajón (cerrado) ni fuera de él (abierto).
  (abrir ? document.getElementById('btnCerrarSidebarMovil') : document.getElementById('btnMenuMovil'))?.focus();
}

// Pie del sidebar: solo la marca (Recambio de diseño, 2026-09-21). Antes
// repetía acá la identidad del usuario + "Cerrar sesión" -- ya duplicado en
// el chip de la topbar (components/topbar.js, en TODAS las páginas, con
// sesión o sin ella: "Iniciar sesión" sin sesión, avatar+rol+"Cerrar sesión"
// con ella) -- dos botones de salir en dos sitios distintos de la misma
// pantalla no suma claridad. Nada más en el proyecto lee #sidebarFooter/
// #btnCerrarSesionSidebar (se verificó antes de este cambio), así que no
// rompe nada quitar ese contenido de acá.
function renderSidebarFooter() {
  const cont = document.getElementById('sidebarFooter');
  if (!cont) return;
  cont.innerHTML = `<div class="sidebar-tagline">Tu negocio, <span>en un solo lugar</span></div>`;
}
