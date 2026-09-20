// js/rrhh/asistencia.js
// Pestaña "Asistencia" (fase R2): el registro de todos los trabajadores en un
// rango de fechas, con horas trabajadas, sobretiempo y tardanza calculados por el
// servidor; carga y corrección manual (siempre con motivo); y la exportación del
// "Registro de asistencia" (CSV y PDF) con los datos del empleador impresos.

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, listarEmpleados, opcionesEmpleados,
  fechaCorta, horaLima, duracion, hoyLima, primerDiaDelMes, badge, tabla, botonesFila, alHacerClic, avisar, descargarCSV, limpiarError
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';
import { cargarLibreriasPDF, limpiarTextoPDF } from '../exportarPDF.js';

const hhmm = (iso) => (iso ? horaLima(iso) : '');
const semanaTexto = (s) => `${s.semana.replace('-S', ' · sem. ')}: ${Math.round(s.minutos / 6) / 10} h`;

export async function montar(zona) {
  const empleados = await listarEmpleados({ recargar: true });
  const filtros = { desde: primerDiaDelMes(), hasta: hoyLima(), empleado_id: '' };
  let datos = null;

  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div>
        <h2>Registro de asistencia</h2>
        <p>Cada trabajador marca desde "Mi asistencia" con la hora del servidor. Aquí ves el consolidado y, si alguien olvidó marcar, lo cargas o corriges con un motivo (queda en Auditoría con el antes y el después).</p>
      </div>
      <div class="rrhh-filtros">
        <label>Desde<input type="date" id="asDesde" value="${filtros.desde}"></label>
        <label>Hasta<input type="date" id="asHasta" value="${filtros.hasta}"></label>
        <label>Trabajador<select id="asEmpleado"><option value="">Todos</option>${opcionesEmpleados(empleados).map(o => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select></label>
      </div>
    </div>
    <div class="rrhh-filtros" style="margin-bottom:14px;">
      ${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="asNueva">+ Registrar asistencia</button>' : ''}
      <button type="button" class="btn btn-ghost" id="asEmpleador">Datos del empleador</button>
      <button type="button" class="btn btn-ghost" id="asCsv">Exportar CSV</button>
      <button type="button" class="btn btn-ghost" id="asPdf">Exportar PDF</button>
    </div>
    <div class="rrhh-legal">El registro de asistencia está regulado por el D.S. 004-2006-TR (datos del empleador y del trabajador, hora y minuto de ingreso y salida, sobretiempo y refrigerio) y lo fiscaliza SUNAFIL. GEALMI arma el registro con esos datos, pero <b>no fue validado por un abogado laboral</b>: confirma con tu contador o abogado que cubre lo que tu empresa necesita presentar.</div>
    <div id="asAviso"></div>
    <div class="kpis rrhh-kpis" id="asKpis"></div>
    <div id="asResumen"></div>
    <div id="asFilas"></div>`;

  const $ = (id) => zona.querySelector(id);

  async function cargar() {
    const qs = new URLSearchParams({ desde: filtros.desde, hasta: filtros.hasta });
    if (filtros.empleado_id) qs.set('empleado_id', filtros.empleado_id);
    try {
      datos = await api(`/asistencia?${qs}`);
    } catch (err) {
      avisar($('#asAviso'), err.message, 'error');
      return;
    }
    limpiarError($('#asAviso'));
    dibujar();
  }

  function dibujar() {
    const { filas, resumen } = datos;
    const horas = filas.reduce((s, f) => s + f.minutos_trabajados, 0);
    const extra = filas.reduce((s, f) => s + f.minutos_sobretiempo, 0);
    const tardanzas = filas.filter(f => f.minutos_tardanza > 0).length;
    const sinSalida = filas.filter(f => !f.completo).length;
    $('#asKpis').innerHTML = [
      kpiCard({ acento: 'blue', icono: '🗓️', label: 'Jornadas registradas', value: fmtNum(filas.length), sub: `${resumen.length} trabajador(es)` }),
      kpiCard({ acento: 'teal', icono: '⏱️', label: 'Horas trabajadas', value: duracion(horas), sub: 'sin contar refrigerio' }),
      kpiCard({ acento: 'purple', icono: '➕', label: 'Sobretiempo', value: duracion(extra), sub: 'sobre la jornada pactada' }),
      kpiCard({ acento: tardanzas ? 'orange' : 'teal', icono: '⏰', label: 'Tardanzas', value: fmtNum(tardanzas), sub: 'llegadas después de la hora pactada' }),
      kpiCard({ acento: sinSalida ? 'orange' : 'teal', icono: '🚪', label: 'Sin salida marcada', value: fmtNum(sinSalida), sub: 'jornadas por completar' })
    ].join('');

    $('#asResumen').innerHTML = `<div class="rrhh-panel"><h3>Resumen por trabajador</h3>${tabla([
      { titulo: 'Trabajador', celda: r => `${esc(r.nombre)}${r.dni ? `<span class="rrhh-sub">${esc(r.dni)}</span>` : ''}` },
      { titulo: 'Días', clase: 'num', celda: r => r.dias },
      { titulo: 'Horas', clase: 'num', celda: r => duracion(r.minutos_trabajados) },
      { titulo: 'Sobretiempo', clase: 'num', celda: r => duracion(r.minutos_sobretiempo) },
      { titulo: 'Tardanzas', clase: 'num', celda: r => (r.tardanzas ? `${r.tardanzas} (${duracion(r.minutos_tardanza)})` : '—') },
      { titulo: 'Sin salida', clase: 'num', celda: r => r.sin_salida || '—' },
      { titulo: 'Semanas sobre 48 h', celda: r => (r.semanas_sobre_el_limite.length
        ? `<span class="rrhh-alerta-texto">⚠ ${esc(r.semanas_sobre_el_limite.map(semanaTexto).join(' · '))}</span>` : '—') }
    ], resumen, { vacio: 'Sin asistencia registrada en este rango.' })}
      <p class="campo-ayuda" style="margin-top:8px;">La jornada máxima es de 8 horas diarias o 48 semanales. Si el rango corta una semana por la mitad, esa semana se mide solo con los días incluidos.</p></div>`;

    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#asFilas').innerHTML = `<div class="rrhh-panel"><h3>Jornadas</h3>${tabla([
      { titulo: 'Fecha', celda: f => fechaCorta(f.fecha) },
      { titulo: 'Trabajador', celda: f => esc(f.nombre) },
      { titulo: 'Entrada', celda: f => horaLima(f.entrada) },
      { titulo: 'Sale a refrigerio', celda: f => horaLima(f.salida_refrigerio) },
      { titulo: 'Regresa', celda: f => horaLima(f.retorno_refrigerio) },
      { titulo: 'Salida', celda: f => (f.salida ? horaLima(f.salida) : '<span class="rrhh-alerta-texto">Falta</span>') },
      { titulo: 'Trabajado', clase: 'num', celda: f => duracion(f.minutos_trabajados) },
      { titulo: 'Sobretiempo', clase: 'num', celda: f => duracion(f.minutos_sobretiempo) },
      { titulo: 'Tardanza', clase: 'num', celda: f => (f.minutos_tardanza ? `${f.minutos_tardanza} min` : '—') },
      { titulo: 'Origen', celda: f => `${badge(f.origen === 'manual' ? 'Manual' : 'Marcó', f.origen === 'manual' ? 'purple' : 'teal')}${f.observacion ? `<span class="rrhh-sub">${esc(f.observacion)}</span>` : ''}` },
      ...(puedeEditar || puedeBorrar ? [{ titulo: '', clase: 'acc', celda: f => botonesFila(f.id, [
        ...(puedeEditar ? [{ accion: 'editar', texto: 'Corregir' }] : []), ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }] : [])
    ], filas, { vacio: 'Sin jornadas en este rango.' })}</div>`;
  }

  // ---- formularios ----
  function abrirFormulario(fila = null) {
    modal({
      titulo: fila ? 'Corregir asistencia' : 'Registrar asistencia', icono: '⏱️', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<p class="rrhh-legal">Usa esto cuando alguien olvidó marcar o marcó mal. El motivo es obligatorio y queda registrado junto con el valor anterior. Si el turno cruza la medianoche, pon la salida como la hora del día siguiente (por ejemplo 22:00 y 06:00).</p><div id="asForm"></div>';
        montarFormulario(cuerpo.querySelector('#asForm'), {
          campos: [
            { id: 'empleado_id', label: 'Trabajador', tipo: 'select', requerido: true, valor: fila?.empleado_id ?? '', ancho: 2,
              opciones: fila ? opcionesEmpleados(empleados) : opcionesEmpleados(empleados, { vacio: 'Elige un trabajador…' }) },
            { id: 'fecha', label: 'Fecha', tipo: 'date', requerido: true, valor: fila?.fecha ?? hoyLima(), max: hoyLima() },
            { id: 'entrada', label: 'Entrada', tipo: 'time', requerido: true, valor: hhmm(fila?.entrada) },
            { id: 'salida_refrigerio', label: 'Sale a refrigerio', tipo: 'time', valor: hhmm(fila?.salida_refrigerio) },
            { id: 'retorno_refrigerio', label: 'Regresa', tipo: 'time', valor: hhmm(fila?.retorno_refrigerio) },
            { id: 'salida', label: 'Salida', tipo: 'time', valor: hhmm(fila?.salida) },
            { id: 'observacion', label: 'Motivo (obligatorio)', requerido: true, ancho: 4, maxlength: 250, valor: '', placeholder: 'Ej.: olvidó marcar; lo confirmó su jefe' }
          ],
          textoGuardar: fila ? 'Guardar corrección' : 'Registrar',
          alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            if (fila) await api(`/asistencia/${fila.id}`, { metodo: 'PUT', cuerpo: { entrada: v.entrada, salida_refrigerio: v.salida_refrigerio, retorno_refrigerio: v.retorno_refrigerio, salida: v.salida, observacion: v.observacion } });
            else await api('/asistencia', { metodo: 'POST', cuerpo: { ...v, empleado_id: Number(v.empleado_id) } });
            cerrarPanelLateral();
            avisar(zona, 'Asistencia guardada.');
            await cargar();
          }
        });
        if (fila) cuerpo.querySelectorAll('[name="empleado_id"], [name="fecha"]').forEach(el => { el.disabled = true; });
      }
    });
  }

  async function abrirEmpleador() {
    let e = {};
    try { e = await api('/empleador'); } catch (err) { avisar($('#asAviso'), err.message, 'error'); return; }
    const editable = puede('rrhh.editar');
    modal({
      titulo: 'Datos del empleador', icono: '🏢', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<p class="rrhh-legal">Se imprimen en el registro de asistencia. El RUC se valida (11 dígitos y dígito verificador).</p><div id="empForm"></div>';
        const form = montarFormulario(cuerpo.querySelector('#empForm'), {
          campos: [
            { id: 'razon_social', label: 'Razón social', valor: e.razon_social ?? e.nombre ?? '', ancho: 4, maxlength: 200 },
            { id: 'ruc', label: 'RUC', valor: e.ruc ?? '', maxlength: 11, ancho: 2 },
            { id: 'domicilio_fiscal', label: 'Domicilio fiscal', valor: e.domicilio_fiscal ?? '', ancho: 4, maxlength: 250 }
          ],
          textoGuardar: 'Guardar', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            await api('/empleador', { metodo: 'PUT', cuerpo: v });
            cerrarPanelLateral();
            avisar(zona, 'Datos del empleador guardados.');
            await cargar();
          }
        });
        if (!editable) { form.querySelectorAll('input').forEach(i => { i.disabled = true; }); form.querySelector('button[type="submit"]')?.remove(); }
      }
    });
  }

  // ---- exportación ----
  const encabezadoEmpleador = () => {
    const e = datos.empleador || {};
    return [`Razón social: ${e.razon_social || e.nombre || '(sin registrar)'}`, `RUC: ${e.ruc || '(sin registrar)'}`, `Domicilio: ${e.domicilio_fiscal || '(sin registrar)'}`];
  };
  const filasTabla = () => datos.filas.map(f => [
    fechaCorta(f.fecha), f.nombre, f.dni || '', horaLima(f.entrada), horaLima(f.salida_refrigerio), horaLima(f.retorno_refrigerio),
    f.salida ? horaLima(f.salida) : 'Falta', duracion(f.minutos_trabajados), duracion(f.minutos_sobretiempo),
    f.minutos_tardanza ? `${f.minutos_tardanza} min` : '', f.origen === 'manual' ? `Manual: ${f.observacion || ''}` : 'Marcación'
  ]);
  const CABECERA = ['Fecha', 'Trabajador', 'DNI', 'Entrada', 'Sale a refrigerio', 'Regresa', 'Salida', 'Trabajado', 'Sobretiempo', 'Tardanza', 'Origen'];

  function exportarCSV() {
    if (!datos?.filas.length) { avisar($('#asAviso'), 'No hay jornadas en este rango para exportar.', 'info'); return; }
    descargarCSV(`Registro de asistencia ${datos.desde} a ${datos.hasta}.csv`, [
      ['Registro de asistencia'], ...encabezadoEmpleador().map(l => [l]), [`Período: ${datos.desde} a ${datos.hasta}`], [], CABECERA, ...filasTabla()
    ]);
  }

  async function exportarPDF(boton) {
    if (!datos?.filas.length) { avisar($('#asAviso'), 'No hay jornadas en este rango para exportar.', 'info'); return; }
    boton.disabled = true;
    const textoOriginal = boton.textContent;
    boton.textContent = 'Generando PDF…';
    try {
      const JsPDF = await cargarLibreriasPDF();
      const doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const t = limpiarTextoPDF;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15);
      doc.text('Registro de asistencia', 14, 16);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      encabezadoEmpleador().forEach((linea, i) => doc.text(t(linea), 14, 23 + i * 5));
      doc.text(t(`Período: ${fechaCorta(datos.desde)} al ${fechaCorta(datos.hasta)}  ·  Generado el ${fechaCorta(hoyLima())}`), 14, 38);
      let y = 43;
      if (!datos.empleador?.ruc || !datos.empleador?.razon_social) {
        doc.setTextColor(175, 75, 67);
        doc.text('Faltan datos del empleador (razón social o RUC): complétalos en "Datos del empleador".', 14, y);
        doc.setTextColor(0, 0, 0);
        y += 5;
      }
      doc.autoTable({
        startY: y, head: [CABECERA.map(t)], body: filasTabla().map(f => f.map(t)),
        styles: { fontSize: 7.5, cellPadding: 1.6 }, headStyles: { fillColor: [14, 27, 69] }, margin: { left: 14, right: 14 }
      });
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 8,
        head: [['Trabajador', 'Días', 'Horas', 'Sobretiempo', 'Tardanzas', 'Sin salida', 'Semanas sobre 48 h'].map(t)],
        body: datos.resumen.map(r => [r.nombre, r.dias, duracion(r.minutos_trabajados), duracion(r.minutos_sobretiempo),
          r.tardanzas ? `${r.tardanzas} (${duracion(r.minutos_tardanza)})` : '-', r.sin_salida || '-',
          r.semanas_sobre_el_limite.map(semanaTexto).join(' · ') || '-'].map(x => t(String(x)))),
        styles: { fontSize: 8, cellPadding: 1.6 }, headStyles: { fillColor: [11, 124, 117] }, margin: { left: 14, right: 14 }
      });
      const paginas = doc.getNumberOfPages();
      for (let p = 1; p <= paginas; p++) {
        doc.setPage(p); doc.setFontSize(8); doc.setTextColor(120);
        doc.text(`Página ${p} de ${paginas}`, 283, 203, { align: 'right' });
      }
      doc.save(`${t(`Registro de asistencia ${datos.desde} a ${datos.hasta}`)}.pdf`);
    } catch (err) {
      console.error(err);
      avisar($('#asAviso'), `No se pudo generar el PDF: ${err.message}`, 'error');
    } finally {
      boton.disabled = false;
      boton.textContent = textoOriginal;
    }
  }

  // ---- eventos ----
  $('#asDesde').addEventListener('change', (e) => { filtros.desde = e.target.value; if (filtros.desde) cargar(); });
  $('#asHasta').addEventListener('change', (e) => { filtros.hasta = e.target.value; if (filtros.hasta) cargar(); });
  $('#asEmpleado').addEventListener('change', (e) => { filtros.empleado_id = e.target.value; cargar(); });
  $('#asNueva')?.addEventListener('click', () => abrirFormulario(null));
  $('#asEmpleador').addEventListener('click', abrirEmpleador);
  $('#asCsv').addEventListener('click', exportarCSV);
  $('#asPdf').addEventListener('click', (e) => exportarPDF(e.currentTarget));
  alHacerClic(zona, {
    editar: (id) => abrirFormulario(datos.filas.find(f => f.id === Number(id))),
    borrar: async (id) => {
      const f = datos.filas.find(x => x.id === Number(id));
      if (!confirm(`¿Eliminar la jornada de ${f.nombre} del ${fechaCorta(f.fecha)}? Queda constancia en Auditoría.`)) return;
      try { await api(`/asistencia/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Jornada eliminada.'); await cargar(); }
      catch (err) { avisar($('#asAviso'), err.message, 'error'); }
    }
  });

  await cargar();
}
