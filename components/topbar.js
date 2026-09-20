// components/topbar.js
// Reemplaza a los renderSesionWidget() que estaban duplicados en js/app.js,
// pages/usuarios.html, pages/auditoria.html y pages/inicio.html. Pinta dos
// cosas en cada página, después de renderSidebar():
//   - #topbarSearch: buscador global (funcional) sobre Ventas/Inventario/
//     Clientes/Finanzas, solo en los módulos donde el usuario tiene
//     "<modulo>.ver". Al primer foco cachea en memoria los datos de cada
//     módulo (Promise.all de listarRegistros ya existente en js/api.js);
//     cada tecla después de eso filtra en cliente, sin volver a pedir nada
//     al backend. Click en un resultado navega a "<modulo>.html?q=<termino>".
//   - #sesionWidget: campana de notificaciones (paso 6: leídas desde la base
//     de datos, con "Enterado" para las importantes -- ver js/notificaciones.js)
//     + el chip de usuario con dropdown (nombre/rol/cerrar sesión).

import { obtenerSesion, tienePermiso, haySesionActiva, cerrarSesion, estaImpersonando, restaurarSesionSuperAdmin } from '../js/sesion.js';
import { listarRegistros } from '../js/api.js';
import { escapeHtml, fmtNum } from '../js/utils.js';
import { iniciarSondeo, suscribir, marcarLeidas, marcarTodasLeidas, confirmarEnterado, tipoDe, tiempoRelativo } from '../js/notificaciones.js';

const MODULOS_BUSCABLES = [
  { id: 'ventas', label: 'Ventas', icon: '💰', campos: ['producto', 'cliente', 'categoria', 'notas'],
    titulo: v => v.producto, sub: v => `Cliente: ${v.cliente || '—'} · ${fmtNum(Number(v.monto) || 0)}` },
  { id: 'inventario', label: 'Inventario', icon: '📦', campos: ['nombre', 'categoria'],
    titulo: v => v.nombre, sub: v => `Stock: ${fmtNum(Number(v.stock) || 0)}` },
  { id: 'clientes', label: 'Clientes', icon: '👥', campos: ['nombre', 'email', 'telefono'],
    titulo: v => v.nombre, sub: v => v.email || v.telefono || 'Sin contacto' },
  { id: 'finanzas', label: 'Finanzas', icon: '📊', campos: ['concepto', 'categoria'],
    titulo: v => v.concepto, sub: v => v.tipo === 'ingreso' ? `Ingreso · ${fmtNum(Number(v.monto) || 0)}` : `Egreso · ${fmtNum(Number(v.monto) || 0)}` }
];

let cacheBusqueda = null;
let cargandoCache = null;

function asegurarCache(config) {
  if (cacheBusqueda) return Promise.resolve(cacheBusqueda);
  if (cargandoCache) return cargandoCache;
  cargandoCache = (async () => {
    const cache = {};
    await Promise.all(MODULOS_BUSCABLES.filter(m => tienePermiso(`${m.id}.ver`)).map(async m => {
      cache[m.id] = (await listarRegistros(config.apiBaseUrl, m.id)) || [];
    }));
    cacheBusqueda = cache;
    return cache;
  })();
  return cargandoCache;
}

function filtrarResultados(cache, termino) {
  const t = termino.trim().toLowerCase();
  if (!t) return [];
  return MODULOS_BUSCABLES
    .filter(m => cache[m.id])
    .map(m => ({
      modulo: m,
      filas: cache[m.id].filter(f => m.campos.some(c => String(f[c] || '').toLowerCase().includes(t))).slice(0, 5)
    }))
    .filter(g => g.filas.length);
}

