// js/rrhh/desempeno.js
// Pestaña "Desempeño" (fase R6): evaluaciones con cinco criterios fijos (1 a 5)
// y capacitaciones con sus participantes y asistencia.

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, opcionesEmpleados, fechaCorta, hoyLima,
  soles, badge, tabla, botonesFila, alHacerClic, avisar, limpiarError
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';
import { ICONO_EDIT, ICONO_STAR, ICONO_GRADUATION, ICONO_CLOCK, ICONO_DOLLAR } from '../iconos.js';

const CRITERIOS = [
  ['puntualidad', 'Puntualidad'], ['calidad_trabajo', 'Calidad del trabajo'], ['trabajo_equipo', 'Trabajo en equipo'],
  ['iniciativa', 'Iniciativa'], ['comunicacion', 'Comunicación']
];
const ESCALA = [
  { value: '', label: 'Elige…' }, { value: 1, label: '1 · Deficiente' }, { value: 2, label: '2 · Por mejorar' },
  { value: 3, label: '3 · Cumple' }, { value: 4, label: '4 · Bueno' }, { value: 5, label: '5 · Excelente' }
];
const barra = (promedio) => `<span class="rrhh-barra" aria-hidden="true"><i style="width:${Math.round((promedio / 5) * 100)}%"></i></span>${promedio.toFixed(1)}`;

export async function montar(zona) {
  const empleados = await listarEmpleados({ recargar: true });
  let vista = 'evaluaciones';

  zona.innerHTML = `
    <div class="rrhh-subtabs" role="tablist">
      <button type="button" class="rrhh-pildora activo" data-vista="evaluaciones" role="tab">Evaluaciones</button>
      <button type="button" class="rrhh-pildora" data-vista="capacitaciones" role="tab">Capacitaciones</button>
    </div>
    <div id="deCuerpo"></div>`;
  const cuerpo = zona.querySelector('#deCuerpo');
  zona.querySelector('.rrhh-subtabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-vista]');
    if (!b) return;
    vista = b.dataset.vista;
    zona.querySelectorAll('.rrhh-pildora').forEach(x => x.classList.toggle('activo', x === b));
    dibujarVista();
  });

  // Contenedor nuevo por vista: cada una engancha sus propios oyentes de clic.
  function dibujarVista() {
    const contenedor = document.createElement('div');
    cuerpo.replaceChildren(contenedor);
    return (vista === 'evaluaciones' ? montarEvaluaciones : montarCapacitaciones)(contenedor, empleados);
  }
  await dibujarVista();
}

// ---------------------------------------------------------------------------
// Evaluaciones
// ---------------------------------------------------------------------------

