// js/rrhh/remuneraciones.js
// Pestaña "Remuneraciones" (fase R4, requiere rrhh.remuneraciones): registro de
// lo que se paga a cada trabajador mes a mes y estimación REFERENCIAL de
// gratificación y CTS. No es una planilla electrónica: no calcula AFP/ONP ni
// renta de 5.ª categoría (eso es del contador).

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, opcionesEmpleados, fechaCorta, hoyLima,
  soles, badge, tabla, botonesFila, alHacerClic, avisar, limpiarError
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';
import { ICONO_DOLLAR, ICONO_CHECK_FILLED, ICONO_HOURGLASS } from '../iconos.js';

export async function montar(zona) {
  const empleados = await listarEmpleados({ recargar: true });
  const conSueldo = empleados.filter(e => e.estado_efectivo !== 'cesado');
  let periodo = hoyLima().slice(0, 7);
  let filas = [], total = 0;

  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div>
        <h2>Remuneraciones</h2>
        <p>Registro de lo pagado a cada trabajador. Un pago por trabajador y por mes. Los cambios de sueldo de la ficha quedan en su historial.</p>
      </div>
      <div class="rrhh-filtros">
        <label>Mes<input type="month" id="reMes" value="${periodo}"></label>
        ${puede('rrhh.crear') ? '<button type="button" class="btn btn-ghost" id="reGenerar" title="Crea el pago pendiente de cada trabajador que aún no lo tiene">Generar pagos del mes</button><button type="button" class="btn btn-ochre" id="reNueva">+ Registrar pago</button>' : ''}
      </div>
    </div>
    <div class="rrhh-legal">Esto es un <b>registro</b> de lo que pagas, no una planilla electrónica: no calcula AFP/ONP, renta de 5.ª categoría ni aportes. Las estimaciones de gratificación y CTS son <b>referenciales</b> y no fueron validadas por un contador; úsalas como orientación, no como liquidación.</div>
    <div id="reAviso"></div>
    <div class="kpis rrhh-kpis" id="reKpis"></div>
    <div class="rrhh-panel" id="reTabla"></div>
    <div class="rrhh-panel">
      <h3>Estimar gratificación y CTS</h3>
      <div class="rrhh-filtros">
        <label>Trabajador<select id="beEmpleado"><option value="">Elige un trabajador…</option>${opcionesEmpleados(conSueldo).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></label>
      </div>
      <div id="beResultado" style="margin-top:12px;"></div>
    </div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    try {
      const r = await api(`/remuneraciones/?periodo=${periodo}`);
      filas = r.filas; total = r.total_neto;
    } catch (err) { avisar($('#reAviso'), err.message, 'error'); return; }
    limpiarError($('#reAviso'));
    dibujar();
  }

  function dibujar() {
    const pagadas = filas.filter(f => f.estado === 'pagado');
    const pendientes = filas.filter(f => f.estado === 'pendiente');
    const suma = (lista) => lista.reduce((s, f) => s + Number(f.neto), 0);
    $('#reKpis').innerHTML = [
      kpiCard({ acento: 'purple', icono: ICONO_DOLLAR, label: 'Neto del mes', value: soles(total), sub: `${filas.length} pago(s)` }),
      kpiCard({ acento: 'teal', icono: ICONO_CHECK_FILLED, label: 'Pagado', value: soles(suma(pagadas)), sub: `${pagadas.length} pago(s)` }),
      kpiCard({ acento: pendientes.length ? 'orange' : 'teal', icono: ICONO_HOURGLASS, label: 'Pendiente', value: soles(suma(pendientes)), sub: `${pendientes.length} pago(s)` })
    ].join('');
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#reTabla').innerHTML = tabla([
      { titulo: 'Trabajador', celda: f => esc(f.empleado_nombre) },
      { titulo: 'Sueldo base', clase: 'num', celda: f => soles(f.sueldo_base) },
      { titulo: 'Bonificaciones', clase: 'num', celda: f => soles(f.bonificaciones) },
      { titulo: 'Horas extra', clase: 'num', celda: f => soles(f.horas_extra) },
      { titulo: 'Descuentos', clase: 'num', celda: f => soles(f.descuentos) },
      { titulo: 'Neto', clase: 'num', celda: f => `<b>${soles(f.neto)}</b>` },
      { titulo: 'Estado', celda: f => `${badge(f.estado === 'pagado' ? 'Pagado' : 'Pendiente', f.estado === 'pagado' ? 'teal' : 'purple')}${f.fecha_pago ? `<span class="rrhh-sub">${fechaCorta(f.fecha_pago)}</span>` : ''}` },
      { titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar && f.estado === 'pendiente' ? [{ accion: 'pagar', texto: 'Marcar pagado' }] : []),
        ...(puedeEditar ? [{ accion: 'editar', texto: 'Editar' }] : []),
        ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }
    ], filas, { vacio: 'No hay pagos registrados en este mes. Usa "Generar pagos del mes" para empezar con el sueldo actual de cada trabajador.' });
  }

  function abrirFormulario(fila = null) {
    modal({
      titulo: fila ? 'Editar pago' : 'Registrar pago', icono: ICONO_DOLLAR, ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="reForm"></div>';
        montarFormulario(cuerpo.querySelector('#reForm'), {
          campos: [
            { id: 'empleado_id', label: 'Trabajador', tipo: 'select', requerido: true, valor: fila?.empleado_id ?? '', ancho: 2,
              opciones: fila ? opcionesEmpleados(empleados) : opcionesEmpleados(conSueldo, { vacio: 'Elige un trabajador…' }) },
            { id: 'periodo', label: 'Mes', tipo: 'month', requerido: true, valor: fila?.periodo ?? periodo },
            { id: 'sueldo_base', label: 'Sueldo base', tipo: 'number', min: 0, step: '0.01', valor: fila?.sueldo_base ?? '', ayuda: fila ? '' : 'Vacío = el sueldo actual de la ficha' },
            { id: 'bonificaciones', label: 'Bonificaciones', tipo: 'number', min: 0, step: '0.01', valor: fila?.bonificaciones ?? 0 },
            { id: 'horas_extra', label: 'Horas extra (S/)', tipo: 'number', min: 0, step: '0.01', valor: fila?.horas_extra ?? 0 },
            { id: 'descuentos', label: 'Descuentos', tipo: 'number', min: 0, step: '0.01', valor: fila?.descuentos ?? 0, ayuda: 'AFP/ONP, adelantos, faltas…' },
            { id: 'estado', label: 'Estado', tipo: 'select', valor: fila?.estado ?? 'pendiente', opciones: [{ value: 'pendiente', label: 'Pendiente' }, { value: 'pagado', label: 'Pagado' }] },
            { id: 'fecha_pago', label: 'Fecha de pago', tipo: 'date', valor: fila?.fecha_pago ?? '' },
            { id: 'notas', label: 'Notas', valor: fila?.notas ?? '', ancho: 4, maxlength: 250 }
          ],
          textoGuardar: fila ? 'Guardar cambios' : 'Registrar pago', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            if (fila) await api(`/remuneraciones/${fila.id}`, { metodo: 'PUT', cuerpo: v });
            else await api('/remuneraciones/', { metodo: 'POST', cuerpo: { ...v, empleado_id: Number(v.empleado_id) } });
            cerrarPanelLateral();
            periodo = v.periodo || periodo;
            $('#reMes').value = periodo;
            avisar(zona, 'Pago guardado.');
            await cargar();
          }
        });
        if (fila) cuerpo.querySelectorAll('[name="empleado_id"], [name="periodo"]').forEach(el => { el.disabled = true; });
      }
    });
  }

  async function estimar(id) {
    const cont = $('#beResultado');
    if (!id) { cont.innerHTML = ''; return; }
    cont.textContent = 'Calculando…';
    try {
      const b = await api(`/remuneraciones/beneficios/${id}`);
      cont.innerHTML = `<div class="rrhh-datos">
          <div class="rrhh-dato"><b>${soles(b.gratificacion.monto)}</b><span>gratificación · ${esc(b.gratificacion.periodo)} (${b.gratificacion.meses} mes/es)</span></div>
          <div class="rrhh-dato"><b>${soles(b.gratificacion.bonificacion_extraordinaria)}</b><span>bonificación extraordinaria (9 %)</span></div>
          <div class="rrhh-dato"><b>${soles(b.cts.monto)}</b><span>CTS · ${esc(b.cts.periodo)} (${b.cts.meses} mes/es)</span></div>
          <div class="rrhh-dato"><b>${soles(b.cts.remuneracion_computable)}</b><span>remuneración computable de la CTS</span></div>
        </div>
        ${b.aplica ? '' : '<p class="campo-ayuda" style="margin-top:8px;">Con el régimen de este trabajador no se estiman gratificación ni CTS: confírmalo con tu contador.</p>'}
        <p class="rrhh-legal" style="margin:10px 0 0;">${esc(b.referencial)}</p>`;
    } catch (err) { cont.innerHTML = `<p class="form-status error">${esc(err.message)}</p>`; }
  }

  $('#reMes').addEventListener('change', (e) => { if (e.target.value) { periodo = e.target.value; cargar(); } });
  $('#reNueva')?.addEventListener('click', () => abrirFormulario(null));
  $('#reGenerar')?.addEventListener('click', async () => {
    try {
      const r = await api('/remuneraciones/generar', { metodo: 'POST', cuerpo: { periodo } });
      avisar($('#reAviso'), r.creadas ? `Se crearon ${fmtNum(r.creadas)} pago(s) pendiente(s) de ${periodo}.` : 'No había trabajadores sin pago en ese mes.', r.creadas ? 'ok' : 'info');
      await cargar();
    } catch (err) { avisar($('#reAviso'), err.message, 'error'); }
  });
  $('#beEmpleado').addEventListener('change', (e) => estimar(e.target.value));
  const buscar = (id) => filas.find(f => f.id === Number(id));
  alHacerClic(zona, {
    editar: (id) => abrirFormulario(buscar(id)),
    pagar: async (id) => {
      const f = buscar(id);
      try {
        await api(`/remuneraciones/${id}`, { metodo: 'PUT', cuerpo: { sueldo_base: f.sueldo_base, bonificaciones: f.bonificaciones, horas_extra: f.horas_extra, descuentos: f.descuentos, estado: 'pagado', fecha_pago: hoyLima(), notas: f.notas } });
        avisar($('#reAviso'), `Pago de ${f.empleado_nombre} marcado como pagado.`);
        await cargar();
      } catch (err) { avisar($('#reAviso'), err.message, 'error'); }
    },
    borrar: async (id) => {
      const f = buscar(id);
      if (!confirm(`¿Eliminar el pago de ${f.empleado_nombre} de ${f.periodo}?`)) return;
      try { await api(`/remuneraciones/${id}`, { metodo: 'DELETE' }); avisar($('#reAviso'), 'Pago eliminado.'); await cargar(); }
      catch (err) { avisar($('#reAviso'), err.message, 'error'); }
    }
  });
  await cargar();
}