function pintarResultados(panel, grupos, termino) {
  if (!grupos.length) {
    panel.innerHTML = `<div class="topbar-search-vacio">Sin resultados para "${escapeHtml(termino)}".</div>`;
    panel.classList.add('abierto');
    return;
  }
  panel.innerHTML = grupos.map(({ modulo, filas }) => `
    <div class="topbar-search-grupo-titulo">${modulo.icon} ${escapeHtml(modulo.label)}</div>
    ${filas.map(f => `
      <div class="topbar-search-item" data-modulo="${modulo.id}">
        <div>
          <div>${escapeHtml(modulo.titulo(f) || 'Sin nombre')}</div>
          <div class="sub">${escapeHtml(modulo.sub(f) || '')}</div>
        </div>
      </div>`).join('')}
  `).join('');
  // El término viaja por sessionStorage, no por la URL (?q=... o #q=...):
  // algunos servidores estáticos de "URLs limpias" (ej. "serve", que es el
  // que usa iniciar.bat) redirigen /modulo.html a /modulo y en ese salto se
  // pierden tanto el query string como el hash. sessionStorage no pasa por
  // el servidor, así que le es indiferente cualquier redirect.
  panel.querySelectorAll('.topbar-search-item').forEach(item => {
    item.addEventListener('click', () => {
      sessionStorage.setItem('pd_busqueda_pendiente', termino);
      location.href = item.dataset.modulo;
    });
  });
  panel.classList.add('abierto');
}

function renderBusqueda(config) {
  const cont = document.getElementById('topbarSearch');
  if (!cont) return;
  const buscables = MODULOS_BUSCABLES.filter(m => tienePermiso(`${m.id}.ver`));
  if (!haySesionActiva() || !buscables.length) { cont.innerHTML = ''; return; }

  cont.innerHTML = `
    <span class="ico">🔍</span>
    <input type="search" id="topbarSearchInput" placeholder="Buscar (clientes, productos, ventas...)">
    <div class="topbar-search-resultados" id="topbarSearchResultados"></div>
  `;
  const input = document.getElementById('topbarSearchInput');
  const panel = document.getElementById('topbarSearchResultados');
  let temporizador = null;

  input.addEventListener('focus', () => asegurarCache(config));
  input.addEventListener('input', () => {
    clearTimeout(temporizador);
    const termino = input.value;
    if (!termino.trim()) { panel.classList.remove('abierto'); return; }
    temporizador = setTimeout(async () => {
      const cache = await asegurarCache(config);
      pintarResultados(panel, filtrarResultados(cache, termino), termino);
    }, 200);
  });
  document.addEventListener('click', (e) => {
    if (!cont.contains(e.target)) panel.classList.remove('abierto');
  });
}

// ---------------------------------------------------------------------------
// Campana de notificaciones (paso 6): lee de la base de datos vía
// js/notificaciones.js -- ya no se arma al vuelo bajando el inventario entero
// en cada página. Se pinta una vez el armazón y después solo se actualiza su
// contenido cuando llega un resumen nuevo (cada ~30 s o al volver a la pestaña),
// así el desplegable no se cierra solo mientras alguien lo está leyendo.
// ---------------------------------------------------------------------------

function itemCampana(n) {
  const tipo = tipoDe(n.tipo);
  return `
    <div class="topbar-notif-item${n.leida ? '' : ' sin-leer'}" role="button" tabindex="0" data-id="${n.id}" data-enlace="${escapeHtml(n.enlace || '')}">
      <div class="topbar-notif-icono tipo-${tipo.clase}" aria-hidden="true">${tipo.icono}</div>
      <div class="topbar-notif-contenido">
        <div class="topbar-notif-texto">${n.requiere_enterado ? '<span class="topbar-notif-tag">Importante</span> ' : ''}<b>${escapeHtml(n.titulo)}</b></div>
        ${n.cuerpo ? `<div class="topbar-notif-detalle">${escapeHtml(n.cuerpo)}</div>` : ''}
        <div class="topbar-notif-hora">${n.remitente_nombre ? `${escapeHtml(n.remitente_nombre)} · ` : ''}${tiempoRelativo(n.creada_el)}</div>
      </div>
    </div>`;
}

