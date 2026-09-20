// js/rrhh/reclutamiento.js
// Pestaña "Reclutamiento" (fase R7): vacantes y un tablero de candidatos por
// etapa (postulado → entrevista → prueba → oferta → contratado / descartado).
// "Contratar" crea la ficha del trabajador con los datos del candidato; si con
// eso se cubren las plazas, la vacante se cierra sola.

import {
  api, esc, puede, modal, cerrarPanelLateral, montarFormulario, invalidarEmpleados, fechaCorta, hoyLima, soles,
  badge, tabla, botonesFila, alHacerClic, avisar
} from './comun.js';
import { kpiCard } from '../kpiCard.js';
import { fmtNum } from '../utils.js';

const ETAPAS = [
  ['postulado', 'Postulados'], ['entrevista', 'Entrevista'], ['prueba', 'Prueba'],
  ['oferta', 'Oferta'], ['contratado', 'Contratados'], ['descartado', 'Descartados']
];
const ESTADO_VACANTE = { abierta: ['Abierta', 'teal'], pausada: ['Pausada', 'purple'], cerrada: ['Cerrada', 'muted'] };
const REGIMENES = [
  { value: 'general', label: 'Régimen general' }, { value: 'mype_pequena', label: 'Pequeña empresa (MYPE)' },
  { value: 'mype_micro', label: 'Microempresa (MYPE)' }, { value: 'otro', label: 'Otro' }
];

