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
//   - #sesionWidget: campana de notificaciones (real: stock bajo,
//     vencimientos próximos, actividad reciente de auditoría -- sin tabla
//     nueva en la base de datos, se arma al vuelo desde endpoints que ya
//     existen) + el chip de usuario con dropdown (nombre/rol/cerrar sesión).

import { obtenerSesion, tienePermiso, haySesionActiva, cerrarSesion, estaImpersonando, restaurarSesionSuperAdmin } from '../js/sesion.js';
import { listarRegistros } from '../js/api.js';
import { escapeHtml, fmtNum } from '../js/utils.js';

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

const ETIQUETA_ACCION = { crear: 'Creó', editar: 'Editó', eliminar: 'Eliminó' };

function diasHasta(fechaStr) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(fechaStr); f.setHours(0, 0, 0, 0);
  return Math.round((f - hoy) / 86400000);
}

function tiempoRelativo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'Justo ahora';
  if (min < 60) return `Hace ${min} minuto${min === 1 ? '' : 's'}`;
  const horas = Math.floor(min / 60);
  if (horas < 24) return `Hace ${horas} hora${horas === 1 ? '' : 's'}`;
  const dias = Math.floor(horas / 24);
  return `Hace ${dias} día${dias === 1 ? '' : 's'}`;
}

// Sin tabla de "notificaciones" en la base de datos: se arman al vuelo a
// partir de datos que ya existen (alertas de stock/vencimiento de
// Inventario + los últimos movimientos de Auditoría), igual que el resumen
// de pages/inicio.html.
async function construirNotificaciones(config) {
  const notifs = [];

  if (tienePermiso('inventario.ver')) {
    const productos = (await listarRegistros(config.apiBaseUrl, 'inventario')) || [];
    productos.filter(p => Number(p.stock) <= Number(p.stock_minimo)).slice(0, 5).forEach(p => {
      notifs.push({ icono: '📦', bg: 'var(--orange-soft)', color: 'var(--orange)', orden: 2,
        texto: `Stock bajo: <b>${escapeHtml(p.nombre)}</b> (${fmtNum(Number(p.stock))} unidad(es))` });
    });
    productos.filter(p => p.fecha_vencimiento && diasHasta(p.fecha_vencimiento) >= 0 && diasHasta(p.fecha_vencimiento) <= 7).slice(0, 5).forEach(p => {
      notifs.push({ icono: '⏰', bg: '#FBEAF0', color: 'var(--coral)', orden: 3,
        texto: `Vence pronto: <b>${escapeHtml(p.nombre)}</b>` });
    });
  }

  if (tienePermiso('auditoria.ver')) {
    try {
      const sesion = obtenerSesion();
      const res = await fetch(`${config.apiBaseUrl}/auditoria?limite=6`, { headers: { Authorization: `Bearer ${sesion.token}` } });
      if (res.ok) {
        const acts = await res.json();
        acts.forEach(a => notifs.push({
          icono: a.accion === 'crear' ? '➕' : (a.accion === 'eliminar' ? '🗑️' : '✏️'),
          bg: 'var(--blue-soft)', color: 'var(--blue)',
          texto: `<b>${escapeHtml(a.usuario_nombre || '—')}</b> ${ETIQUETA_ACCION[a.accion] || a.accion} en ${escapeHtml(a.modulo)}`,
          hora: tiempoRelativo(a.creado_el), orden: new Date(a.creado_el).getTime()
        }));
      }
    } catch { /* sin conexión: se omite, el resto de notificaciones sigue funcionando */ }
  }

  return notifs.sort((a, b) => (b.orden || 0) - (a.orden || 0)).slice(0, 10);
}

async function renderUsuarioYNotificaciones(config) {
  const cont = document.getElementById('sesionWidget');
  if (!cont) return;
  const sesion = obtenerSesion();
  if (!sesion?.usuario) { cont.innerHTML = `<a href="login" class="topbar-login-link">Iniciar sesión</a>`; return; }

  const notifs = await construirNotificaciones(config);
  const inicial = (sesion.usuario.nombre || '?').trim().charAt(0).toUpperCase();

  cont.innerHTML = `
    <div class="topbar-user">
      <div class="topbar-notif">
        <button type="button" class="topbar-notif-btn" id="btnNotif" title="Notificaciones">
          🔔${notifs.length ? `<span class="topbar-notif-badge">${notifs.length > 9 ? '9+' : notifs.length}</span>` : ''}
        </button>
        <div class="topbar-notif-panel" id="panelNotif">
          <div class="topbar-notif-titulo">Notificaciones</div>
          ${notifs.length ? notifs.map(n => `
            <div class="topbar-notif-item">
              <div class="topbar-notif-icono" style="background:${n.bg}; color:${n.color};">${n.icono}</div>
              <div>
                <div class="topbar-notif-texto">${n.texto}</div>
                ${n.hora ? `<div class="topbar-notif-hora">${n.hora}</div>` : ''}
              </div>
            </div>`).join('') : '<div class="topbar-notif-vacio">Sin novedades por ahora.</div>'}
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
