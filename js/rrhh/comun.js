// js/rrhh/comun.js
// Piezas compartidas por las pantallas de RRHH (paso 8): cliente de /api/rrhh,
// formato de fechas y horas en Lima, y unos constructores mínimos de tabla y
// formulario. Todo texto que viene del servidor pasa por esc() antes de entrar
// a un innerHTML -- son datos que cualquier usuario con permiso pudo escribir.

import { API_BASE_URL } from '../apiConfig.js';
import { obtenerSesion, tienePermiso } from '../sesion.js';
import { escapeHtml } from '../utils.js';
import { abrirPanelLateral, cerrarPanelLateral } from '../../components/panelLateral.js';
import { ICONO_USERS } from '../iconos.js';

export const esc = escapeHtml;
export const puede = tienePermiso;
export { abrirPanelLateral, cerrarPanelLateral };

// Llama a /api/{base}{ruta}. Lanza un Error con el mensaje exacto del servidor
// (y `.status` / `.codigo`) para mostrarlo tal cual. 204 => true.
export async function api(ruta, { metodo = 'GET', cuerpo, base = 'rrhh' } = {}) {
  const token = obtenerSesion()?.token;
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/${base}${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa tu conexión e intenta de nuevo.');
  }
  if (res.status === 204) return true;
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    const error = new Error(json?.error || `Error del servidor (HTTP ${res.status}).`);
    error.status = res.status;
    error.codigo = json?.codigo;
    throw error;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Fechas, horas y montos (Perú: la hora siempre se muestra en Lima)
// ---------------------------------------------------------------------------

export const hoyLima = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const horaLima = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
export const fechaCorta = (v) => {
  if (!v) return '—';
  const [a, m, d] = String(v).slice(0, 10).split('-');
  return d && m && a ? `${d}/${m}/${a}` : esc(v);
};
export const sumarDias = (fecha, dias) => { const d = new Date(`${fecha}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10); };
export const primerDiaDelMes = () => `${hoyLima().slice(0, 8)}01`;
export const duracion = (min) => (min ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : '—');
export const soles = (n) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const ETIQUETA_AUSENCIA = { vacaciones: 'Vacaciones', descanso_medico: 'Descanso médico', licencia: 'Licencia', permiso: 'Permiso' };
export const ETIQUETA_ESTADO_AUSENCIA = { pendiente: ['Pendiente', 'purple'], aprobada: ['Aprobada', 'teal'], rechazada: ['Rechazada', 'danger'], cancelada: ['Cancelada', 'muted'] };

export function badge(texto, color = 'muted') {
  return `<span class="evento-badge evento-badge-${color}">${esc(texto)}</span>`;
}

// ---------------------------------------------------------------------------
// Tablas
// ---------------------------------------------------------------------------

// columnas: [{ titulo, celda(fila) -> HTML ya escapado, clase? }]
export function tabla(columnas, filas, { vacio = 'Todavía no hay registros.' } = {}) {
  if (!filas.length) return `<p class="tabla-vacia">${esc(vacio)}</p>`;
  return `<div class="tabla-registros-wrap"><table class="tabla-registros">
    <thead><tr>${columnas.map(c => `<th${c.clase ? ` class="${c.clase}"` : ''}>${esc(c.titulo)}</th>`).join('')}</tr></thead>
    <tbody>${filas.map(f => `<tr>${columnas.map(c => `<td${c.clase ? ` class="${c.clase}"` : ''}>${c.celda(f)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// Botones de acción de una fila: [{ accion, texto, peligro? }] con data-id.
export function botonesFila(id, acciones) {
  return `<span class="rrhh-acciones">${acciones.map(a =>
    `<button type="button" class="rrhh-btn-mini${a.peligro ? ' peligro' : ''}" data-accion="${a.accion}" data-id="${id}">${esc(a.texto)}</button>`).join('')}</span>`;
}

// Un solo listener por contenedor: llama a manejadores[accion](id, boton).
export function alHacerClic(contenedor, manejadores) {
  contenedor.addEventListener('click', (e) => {
    const boton = e.target.closest('[data-accion]');
    if (!boton || !contenedor.contains(boton)) return;
    const manejador = manejadores[boton.dataset.accion];
    if (manejador) manejador(boton.dataset.id, boton);
  });
}

// ---------------------------------------------------------------------------
// Formularios
// ---------------------------------------------------------------------------

// campo: { id, label, tipo: text|number|date|time|month|email|url|select|textarea|checkbox, valor, opciones, requerido,
//          ancho (2..4 columnas), ayuda, min, max, step, maxlength, placeholder, oculto }
export function campoHtml(c) {
  if (c.oculto) return '';
  if (c.titulo) return `<h4>${esc(c.titulo)}</h4>`;
  // Días de la semana (1 = lunes ... 7 = domingo) como casillas dia_1..dia_7.
  if (c.tipo === 'dias') {
    const marcados = new Set((c.valor || []).map(Number));
    const nombres = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
    return `<div class="campo campo-ancho-4"><label>${esc(c.label)}</label><div class="rrhh-dias">${nombres.map((n, i) =>
      `<label><input type="checkbox" name="dia_${i + 1}"${marcados.has(i + 1) ? ' checked' : ''}> ${n}</label>`).join('')}</div></div>`;
  }
  const id = `f_${c.id}`;
  const valor = c.valor ?? '';
  const ancho = c.ancho ? ` campo-ancho-${c.ancho}` : '';
  const attrs = [
    c.requerido ? 'required' : '', c.min !== undefined ? `min="${c.min}"` : '', c.max !== undefined ? `max="${c.max}"` : '',
    c.step ? `step="${c.step}"` : '', c.maxlength ? `maxlength="${c.maxlength}"` : '', c.placeholder ? `placeholder="${esc(c.placeholder)}"` : ''
  ].filter(Boolean).join(' ');
  let control;
  if (c.tipo === 'select') {
    control = `<select id="${id}" name="${c.id}" ${c.requerido ? 'required' : ''}>${(c.opciones || []).map(o =>
      `<option value="${esc(o.value)}"${String(o.value) === String(valor) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (c.tipo === 'textarea') {
    control = `<textarea id="${id}" name="${c.id}" rows="${c.filas || 3}" ${attrs}>${esc(valor)}</textarea>`;
  } else if (c.tipo === 'checkbox') {
    return `<div class="campo campo-check${ancho}"><label class="rrhh-check"><input type="checkbox" id="${id}" name="${c.id}"${valor ? ' checked' : ''}> ${esc(c.label)}</label>${c.ayuda ? `<span class="campo-ayuda">${esc(c.ayuda)}</span>` : ''}</div>`;
  } else {
    control = `<input id="${id}" name="${c.id}" type="${c.tipo || 'text'}" value="${esc(valor)}" ${attrs}>`;
  }
  return `<div class="campo${ancho}"><label for="${id}">${esc(c.label)}</label>${control}${c.ayuda ? `<span class="campo-ayuda">${esc(c.ayuda)}</span>` : ''}</div>`;
}

export function leerFormulario(form) {
  const valores = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    valores[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  return valores;
}

// Dibuja un formulario dentro de `contenedor` y conecta su envío: bloquea el
// botón, muestra el error del servidor (o "Guardando…") y, si sale bien, llama
// a alGuardar(valores) -- que puede lanzar un Error con el mensaje a mostrar.
export function montarFormulario(contenedor, { campos, textoGuardar = 'Guardar', alGuardar, alCancelar, extra = '' }) {
  contenedor.innerHTML = `<form class="form-registro rrhh-form" novalidate>
    ${campos.map(campoHtml).join('')}
    ${extra}
    <div class="campo campo-accion">
      <button type="submit" class="btn btn-ochre">${esc(textoGuardar)}</button>
      ${alCancelar ? '<button type="button" class="btn btn-ghost" data-cancelar>Cancelar</button>' : ''}
      <span class="form-status" role="status" data-estado></span>
    </div>
  </form>`;
  const form = contenedor.querySelector('form');
  const estado = form.querySelector('[data-estado]');
  const boton = form.querySelector('button[type="submit"]');
  form.querySelector('[data-cancelar]')?.addEventListener('click', alCancelar);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    boton.disabled = true;
    estado.textContent = 'Guardando…';
    try {
      await alGuardar(leerFormulario(form));
    } catch (err) {
      estado.textContent = err.message;
      estado.classList.add('error');
      boton.disabled = false;
      return;
    }
    boton.disabled = false;
  });
  return form;
}

export function modal({ titulo, icono = ICONO_USERS, ancho = 'amplio', montar }) {
  abrirPanelLateral({ titulo, icono, ancho, montar });
}

// Avisos fugaces dentro de una sección (guardado, error de carga...).
export function avisar(contenedor, texto, tipo = 'ok') {
  let zona = contenedor.querySelector(':scope > .rrhh-aviso-zona');
  if (!zona) {
    zona = document.createElement('div');
    zona.className = 'rrhh-aviso-zona';
    zona.setAttribute('role', 'status');
    contenedor.prepend(zona);
  }
  zona.innerHTML = texto ? `<div class="rrhh-aviso ${tipo}">${esc(texto)}</div>` : '';
  // Un solo temporizador por zona: si llega un aviso nuevo, el del anterior no debe borrarlo.
  clearTimeout(zona._temporizador);
  if (texto && tipo === 'ok') zona._temporizador = setTimeout(() => { if (zona.isConnected) zona.innerHTML = ''; }, 5000);
}

// Quita el aviso solo si es un ERROR: al recargar una lista con éxito no debe
// borrarse el "Guardado." que acaba de mostrarse en el mismo contenedor.
export function limpiarError(contenedor) {
  const zona = contenedor?.querySelector(':scope > .rrhh-aviso-zona');
  if (zona?.querySelector('.rrhh-aviso.error')) zona.innerHTML = '';
}

// Lista de trabajadores para los <select> (activa y cesados; el servidor filtra por empresa).
let cacheEmpleados = null;
export async function listarEmpleados({ recargar = false } = {}) {
  if (!cacheEmpleados || recargar) cacheEmpleados = await api('/');
  return cacheEmpleados;
}
export function invalidarEmpleados() { cacheEmpleados = null; }
export const opcionesEmpleados = (empleados, { vacio = null } = {}) => [
  ...(vacio ? [{ value: '', label: vacio }] : []),
  ...empleados.map(e => ({ value: e.id, label: e.estado_efectivo === 'cesado' ? `${e.nombre} (cesado)` : e.nombre }))
];

export function descargarCSV(nombre, filas) {
  const celda = (v) => {
    const s = String(v ?? '');
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const texto = '﻿' + filas.map(f => f.map(celda).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([texto], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