function pintarCampana(estado) {
  const badge = document.getElementById('badgeNotif');
  if (badge) {
    badge.textContent = estado.no_leidas > 9 ? '9+' : String(estado.no_leidas);
    badge.style.display = estado.no_leidas ? 'flex' : 'none';
  }
  const boton = document.getElementById('btnNotif');
  if (boton) boton.setAttribute('aria-label', estado.no_leidas ? `Notificaciones: ${estado.no_leidas} sin leer` : 'Notificaciones');

  const lista = document.getElementById('listaNotif');
  if (lista) {
    lista.innerHTML = estado.recientes.length
      ? estado.recientes.map(itemCampana).join('')
      : '<div class="topbar-notif-vacio">Sin novedades por ahora.</div>';
  }
  const marcar = document.getElementById('btnMarcarTodasNotif');
  if (marcar) marcar.style.display = estado.no_leidas ? '' : 'none';

  // El menú lateral muestra el mismo contador junto a "Notificaciones".
  const badgeMenu = document.getElementById('badgeMenuNotif');
  if (badgeMenu) {
    badgeMenu.textContent = estado.no_leidas > 99 ? '99+' : String(estado.no_leidas);
    badgeMenu.hidden = !estado.no_leidas;
  }
  pintarAvisoFijo(estado);
}

// Las importantes (prioridad alta) quedan como una franja fija arriba de la
// página hasta que la persona da "Enterado": leerlas no alcanza. Solo se vuelve
// a dibujar cuando cambia cuál toca mostrar, para que el lector de pantalla no
// la repita en cada consulta.
let avisoMostrado = null; // "id:total"

function pintarAvisoFijo(estado) {
  const mainArea = document.querySelector('.main-area');
  if (!mainArea) return;
  const actual = document.getElementById('bannerAvisos');
  const n = estado.importantes[0];
  if (!n) { actual?.remove(); avisoMostrado = null; return; }
  const marca = `${n.id}:${estado.pendientes_enterado}`;
  if (actual && avisoMostrado === marca) return;
  avisoMostrado = marca;

  const resto = estado.pendientes_enterado - 1;
  const banner = actual || document.createElement('div');
  banner.id = 'bannerAvisos';
  banner.className = 'banner-avisos';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `
    <span class="banner-avisos-icono" aria-hidden="true">${tipoDe(n.tipo).icono}</span>
    <div class="banner-avisos-texto">
      <b>${escapeHtml(n.titulo)}</b>
      ${n.cuerpo ? `<span>${escapeHtml(n.cuerpo)}</span>` : ''}
      ${resto > 0 ? `<em>+ ${resto} aviso${resto === 1 ? '' : 's'} importante${resto === 1 ? '' : 's'} más</em>` : ''}
    </div>
    <div class="banner-avisos-acciones">
      ${n.enlace ? `<a class="banner-avisos-ver" href="${escapeHtml(n.enlace)}">Ver</a>` : ''}
      <button type="button" id="btnEnterado" data-id="${n.id}">Enterado</button>
    </div>`;
  if (!actual) mainArea.prepend(banner);
  document.getElementById('btnEnterado').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    await confirmarEnterado(n.id);
  });
}

async function alHacerClicEnNotificacion(item) {
  const { id, enlace } = item.dataset;
  await marcarLeidas([Number(id)]);
  if (enlace) location.href = enlace;
}

