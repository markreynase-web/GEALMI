// components/panelLateral.js
// Ventana modal reutilizable (centrada, con fondo oscuro) para formularios de
// "Nuevo registro", edición, detalle, etc. Antes era un cajón que se deslizaba
// desde la derecha; se conserva el nombre "panelLateral" (y los ids/clases del
// DOM) para no tocar las ~12 pantallas que ya lo usan -- solo cambió cómo se ve
// y cómo se comporta el foco.
//
// Uso:
//   import { abrirPanelLateral, cerrarPanelLateral } from './panelLateral.js';
//
//   abrirPanelLateral({
//     titulo: 'Nueva venta',
//     ancho: 'amplio',            // opcional: 'normal' (560px, default) | 'amplio' (780px)
//     montar: (body) => {
//       body.innerHTML = '<div id="formularioCaptura"></div>';
//       renderFormulario('formularioCaptura', esquema, onGuardar, { puedeCrear });
//     }
//   });
//
// `montar(body)` recibe el contenedor vacío del modal: ahí se decide qué se
// dibuja adentro (formulario genérico, edición, historial...) sin duplicar el
// armazón. Se cierra con Esc, clic afuera, la ✕ o cerrarPanelLateral().
//
// Accesibilidad: role="dialog" + aria-modal; al abrir el foco pasa al primer
// campo (solo con mouse -- en pantallas táctiles evita abrir el teclado sin que
// nadie lo pida), Tab no se escapa del modal, y al cerrar el foco vuelve al
// elemento que lo abrió.

let elPanel = null;
let elOverlay = null;
let alCerrar = null;
let elFocoPrevio = null;
// Sube en cada apertura y cada cierre: una activación pendiente (rAF o el
// setTimeout de respaldo) de una apertura anterior no debe reabrir un modal
// que ya se cerró, ni pisar a uno más nuevo.
let generacion = 0;

const FOCUSABLES = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusablesVisibles() {
  return [...elPanel.querySelectorAll(FOCUSABLES)].filter(el => el.offsetParent !== null);
}

function asegurarDom() {
  if (elPanel) return;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="panel-lateral-overlay" id="panelLateralOverlay"></div>
    <div class="panel-lateral" id="panelLateral" role="dialog" aria-modal="true" aria-labelledby="panelLateralTitulo" tabindex="-1">
      <div class="panel-lateral-header">
        <div class="panel-lateral-titulo-wrap">
          <span class="panel-lateral-icono" id="panelLateralIcono" aria-hidden="true"></span>
          <h3 id="panelLateralTitulo"></h3>
        </div>
        <button type="button" class="panel-lateral-cerrar" id="panelLateralCerrar" aria-label="Cerrar">✕</button>
      </div>
      <div class="panel-lateral-body" id="panelLateralBody"></div>
    </div>
  `;
  document.body.appendChild(wrap);

  elOverlay = document.getElementById('panelLateralOverlay');
  elPanel = document.getElementById('panelLateral');

  elOverlay.addEventListener('click', cerrarPanelLateral);
  document.getElementById('panelLateralCerrar').addEventListener('click', cerrarPanelLateral);
  document.addEventListener('keydown', (e) => {
    if (!elPanel.classList.contains('activo')) return;
    if (e.key === 'Escape') { cerrarPanelLateral(); return; }
    if (e.key !== 'Tab') return;

    // Tab no se escapa hacia la página de atrás: da la vuelta dentro del modal.
    const lista = focusablesVisibles();
    if (!lista.length) { e.preventDefault(); elPanel.focus(); return; }
    const primero = lista[0], ultimo = lista[lista.length - 1];
    // Si quien lo abrió cambió el contenido por dentro (ej. "+ Nuevo cliente"
    // dentro de una venta), el foco pudo quedar en un elemento que ya no existe
    // y volver al <body>: Tab lo devuelve al modal en vez de escaparse a la página.
    if (!elPanel.contains(document.activeElement)) { e.preventDefault(); primero.focus(); return; }
    const enElPanel = document.activeElement === elPanel;
    if (e.shiftKey && (enElPanel || document.activeElement === primero)) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
  });
}

export function abrirPanelLateral({ titulo = '', icono = '📝', ancho = 'normal', montar, onCerrar } = {}) {
  asegurarDom();
  document.getElementById('panelLateralTitulo').textContent = titulo;
  document.getElementById('panelLateralIcono').textContent = icono;
  elPanel.classList.toggle('panel-lateral--amplio', ancho === 'amplio');

  // Si ya había un modal abierto (un panel que abre otro encima), se conserva
  // el elemento que tenía el foco ORIGINALMENTE, no el botón del primer modal.
  if (!elPanel.classList.contains('activo')) elFocoPrevio = document.activeElement;

  const body = document.getElementById('panelLateralBody');
  body.innerHTML = '';
  body.scrollTop = 0;
  alCerrar = onCerrar || null;

  if (typeof montar === 'function') montar(body);

  // requestAnimationFrame para que la transición CSS anime la entrada (si se
  // agrega .activo en el mismo tick que se inserta el DOM, el navegador no
  // siempre alcanza a animar el paso de "cerrado" a "abierto"). El setTimeout
  // es la red de seguridad: con la pestaña en segundo plano rAF se pausa y el
  // modal se quedaría cerrado. La segunda llamada no hace nada (idempotente).
  const miGeneracion = ++generacion;
  let activado = false;
  const activar = () => {
    if (activado || miGeneracion !== generacion) return;
    activado = true;
    elOverlay.classList.add('activo');
    elPanel.classList.add('activo');
    const primero = body.querySelector(FOCUSABLES);
    if (primero && window.matchMedia('(pointer: fine)').matches) primero.focus();
    else elPanel.focus();
  };
  requestAnimationFrame(activar);
  setTimeout(activar, 60);
  document.body.classList.add('panel-lateral-abierto');
}

export function cerrarPanelLateral() {
  if (!elPanel) return;
  generacion++;
  elOverlay.classList.remove('activo');
  elPanel.classList.remove('activo');
  document.body.classList.remove('panel-lateral-abierto');
  if (alCerrar) { alCerrar(); alCerrar = null; }
  if (elFocoPrevio && document.contains(elFocoPrevio) && typeof elFocoPrevio.focus === 'function') elFocoPrevio.focus();
  elFocoPrevio = null;
}

export function panelLateralEstaAbierto() {
  return !!(elPanel && elPanel.classList.contains('activo'));
}