export async function montar(zona) {
  let vacantes = [], candidatos = [];
  let seleccionada = null;

  zona.innerHTML = `
    <div class="rrhh-cabecera">
      <div><h2>Reclutamiento</h2><p>Publica la vacante, registra a quienes postulan y muévelos por las etapas. Al contratar, se crea su ficha de trabajador.</p></div>
      <div class="rrhh-filtros">${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="rcNuevaVacante">+ Nueva vacante</button>' : ''}</div>
    </div>
    <div id="rcAviso"></div>
    <div class="kpis rrhh-kpis" id="rcKpis"></div>
    <div class="rrhh-panel" id="rcVacantes"></div>
    <div id="rcTablero"></div>`;
  const $ = (id) => zona.querySelector(id);

  async function cargarVacantes() {
    try { vacantes = await api('/vacantes'); }
    catch (err) { avisar($('#rcAviso'), err.message, 'error'); return; }
    if (!vacantes.some(v => v.id === seleccionada)) seleccionada = (vacantes.find(v => v.estado === 'abierta') || vacantes[0])?.id ?? null;
    dibujarVacantes();
    await cargarCandidatos();
  }

  async function cargarCandidatos() {
    if (!seleccionada) { candidatos = []; dibujarTablero(); return; }
    try { candidatos = await api(`/candidatos?vacante_id=${seleccionada}`); }
    catch (err) { avisar($('#rcAviso'), err.message, 'error'); return; }
    dibujarTablero();
  }

  function dibujarVacantes() {
    const abiertas = vacantes.filter(v => v.estado === 'abierta');
    $('#rcKpis').innerHTML = [
      kpiCard({ acento: 'teal', icono: '📢', label: 'Vacantes abiertas', value: fmtNum(abiertas.length), sub: `${fmtNum(abiertas.reduce((s, v) => s + Math.max(0, v.cantidad - v.contratados), 0))} plaza(s) por cubrir` }),
      kpiCard({ acento: 'blue', icono: '👤', label: 'Candidatos', value: fmtNum(vacantes.reduce((s, v) => s + v.candidatos, 0)), sub: `${fmtNum(vacantes.reduce((s, v) => s + v.en_proceso, 0))} en proceso` }),
      kpiCard({ acento: 'purple', icono: '🤝', label: 'Contratados', value: fmtNum(vacantes.reduce((s, v) => s + v.contratados, 0)), sub: 'desde el reclutamiento' })
    ].join('');
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar');
    $('#rcVacantes').innerHTML = `<h3>Vacantes</h3>${tabla([
      { titulo: 'Vacante', celda: v => `<b>${esc(v.titulo)}</b>${v.departamento ? `<span class="rrhh-sub">${esc(v.departamento)}</span>` : ''}` },
      { titulo: 'Estado', celda: v => { const [t, c] = ESTADO_VACANTE[v.estado]; return badge(t, c); } },
      { titulo: 'Plazas', clase: 'num', celda: v => `${v.contratados} de ${v.cantidad}` },
      { titulo: 'Candidatos', clase: 'num', celda: v => `${v.candidatos} (${v.en_proceso} en proceso)` },
      { titulo: 'Publicada', celda: v => fechaCorta(v.fecha_publicacion) },
      { titulo: '', clase: 'acc', celda: v => botonesFila(v.id, [
        { accion: 'ver', texto: v.id === seleccionada ? 'Viendo ✓' : 'Ver candidatos' },
        ...(puedeEditar ? [{ accion: 'editarVacante', texto: 'Editar' }] : []), ...(puedeBorrar ? [{ accion: 'borrarVacante', texto: 'Eliminar', peligro: true }] : [])]) }
    ], vacantes, { vacio: 'Todavía no hay vacantes. Crea la primera con "+ Nueva vacante".' })}`;
  }

  function dibujarTablero() {
    const vac = vacantes.find(v => v.id === seleccionada);
    if (!vac) { $('#rcTablero').innerHTML = ''; return; }
    const puedeEditar = puede('rrhh.editar'), puedeBorrar = puede('rrhh.eliminar'), puedeContratar = puede('rrhh.crear');
    $('#rcTablero').innerHTML = `
      <div class="rrhh-cabecera" style="margin-bottom:10px;">
        <div><h2 style="font-size:16px;">Candidatos: ${esc(vac.titulo)}</h2></div>
        <div class="rrhh-filtros">${puede('rrhh.crear') ? '<button type="button" class="btn btn-ochre" id="rcNuevoCandidato">+ Agregar candidato</button>' : ''}</div>
      </div>
      <div class="rrhh-tablero">${ETAPAS.map(([etapa, titulo]) => {
        const lista = candidatos.filter(c => c.etapa === etapa);
        return `<div class="rrhh-col"><h4><span>${titulo}</span><span>${lista.length}</span></h4>${lista.map(c => `
          <div class="rrhh-cand">
            <b>${esc(c.nombre)}</b>
            <span class="rrhh-sub">${[c.email, c.telefono].filter(Boolean).map(esc).join(' · ')}</span>
            ${c.fuente ? `<span class="rrhh-sub">Fuente: ${esc(c.fuente)}</span>` : ''}
            ${c.pretension_salarial !== null && c.pretension_salarial !== undefined ? `<span class="rrhh-sub">Pretende ${soles(c.pretension_salarial)}</span>` : ''}
            ${c.cv_url ? `<a class="rrhh-enlace" href="${esc(c.cv_url)}" target="_blank" rel="noopener noreferrer">Ver CV ↗</a>` : ''}
            ${etapa === 'contratado' ? '<span class="rrhh-sub">✓ Ya es trabajador</span>' : `
              <div class="rrhh-acciones">
                ${puedeEditar ? `<select data-mover="${c.id}" aria-label="Mover a otra etapa">${['postulado', 'entrevista', 'prueba', 'oferta', 'descartado'].map(e =>
                  `<option value="${e}"${e === etapa ? ' selected' : ''}>${e === etapa ? '● ' : 'Mover a '}${e}</option>`).join('')}</select>` : ''}
                ${puedeContratar && etapa !== 'descartado' ? `<button type="button" class="rrhh-btn-mini confirmar" data-accion="contratar" data-id="${c.id}">Contratar</button>` : ''}
                ${puedeEditar ? `<button type="button" class="rrhh-btn-mini" data-accion="editarCandidato" data-id="${c.id}">Editar</button>` : ''}
                ${puedeBorrar ? `<button type="button" class="rrhh-btn-mini peligro" data-accion="borrarCandidato" data-id="${c.id}">Eliminar</button>` : ''}
              </div>`}
          </div>`).join('')}</div>`;
      }).join('')}</div>`;
    $('#rcNuevoCandidato')?.addEventListener('click', () => formularioCandidato(null));
  }

  function formularioVacante(v = null) {
    modal({
      titulo: v ? 'Editar vacante' : 'Nueva vacante', icono: '📢', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="vaForm"></div>';
        montarFormulario(cuerpo.querySelector('#vaForm'), {
          campos: [
            { id: 'titulo', label: 'Puesto', requerido: true, valor: v?.titulo ?? '', ancho: 2, maxlength: 150 },
            { id: 'departamento', label: 'Departamento', valor: v?.departamento ?? '', maxlength: 100 },
            { id: 'cantidad', label: 'Plazas', tipo: 'number', min: 1, max: 999, step: '1', valor: v?.cantidad ?? 1 },
            { id: 'estado', label: 'Estado', tipo: 'select', valor: v?.estado ?? 'abierta', opciones: [{ value: 'abierta', label: 'Abierta' }, { value: 'pausada', label: 'Pausada' }, { value: 'cerrada', label: 'Cerrada' }] },
            { id: 'descripcion', label: 'Descripción', tipo: 'textarea', valor: v?.descripcion ?? '', ancho: 4, filas: 3 }
          ],
          textoGuardar: v ? 'Guardar cambios' : 'Crear vacante', alCancelar: cerrarPanelLateral,
          alGuardar: async (d) => {
            const r = v ? await api(`/vacantes/${v.id}`, { metodo: 'PUT', cuerpo: d }) : await api('/vacantes', { metodo: 'POST', cuerpo: d });
            if (!v) seleccionada = r.id;
            cerrarPanelLateral();
            avisar(zona, 'Vacante guardada.');
            await cargarVacantes();
          }
        });
      }
    });
  }

  function formularioCandidato(c = null) {
    modal({
      titulo: c ? 'Editar candidato' : 'Agregar candidato', icono: '👤', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<div id="caForm"></div>';
        montarFormulario(cuerpo.querySelector('#caForm'), {
          campos: [
            { id: 'nombre', label: 'Nombre completo', requerido: true, valor: c?.nombre ?? '', ancho: 2, maxlength: 200 },
            { id: 'dni', label: 'DNI / documento', valor: c?.dni ?? '', maxlength: 12 },
            { id: 'fuente', label: 'Fuente', valor: c?.fuente ?? '', maxlength: 60, placeholder: 'Computrabajo, referido…' },
            { id: 'email', label: 'Correo', tipo: 'email', valor: c?.email ?? '', ancho: 2, maxlength: 200 },
            { id: 'telefono', label: 'Teléfono', valor: c?.telefono ?? '', maxlength: 60 },
            ...(puede('rrhh.remuneraciones') ? [{ id: 'pretension_salarial', label: 'Pretensión salarial (S/)', tipo: 'number', min: 0, step: '0.01', valor: c?.pretension_salarial ?? '' }] : []),
            { id: 'cv_url', label: 'Enlace al CV (https://…)', tipo: 'url', valor: c?.cv_url ?? '', ancho: 4, maxlength: 500 },
            { id: 'notas', label: 'Notas', tipo: 'textarea', valor: c?.notas ?? '', ancho: 4, filas: 2 }
          ],
          textoGuardar: c ? 'Guardar cambios' : 'Agregar candidato', alCancelar: cerrarPanelLateral,
          alGuardar: async (d) => {
            if (c) await api(`/candidatos/${c.id}`, { metodo: 'PUT', cuerpo: d });
            else await api('/candidatos', { metodo: 'POST', cuerpo: { ...d, vacante_id: seleccionada } });
            cerrarPanelLateral();
            avisar(zona, 'Candidato guardado.');
            await cargarVacantes();
          }
        });
      }
    });
  }

  function formularioContratar(c) {
    const vac = vacantes.find(v => v.id === seleccionada);
    modal({
      titulo: `Contratar a ${c.nombre}`, icono: '🤝', ancho: 'normal',
      montar: (cuerpo) => {
        cuerpo.innerHTML = '<p class="rrhh-legal">Se creará su ficha de trabajador con estos datos. Después completas el resto (jornada, contrato, usuario de GEALMI…) desde "Equipo".</p><div id="ctForm"></div>';
        montarFormulario(cuerpo.querySelector('#ctForm'), {
          campos: [
            { id: 'fecha_contratacion', label: 'Fecha de contratación', tipo: 'date', requerido: true, valor: hoyLima() },
            { id: 'puesto', label: 'Puesto', valor: vac?.titulo ?? '', maxlength: 150, ancho: 2 },
            { id: 'departamento', label: 'Departamento', valor: vac?.departamento ?? '', maxlength: 100 },
            { id: 'regimen_laboral', label: 'Régimen laboral', tipo: 'select', opciones: REGIMENES, valor: 'general' },
            { id: 'tipo_contrato', label: 'Tipo de contrato', valor: '', maxlength: 40, placeholder: 'Plazo fijo, indeterminado…' },
            ...(puede('rrhh.remuneraciones') ? [{ id: 'salario', label: 'Sueldo mensual (S/)', tipo: 'number', min: 0, step: '0.01', valor: c.pretension_salarial ?? '' }] : [])
          ],
          textoGuardar: 'Contratar', alCancelar: cerrarPanelLateral,
          alGuardar: async (d) => {
            const r = await api(`/candidatos/${c.id}/contratar`, { metodo: 'POST', cuerpo: d });
            invalidarEmpleados();
            cerrarPanelLateral();
            avisar(zona, `${c.nombre} ya es parte del equipo.${r.vacante_cerrada ? ' La vacante se cerró al cubrirse todas las plazas.' : ''}`);
            document.dispatchEvent(new CustomEvent('gealmi:datos-cambiaron', { detail: { modulo: 'rrhh' } }));
            await cargarVacantes();
          }
        });
      }
    });
  }

  $('#rcNuevaVacante')?.addEventListener('click', () => formularioVacante(null));
  // Cambiar de etapa desde el selector de cada tarjeta.
  zona.addEventListener('change', async (e) => {
    const sel = e.target.closest('[data-mover]');
    if (!sel) return;
    const c = candidatos.find(x => x.id === Number(sel.dataset.mover));
    try {
      await api(`/candidatos/${c.id}`, { metodo: 'PUT', cuerpo: { nombre: c.nombre, email: c.email, telefono: c.telefono, dni: c.dni, cv_url: c.cv_url, fuente: c.fuente, pretension_salarial: c.pretension_salarial, notas: c.notas, etapa: sel.value } });
      await cargarVacantes();
    } catch (err) { avisar($('#rcAviso'), err.message, 'error'); await cargarCandidatos(); }
  });
  alHacerClic(zona, {
    ver: async (id) => { seleccionada = Number(id); dibujarVacantes(); await cargarCandidatos(); },
    editarVacante: (id) => formularioVacante(vacantes.find(v => v.id === Number(id))),
    borrarVacante: async (id) => {
      const v = vacantes.find(x => x.id === Number(id));
      if (!confirm(`¿Eliminar la vacante "${v.titulo}" y todos sus candidatos? Quien ya fue contratado sigue como trabajador.`)) return;
      try { await api(`/vacantes/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Vacante eliminada.'); await cargarVacantes(); }
      catch (err) { avisar($('#rcAviso'), err.message, 'error'); }
    },
    contratar: (id) => formularioContratar(candidatos.find(c => c.id === Number(id))),
    editarCandidato: (id) => formularioCandidato(candidatos.find(c => c.id === Number(id))),
    borrarCandidato: async (id) => {
      const c = candidatos.find(x => x.id === Number(id));
      if (!confirm(`¿Eliminar a ${c.nombre} de esta vacante?`)) return;
      try { await api(`/candidatos/${id}`, { metodo: 'DELETE' }); avisar(zona, 'Candidato eliminado.'); await cargarVacantes(); }
      catch (err) { avisar($('#rcAviso'), err.message, 'error'); }
    }
  });
  await cargarVacantes();
}
