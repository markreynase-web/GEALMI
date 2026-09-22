// js/rrhh/documentos.js
// Pestaña "Documentos" (fase R5): el legajo de cada trabajador como ENLACES
// (Drive, OneDrive...) con fecha de vencimiento. GEALMI no guarda los archivos;
// avisa por la campana cuando algo está por vencer. El examen médico es dato de
// salud: el servidor solo lo entrega a quien tiene rrhh.salud.

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, opcionesEmpleados, fechaCorta,
  badge, tabla, botonesFila, alHacerClic, avisar, limpiarError
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';
import { ICONO_FOLDER, ICONO_ALERT_TRIANGLE } from '../iconos.js';

const TIPOS = [
  { value: 'contrato', label: 'Contrato' }, { value: 'dni', label: 'DNI / identidad' }, { value: 'cv', label: 'CV' },
  { value: 'certificado', label: 'Certificado' }, { value: 'examen_medico', label: 'Examen médico' },
  { value: 'antecedentes', label: 'Antecedentes' }, { value: 'declaracion_jurada', label: 'Declaración jurada' }, { value: 'otro', label: 'Otro' }
];
const ETIQUETA = Object.fromEntries(TIPOS.map(t => [t.value, t.label]));

export async function montar(zona) {
  const empleados = await listarEmpleados({ recargar: true });
  const filtros = { empleado_id: '', tipo: '', pronto: false };
  let filas = [];
  const tiposDisponibles = puede('rrhh.salud') ? TIPOS : TIPOS.filter(t => t.value !== 'examen_medico');

  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div>
        <h2>Legajo de documentos</h2>
        <p>Guarda aquí el enlace de cada documento (Drive, OneDrive…). GEALMI no almacena el archivo: solo el enlace y su fecha de vencimiento, para avisarte antes de que caduque.</p>
      </div>
      <div class="rrhh-filtros">
        <label>Trabajador<select id="doEmpleado"><option value="">Todos</option>${opcionesEmpleados(empleados).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></label>
        <label>Tipo<select id="doTipo"><option value="">Todos</option>${tiposDisponibles.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}</select></label>
        <label class="rrhh-check" style="padding-bottom:8px;"><input type="checkbox" id="doPronto"> Solo vencidos o por vencer (30 días)</label>
        ${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="doNuevo">+ Agregar documento</button>' : ''}
      </div>
    </div>
    <div id="doAviso"></div>
    <div class="kpis rrhh-kpis" id="doKpis"></div>
    <div class="rrhh-panel" id="doTabla"></div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    const qs = new URLSearchParams();
    if (filtros.empleado_id) qs.set('empleado_id', filtros.empleado_id);
    if (filtros.pronto) qs.set('vence_en', '30');
    try { filas = await api(`/documentos${qs.toString() ? `?${qs}` : ''}`); }
    catch (err) { avisar($('#doAviso'), err.message, 'error'); return; }
    limpiarError($('#doAviso'));
    dibujar();
  }

  function estadoVencimiento(f) {
    if (!f.fecha_vencimiento) return '<span class="rrhh-sub">Sin vencimiento</span>';
    if (f.vencido) return `${badge('Vencido', 'danger')}<span class="rrhh-sub">${fechaCorta(f.fecha_vencimiento)}</span>`;
    const dias = Math.round((new Date(`${f.fecha_vencimiento}T00:00:00Z`) - new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 86400000);
    return `${dias <= 30 ? badge(`Vence en ${dias} d`, 'purple') : badge('Vigente', 'teal')}<span class="rrhh-sub">${fechaCorta(f.fecha_vencimiento)}</span>`;
  }

  function dibujar() {
    const visibles = filtros.tipo ? filas.filter(f => f.tipo === filtros.tipo) : filas;
    const vencidos = visibles.filter(f => f.vencido).length;
    $('#doKpis').innerHTML = [
      kpiCard({ acento: 'blue', icono: ICONO_FOLDER, label: 'Documentos', value: fmtNum(visibles.length), sub: 'en la vista actual' }),
      kpiCard({ acento: vencidos ? 'orange' : 'teal', icono: ICONO_ALERT_TRIANGLE, label: 'Vencidos', value: fmtNum(vencidos), sub: 'requieren renovación' })
    ].join('');
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#doTabla').innerHTML = tabla([
      { titulo: 'Trabajador', celda: f => esc(f.empleado_nombre) },
      { titulo: 'Tipo', celda: f => esc(ETIQUETA[f.tipo] || f.tipo) },
      { titulo: 'Documento', celda: f => (f.url
        ? `<a class="rrhh-enlace" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.nombre)} ↗</a>` : esc(f.nombre)) + (f.notas ? `<span class="rrhh-sub">${esc(f.notas)}</span>` : '') },
      { titulo: 'Emitido', celda: f => fechaCorta(f.fecha_emision) },
      { titulo: 'Vencimiento', celda: estadoVencimiento },
      { titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar ? [{ accion: 'editar', texto: 'Editar' }] : []), ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }
    ], visibles, { vacio: 'No hay documentos con esos filtros.' });
  }

  function abrirFormulario(fila = null) {
    modal({
      titulo: fila ? 'Editar documento' : 'Agregar documento', icono: ICONO_FOLDER, ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="doForm"></div>';
        montarFormulario(cuerpo.querySelector('#doForm'), {
          campos: [
            { id: 'empleado_id', label: 'Trabajador', tipo: 'select', requerido: true, valor: fila?.empleado_id ?? filtros.empleado_id ?? '', ancho: 2,
              opciones: fila ? opcionesEmpleados(empleados) : opcionesEmpleados(empleados, { vacio: 'Elige un trabajador…' }) },
            { id: 'tipo', label: 'Tipo', tipo: 'select', opciones: tiposDisponibles, valor: fila?.tipo ?? 'contrato', requerido: true },
            { id: 'nombre', label: 'Nombre del documento', requerido: true, valor: fila?.nombre ?? '', ancho: 2, maxlength: 150 },
            { id: 'url', label: 'Enlace (https://…)', tipo: 'url', valor: fila?.url ?? '', ancho: 4, maxlength: 500, placeholder: 'https://drive.google.com/…', ayuda: 'Solo enlaces seguros (https). Asegúrate de que estén compartidos solo con quien corresponde.' },
            { id: 'fecha_emision', label: 'Emitido el', tipo: 'date', valor: fila?.fecha_emision ?? '' },
            { id: 'fecha_vencimiento', label: 'Vence el', tipo: 'date', valor: fila?.fecha_vencimiento ?? '', ayuda: 'Avisamos 30 días antes' },
            { id: 'notas', label: 'Notas', valor: fila?.notas ?? '', ancho: 4, maxlength: 250 }
          ],
          textoGuardar: fila ? 'Guardar cambios' : 'Agregar documento', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            if (fila) await api(`/documentos/${fila.id}`, { metodo: 'PUT', cuerpo: v });
            else await api('/documentos', { metodo: 'POST', cuerpo: { ...v, empleado_id: Number(v.empleado_id) } });
            cerrarPanelLateral();
            avisar(zona, 'Documento guardado.');
            document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
            await cargar();
          }
        });
        if (fila) cuerpo.querySelector('[name="empleado_id"]').disabled = true;
      }
    });
  }

  $('#doEmpleado').addEventListener('change', (e) => { filtros.empleado_id = e.target.value; cargar(); });
  $('#doTipo').addEventListener('change', (e) => { filtros.tipo = e.target.value; dibujar(); });
  $('#doPronto').addEventListener('change', (e) => { filtros.pronto = e.target.checked; cargar(); });
  $('#doNuevo')?.addEventListener('click', () => abrirFormulario(null));
  const buscar = (id) => filas.find(f => f.id === Number(id));
  alHacerClic(zona, {
    editar: (id) => abrirFormulario(buscar(id)),
    borrar: async (id) => {
      const f = buscar(id);
      if (!confirm(`¿Eliminar "${f.nombre}" de ${f.empleado_nombre}? (Solo se borra el registro del enlace.)`)) return;
      try { await api(`/documentos/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Documento eliminado.'); await cargar(); }
      catch (err) { avisar($('#doAviso'), err.message, 'error'); }
    }
  });
  await cargar();
}
