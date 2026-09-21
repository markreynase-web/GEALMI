// js/sesion.js
// Maneja el token JWT en el navegador. Se guarda en localStorage (no hay
// namespace por módulo aquí a propósito: la sesión es global, la misma
// persona navega entre Ventas/Inventario/Clientes sin volver a loguearse).
//
// "Mantener sesión iniciada" (pages/login): marcada = localStorage, como
// siempre; desmarcada = sessionStorage, que se pierde al cerrar la pestaña
// (útil en un computador compartido). La sesión vive en UNO de los dos, nunca
// en ambos. Quien llama a guardarSesion() sin decir nada (p. ej. la
// impersonación del super admin) conserva el almacén de la sesión que ya hay.

const CLAVE = 'pd_sesion';

function almacenActual() {
  try {
    if (sessionStorage.getItem(CLAVE) !== null) return sessionStorage;
  } catch { /* sessionStorage no disponible: se usa localStorage */ }
  return localStorage;
}

function escribirSesion(cruda, recordar) {
  const destino = recordar === undefined ? almacenActual() : (recordar ? localStorage : sessionStorage);
  const otro = destino === localStorage ? sessionStorage : localStorage;
  destino.setItem(CLAVE, cruda);
  try { otro.removeItem(CLAVE); } catch { /* nada que limpiar */ }
}

export function guardarSesion({ token, usuario }, { recordar } = {}) {
  escribirSesion(JSON.stringify({ token, usuario }), recordar);
}

export function obtenerSesion() {
  try {
    const cruda = sessionStorage.getItem(CLAVE) ?? localStorage.getItem(CLAVE);
    return cruda ? JSON.parse(cruda) : null;
  } catch {
    return null;
  }
}

export function cerrarSesion() {
  localStorage.removeItem(CLAVE);
  try { sessionStorage.removeItem(CLAVE); } catch { /* nada que limpiar */ }
}

// Decodifica el payload de un JWT (base64url, sin validar la firma -- eso
// ya lo hace el backend en cada request; acá solo interesa leer "exp" para
// evitar mandar de entrada un token que sabemos vencido) y compara contra
// la hora actual. Un token sin campo "exp" no se asume vencido (no hay con
// qué compararlo); uno malformado sí, para el lado seguro.
export function tokenExpirado(token) {
  if (!token || typeof token !== 'string') return true;
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return true;
    const normalizado = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const relleno = normalizado.length % 4 === 0 ? '' : '='.repeat(4 - (normalizado.length % 4));
    const payload = JSON.parse(atob(normalizado + relleno));
    if (typeof payload.exp !== 'number') return false;
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

// Sub-bloque B1 (Fase 3, Eje B): antes esto solo confirmaba que HUBIERA un
// token guardado, nunca si seguía vigente -- un token vencido en
// localStorage "parecía" una sesión activa hasta que la primera llamada
// real al backend fallaba. Ahora, si el token venció, se limpia la sesión
// acá mismo (efecto secundario a propósito: cualquier código que llame a
// esta función para decidir si redirige a login queda, de paso, con
// localStorage ya limpio, sin tener que acordarse de llamar cerrarSesion()
// aparte).
export function haySesionActiva() {
  const s = obtenerSesion();
  if (!s || !s.token) return false;
  if (tokenExpirado(s.token)) {
    cerrarSesion();
    return false;
  }
  return true;
}

// Fase 4.5 (Frontend): no basta con bloquear en el backend, también hay que
// ocultar el botón. Los permisos ya vienen calculados dentro del token desde
// el login (ver backend/src/routes/auth.js), así que esto es una consulta
// local, sin red.
export function tienePermiso(permiso) {
  const s = obtenerSesion();
  const permisos = s?.usuario?.permisos || [];
  return permisos.includes(permiso);
}

export function tieneAlgunPermiso(prefijoModulo) {
  const s = obtenerSesion();
  const permisos = s?.usuario?.permisos || [];
  return permisos.some(p => p.startsWith(`${prefijoModulo}.`));
}

// Panel de super administrador: sesión exclusiva, sin empresa_id ni
// permisos (ver backend/src/routes/auth.js) -- por eso es una consulta
// aparte, no una revisión más de `permisos`.
export function esSuperAdmin() {
  const s = obtenerSesion();
  return !!s?.usuario?.es_super_admin;
}

// Impersonación (ver POST /superadmin/empresas/:id/impersonar): una sesión
// impersonada es, para el resto del frontend, una sesión normal de empresa
// (mismo empresa_id/permisos que cualquier admin) -- lo único que la
// distingue es este flag, usado solo para el banner de aviso (ver
// components/topbar.js) y para decidir qué hace "Salir" en ese banner.
export function estaImpersonando() {
  const s = obtenerSesion();
  return !!s?.usuario?.impersonando;
}

// Al impersonar, la sesión de super admin (que no lleva empresa_id/permisos,
// ver arriba) se reemplaza por la sesión impersonada en la misma clave de
// localStorage -- no pueden convivir las dos. Se guarda una copia aparte
// antes de reemplazarla, así "Salir" (ver components/topbar.js) puede volver
// directo a Super Admin sin pedir contraseña de nuevo.
const CLAVE_BACKUP_SUPER_ADMIN = 'pd_sesion_super_admin_backup';

export function respaldarSesionSuperAdmin() {
  const actual = obtenerSesion();
  if (actual) sessionStorage.setItem(CLAVE_BACKUP_SUPER_ADMIN, JSON.stringify(actual));
}

// PWA instalable (Nivel 3 del roadmap): se registra acá, no en cada página
// por separado, porque este archivo ya lo importa literalmente cada .html
// del sitio (la landing y las ~35 páginas de la app) -- un solo lugar para
// que el service worker (sw.js, ver ese archivo para la estrategia de
// caché) quede activo en todas. Ruta absoluta ('/sw.js') a propósito: así
// funciona igual desde index.html (raíz) que desde pages/*.html (un nivel
// abajo), sin tener que ajustar la ruta relativa según la profundidad.
// serviceWorker requiere contexto seguro (https) -- 'in navigator' ya lo
// filtra solo en navegadores/contextos que no lo soportan (ej. si algún
// día se abre por http a propósito en un entorno de pruebas).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('No se pudo registrar el service worker:', err.message);
    });
  });
}

export function restaurarSesionSuperAdmin() {
  const cruda = sessionStorage.getItem(CLAVE_BACKUP_SUPER_ADMIN);
  sessionStorage.removeItem(CLAVE_BACKUP_SUPER_ADMIN);
  if (!cruda) return false;
  try {
    escribirSesion(cruda);
    return true;
  } catch {
    return false;
  }
}

// Fase A (multi-tenant): cuando un usuario pertenece a más de una empresa,
// el login no entrega sesión de una vez -- entrega un preAuthToken de 5
// minutos + la lista de empresas para que el usuario elija. Eso NO es una
// sesión válida todavía, así que se guarda aparte, en sessionStorage (se
// pierde solo con esa pestaña, no debe sobrevivir como localStorage).
const CLAVE_PREAUTH = 'pd_preauth';

export function guardarPreAuth({ preAuthToken, empresas }) {
  sessionStorage.setItem(CLAVE_PREAUTH, JSON.stringify({ preAuthToken, empresas }));
}

export function obtenerPreAuth() {
  try {
    const cruda = sessionStorage.getItem(CLAVE_PREAUTH);
    return cruda ? JSON.parse(cruda) : null;
  } catch {
    return null;
  }
}

export function borrarPreAuth() {
  sessionStorage.removeItem(CLAVE_PREAUTH);
}
