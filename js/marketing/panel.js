// js/marketing/panel.js
// Marketing v1 (paso 9, pages/marketing.html). La cadena que se mide:
//   Campaña -> Clientes objetivo -> Venta -> Resultado
// La lista de campañas muestra el resultado de cada una; al abrir una se ve su
// embudo, la lista de clientes con su avance y las ventas que se le atribuyeron
// (la venta se atribuye eligiendo la campaña al registrarla en Ventas).
// GEALMI no envía nada: "WhatsApp" abre la conversación con el mensaje listo y
// la persona lo manda por su cuenta.
//
// Reutiliza el kit de pantallas propias que nació en RRHH (js/rrhh/comun.js).

import {
  api as apiBase, esc, puede, modal, cerrarPanelLateral, montarFormulario, fechaCorta, soles, badge, tabla,
  botonesFila, alHacerClic, avisar
} from '../rrhh/comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum, formatearTelefonoWhatsapp } from '../utils.js';

const api = (ruta, opciones = {}) => apiBase(ruta, { ...opciones, base: 'marketing' });

const CANALES = [
  { value: 'whatsapp', label: 'WhatsApp' }, { value: 'correo', label: 'Correo' }, { value: 'redes', label: 'Redes sociales' },
  { value: 'presencial', label: 'Presencial' }, { value: 'llamada', label: 'Llamada' }, { value: 'otro', label: 'Otro' }
];
const ETIQUETA_CANAL = Object.fromEntries(CANALES.map(c => [c.value, c.label]));
const ESTADOS = [
  { value: 'borrador', label: 'Borrador' }, { value: 'activa', label: 'Activa' }, { value: 'pausada', label: 'Pausada' }, { value: 'finalizada', label: 'Finalizada' }
];
const BADGE_ESTADO = { borrador: ['Borrador', 'muted'], activa: ['Activa', 'teal'], pausada: ['Pausada', 'purple'], finalizada: ['Finalizada', 'blue'] };
const ESTADOS_CLIENTE = [
  { value: 'objetivo', label: 'Por contactar' }, { value: 'contactado', label: 'Contactado' }, { value: 'respondio', label: 'Respondió' },
  { value: 'convirtio', label: 'Convirtió' }, { value: 'descartado', label: 'Descartado' }
];
const ACCIONES_ESTADO = {
  borrador: [['activa', 'Activar']], activa: [['pausada', 'Pausar'], ['finalizada', 'Finalizar']],
  pausada: [['activa', 'Reanudar'], ['finalizada', 'Finalizar']], finalizada: [['activa', 'Reabrir']]
};
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 1000) / 10} %`);
const veces = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(1)}×`);