async function renderUsuarioYNotificaciones(config) {
  const cont = document.getElementById('sesionWidget');
  if (!cont) return;
  const sesion = obtenerSesion();
  if (!sesion?.usuario) { cont.innerHTML = `<a href="login" class="topbar-login-link">Iniciar sesión</a>`; return; }

  const inicial = (sesion.usuario.nombre || '?').trim().charAt(0).toUpperCase();

  cont.innerHTML = `
    <div class="topbar-user">
      <div class="topbar-notif">
        <button type="button" class="topbar-notif-btn" id="btnNotif" title="Notificaciones" aria-label="Notificaciones">
          🔔<span class="topbar-notif-badge" id="badgeNotif" style="display:none;"></span>
        </button>
        <div class="topbar-notif-panel" id="panelNotif">
          <div class="topbar-notif-cabecera">
            <div class="topbar-notif-titulo">Notificaciones</div>
            <button type="button" class="topbar-notif-marcar" id="btnMarcarTodasNotif" style="display:none;">Marcar todas como leídas</button>
          </div>
          <div class="topbar-notif-lista" id="listaNotif"><div class="topbar-notif-vacio">Sin novedades por ahora.</div></div>
          <a class="topbar-notif-ver-todas" href="notificaciones">Ver todas las notificaciones</a>
        </div>
      </div>
      <div class="topbar-usuario-menu">
        <button type="button" class="topbar-usuario-chip" id="btnUsuario">
          <div class="topbar-usuario-avatar">${inicial}</div>
          <div class="topbar-usuario-info">
            <div class="topbar-usuario-nombre">${escapeHtml(sesion.usuario.nombre)}</div>
            <div class="topbar-usuario-rol">${escapeHtml(sesion.usuario.rol)}</div>
          </div>
          <span class="topbar-usuario-chevron">▾</span>
        </button>
        <div class="topbar-usuario-panel" id="panelUsuario">
          <button type="button" id="btnCerrarSesionTopbar">⎋ Cerrar sesión</button>
        </div>
      </div>
    </div>
  `;

  const panelNotif = document.getElementById('panelNotif');
  const panelUsuario = document.getElementById('panelUsuario');

  document.getElementById('btnNotif').addEventListener('click', (e) => {
    e.stopPropagation();
    panelUsuario.classList.remove('abierto');
    panelNotif.classList.toggle('abierto');
  });
  // Un clic dentro del desplegable no lo cierra (el clic global de abajo lo haría antes de tiempo).
  panelNotif.addEventListener('click', (e) => e.stopPropagation());
  document.getElementById('listaNotif').addEventListener('click', (e) => {
    const item = e.target.closest('.topbar-notif-item');
    if (item) alHacerClicEnNotificacion(item);
  });
  document.getElementById('listaNotif').addEventListener('keydown', (e) => {
    const item = e.target.closest('.topbar-notif-item');
    if (item && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); alHacerClicEnNotificacion(item); }
  });
  document.getElementById('btnMarcarTodasNotif').addEventListener('click', () => marcarTodasLeidas());

  document.getElementById('btnUsuario').addEventListener('click', (e) => {
    e.stopPropagation();
    panelNotif.classList.remove('abierto');
    panelUsuario.classList.toggle('abierto');
  });
  document.getElementById('btnCerrarSesionTopbar').addEventListener('click', (e) => {
    e.stopPropagation();
    cerrarSesion();
    location.reload();
  });
  document.addEventListener('click', () => {
    panelNotif.classList.remove('abierto');
    panelUsuario.classList.remove('abierto');
  });

  // No se espera a la red: la página aparece ya y la campana se llena cuando llega el resumen.
  suscribir(pintarCampana);
  iniciarSondeo(config.apiBaseUrl);
}

// Banner mientras el super admin está impersonando una empresa (ver POST
// /superadmin/empresas/:id/impersonar). Se pinta acá -- no en cada página --
// porque renderTopbar() ya corre en TODAS ellas (tanto desde js/app.js como
// desde las páginas bespoke), así ninguna página nueva tiene que acordarse
// de agregarlo. Va primero dentro de .main-area (no de document.body):
// .sidebar ya es sticky top:0 dentro de .app-shell, y este banner sticky
// top:0 tendría que competir por esa misma posición si viviera afuera; dentro
// de .main-area (la columna derecha, .topbar no es sticky) no hay ese
// choque. "Salir" restaura la sesión de super admin que quedó respaldada al
// entrar (ver respaldarSesionSuperAdmin() en js/sesion.js) en vez de
// simplemente cerrar sesión, para no pedir contraseña de nuevo.
function renderBannerImpersonacion() {
  const existente = document.getElementById('bannerImpersonacion');
  if (!estaImpersonando()) { existente?.remove(); return; }
  if (existente) return;

  const mainArea = document.querySelector('.main-area');
  if (!mainArea) return;

  const sesion = obtenerSesion();
  const banner = document.createElement('div');
  banner.id = 'bannerImpersonacion';
  banner.className = 'banner-impersonacion';
  banner.innerHTML = `
    🔒 Estás viendo como soporte técnico — <b>${escapeHtml(sesion.usuario.empresa_nombre || 'esta empresa')}</b>
    <button type="button" id="btnSalirImpersonacion">Salir</button>
  `;
  mainArea.prepend(banner);
  document.getElementById('btnSalirImpersonacion').addEventListener('click', () => {
    const restaurada = restaurarSesionSuperAdmin();
    location.href = restaurada ? 'superadmin' : 'login';
  });
}

export async function renderTopbar(config) {
  renderBannerImpersonacion();
  renderBusqueda(config);
  await renderUsuarioYNotificaciones(config);
}
