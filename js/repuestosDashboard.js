// js/repuestosDashboard.js
// Dashboard bespoke de Repuestos (Rediseño v3): "búsqueda rápida y
// disponibilidad" -- un buscador en vivo como pieza central (no KPIs
// primero), mostrando ubicación en almacén y stock de cada resultado, en
// vez del dashboard genérico de columnas auto-detectadas.
//
// Rotación ("Más usados"): mismo cálculo que velocidadDeVentaDeProducto()
// en backend/src/gealmiAiTools.js (rama repuestos) y que ya usa
// js/inventarioDashboard.js para Inventario -- unidades usadas en los
// últimos 30 días / 30 = ritmo diario. Acá la fuente es
// postventa.cantidad_repuesto (no ventas.cantidad), porque Repuestos se
// consume desde Postventa, no desde Ventas.
//
// LIMITACIÓN REAL (no inventada): compatibilidad/equivalencias son texto
// libre, sin estructura ni relación con la tabla vehiculos (confirmado en
// el esquema y la migración) -- el buscador hace coincidencia de texto
// sobre esos campos, no un filtro real "compatible con Toyota Corolla
// 2018". Un filtro estructurado por vehículo necesitaría un modelo de
// datos nuevo, no es algo que se pueda armar solo del lado del cliente.

import { fmtNum, escapeHtml } from './utils.js';
import { kpiCard } from './kpiCard.js';
import { nivelRiesgoStock } from './stockRisk.js';
import { crearGraficoDona, crearGraficoBarras, crearGraficoLineaFecha } from './charts.js';

const VENTANA_VELOCIDAD_DIAS = 30;

let repuestosCache = [];
let postventaCache = [];
let terminoBusqueda = '';
let eventosListos = false;
let chartRiesgo = null;
let chartProveedor = null;
let chartReposicion = null;
let chartConsumo = null;

function ultimosNMeses(n) {
  const hoy = new Date();
  const meses = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return meses;
}
function etiquetaMes(mesStr) {
  const [y, mm] = mesStr.split('-');
  return new Date(Number(y), Number(mm) - 1, 1).toLocaleDateString('es-PE', { month: 'short', year: '2-digit' });
}

function calcularVelocidad(repuesto, postventa) {
  const limite = new Date(); limite.setDate(limite.getDate() - VENTANA_VELOCIDAD_DIAS);
  const unidades = postventa
    .filter(o => o.repuesto_id === repuesto.id && o.fecha && new Date(o.fecha) >= limite)
    .reduce((s, o) => s + (Number(o.cantidad_repuesto) || 0), 0);
  const ritmoDiario = unidades / VENTANA_VELOCIDAD_DIAS;
  return {
    unidades,
    diasRestantes: ritmoDiario > 0 ? Math.round(Number(repuesto.stock) / ritmoDiario) : null
  };
}

export function renderRepuestosDashboard(filasCrudas, backend) {
  repuestosCache = filasCrudas || [];
  backend.listarDeModulo('postventa').then(postventa => {
    postventaCache = postventa || [];
    asegurarEventos();
    dibujar();
  });
}

function asegurarEventos() {
  if (eventosListos) return;
  eventosListos = true;
  document.getElementById('repBuscador').addEventListener('input', (e) => {
    terminoBusqueda = e.target.value.trim().toLowerCase();
    dibujarResultados(conVelocidad());
  });
}

function conVelocidad() {
  return repuestosCache.map(r => ({ ...r, _velocidad: calcularVelocidad(r, postventaCache) }));
}

function dibujar() {
  const enriquecidos = conVelocidad();
  dibujarKpis(enriquecidos);
  dibujarResultados(enriquecidos);
  dibujarMasUsados();
  dibujarChartRiesgo(enriquecidos);
  dibujarChartProveedor(enriquecidos);
  dibujarChartReposicion(enriquecidos);
  dibujarChartConsumo();
}

function dibujarKpis(repuestos) {
  const valor = repuestos.reduce((s, r) => s + (Number(r.stock) || 0) * (Number(r.costo_unitario) || 0), 0);
  const alertas = repuestos.map(r => nivelRiesgoStock(r.stock, r.stock_minimo)).filter(Boolean);
  const criticos = alertas.filter(a => a.nivel === 'critico').length;
  const sinMovimiento = repuestos.filter(r => (Number(r.stock) || 0) > 0 && r._velocidad.unidades === 0).length;

  const conTiempo = repuestos.filter(r => r.tiempo_reposicion_dias);
  const promedioReposicion = conTiempo.length ? conTiempo.reduce((s, r) => s + Number(r.tiempo_reposicion_dias), 0) / conTiempo.length : null;

  document.getElementById('repKpis').innerHTML = [
    kpiCard({ acento: 'blue', icono: '🔧', label: 'Repuestos registrados', value: fmtNum(repuestos.length), sub: `${fmtNum(valor)} en stock` }),
    kpiCard({
      acento: alertas.length ? 'orange' : 'teal', icono: '⚠️', label: 'Alertas de stock', value: fmtNum(alertas.length),
      sub: criticos ? `${criticos} en nivel crítico` : (alertas.length ? 'Ninguno crítico todavía' : 'Todo por encima del mínimo')
    }),
    kpiCard({ acento: 'purple', icono: '🐌', label: 'Sin movimiento', value: fmtNum(sinMovimiento), sub: `Sin uso en ${VENTANA_VELOCIDAD_DIAS} días` }),
    kpiCard({
      acento: 'teal', icono: '⏱️', label: 'Reposición promedio',
      value: promedioReposicion === null ? '—' : `${fmtNum(promedioReposicion)} d`,
      sub: promedioReposicion === null ? 'Sin datos de tiempo de reposición' : 'desde que se pide hasta que llega'
    })
  ].join('');
}

