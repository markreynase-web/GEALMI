// js/rrhh/miAsistencia.js
// "Mi asistencia" (pages/mi-asistencia.html): lo que cada trabajador hace con SU
// ficha, sin ser de RRHH -- marcar entrada, refrigerio y salida (con la hora del
// servidor), ver su historial del mes y su saldo de vacaciones, y pedir o retirar
// una ausencia. Solo funciona si su usuario está vinculado a una ficha.

import {
  api, esc, modal, cerrarPanelLateral, montarFormulario, fechaCorta, horaLima, duracion, hoyLima, primerDiaDelMes,
  badge, tabla, botonesFila, alHacerClic, avisar, ETIQUETA_AUSENCIA, ETIQUETA_ESTADO_AUSENCIA
} from './comun.js';

// Cómo se nombra cada marca en el aviso de confirmación ("Entrada registrada a las 08:02.").
const NOMBRE_MARCA = { entrada: 'Entrada', salida_refrigerio: 'Salida a refrigerio', retorno_refrigerio: 'Regreso del refrigerio', salida: 'Salida' };
const TEXTO_ACCION = {
  entrada: ['Marcar entrada', 'btn-ochre'], salida_refrigerio: ['Salir a refrigerio', 'btn-ghost'],
  retorno_refrigerio: ['Regresar del refrigerio', 'btn-ochre'], salida: ['Marcar salida', 'btn-ochre']
};

