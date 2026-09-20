// js/rrhh/alertas.js
// Franja de "lo que hay que mirar hoy" en la pestaña Equipo: solicitudes de
// ausencia pendientes, contratos y documentos por vencer, quién está ausente
// hoy y los cumpleaños del mes. Sale de GET /api/rrhh/resumen; cada aviso
// lleva a la pestaña donde se resuelve.

import { api, esc, fechaCorta, ETIQUETA_AUSENCIA, puede } from './comun.js';

const ir = (seccion) => document.dispatchEvent(new CustomEvent('rrhh:ir', { detail: seccion }));

export async function montarAlertas(cont) {
  if (!cont) return;
  let r;
  try {
    r = await api('/resumen');
  } catch {
    return; // sin resumen no hay franja: la pantalla de Equipo funciona igual
  }
  const avisos = [];
  if (r.ausencias_pendientes) {
    avisos.push({ texto: `${r.ausencias_pendientes} solicitud(es) de ausencia por resolver`, tono: 'alerta', seccion: 'ausencias' });
  }
  if (r.contratos_por_vencer.length) {
    const nombres = r.contratos_por_vencer.slice(0, 3).map(c => `${c.nombre} (${c.dias_restantes < 0 ? 'venció' : `${c.dias_restantes} d`})`).join(', ');
    avisos.push({ texto: `Contratos por vencer: ${nombres}${r.contratos_por_vencer.length > 3 ? '…' : ''}`, tono: 'alerta' });
  }
  if (r.documentos.vencidos || r.documentos.por_vencer) {
    const partes = [];
    if (r.documentos.vencidos) partes.push(`${r.documentos.vencidos} vencido(s)`);
    if (r.documentos.por_vencer) partes.push(`${r.documentos.por_vencer} por vencer en 30 días`);
    avisos.push({ texto: `Documentos: ${partes.join(' · ')}`, tono: r.documentos.vencidos ? 'alerta' : 'info', seccion: 'documentos' });
  }
  if (r.ausentes_hoy.length) {
    avisos.push({
      texto: `Ausentes hoy: ${r.ausentes_hoy.slice(0, 4).map(a => `${a.nombre} (${ETIQUETA_AUSENCIA[a.tipo] || a.tipo}, hasta ${fechaCorta(a.hasta)})`).join(', ')}${r.ausentes_hoy.length > 4 ? '…' : ''}`,
      tono: 'info'
    });
  }
  if (r.cumpleanos_mes.length) {
    avisos.push({ texto: `Cumpleaños este mes: ${r.cumpleanos_mes.slice(0, 5).map(c => `${c.nombre} (${c.dia})`).join(', ')}${r.cumpleanos_mes.length > 5 ? '…' : ''}`, tono: 'info' });
  }
  if (!avisos.length) { cont.innerHTML = ''; return; }

  cont.innerHTML = avisos.map((a, i) => (a.seccion && puede('rrhh.ver')
    ? `<button type="button" class="rrhh-aviso ${a.tono === 'alerta' ? 'error' : 'info'} rrhh-aviso-enlace" data-i="${i}">${esc(a.texto)} →</button>`
    : `<div class="rrhh-aviso ${a.tono === 'alerta' ? 'error' : 'info'}">${esc(a.texto)}</div>`)).join('');
  cont.querySelectorAll('.rrhh-aviso-enlace').forEach(b => b.addEventListener('click', () => ir(avisos[Number(b.dataset.i)].seccion)));
}
