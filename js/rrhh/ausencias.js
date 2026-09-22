// js/rrhh/ausencias.js
// Pestaña "Ausencias" (fase R3): vacaciones, descansos médicos, licencias y
// permisos con flujo de aprobación. El trabajador solicita desde "Mi asistencia"
// (queda pendiente); aquí RRHH aprueba, rechaza o cancela, y también puede
// cargar una ausencia ya decidida. Solo lo aprobado cuenta para el saldo de
// vacaciones y para el estado que muestra la ficha.

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, opcionesEmpleados, fechaCorta, hoyLima,
  sumarDias, badge, tabla, botonesFila, alHacerClic, avisar, ETIQUETA_AUSENCIA, ETIQUETA_ESTADO_AUSENCIA, limpiarError
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';
import { ICONO_INBOX, ICONO_UMBRELLA, ICONO_CALENDAR, ICONO_LOCK, ICONO_EDIT } from '../iconos.js';

const TIPOS = Object.entries(ETIQUETA_AUSENCIA).map(([value, label]) => ({ value, label }));

export async function montar(zona) {
  const empleados = await listarEmpleados({ recargar: true });
  const filtros = { estado: '', tipo: '', empleado_id: '' };
  let filas = [];
  const verSalud = puede('rrhh.salud');

  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div>
        <h2>Ausencias y vacaciones</h2>
        <p>Las solicitudes de los trabajadores aparecen primero. Al aprobar una ausencia, el trabajador figura de vacaciones o de licencia durante esas fechas y las vacaciones descuentan de su saldo.</p>
      </div>
      <div class="rrhh-filtros">
        <label>Estado<select id="auEstado"><option value="">Todos</option><option value="pendiente">Pendientes</option><option value="aprobada">Aprobadas</option><option value="rechazada">Rechazadas</option><option value="cancelada">Canceladas</option></select></label>
        <label>Tipo<select id="auTipo"><option value="">Todos</option>${TIPOS.map(t => `<option value="${t.value}">${esc(t.label)}</option>`).join('')}</select></label>
        <label>Trabajador<select id="auEmpleado"><option value="">Todos</option>${opcionesEmpleados(empleados).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></label>
        ${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="auNueva">+ Registrar ausencia</button>' : ''}
      </div>
    </div>
    <div id="auAviso"></div>
    <div class="kpis rrhh-kpis" id="auKpis"></div>
    <div class="rrhh-panel" id="auTabla"></div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) if (v) qs.set(k, v);
    try { filas = await api(`/ausencias${qs.toString() ? `?${qs}` : ''}`); }
    catch (err) { avisar($('#auAviso'), err.message, 'error'); return; }
    limpiarError($('#auAviso'));
    dibujar();
  }

  function dibujar() {
    const hoy = hoyLima(), en30 = sumarDias(hoy, 30);
    const pendientes = filas.filter(f => f.estado === 'pendiente').length;
    const hoyAusentes = filas.filter(f => f.estado === 'aprobada' && f.fecha_inicio <= hoy && f.fecha_fin >= hoy).length;
    const proximas = filas.filter(f => f.estado === 'aprobada' && f.fecha_inicio > hoy && f.fecha_inicio <= en30).length;
    $('#auKpis').innerHTML = [
      kpiCard({ acento: pendientes ? 'orange' : 'teal', icono: ICONO_INBOX, label: 'Por resolver', value: fmtNum(pendientes), sub: 'solicitudes pendientes' }),
      kpiCard({ acento: 'blue', icono: ICONO_UMBRELLA, label: 'Ausentes hoy', value: fmtNum(hoyAusentes), sub: 'con ausencia aprobada' }),
      kpiCard({ acento: 'purple', icono: ICONO_CALENDAR, label: 'Próximos 30 días', value: fmtNum(proximas), sub: 'ausencias aprobadas por empezar' })
    ].join('');

    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#auTabla').innerHTML = tabla([
      { titulo: 'Trabajador', celda: f => esc(f.empleado_nombre) },
      { titulo: 'Tipo', celda: f => esc(ETIQUETA_AUSENCIA[f.tipo] || f.tipo) },
      { titulo: 'Desde', celda: f => fechaCorta(f.fecha_inicio) },
      { titulo: 'Hasta', celda: f => fechaCorta(f.fecha_fin) },
      { titulo: 'Días', clase: 'num', celda: f => f.dias },
      { titulo: 'Con goce', celda: f => (f.con_goce ? 'Sí' : 'No') },
      { titulo: 'Estado', celda: f => {
        const [texto, color] = ETIQUETA_ESTADO_AUSENCIA[f.estado] || [f.estado, 'muted'];
        return `${badge(texto, color)}${f.comentario_resolucion ? `<span class="rrhh-sub">${esc(f.comentario_resolucion)}</span>` : ''}`;
      } },
      { titulo: 'Motivo', celda: f => `${esc(f.motivo || '')}${f.detalle_medico ? `<span class="rrhh-sub">${ICONO_LOCK} ${esc(f.detalle_medico)}</span>` : ''}` },
      { titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar && f.estado === 'pendiente' ? [{ accion: 'aprobar', texto: 'Aprobar' }, { accion: 'rechazar', texto: 'Rechazar', peligro: true }] : []),
        ...(puedeEditar && ['pendiente', 'aprobada'].includes(f.estado) ? [{ accion: 'editar', texto: 'Editar' }] : []),
        ...(puedeEditar && f.estado === 'aprobada' ? [{ accion: 'cancelar', texto: 'Cancelar', peligro: true }] : []),
        ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])
      ]) }
    ], filas, { vacio: 'No hay ausencias con esos filtros.' });
  }

  function abrirFormulario(fila = null) {
    modal({
      titulo: fila ? 'Editar ausencia' : 'Registrar ausencia', icono: ICONO_UMBRELLA, ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="auForm"></div>';
        montarFormulario(cuerpo.querySelector('#auForm'), {
          campos: [
            { id: 'empleado_id', label: 'Trabajador', tipo: 'select', requerido: true, valor: fila?.empleado_id ?? '', ancho: 2,
              opciones: fila ? opcionesEmpleados(empleados) : opcionesEmpleados(empleados, { vacio: 'Elige un trabajador…' }) },
            { id: 'tipo', label: 'Tipo', tipo: 'select', opciones: TIPOS, valor: fila?.tipo ?? 'vacaciones', requerido: true },
            { id: 'estado', label: 'Estado inicial', tipo: 'select', valor: 'aprobada', oculto: !!fila,
              opciones: [{ value: 'aprobada', label: 'Aprobada (ya decidida)' }, { value: 'pendiente', label: 'Pendiente de aprobar' }] },
            { id: 'fecha_inicio', label: 'Desde', tipo: 'date', requerido: true, valor: fila?.fecha_inicio ?? hoyLima() },
            { id: 'fecha_fin', label: 'Hasta', tipo: 'date', requerido: true, valor: fila?.fecha_fin ?? hoyLima() },
            { id: 'con_goce', label: 'Con goce de haber', tipo: 'checkbox', valor: fila ? fila.con_goce : true, ayuda: 'Las vacaciones siempre son con goce' },
            { id: 'motivo', label: 'Motivo', valor: fila?.motivo ?? '', ancho: 4, maxlength: 250, ayuda: 'No escribas diagnósticos aquí' },
            { id: 'detalle_medico', label: 'Detalle médico (diagnóstico, CITT)', tipo: 'textarea', valor: fila?.detalle_medico ?? '', ancho: 4, filas: 2, oculto: !verSalud,
              ayuda: 'Dato de salud: solo lo ven quienes tienen acceso a datos de salud' }
          ],
          textoGuardar: fila ? 'Guardar cambios' : 'Registrar ausencia',
          alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            const cuerpoApi = { ...v };
            if (!verSalud) delete cuerpoApi.detalle_medico;
            if (fila) await api(`/ausencias/${fila.id}`, { metodo: 'PUT', cuerpo: cuerpoApi });
            else await api('/ausencias', { metodo: 'POST', cuerpo: { ...cuerpoApi, empleado_id: Number(v.empleado_id) } });
            cerrarPanelLateral();
            avisar(zona, 'Ausencia guardada.');
            document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
            await cargar();
          }
        });
        if (fila) cuerpo.querySelector('[name="empleado_id"]').disabled = true;
      }
    });
  }

  function abrirResolucion(fila, estado) {
    const verbo = { aprobada: 'Aprobar', rechazada: 'Rechazar', cancelada: 'Cancelar' }[estado];
    modal({
      titulo: `${verbo} ausencia`, icono: ICONO_EDIT, ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = `<p style="margin:0 0 12px;font-size:13.5px;"><b>${esc(fila.empleado_nombre)}</b> · ${esc(ETIQUETA_AUSENCIA[fila.tipo])} del ${fechaCorta(fila.fecha_inicio)} al ${fechaCorta(fila.fecha_fin)} (${fila.dias} día${fila.dias === 1 ? '' : 's'})</p><div id="resForm"></div>`;
        montarFormulario(cuerpo.querySelector('#resForm'), {
          campos: [{ id: 'comentario', label: 'Comentario para el trabajador (opcional)', ancho: 4, maxlength: 250, valor: '' }],
          textoGuardar: verbo, alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            await api(`/ausencias/${fila.id}/resolver`, { metodo: 'PUT', cuerpo: { estado, comentario: v.comentario } });
            cerrarPanelLateral();
            avisar(zona, `Ausencia ${estado}.`);
            document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
            await cargar();
          }
        });
      }
    });
  }

  for (const [id, clave] of [['#auEstado', 'estado'], ['#auTipo', 'tipo'], ['#auEmpleado', 'empleado_id']]) {
    $(id).addEventListener('change', (e) => { filtros[clave] = e.target.value; cargar(); });
  }
  $('#auNueva')?.addEventListener('click', () => abrirFormulario(null));
  const buscar = (id) => filas.find(f => f.id === Number(id));
  alHacerClic(zona, {
    aprobar: (id) => abrirResolucion(buscar(id), 'aprobada'),
    rechazar: (id) => abrirResolucion(buscar(id), 'rechazada'),
    cancelar: (id) => abrirResolucion(buscar(id), 'cancelada'),
    editar: (id) => abrirFormulario(buscar(id)),
    borrar: async (id) => {
      const f = buscar(id);
      if (!confirm(`¿Eliminar la ausencia de ${f.empleado_nombre} (${fechaCorta(f.fecha_inicio)} al ${fechaCorta(f.fecha_fin)})?`)) return;
      try { await api(`/ausencias/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Ausencia eliminada.'); await cargar(); }
      catch (err) { avisar($('#auAviso'), err.message, 'error'); }
    }
  });
  await cargar();
}