export async function montar(cont) {
  let estado;
  try {
    estado = await api('/mi/hoy');
  } catch (err) {
    cont.innerHTML = err.codigo === 'sin_ficha'
      ? `<div class="panel" style="padding:28px;text-align:center;"><h3 style="margin:0 0 6px;">Tu usuario aún no está vinculado a una ficha</h3><p style="margin:0;color:var(--muted);font-size:13.5px;line-height:1.5;">Para marcar tu asistencia, RRHH debe vincular tu usuario a tu ficha de trabajador.<br>Pídeselo a quien administra RRHH en tu empresa.</p></div>`
      : `<div class="panel" style="padding:28px;text-align:center;color:var(--coral-deep);">${esc(err.message)}</div>`;
    return;
  }

  let desfase = Date.parse(estado.hora_servidor) - Date.now(); // hora del servidor - hora de este dispositivo
  let historial = { desde: primerDiaDelMes(), hasta: hoyLima() };
  let ausencias = [];

  cont.innerHTML = `
    <div id="miAviso"></div>
    <div class="mi-grid">
      <div class="panel mi-reloj">
        <div class="mi-hora" id="miHora" aria-live="off">--:--:--</div>
        <div class="mi-fecha" id="miFecha"></div>
        <div id="miEstado"></div>
        <div class="mi-acciones" id="miAcciones"></div>
        <div class="mi-marcas" id="miMarcas"></div>
        <div class="mi-servidor">La hora la registra el servidor: no depende del reloj de tu dispositivo.</div>
      </div>
      <div class="panel" style="padding:18px 20px;">
        <h3 style="margin:0 0 10px;">Mis vacaciones y ausencias</h3>
        <div id="miSaldo"></div>
        <div style="margin:12px 0 8px;"><button type="button" class="btn btn-ochre" id="miSolicitar">+ Solicitar ausencia</button></div>
        <div id="miAusencias"></div>
      </div>
    </div>
    <div class="rrhh-panel" style="margin-top:18px;">
      <div class="rrhh-cabecera" style="margin-bottom:10px;">
        <h3 style="margin:0;">Mi historial</h3>
        <div class="rrhh-filtros">
          <label>Desde<input type="date" id="miDesde" value="${historial.desde}"></label>
          <label>Hasta<input type="date" id="miHasta" value="${historial.hasta}"></label>
        </div>
      </div>
      <div id="miResumen"></div>
      <div id="miHistorial"></div>
    </div>`;
  const $ = (id) => cont.querySelector(id);

  // ---- reloj ----
  const formatoHora = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const formatoFecha = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const tic = () => {
    const ahora = new Date(Date.now() + desfase);
    $('#miHora').textContent = formatoHora.format(ahora);
    $('#miFecha').textContent = formatoFecha.format(ahora);
  };
  tic();
  const reloj = setInterval(() => { if (!cont.isConnected) clearInterval(reloj); else tic(); }, 1000);

  // ---- marcación ----
  function dibujarHoy() {
    const { registro, acciones, empleado, ausencia_hoy } = estado;
    const pactado = empleado.hora_entrada ? ` · Entrada pactada ${empleado.hora_entrada}` : '';
    let linea = `<b>${esc(empleado.nombre)}</b><span class="rrhh-sub">${esc(empleado.puesto || 'Trabajador')} · Jornada de ${empleado.jornada_horas_dia} h${pactado}</span>`;
    if (ausencia_hoy) linea += `<div class="rrhh-aviso info" style="margin:10px 0 0;">Tienes una ausencia aprobada hoy (${esc(ETIQUETA_AUSENCIA[ausencia_hoy.tipo] || ausencia_hoy.tipo)}, hasta el ${fechaCorta(ausencia_hoy.hasta)}). Puedes marcar igual si vas a trabajar.</div>`;
    $('#miEstado').innerHTML = linea;

    $('#miAcciones').innerHTML = acciones.length
      ? acciones.map(a => `<button type="button" class="btn ${TEXTO_ACCION[a][1]}" data-marcar="${a}">${TEXTO_ACCION[a][0]}</button>`).join('')
      : '<p class="form-status">Ya completaste tu jornada. ¡Buen descanso!</p>';

    const m = (etiqueta, valor) => `<div class="mi-marca"><b>${valor}</b><span>${etiqueta}</span></div>`;
    $('#miMarcas').innerHTML = registro
      ? [m('Entrada', horaLima(registro.entrada)), m('Sale a refrigerio', horaLima(registro.salida_refrigerio)), m('Regresa', horaLima(registro.retorno_refrigerio)), m('Salida', horaLima(registro.salida))].join('')
        + (registro.completo ? `<div class="mi-marca" style="grid-column:1 / -1;"><b>${registro.minutos_trabajados ? duracion(registro.minutos_trabajados) : '0 min'}</b><span>trabajadas hoy${registro.minutos_sobretiempo ? ` · ${duracion(registro.minutos_sobretiempo)} de sobretiempo` : ''}${registro.minutos_tardanza ? ` · llegaste ${registro.minutos_tardanza} min tarde` : ''}</span></div>` : '')
      : '';
  }

  cont.addEventListener('click', async (e) => {
    const boton = e.target.closest('[data-marcar]');
    if (!boton) return;
    cont.querySelectorAll('[data-marcar]').forEach(b => { b.disabled = true; });
    try {
      estado = await api('/mi/marcar', { metodo: 'POST', cuerpo: { tipo: boton.dataset.marcar } });
      desfase = Date.parse(estado.hora_servidor) - Date.now();
      avisar($('#miAviso'), `${NOMBRE_MARCA[boton.dataset.marcar]} registrada a las ${horaLima(new Date(Date.now() + desfase).toISOString())}.`);
      dibujarHoy();
      await cargarHistorial();
    } catch (err) {
      avisar($('#miAviso'), err.message, 'error');
      try { estado = await api('/mi/hoy'); } catch { /* se queda con lo que había */ }
      dibujarHoy();
    }
  });

  // ---- historial ----
  async function cargarHistorial() {
    try {
      const h = await api(`/mi/historial?desde=${historial.desde}&hasta=${historial.hasta}`);
      const r = h.resumen;
      $('#miResumen').innerHTML = r ? `<div class="rrhh-datos" style="margin-bottom:12px;">
        <div class="rrhh-dato"><b>${r.dias}</b><span>día(s) con registro</span></div>
        <div class="rrhh-dato"><b>${duracion(r.minutos_trabajados)}</b><span>trabajadas</span></div>
        <div class="rrhh-dato"><b>${duracion(r.minutos_sobretiempo)}</b><span>de sobretiempo</span></div>
        <div class="rrhh-dato"><b>${r.tardanzas}</b><span>tardanza(s)</span></div></div>` : '';
      $('#miHistorial').innerHTML = tabla([
        { titulo: 'Fecha', celda: f => fechaCorta(f.fecha) },
        { titulo: 'Entrada', celda: f => horaLima(f.entrada) },
        { titulo: 'Refrigerio', celda: f => (f.salida_refrigerio ? `${horaLima(f.salida_refrigerio)} – ${horaLima(f.retorno_refrigerio)}` : '—') },
        { titulo: 'Salida', celda: f => (f.salida ? horaLima(f.salida) : '<span class="rrhh-alerta-texto">Falta</span>') },
        { titulo: 'Trabajado', clase: 'num', celda: f => duracion(f.minutos_trabajados) },
        { titulo: 'Sobretiempo', clase: 'num', celda: f => duracion(f.minutos_sobretiempo) },
        { titulo: 'Tardanza', clase: 'num', celda: f => (f.minutos_tardanza ? `${f.minutos_tardanza} min` : '—') },
        { titulo: '', celda: f => (f.origen === 'manual' ? `${badge('Corregido por RRHH', 'purple')}${f.observacion ? `<span class="rrhh-sub">${esc(f.observacion)}</span>` : ''}` : '') }
      ], h.filas, { vacio: 'No tienes asistencia registrada en este rango.' });
    } catch (err) {
      $('#miHistorial').innerHTML = `<p class="form-status error">${esc(err.message)}</p>`;
    }
  }
  $('#miDesde').addEventListener('change', (e) => { if (e.target.value) { historial.desde = e.target.value; cargarHistorial(); } });
  $('#miHasta').addEventListener('change', (e) => { if (e.target.value) { historial.hasta = e.target.value; cargarHistorial(); } });

  // ---- vacaciones y ausencias ----
  async function cargarAusencias() {
    try {
      const [saldo, lista] = await Promise.all([api('/mi/saldo-vacaciones'), api('/mi/ausencias')]);
      ausencias = lista;
      $('#miSaldo').innerHTML = `<div class="rrhh-datos">
        <div class="rrhh-dato"><b>${saldo.saldo}</b><span>días de saldo estimado</span></div>
        <div class="rrhh-dato"><b>${saldo.dias_tomados}</b><span>tomados</span></div>
        <div class="rrhh-dato"><b>${saldo.dias_pendientes_aprobacion}</b><span>en solicitudes pendientes</span></div></div>
        <p class="campo-ayuda" style="margin:8px 0 0;">${esc(saldo.referencial)}</p>`;
      $('#miAusencias').innerHTML = tabla([
        { titulo: 'Tipo', celda: a => esc(ETIQUETA_AUSENCIA[a.tipo] || a.tipo) },
        { titulo: 'Fechas', celda: a => `${fechaCorta(a.fecha_inicio)} al ${fechaCorta(a.fecha_fin)}<span class="rrhh-sub">${a.dias} día(s)</span>` },
        { titulo: 'Estado', celda: a => { const [t, c] = ETIQUETA_ESTADO_AUSENCIA[a.estado] || [a.estado, 'muted']; return `${badge(t, c)}${a.comentario_resolucion ? `<span class="rrhh-sub">${esc(a.comentario_resolucion)}</span>` : ''}`; } },
        { titulo: '', clase: 'acc', celda: a => (a.estado === 'pendiente' ? botonesFila(a.id, [{ accion: 'retirar', texto: 'Retirar', peligro: true }]) : '') }
      ], ausencias.slice(0, 15), { vacio: 'Todavía no has pedido ausencias.' });
    } catch (err) {
      $('#miSaldo').innerHTML = `<p class="form-status error">${esc(err.message)}</p>`;
    }
  }

  $('#miSolicitar').addEventListener('click', () => {
    modal({
      titulo: 'Solicitar ausencia', icono: '🏖️', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<p class="rrhh-legal">Tu solicitud le llega a RRHH y queda pendiente hasta que la aprueben. No escribas diagnósticos en el motivo.</p><div id="soForm"></div>';
        montarFormulario(cuerpo.querySelector('#soForm'), {
          campos: [
            { id: 'tipo', label: 'Tipo', tipo: 'select', requerido: true, valor: 'vacaciones', ancho: 2,
              opciones: Object.entries(ETIQUETA_AUSENCIA).map(([value, label]) => ({ value, label })) },
            { id: 'fecha_inicio', label: 'Desde', tipo: 'date', requerido: true, valor: hoyLima() },
            { id: 'fecha_fin', label: 'Hasta', tipo: 'date', requerido: true, valor: hoyLima() },
            { id: 'motivo', label: 'Motivo', ancho: 4, maxlength: 250, valor: '' }
          ],
          textoGuardar: 'Enviar solicitud', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            const r = await api('/mi/ausencias', { metodo: 'POST', cuerpo: v });
            cerrarPanelLateral();
            avisar($('#miAviso'), r.aviso ? `Solicitud enviada. ${r.aviso}` : 'Solicitud enviada. RRHH la revisará.');
            await cargarAusencias();
          }
        });
      }
    });
  });
  alHacerClic(cont, {
    retirar: async (id) => {
      if (!confirm('¿Retirar esta solicitud?')) return;
      try { await api(`/mi/ausencias/${id}`, { metodo: 'DELETE' }); avisar($('#miAviso'), 'Solicitud retirada.'); await cargarAusencias(); }
      catch (err) { avisar($('#miAviso'), err.message, 'error'); }
    }
  });

  dibujarHoy();
  await Promise.all([cargarHistorial(), cargarAusencias()]);
}