function coincide(r, termino) {
  if (!termino) return true;
  const campos = [r.nombre, r.codigo_oem, r.compatibilidad, r.equivalencias, r.proveedor, r.ubicacion];
  return campos.some(c => (c || '').toLowerCase().includes(termino));
}

function dibujarResultados(repuestos) {
  const filtrados = repuestos.filter(r => coincide(r, terminoBusqueda));
  const ordenados = [...filtrados].sort((a, b) => {
    const ra = nivelRiesgoStock(a.stock, a.stock_minimo), rb = nivelRiesgoStock(b.stock, b.stock_minimo);
    const pa = ra ? (ra.nivel === 'critico' ? 0 : 1) : 2, pb = rb ? (rb.nivel === 'critico' ? 0 : 1) : 2;
    return pa - pb || String(a.nombre).localeCompare(String(b.nombre));
  });

  const contador = document.getElementById('repResultadosCount');
  contador.textContent = terminoBusqueda ? `${ordenados.length} resultado(s)` : `${ordenados.length} repuesto(s)`;

  document.getElementById('repResultados').innerHTML = ordenados.length ? ordenados.slice(0, 60).map(r => {
    const riesgo = nivelRiesgoStock(r.stock, r.stock_minimo);
    const badge = riesgo ? `<span class="stock-risk-badge stock-risk-${riesgo.nivel}">${riesgo.icono} ${riesgo.etiqueta}</span>` : '';
    const sub = [
      r.codigo_oem ? `OEM ${r.codigo_oem}` : null,
      r.ubicacion ? `📍 ${r.ubicacion}` : null,
      r.proveedor ? `Proveedor: ${r.proveedor}` : null
    ].filter(Boolean).join(' · ');
    return `<div class="rank-row">
      <span class="rank-name">${escapeHtml(r.nombre)}${sub ? `<div class="rank-sub">${escapeHtml(sub)}</div>` : ''}</span>
      ${badge}
      <span class="rank-val">${fmtNum(Number(r.stock))} u.</span>
    </div>`;
  }).join('') : `<div class="rank-row">${terminoBusqueda ? 'Sin resultados para tu búsqueda.' : 'Todavía no hay repuestos registrados.'}</div>`;
}

function dibujarMasUsados() {
  const conUso = repuestosCache
    .map(r => ({ r, unidades: calcularVelocidad(r, postventaCache).unidades }))
    .filter(x => x.unidades > 0)
    .sort((a, b) => b.unidades - a.unidades)
    .slice(0, 8);

  document.getElementById('repMasUsados').innerHTML = conUso.length
    ? conUso.map((x, i) => `<div class="rank-row"><span class="rank-num">${i + 1}</span><span class="rank-name">${escapeHtml(x.r.nombre)}</span><span class="rank-val">${fmtNum(x.unidades)} u.</span></div>`).join('')
    : `<div class="rank-row">Sin uso registrado en los últimos ${VENTANA_VELOCIDAD_DIAS} días.</div>`;
}

// Proporción del catálogo en cada nivel de riesgo -- distinto de la lista
// "Resultados" (que muestra repuestos puntuales, filtrables por búsqueda).
function dibujarChartRiesgo(repuestos) {
  let critico = 0, bajo = 0, normal = 0;
  repuestos.forEach(r => {
    const riesgo = nivelRiesgoStock(r.stock, r.stock_minimo);
    if (!riesgo) normal++;
    else if (riesgo.nivel === 'critico') critico++;
    else bajo++;
  });
  const COLOR_POR_NIVEL = { 'Normal': '#0F6E56', 'Bajo': '#C98A3C', 'Crítico': '#C4544B' };
  const entradas = [['Normal', normal], ['Bajo', bajo], ['Crítico', critico]].filter(([, n]) => n > 0);

  const wrap = document.getElementById('repChartRiesgoWrap');
  wrap.innerHTML = '<canvas id="repChartRiesgo"></canvas>';
  if (chartRiesgo) { chartRiesgo.destroy(); chartRiesgo = null; }
  if (!entradas.length) { wrap.innerHTML = '<div class="chart-empty">Todavía no hay repuestos registrados.</div>'; return; }
  const ctx = document.getElementById('repChartRiesgo').getContext('2d');
  chartRiesgo = crearGraficoDona(ctx, { etiquetas: entradas.map(e => e[0]), valores: entradas.map(e => e[1]), colores: entradas.map(e => COLOR_POR_NIVEL[e[0]]) });
}