export async function montar(cont) {
  cont.innerHTML = '<div id="mkAviso"></div><div id="mkVista"></div>';
  const $ = (id) => cont.querySelector(id);
  const vista = $('#mkVista');
  let campanas = [];
  let detalle = null;

  // ---------------------------------------------------------------------------
  // Lista de campañas
  // ---------------------------------------------------------------------------
  async function mostrarLista() {
    detalle = null;
    vista.replaceChildren();
    const zona = document.createElement('div');
    vista.appendChild(zona);
    zona.innerHTML = '<p class="rrhh-vacio">Cargando…</p>';
    try { campanas = await api('/campanas'); }
    catch (err) { zona.innerHTML = `<p class="rrhh-vacio">${esc(err.message)}</p>`; return; }

    const suma = (campo) => campanas.reduce((s, c) => s + c[campo], 0);
    const objetivo = suma('objetivo'), conversiones = suma('conversiones'), ingresos = suma('ingresos'), presupuesto = suma('presupuesto');
    zona.innerHTML = `
      <div class="rrhh-cabecera">
        <div>
          <h2>Campañas</h2>
          <p>Una campaña es un esfuerzo puntual para vender más: eliges a quién contactar, llevas el avance de cada contacto y, al registrar ventas, las atribuyes a la campaña para saber cuánto dejó.</p>
        </div>
        <div class="rrhh-filtros">${puede('marketing.crear') ? '<button type="button" class="btn btn-ochre" id="mkNueva">+ Nueva campaña</button>' : ''}</div>
      </div>
      <div class="kpis rrhh-kpis">
        ${kpiCard({ acento: 'teal', icono: '📣', label: 'Campañas activas', value: fmtNum(campanas.filter(c => c.estado === 'activa').length), sub: `${fmtNum(campanas.length)} en total` })}
        ${kpiCard({ acento: 'blue', icono: '🎯', label: 'Clientes objetivo', value: fmtNum(objetivo), sub: `${fmtNum(suma('contactados'))} contactados` })}
        ${kpiCard({ acento: 'purple', icono: '🤝', label: 'Conversiones', value: fmtNum(conversiones), sub: objetivo ? `${pct(conversiones / objetivo)} de los objetivo` : 'sin clientes objetivo' })}
        ${kpiCard({ acento: 'orange', icono: '🧾', label: 'Ventas generadas', value: fmtNum(suma('ventas_generadas')), sub: 'atribuidas a campañas' })}
        ${kpiCard({ acento: 'teal', icono: '💰', label: 'Ingresos', value: soles(ingresos), sub: presupuesto > 0 ? `${veces(ingresos / presupuesto)} el presupuesto (${soles(presupuesto)})` : 'sin presupuesto cargado' })}
      </div>
      <div class="rrhh-panel" id="mkTabla"></div>`;

    const puedeEditar = puede('marketing.editar'), puedeBorrar = puede('marketing.eliminar');
    zona.querySelector('#mkTabla').innerHTML = tabla([
      { titulo: 'Campaña', celda: c => `<b>${esc(c.nombre)}</b><span class="rrhh-sub">${esc(ETIQUETA_CANAL[c.canal])}${c.fecha_inicio ? ` · ${fechaCorta(c.fecha_inicio)}${c.fecha_fin ? ` al ${fechaCorta(c.fecha_fin)}` : ''}` : ''}</span>` },
      { titulo: 'Estado', celda: c => badge(...BADGE_ESTADO[c.estado]) },
      { titulo: 'Objetivo', clase: 'num', celda: c => c.objetivo },
      { titulo: 'Contactados', clase: 'num', celda: c => c.contactados },
      { titulo: 'Respondieron', clase: 'num', celda: c => c.respuestas },
      { titulo: 'Convirtieron', clase: 'num', celda: c => c.conversiones },
      { titulo: 'Ventas', clase: 'num', celda: c => c.ventas_generadas },
      { titulo: 'Ingresos', clase: 'num', celda: c => soles(c.ingresos) },
      { titulo: 'Presupuesto', clase: 'num', celda: c => (c.presupuesto ? soles(c.presupuesto) : '—') },
      { titulo: 'Retorno', clase: 'num', celda: c => veces(c.retorno) },
      { titulo: '', clase: 'acc', celda: c => botonesFila(c.id, [
        { accion: 'abrir', texto: 'Abrir' }, ...(puedeEditar ? [{ accion: 'editar', texto: 'Editar' }] : []),
        ...(puedeBorrar ? [{ accion: 'borrar', texto: 'Eliminar', peligro: true }] : [])]) }
    ], campanas, { vacio: 'Todavía no hay campañas. Crea la primera con "+ Nueva campaña".' });

    zona.querySelector('#mkNueva')?.addEventListener('click', () => formularioCampana(null));
    alHacerClic(zona, {
      abrir: (id) => mostrarDetalle(Number(id)),
      editar: (id) => formularioCampana(campanas.find(c => c.id === Number(id))),
      borrar: async (id) => {
        const c = campanas.find(x => x.id === Number(id));
        if (!confirm(`¿Eliminar la campaña "${c.nombre}"? Se borra también su lista de clientes.`)) return;
        try { await api(`/campanas/${id}`, { metodo: 'DELETE' }); avisar($('#mkAviso'), 'Campaña eliminada.'); await mostrarLista(); }
        catch (err) { avisar($('#mkAviso'), err.message, 'error'); }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Formulario de campaña
  // ---------------------------------------------------------------------------
  function formularioCampana(c = null) {
    modal({
      titulo: c ? 'Editar campaña' : 'Nueva campaña', icono: '📣', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="cmForm"></div>';
        montarFormulario(cuerpo.querySelector('#cmForm'), {
          campos: [
            { id: 'nombre', label: 'Nombre de la campaña', requerido: true, valor: c?.nombre ?? '', ancho: 4, maxlength: 150, placeholder: 'Reactivación de inactivos, Día de la Madre…' },
            { id: 'canal', label: 'Canal', tipo: 'select', opciones: CANALES, valor: c?.canal ?? 'whatsapp' },
            { id: 'estado', label: 'Estado', tipo: 'select', opciones: ESTADOS, valor: c?.estado ?? 'borrador', ayuda: 'Solo las activas se ofrecen al registrar una venta' },
            { id: 'presupuesto', label: 'Presupuesto (S/)', tipo: 'number', min: 0, step: '0.01', valor: c?.presupuesto ?? 0, ayuda: 'Lo que piensas invertir: sirve para medir el retorno' },
            { id: 'fecha_inicio', label: 'Empieza', tipo: 'date', valor: c?.fecha_inicio ?? '' },
            { id: 'fecha_fin', label: 'Termina', tipo: 'date', valor: c?.fecha_fin ?? '' },
            { id: 'descripcion', label: 'Descripción', tipo: 'textarea', valor: c?.descripcion ?? '', ancho: 4, filas: 2 },
            { id: 'mensaje', label: 'Mensaje para los clientes', tipo: 'textarea', valor: c?.mensaje ?? '', ancho: 4, filas: 3, maxlength: 1000,
              ayuda: 'Usa {nombre} para poner el nombre del cliente. Con el canal WhatsApp, el botón de cada cliente abre la conversación con este texto.' }
          ],
          textoGuardar: c ? 'Guardar cambios' : 'Crear campaña', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            if (c) await api(`/campanas/${c.id}`, { metodo: 'PUT', cuerpo: v });
            else { const r = await api('/campanas', { metodo: 'POST', cuerpo: v }); c = { id: r.id, nuevo: true }; }
            cerrarPanelLateral();
            avisar($('#mkAviso'), c.nuevo ? 'Campaña creada. Ahora agrega a quién contactar.' : 'Campaña guardada.');
            if (detalle && detalle.id === c.id) await mostrarDetalle(c.id);
            else if (c.nuevo) await mostrarDetalle(c.id);
            else await mostrarLista();
          }
        });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Detalle de una campaña
  // ---------------------------------------------------------------------------
  async function mostrarDetalle(id) {
    let d;
    try { d = await api(`/campanas/${id}`); }
    catch (err) { avisar($('#mkAviso'), err.message, 'error'); return; }
    detalle = d;
    const filtro = { estado: '', texto: '' };
    const seleccion = new Set();

    vista.replaceChildren();
    const zona = document.createElement('div');
    vista.appendChild(zona);
    const puedeEditar = puede('marketing.editar');

    zona.innerHTML = `
      <button type="button" class="mk-volver" id="mkVolver">← Todas las campañas</button>
      <div class="rrhh-cabecera">
        <div>
          <div class="mk-titulo"><h2>${esc(d.nombre)}</h2>${badge(...BADGE_ESTADO[d.estado])}</div>
          <div class="mk-meta">
            <span>Canal: ${esc(ETIQUETA_CANAL[d.canal])}</span>
            ${d.fecha_inicio ? `<span>${fechaCorta(d.fecha_inicio)}${d.fecha_fin ? ` al ${fechaCorta(d.fecha_fin)}` : ''}</span>` : ''}
            <span>Presupuesto: ${d.presupuesto ? soles(d.presupuesto) : 'sin definir'}</span>
          </div>
          ${d.descripcion ? `<p>${esc(d.descripcion)}</p>` : ''}
        </div>
        <div class="rrhh-filtros">
          ${puedeEditar ? ACCIONES_ESTADO[d.estado].map(([estado, texto]) => `<button type="button" class="btn btn-ghost" data-accion="estado" data-id="${estado}">${texto}</button>`).join('') : ''}
          ${puedeEditar ? '<button type="button" class="btn btn-ghost" data-accion="editarCampana" data-id="0">Editar</button>' : ''}
        </div>
      </div>
      <div class="rrhh-panel">
        <h3>Resultados</h3>
        <div class="mk-embudo">
          <div class="mk-paso"><b>${d.objetivo}</b><span>clientes objetivo</span></div>
          <div class="mk-paso"><b>${d.contactados}</b><span>contactados</span>${d.objetivo ? `<small>${pct(d.contactados / d.objetivo)} del objetivo</small>` : ''}</div>
          <div class="mk-paso"><b>${d.respuestas}</b><span>respondieron</span>${d.contactados ? `<small>${pct(d.respuestas / d.contactados)} de los contactados</small>` : ''}</div>
          <div class="mk-paso"><b>${d.conversiones}</b><span>convirtieron</span>${d.tasa_conversion !== null ? `<small>${pct(d.tasa_conversion)} del objetivo</small>` : ''}</div>
        </div>
        <div class="mk-resultados">
          <div class="rrhh-dato"><b>${d.ventas_generadas}</b><span>ventas atribuidas</span></div>
          <div class="rrhh-dato"><b>${soles(d.ingresos)}</b><span>ingresos generados</span></div>
          <div class="rrhh-dato"><b>${veces(d.retorno)}</b><span>retorno (ingresos ÷ presupuesto)</span></div>
          <div class="rrhh-dato"><b>${d.costo_por_conversion === null ? '—' : soles(d.costo_por_conversion)}</b><span>costo por conversión</span></div>
        </div>
      </div>
      ${d.mensaje ? `<div class="rrhh-panel"><h3>Mensaje <button type="button" class="rrhh-btn-mini" data-accion="copiarMensaje" data-id="0" style="margin-left:8px;">Copiar</button></h3><div class="mk-mensaje">${esc(d.mensaje)}</div></div>` : ''}
      <div class="rrhh-panel">
        <h3>Clientes objetivo <span class="tag">${d.clientes.length}</span></h3>
        <div class="mk-herramientas">
          ${puedeEditar ? '<button type="button" class="btn btn-ochre" data-accion="porCriterios" data-id="0">+ Agregar por criterios</button>' : ''}
          ${puedeEditar && puede('clientes.ver') ? '<button type="button" class="btn btn-ghost" data-accion="aMano" data-id="0">+ Elegir clientes</button>' : ''}
          <select id="mkFiltroEstado" aria-label="Filtrar por estado"><option value="">Todos los estados</option>${ESTADOS_CLIENTE.map(e => `<option value="${e.value}">${e.label}</option>`).join('')}</select>
          <input type="search" id="mkFiltroTexto" placeholder="Buscar cliente…" aria-label="Buscar cliente">
        </div>
        <div class="mk-masiva" id="mkMasiva" hidden>
          <b id="mkMasivaN"></b>
          <select class="mk-estado-select" id="mkMasivaEstado" aria-label="Nuevo estado">${ESTADOS_CLIENTE.map(e => `<option value="${e.value}">${e.label}</option>`).join('')}</select>
          <button type="button" class="btn btn-ochre" style="padding:6px 14px;font-size:13px;" data-accion="aplicarMasivo" data-id="0">Aplicar a los seleccionados</button>
          <button type="button" class="rrhh-btn-mini" data-accion="limpiarSeleccion" data-id="0">Quitar selección</button>
        </div>
        <div id="mkClientes"></div>
      </div>
      <div class="rrhh-panel">
        <h3>Ventas atribuidas <span class="tag">${d.ventas.length}</span></h3>
        <div id="mkVentas"></div>
        <p class="campo-ayuda" style="margin-top:8px;">Para atribuir una venta a esta campaña, elígela en el campo "Campaña" al registrar la venta (solo aparecen las campañas activas).</p>
      </div>`;

    zona.querySelector('#mkVentas').innerHTML = tabla([
      { titulo: 'Fecha', celda: v => fechaCorta(v.fecha) }, { titulo: 'Cliente', celda: v => esc(v.cliente || '—') },
      { titulo: 'Producto', celda: v => esc(v.producto) }, { titulo: 'Monto', clase: 'num', celda: v => soles(v.monto) }
    ], d.ventas, { vacio: 'Todavía no hay ventas atribuidas a esta campaña.' });

    const visibles = () => d.clientes.filter(c =>
      (!filtro.estado || c.estado === filtro.estado) &&
      (!filtro.texto || `${c.nombre} ${c.email || ''} ${c.telefono || ''} ${c.etiqueta || ''}`.toLowerCase().includes(filtro.texto)));

    function dibujarClientes() {
      const lista = visibles();
      zona.querySelector('#mkClientes').innerHTML = tabla([
        ...(puedeEditar ? [{ titulo: '', celda: c => `<input type="checkbox" data-sel="${c.cliente_id}" aria-label="Seleccionar a ${esc(c.nombre)}"${seleccion.has(c.cliente_id) ? ' checked' : ''}>` }] : []),
        { titulo: 'Cliente', celda: c => `<b>${esc(c.nombre)}</b><span class="rrhh-sub">${[c.telefono, c.email].filter(Boolean).map(esc).join(' · ') || 'Sin datos de contacto'}</span>` },
        { titulo: 'Etiqueta', celda: c => esc(c.etiqueta || '—') },
        { titulo: 'Compras', clase: 'num', celda: c => soles(c.compras_totales) },
        { titulo: 'Estado', celda: c => (puedeEditar
          ? `<select class="mk-estado-select" data-estado-cliente="${c.cliente_id}" aria-label="Estado de ${esc(c.nombre)}">${ESTADOS_CLIENTE.map(e => `<option value="${e.value}"${e.value === c.estado ? ' selected' : ''}>${e.label}</option>`).join('')}</select>`
          : esc(ESTADOS_CLIENTE.find(e => e.value === c.estado)?.label || c.estado)) },
        { titulo: '', clase: 'acc', celda: c => {
          const numero = formatearTelefonoWhatsapp(c.telefono);
          const primerNombre = String(c.nombre).split(' ')[0];
          const texto = encodeURIComponent((d.mensaje || '').replaceAll('{nombre}', primerNombre));
          return `<span class="rrhh-acciones">${numero
            ? `<a class="rrhh-btn-mini confirmar" href="https://wa.me/${numero}${texto ? `?text=${texto}` : ''}" target="_blank" rel="noopener noreferrer" data-wa="${c.cliente_id}" title="Abre WhatsApp con el mensaje listo; tú lo envías">WhatsApp</a>`
            : '<button type="button" class="rrhh-btn-mini" disabled title="Este cliente no tiene teléfono registrado">WhatsApp</button>'}${puedeEditar ? ` <button type="button" class="rrhh-btn-mini peligro" data-accion="quitar" data-id="${c.cliente_id}">Quitar</button>` : ''}</span>`;
        } }
      ], lista, { vacio: d.clientes.length ? 'Ningún cliente coincide con el filtro.' : 'Todavía no agregaste clientes. Usa "+ Agregar por criterios" para armar la lista.' });
      const n = seleccion.size;
      zona.querySelector('#mkMasiva').hidden = n === 0;
      zona.querySelector('#mkMasivaN').textContent = `${n} seleccionado(s)`;
    }
    dibujarClientes();

    // ---- eventos ----
    zona.querySelector('#mkVolver').addEventListener('click', mostrarLista);
    zona.querySelector('#mkFiltroEstado').addEventListener('change', (e) => { filtro.estado = e.target.value; dibujarClientes(); });
    zona.querySelector('#mkFiltroTexto').addEventListener('input', (e) => { filtro.texto = e.target.value.trim().toLowerCase(); dibujarClientes(); });

    zona.addEventListener('change', async (e) => {
      const sel = e.target.closest('[data-sel]');
      if (sel) {
        const id = Number(sel.dataset.sel);
        if (sel.checked) seleccion.add(id); else seleccion.delete(id);
        zona.querySelector('#mkMasiva').hidden = seleccion.size === 0;
        zona.querySelector('#mkMasivaN').textContent = `${seleccion.size} seleccionado(s)`;
        return;
      }
      const est = e.target.closest('[data-estado-cliente]');
      if (est) await cambiarEstado([Number(est.dataset.estadoCliente)], est.value);
    });
    // Abrir WhatsApp cuenta como "contactado": se anota solo, pero el envío lo hace la persona.
    zona.addEventListener('click', (e) => {
      const wa = e.target.closest('[data-wa]');
      if (!wa || !puedeEditar) return;
      const c = d.clientes.find(x => x.cliente_id === Number(wa.dataset.wa));
      if (c && c.estado === 'objetivo') setTimeout(() => cambiarEstado([c.cliente_id], 'contactado'), 400);
    });

    async function cambiarEstado(ids, estado) {
      try {
        await api(`/campanas/${d.id}/clientes`, { metodo: 'PUT', cuerpo: { cliente_ids: ids, estado } });
        seleccion.clear();
        await mostrarDetalle(d.id);
      } catch (err) { avisar($('#mkAviso'), err.message, 'error'); }
    }

    alHacerClic(zona, {
      estado: async (nuevo) => {
        try { await api(`/campanas/${d.id}/estado`, { metodo: 'PUT', cuerpo: { estado: nuevo } }); avisar($('#mkAviso'), `Campaña ${BADGE_ESTADO[nuevo][0].toLowerCase()}.`); await mostrarDetalle(d.id); }
        catch (err) { avisar($('#mkAviso'), err.message, 'error'); }
      },
      editarCampana: () => formularioCampana(d),
      copiarMensaje: async (_, boton) => {
        try { await navigator.clipboard.writeText(d.mensaje); boton.textContent = '¡Copiado!'; setTimeout(() => { boton.textContent = 'Copiar'; }, 1500); }
        catch { avisar($('#mkAviso'), 'No se pudo copiar: selecciona el texto y cópialo a mano.', 'info'); }
      },
      porCriterios: () => formularioCriterios(d),
      aMano: () => formularioManual(d),
      aplicarMasivo: () => cambiarEstado([...seleccion], zona.querySelector('#mkMasivaEstado').value),
      limpiarSeleccion: () => { seleccion.clear(); dibujarClientes(); },
      quitar: async (clienteId) => {
        const c = d.clientes.find(x => x.cliente_id === Number(clienteId));
        if (!confirm(`¿Quitar a ${c.nombre} de la campaña?`)) return;
        try { await api(`/campanas/${d.id}/clientes/${clienteId}`, { metodo: 'DELETE' }); await mostrarDetalle(d.id); }
        catch (err) { avisar($('#mkAviso'), err.message, 'error'); }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Agregar clientes: por criterios (segmentación) o a mano
  // ---------------------------------------------------------------------------
  function formularioCriterios(d) {
    modal({
      titulo: 'Agregar clientes por criterios', icono: '🎯', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<p class="rrhh-legal" style="margin-bottom:12px;">Los criterios se combinan (deben cumplirse todos). Sin ningún criterio se agregan todos tus clientes. Los que ya estaban en la campaña no se duplican.</p><div id="crForm"></div>';
        let vistaPrevia = null;
        const form = montarFormulario(cuerpo.querySelector('#crForm'), {
          campos: [
            { id: 'inactivos_dias', label: 'Sin comprar hace (días)', tipo: 'number', min: 1, max: 3650, step: '1', ayuda: 'Incluye a quienes nunca compraron' },
            { id: 'compras_min', label: 'Al menos (compras)', tipo: 'number', min: 1, step: '1' },
            { id: 'gasto_min', label: 'Gasto total desde (S/)', tipo: 'number', min: 0, step: '0.01' },
            { id: 'con_telefono', label: 'Solo con teléfono', tipo: 'checkbox', valor: false },
            { id: 'con_email', label: 'Solo con correo', tipo: 'checkbox', valor: false },
            { id: 'etiqueta', label: 'Etiqueta (opcional)', maxlength: 40, ancho: 2, placeholder: 'Por defecto describe los criterios' }
          ],
          extra: '<div class="campo campo-ancho-4"><button type="button" class="btn btn-ghost" data-previa>Ver a quiénes alcanza</button><div class="mk-previa" data-previa-zona hidden></div></div>',
          textoGuardar: 'Agregar a la campaña', alCancelar: cerrarPanelLateral,
          alGuardar: async (v) => {
            const r = await api(`/campanas/${d.id}/clientes/segmento`, { metodo: 'POST', cuerpo: criterios(v) });
            cerrarPanelLateral();
            avisar($('#mkAviso'), `${r.agregados} cliente(s) agregado(s)${r.ya_estaban ? ` (${r.ya_estaban} ya estaban)` : ''} con la etiqueta "${r.etiqueta}".`);
            await mostrarDetalle(d.id);
          }
        });
        const criterios = (v) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== '' && x !== false));
        const zonaPrevia = form.querySelector('[data-previa-zona]');
        form.querySelector('[data-previa]').addEventListener('click', async () => {
          zonaPrevia.hidden = false;
          zonaPrevia.textContent = 'Calculando…';
          try {
            const valores = Object.fromEntries([...form.elements].filter(e => e.name).map(e => [e.name, e.type === 'checkbox' ? e.checked : e.value]));
            vistaPrevia = await api('/segmento/vista-previa', { metodo: 'POST', cuerpo: criterios(valores) });
            zonaPrevia.innerHTML = vistaPrevia.total
              ? `Alcanza a <b>${vistaPrevia.total}</b> cliente(s)${vistaPrevia.supera_el_limite ? ` (máximo ${vistaPrevia.limite}: acota el segmento)` : ''}. Por ejemplo: ${vistaPrevia.muestra.map(m => esc(m.nombre)).join(', ')}${vistaPrevia.total > vistaPrevia.muestra.length ? '…' : '.'}`
              : 'Ningún cliente cumple esos criterios.';
          } catch (err) { zonaPrevia.textContent = err.message; }
        });
      }
    });
  }

  async function formularioManual(d) {
    let clientes;
    try { clientes = await apiBase('', { base: 'clientes' }); }
    catch (err) { avisar($('#mkAviso'), err.message, 'error'); return; }
    const yaEstan = new Set(d.clientes.map(c => c.cliente_id));
    modal({
      titulo: 'Elegir clientes', icono: '👥', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = `
          <div class="mk-herramientas"><input type="search" id="mnBuscar" placeholder="Buscar por nombre, correo o teléfono…" style="flex:1;min-width:200px;" aria-label="Buscar cliente"></div>
          <div class="mk-lista-clientes" id="mnLista"></div>
          <div class="mk-herramientas" style="margin-top:12px;">
            <button type="button" class="btn btn-ochre" id="mnAgregar" disabled>Agregar seleccionados</button>
            <button type="button" class="btn btn-ghost" id="mnCancelar">Cancelar</button>
            <span class="form-status" id="mnEstado"></span>
          </div>`;
        const elegidos = new Set();
        const lista = cuerpo.querySelector('#mnLista');
        const dibujar = () => {
          const t = cuerpo.querySelector('#mnBuscar').value.trim().toLowerCase();
          const filtrados = clientes.filter(c => !t || `${c.nombre} ${c.email || ''} ${c.telefono || ''}`.toLowerCase().includes(t)).slice(0, 200);
          lista.innerHTML = filtrados.length ? filtrados.map(c => {
            const ya = yaEstan.has(c.id);
            return `<label class="${ya ? 'ya' : ''}"><input type="checkbox" data-cliente="${c.id}"${ya ? ' disabled checked' : elegidos.has(c.id) ? ' checked' : ''}>
              <span><b>${esc(c.nombre)}</b> <span class="rrhh-sub" style="display:inline;">${[c.telefono, c.email].filter(Boolean).map(esc).join(' · ')}${ya ? ' · ya está en la campaña' : ''}</span></span></label>`;
          }).join('') : '<p class="tabla-vacia" style="padding:0 12px;">No hay clientes que coincidan.</p>';
          const boton = cuerpo.querySelector('#mnAgregar');
          boton.disabled = !elegidos.size;
          boton.textContent = elegidos.size ? `Agregar ${elegidos.size} seleccionado(s)` : 'Agregar seleccionados';
        };
        dibujar();
        cuerpo.querySelector('#mnBuscar').addEventListener('input', dibujar);
        lista.addEventListener('change', (e) => {
          const chk = e.target.closest('[data-cliente]');
          if (!chk) return;
          const id = Number(chk.dataset.cliente);
          if (chk.checked) elegidos.add(id); else elegidos.delete(id);
          const boton = cuerpo.querySelector('#mnAgregar');
          boton.disabled = !elegidos.size;
          boton.textContent = elegidos.size ? `Agregar ${elegidos.size} seleccionado(s)` : 'Agregar seleccionados';
        });
        cuerpo.querySelector('#mnCancelar').addEventListener('click', cerrarPanelLateral);
        cuerpo.querySelector('#mnAgregar').addEventListener('click', async () => {
          const estado = cuerpo.querySelector('#mnEstado');
          estado.textContent = 'Agregando…';
          try {
            const r = await api(`/campanas/${d.id}/clientes`, { metodo: 'POST', cuerpo: { cliente_ids: [...elegidos] } });
            cerrarPanelLateral();
            avisar($('#mkAviso'), `${r.agregados} cliente(s) agregado(s).`);
            await mostrarDetalle(d.id);
          } catch (err) { estado.textContent = err.message; estado.classList.add('error'); }
        });
      }
    });
  }

  await mostrarLista();
}