async function montarEvaluaciones(zona, empleados) {
  let filas = [];
  let empleadoId = '';
  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div><h2>Evaluaciones de desempeño</h2><p>Cinco criterios de 1 a 5; el promedio lo calcula el sistema. Son datos confidenciales: solo los ve quien tiene acceso a RRHH.</p></div>
      <div class="rrhh-filtros">
        <label>Trabajador<select id="evEmpleado"><option value="">Todos</option>${opcionesEmpleados(empleados).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></label>
        ${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="evNueva">+ Nueva evaluación</button>' : ''}
      </div>
    </div>
    <div id="evAviso"></div><div class="kpis rrhh-kpis" id="evKpis"></div><div class="rrhh-panel" id="evTabla"></div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    try { filas = await api(`/evaluaciones${empleadoId ? `?empleado_id=${empleadoId}` : ''}`); }
    catch (err) { avisar($('#evAviso'), err.message, 'error'); return; }
    limpiarError($('#evAviso'));
    const prom = filas.length ? filas.reduce((s, f) => s + f.promedio, 0) / filas.length : 0;
    $('#evKpis').innerHTML = [
      kpiCard({ acento: 'blue', icono: ICONO_EDIT, label: 'Evaluaciones', value: fmtNum(filas.length), sub: 'en la vista actual' }),
      kpiCard({ acento: 'teal', icono: ICONO_STAR, label: 'Promedio general', value: filas.length ? prom.toFixed(2) : '—', sub: 'de 5 puntos' })
    ].join('');
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#evTabla').innerHTML = tabla([
      { titulo: 'Trabajador', celda: f => esc(f.empleado_nombre) },
      { titulo: 'Período', celda: f => `${esc(f.periodo)}<span class="rrhh-sub">${fechaCorta(f.fecha)}</span>` },
      ...CRITERIOS.map(([k, t]) => ({ titulo: t, clase: 'num', celda: f => f[k] })),
      { titulo: 'Promedio', celda: f => barra(f.promedio) },
      { titulo: 'Evaluó', celda: f => esc(f.evaluador_nombre || '—') },
      { titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar ? [{ accion: 'editar', texto: 'Editar' }] : []), ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }
    ], filas, { vacio: 'Todavía no hay evaluaciones.' });
  }

  function abrirFormulario(fila = null) {
    modal({
      titulo: fila ? 'Editar evaluación' : 'Nueva evaluación', icono: ICONO_STAR, ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="evForm"></div>';
        montarFormulario(cuerpo.querySelector('#evForm'), {
          campos: [
            { id: 'empleado_id', label: 'Trabajador', tipo: 'select', requerido: true, valor: fila?.empleado_id ?? empleadoId, ancho: 2,
              opciones: fila ? opcionesEmpleados(empleados) : opcionesEmpleados(empleados, { vacio: 'Elige un trabajador…' }) },
            { id: 'periodo', label: 'Período', requerido: true, valor: fila?.periodo ?? '', maxlength: 40, placeholder: '2026-S1, Anual 2026…' },
            { id: 'fecha', label: 'Fecha', tipo: 'date', valor: fila?.fecha ?? hoyLima() },
            ...CRITERIOS.map(([k, t]) => ({ id: k, label: t, tipo: 'select', opciones: ESCALA, valor: fila?.[k] ?? '', requerido: true })),
            { id: 'fortalezas', label: 'Fortalezas', tipo: 'textarea', valor: fila?.fortalezas ?? '', ancho: 4, filas: 2 },
            { id: 'oportunidades', label: 'Oportunidades de mejora', tipo: 'textarea', valor: fila?.oportunidades ?? '', ancho: 4, filas: 2 }
          ],
          textoGuardar: fila ? 'Guardar cambios' : 'Registrar evaluación', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            if (fila) await api(`/evaluaciones/${fila.id}`, { metodo: 'PUT', cuerpo: v });
            else await api('/evaluaciones', { metodo: 'POST', cuerpo: { ...v, empleado_id: Number(v.empleado_id) } });
            cerrarPanelLateral();
            avisar(zona, 'Evaluación guardada.');
            await cargar();
          }
        });
        if (fila) cuerpo.querySelector('[name="empleado_id"]').disabled = true;
      }
    });
  }

  $('#evEmpleado').addEventListener('change', (e) => { empleadoId = e.target.value; cargar(); });
  $('#evNueva')?.addEventListener('click', () => abrirFormulario(null));
  const buscar = (id) => filas.find(f => f.id === Number(id));
  alHacerClic(zona, {
    editar: (id) => abrirFormulario(buscar(id)),
    borrar: async (id) => {
      const f = buscar(id);
      if (!confirm(`¿Eliminar la evaluación "${f.periodo}" de ${f.empleado_nombre}?`)) return;
      try { await api(`/evaluaciones/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Evaluación eliminada.'); await cargar(); }
      catch (err) { avisar($('#evAviso'), err.message, 'error'); }
    }
  });
  await cargar();
}

// ---------------------------------------------------------------------------
// Capacitaciones
// ---------------------------------------------------------------------------

async function montarCapacitaciones(zona, empleados) {
  let filas = [];
  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div><h2>Capacitaciones</h2><p>Cursos y talleres con sus participantes y asistencia. Las obligatorias (por ejemplo, seguridad y salud en el trabajo) se marcan aparte.</p></div>
      <div class="rrhh-filtros">${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="caNueva">+ Nueva capacitación</button>' : ''}</div>
    </div>
    <div id="caAviso"></div><div class="kpis rrhh-kpis" id="caKpis"></div><div class="rrhh-panel" id="caTabla"></div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    try { filas = await api('/capacitaciones'); }
    catch (err) { avisar($('#caAviso'), err.message, 'error'); return; }
    limpiarError($('#caAviso'));
    const horas = filas.reduce((s, f) => s + f.horas, 0);
    const costo = filas.reduce((s, f) => s + Number(f.costo), 0);
    $('#caKpis').innerHTML = [
      kpiCard({ acento: 'blue', icono: ICONO_GRADUATION, label: 'Capacitaciones', value: fmtNum(filas.length), sub: `${fmtNum(filas.filter(f => f.obligatoria).length)} obligatoria(s)` }),
      kpiCard({ acento: 'teal', icono: ICONO_CLOCK, label: 'Horas', value: horas.toFixed(1), sub: 'de formación registradas' }),
      kpiCard({ acento: 'purple', icono: ICONO_DOLLAR, label: 'Inversión', value: soles(costo), sub: 'costo de las capacitaciones' })
    ].join('');
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#caTabla').innerHTML = tabla([
      { titulo: 'Capacitación', celda: f => `${esc(f.nombre)}${f.proveedor ? `<span class="rrhh-sub">${esc(f.proveedor)}</span>` : ''}` },
      { titulo: 'Fecha', celda: f => fechaCorta(f.fecha) },
      { titulo: 'Horas', clase: 'num', celda: f => f.horas },
      { titulo: 'Costo', clase: 'num', celda: f => soles(f.costo) },
      { titulo: '', celda: f => (f.obligatoria ? badge('Obligatoria', 'danger') : '') },
      { titulo: 'Asistieron', clase: 'num', celda: f => `${f.asistentes} de ${f.participantes}` },
      { titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar ? [{ accion: 'editar', texto: 'Editar' }] : []), ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }
    ], filas, { vacio: 'Todavía no hay capacitaciones.' });
  }

  async function abrirFormulario(fila = null) {
    let detalle = null;
    if (fila) {
      try { detalle = await api(`/capacitaciones/${fila.id}`); } catch (err) { avisar($('#caAviso'), err.message, 'error'); return; }
    }
    const participantes = new Map((detalle?.participantes || []).map(p => [p.empleado_id, p]));
    // Los cesados que ya participaron siguen apareciendo, para no perder su registro al guardar.
    const lista = empleados.filter(e => e.estado_efectivo !== 'cesado' || participantes.has(e.id));
    const extra = `<div class="campo campo-ancho-4"><label>Participantes</label>
      <div class="rrhh-panel" style="margin:0;padding:8px 12px;max-height:230px;overflow:auto;">
        ${lista.length ? `<table class="tabla-registros"><thead><tr><th>Trabajador</th><th>Participa</th><th>Asistió</th></tr></thead><tbody>
          ${lista.map(e => `<tr><td>${esc(e.nombre)}</td>
            <td><input type="checkbox" name="p_${e.id}"${participantes.has(e.id) ? ' checked' : ''} aria-label="Participa: ${esc(e.nombre)}"></td>
            <td><input type="checkbox" name="a_${e.id}"${participantes.get(e.id)?.asistio ? ' checked' : ''} aria-label="Asistió: ${esc(e.nombre)}"></td></tr>`).join('')}
        </tbody></table>` : '<p class="tabla-vacia">No hay trabajadores registrados.</p>'}
      </div></div>`;
    modal({
      titulo: fila ? 'Editar capacitación' : 'Nueva capacitación', icono: ICONO_GRADUATION, ancho: 'amplio',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="caForm"></div>';
        montarFormulario(cuerpo.querySelector('#caForm'), {
          campos: [
            { id: 'nombre', label: 'Nombre', requerido: true, valor: fila?.nombre ?? '', ancho: 2, maxlength: 150 },
            { id: 'proveedor', label: 'Proveedor / instructor', valor: fila?.proveedor ?? '', ancho: 2, maxlength: 150 },
            { id: 'fecha', label: 'Fecha', tipo: 'date', valor: fila?.fecha ?? hoyLima() },
            { id: 'horas', label: 'Horas', tipo: 'number', min: 0, step: '0.5', valor: fila?.horas ?? 0 },
            { id: 'costo', label: 'Costo (S/)', tipo: 'number', min: 0, step: '0.01', valor: fila?.costo ?? 0 },
            { id: 'obligatoria', label: 'Obligatoria', tipo: 'checkbox', valor: fila?.obligatoria ?? false },
            { id: 'notas', label: 'Notas', valor: fila?.notas ?? '', ancho: 4, maxlength: 250 }
          ],
          extra, textoGuardar: fila ? 'Guardar cambios' : 'Registrar capacitación', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            const cuerpoApi = { nombre: v.nombre, proveedor: v.proveedor, fecha: v.fecha, horas: v.horas, costo: v.costo, obligatoria: v.obligatoria, notas: v.notas,
              participantes: lista.filter(e => v[`p_${e.id}`]).map(e => ({ empleado_id: e.id, asistio: !!v[`a_${e.id}`], certificado_url: participantes.get(e.id)?.certificado_url ?? null })) };
            if (fila) await api(`/capacitaciones/${fila.id}`, { metodo: 'PUT', cuerpo: cuerpoApi });
            else await api('/capacitaciones', { metodo: 'POST', cuerpo: cuerpoApi });
            cerrarPanelLateral();
            avisar(zona, 'Capacitación guardada.');
            await cargar();
          }
        });
      }
    });
  }

  $('#caNueva')?.addEventListener('click', () => abrirFormulario(null));
  const buscar = (id) => filas.find(f => f.id === Number(id));
  alHacerClic(zona, {
    editar: (id) => abrirFormulario(buscar(id)),
    borrar: async (id) => {
      const f = buscar(id);
      if (!confirm(`¿Eliminar la capacitación "${f.nombre}"? También se borra su lista de participantes.`)) return;
      try { await api(`/capacitaciones/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Capacitación eliminada.'); await cargar(); }
      catch (err) { avisar($('#caAviso'), err.message, 'error'); }
    }
  });
  await cargar();
}