// Cuánto capital está inmovilizado en stock, por proveedor -- distinto del
// KPI "Repuestos registrados" (que es un solo total, sin desglosar por
// quién provee qué).
function dibujarChartProveedor(repuestos) {
  const porProveedor = new Map();
  repuestos.forEach(r => {
    const prov = r.proveedor || 'Sin proveedor';
    const valor = (Number(r.stock) || 0) * (Number(r.costo_unitario) || 0);
    porProveedor.set(prov, (porProveedor.get(prov) || 0) + valor);
  });
  const entradas = [...porProveedor.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);

  const wrap = document.getElementById('repChartProveedorWrap');
  wrap.innerHTML = '<canvas id="repChartProveedor"></canvas>';
  if (chartProveedor) { chartProveedor.destroy(); chartProveedor = null; }
  if (!entradas.length) { wrap.innerHTML = '<div class="chart-empty">Sin valor de inventario registrado.</div>'; return; }
  const color = getComputedStyle(document.documentElement).getPropertyValue('--blue').trim();
  const ctx = document.getElementById('repChartProveedor').getContext('2d');
  chartProveedor = crearGraficoBarras(ctx, { etiquetas: entradas.map(e => e[0]), valores: entradas.map(e => e[1]), label: 'Valor en stock', color });
}

// Riesgo de cadena de suministro: cuántos repuestos tardan poco vs. mucho en
// reponerse -- un catálogo con mucho "31+ días" es más vulnerable a
// quiebres de stock que uno con reposición rápida.
function dibujarChartReposicion(repuestos) {
  const franjas = [
    { label: '0-7 días', test: d => d >= 0 && d <= 7 },
    { label: '8-15 días', test: d => d >= 8 && d <= 15 },
    { label: '16-30 días', test: d => d >= 16 && d <= 30 },
    { label: '31+ días', test: d => d > 30 }
  ];
  const conDato = repuestos.filter(r => r.tiempo_reposicion_dias !== null && r.tiempo_reposicion_dias !== undefined && r.tiempo_reposicion_dias !== '');
  const conteos = franjas.map(f => conDato.filter(r => f.test(Number(r.tiempo_reposicion_dias))).length);

  const wrap = document.getElementById('repChartReposicionWrap');
  wrap.innerHTML = '<canvas id="repChartReposicion"></canvas>';
  if (chartReposicion) { chartReposicion.destroy(); chartReposicion = null; }
  if (!conDato.length) { wrap.innerHTML = '<div class="chart-empty">Sin datos de tiempo de reposición.</div>'; return; }
  const color = getComputedStyle(document.documentElement).getPropertyValue('--purple').trim();
  const ctx = document.getElementById('repChartReposicion').getContext('2d');
  chartReposicion = crearGraficoBarras(ctx, { etiquetas: franjas.map(f => f.label), valores: conteos, label: 'Repuestos', color });
}

// Tendencia de consumo real (unidades usadas en órdenes de Postventa) mes a
// mes -- distinto de "Más usados" (que rankea repuestos puntuales en una
// sola ventana de 30 días, sin eje de tiempo).
function dibujarChartConsumo() {
  const meses = ultimosNMeses(6);
  const porMes = new Map(meses.map(m => [m, 0]));
  postventaCache.forEach(o => {
    if (!o.fecha) return;
    const mes = String(o.fecha).slice(0, 7);
    if (porMes.has(mes)) porMes.set(mes, porMes.get(mes) + (Number(o.cantidad_repuesto) || 0));
  });

  const wrap = document.getElementById('repChartConsumoWrap');
  wrap.innerHTML = '<canvas id="repChartConsumo"></canvas>';
  if (chartConsumo) { chartConsumo.destroy(); chartConsumo = null; }
  const total = [...porMes.values()].reduce((s, n) => s + n, 0);
  if (!total) { wrap.innerHTML = '<div class="chart-empty">Sin consumo registrado en los últimos 6 meses.</div>'; return; }
  const color = getComputedStyle(document.documentElement).getPropertyValue('--teal').trim();
  const ctx = document.getElementById('repChartConsumo').getContext('2d');
  chartConsumo = crearGraficoLineaFecha(ctx, {
    fechas: meses.map(etiquetaMes), valores: meses.map(m => porMes.get(m)), label: 'Unidades usadas', color, colorFondo: 'rgba(15,166,156,0.12)'
  });
}
