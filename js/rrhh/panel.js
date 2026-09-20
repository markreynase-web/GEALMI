// js/rrhh/panel.js
// Pestañas de RRHH (paso 8). "Equipo" es la pantalla de siempre (la pinta
// js/app.js: KPIs, lista, tabla de registros); las demás -- Asistencia,
// Ausencias, Remuneraciones, Documentos, Desempeño y Reclutamiento -- son
// secciones que se cargan a demanda y reemplazan el contenido mientras están
// abiertas (la clase rrhh-seccion-activa del <body> oculta lo de Equipo).
// Cada pestaña aparece solo si el usuario tiene el permiso para ella.

import { puede } from './comun.js';
import { abrirFicha } from './ficha.js';
import { montarAlertas } from './alertas.js';

const SECCIONES = [
  { id: 'equipo', etiqueta: 'Equipo', permiso: null },
  { id: 'asistencia', etiqueta: 'Asistencia', permiso: 'rrhh.ver', cargar: () => import('./asistencia.js') },
  { id: 'ausencias', etiqueta: 'Ausencias', permiso: 'rrhh.ver', cargar: () => import('./ausencias.js') },
  { id: 'remuneraciones', etiqueta: 'Remuneraciones', permiso: 'rrhh.remuneraciones', cargar: () => import('./remuneraciones.js') },
  { id: 'documentos', etiqueta: 'Documentos', permiso: 'rrhh.ver', cargar: () => import('./documentos.js') },
  { id: 'desempeno', etiqueta: 'Desempeño', permiso: 'rrhh.ver', cargar: () => import('./desempeno.js') },
  { id: 'reclutamiento', etiqueta: 'Reclutamiento', permiso: 'rrhh.ver', cargar: () => import('./reclutamiento.js') }
];

let activa = 'equipo';
let contador = 0; // descarta respuestas de una pestaña que ya se dejó atrás

function visibles() {
  return SECCIONES.filter(s => !s.permiso || puede(s.permiso));
}

async function abrir(id, { actualizarUrl = true } = {}) {
  const seccion = visibles().find(s => s.id === id) || SECCIONES[0];
  activa = seccion.id;
  const mio = ++contador;
  document.querySelectorAll('.rrhh-tab').forEach(b => {
    const esActiva = b.dataset.seccion === activa;
    b.classList.toggle('activo', esActiva);
    b.setAttribute('aria-selected', esActiva ? 'true' : 'false');
  });
  const zona = document.getElementById('rrhhSeccion');
  const esEquipo = activa === 'equipo';
  document.body.classList.toggle('rrhh-seccion-activa', !esEquipo);
  zona.hidden = esEquipo;
  if (actualizarUrl) history.replaceState(null, '', esEquipo ? location.pathname + location.search : `#${activa}`);
  if (esEquipo) { zona.innerHTML = ''; return; }

  zona.innerHTML = '<p class="rrhh-vacio">Cargando…</p>';
  try {
    const modulo = await seccion.cargar();
    if (mio !== contador) return;
    // Un contenedor NUEVO por visita: las secciones enganchan sus oyentes de clic
    // ahí, y así se van con él al cambiar de pestaña (en vez de acumularse en
    // #rrhhSeccion, que dura toda la página).
    const contenedor = document.createElement('div');
    zona.replaceChildren(contenedor);
    await modulo.montar(contenedor);
  } catch (err) {
    if (mio !== contador) return;
    console.error(err);
    zona.innerHTML = `<p class="rrhh-vacio">No se pudo cargar esta sección. ${String(err.message || '')}</p>`;
  }
}

function iniciar() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;
  const lista = visibles();

  // La franja de pestañas se desplaza sola en pantallas angostas; el botón de
  // "Nuevo trabajador" queda fuera de esa franja para que nunca se esconda.
  const barra = document.createElement('div');
  barra.className = 'rrhh-barra-pestanas';
  const nav = document.createElement('nav');
  nav.className = 'rrhh-tabs';
  nav.setAttribute('aria-label', 'Secciones de RRHH');
  nav.setAttribute('role', 'tablist');
  nav.innerHTML = lista.map(s =>
    `<button type="button" class="rrhh-tab${s.id === activa ? ' activo' : ''}" role="tab" aria-selected="${s.id === activa}" data-seccion="${s.id}">${s.etiqueta}</button>`
  ).join('');
  barra.appendChild(nav);
  if (puede('rrhh.crear')) barra.insertAdjacentHTML('beforeend', '<button type="button" class="btn btn-ochre rrhh-nueva-ficha" id="rrhhNuevaFicha">+ Nuevo<span class="rrhh-ocultable"> trabajador</span></button>');
  topbar.insertAdjacentElement('afterend', barra);

  const zona = document.createElement('section');
  zona.className = 'rrhh-seccion';
  zona.id = 'rrhhSeccion';
  zona.hidden = true;
  barra.insertAdjacentElement('afterend', zona);

  nav.addEventListener('click', (e) => {
    const boton = e.target.closest('.rrhh-tab');
    if (boton) abrir(boton.dataset.seccion);
  });
  document.getElementById('rrhhNuevaFicha')?.addEventListener('click', () => abrirFicha(null));

  // Un clic en un trabajador de la lista de "Equipo" abre su ficha completa.
  document.getElementById('rrhhLista')?.addEventListener('click', (e) => {
    const fila = e.target.closest('[data-empleado-id]');
    if (fila) abrirFicha(fila.dataset.empleadoId);
  });
  document.getElementById('rrhhLista')?.addEventListener('keydown', (e) => {
    const fila = e.target.closest('[data-empleado-id]');
    if (fila && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); abrirFicha(fila.dataset.empleadoId); }
  });

  // Otras partes de la pantalla (las alertas de "Equipo") piden cambiar de pestaña.
  document.addEventListener('rrhh:ir', (e) => abrir(e.detail));
  window.addEventListener('hashchange', () => abrir(location.hash.slice(1), { actualizarUrl: false }));

  if (puede('rrhh.ver')) montarAlertas(document.getElementById('rrhhAlertas'));
  const inicial = location.hash.slice(1);
  if (inicial && lista.some(s => s.id === inicial)) abrir(inicial, { actualizarUrl: false });
}

iniciar();
