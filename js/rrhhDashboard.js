// js/rrhhDashboard.js
// Dashboard bespoke de RRHH: reemplaza la vista previa con datos de
// ejemplo que tenía esta página antes -- todo acá sale de empleados reales
// (backend/src/routes/rrhh.js). Asistencia, ausencias, remuneraciones,
// documentos, desempeño y reclutamiento viven en las demás pestañas de la
// página (js/rrhh/panel.js); acá solo está lo de "Equipo".

import { fmtNum, escapeHtml } from './utils.js';
import { kpiCard } from './kpiCard.js';
import { tienePermiso } from './sesion.js';

const ETIQUETA_ESTADO = {
  activo: { texto: 'Activo', color: 'teal' },
  inactivo: { texto: 'Inactivo', color: 'danger' },
  vacaciones: { texto: 'Vacaciones', color: 'blue' },
  licencia: { texto: 'Licencia', color: 'purple' },
  cesado: { texto: 'Cesado', color: 'muted' }
};

// El servidor devuelve estado_efectivo: el escrito en la ficha, salvo que hoy el
// trabajador ya esté cesado o tenga una ausencia aprobada vigente.
const estadoDe = (e) => e.estado_efectivo || e.estado;
// Sin rrhh.remuneraciones el servidor manda el sueldo en null: no se muestra ni se suma.
const veSueldos = () => tienePermiso('rrhh.remuneraciones');

let empleadosCache = [];

export function renderRrhhDashboard(filasCrudas) {
  empleadosCache = filasCrudas || [];
  dibujar();
}

function esteMes(fechaStr) {
  if (!fechaStr) return false;
  const hoy = new Date();
  const f = new Date(fechaStr);
  return f.getFullYear() === hoy.getFullYear() && f.getMonth() === hoy.getMonth();
}

function dibujar() {
  dibujarKpis();
  dibujarLista();
  dibujarPorDepartamento();
}

function dibujarKpis() {
  const activos = empleadosCache.filter(e => estadoDe(e) === 'activo');
  const nominaMensual = activos.reduce((s, e) => s + (Number(e.salario) || 0), 0);
  const ausentes = empleadosCache.filter(e => ['vacaciones', 'licencia'].includes(estadoDe(e))).length;
  const cesados = empleadosCache.filter(e => estadoDe(e) === 'cesado').length;
  const contratadosMes = empleadosCache.filter(e => esteMes(e.fecha_contratacion)).length;

  document.getElementById('rrhhKpis').innerHTML = [
    kpiCard({ acento: 'blue', icono: '👥', label: 'Empleados activos', value: fmtNum(activos.length), sub: `${empleadosCache.length} en total` }),
    veSueldos()
      ? kpiCard({ acento: 'purple', icono: '💰', label: 'Nómina mensual estimada', value: fmtNum(nominaMensual), sub: 'suma de salarios activos' })
      : kpiCard({ acento: 'purple', icono: '🚪', label: 'Cesados', value: fmtNum(cesados), sub: 'ya no trabajan aquí' }),
    kpiCard({ acento: ausentes ? 'orange' : 'teal', icono: '🏖️', label: 'Vacaciones / licencia', value: fmtNum(ausentes), sub: 'ausentes ahora' }),
    kpiCard({ acento: 'teal', icono: '✨', label: 'Contratados este mes', value: fmtNum(contratadosMes), sub: 'nuevos ingresos' })
  ].join('');
}

function dibujarLista() {
  const ordenados = [...empleadosCache].sort((a, b) => a.nombre.localeCompare(b.nombre));
  document.getElementById('rrhhCount').textContent = `${ordenados.length} empleado(s)`;

  document.getElementById('rrhhLista').innerHTML = ordenados.length ? ordenados.map(e => {
    const est = ETIQUETA_ESTADO[estadoDe(e)] || { texto: estadoDe(e), color: 'muted' };
    const sub = [e.puesto, e.departamento].filter(Boolean).join(' · ') || 'Sin puesto asignado';
    const valor = veSueldos()
      ? `<div class="rank-val">${fmtNum(Number(e.salario) || 0)}</div>`
      : '<div class="rank-val">—</div>';
    return `<div class="cliente-row rrhh-fila-click" data-empleado-id="${e.id}" role="button" tabindex="0" title="Abrir la ficha de ${escapeHtml(e.nombre)}">
      <div class="cliente-row-info">
        <div class="cliente-row-nombre">${escapeHtml(e.nombre)}</div>
        <div class="cliente-row-contacto">${escapeHtml(sub)}</div>
      </div>
      <span class="evento-badge evento-badge-${est.color}">${escapeHtml(est.texto)}</span>
      <div class="cliente-row-valor">
        ${valor}
        <div class="cliente-row-sub">desde ${escapeHtml(String(e.fecha_contratacion || '').slice(0, 10))}</div>
      </div>
    </div>`;
  }).join('') : '<div class="rank-row">Todavía no hay empleados registrados.</div>';
}

function dibujarPorDepartamento() {
  const porDepto = new Map();
  empleadosCache.forEach(e => {
    const depto = e.departamento || 'Sin departamento';
    porDepto.set(depto, (porDepto.get(depto) || 0) + 1);
  });
  const top = [...porDepto.entries()].sort((a, b) => b[1] - a[1]);
  document.getElementById('rrhhPorDepartamento').innerHTML = top.length
    ? top.map((r, i) => `<div class="rank-row"><span class="rank-num">${i + 1}</span><span class="rank-name">${escapeHtml(r[0])}</span><span class="rank-val">${fmtNum(r[1])}</span></div>`).join('')
    : '<div class="rank-row">Todavía no hay empleados registrados.</div>';
}
