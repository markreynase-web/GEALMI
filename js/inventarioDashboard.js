// js/inventarioDashboard.js
// Dashboard bespoke de Inventario (Rediseño v3): "inventory management" --
// valor real del stock (a costo, no a precio de venta), alertas con días
// restantes estimados (mismo cálculo que la herramienta de GEALMI AI
// velocidadDeVentaDeProducto en backend/src/gealmiAiTools.js: unidades
// vendidas en los últimos 30 días / 30), y detección de stock sin
// movimiento. Reemplaza el motor genérico de js/dashboard.js para este
// módulo, igual que ya se hizo con Ventas/Clientes/Finanzas.
//
// A propósito NO tiene selector de período (Ventas/Clientes/Finanzas sí):
// "cuánto stock tengo y qué riesgo corre" es una foto de ahora mismo, no
// algo que tenga sentido comparar contra "el mes pasado". La única parte
// con ventana de tiempo (velocidad de venta, productos sin movimiento,
// top vendidos) usa un fijo de 30 días, igual que la herramienta de Khipu
// AI que ya usa ese mismo criterio -- así ambos coinciden si el usuario
// compara lo que ve acá con lo que le contesta el asistente.
//
// IMPORTANTE (limitación real, no inventada): no existe una tabla de
// movimientos de stock en el backend -- editar `stock` a mano es un
// sobreescribe directo, sin dejar rastro del valor anterior. Por eso NO se
// muestra un "historial de entradas y salidas" completo: solo se infieren
// las SALIDAS reales (ventas), que sí son verificables.

import { fmtNum, escapeHtml } from './utils.js';
import { kpiCard } from './kpiCard.js';
import { nivelRiesgoStock } from './stockRisk.js';
import { crearGraficoDona, crearGraficoBarrasComparativo, crearGraficoBarras } from './charts.js';

const VENTANA_VELOCIDAD_DIAS = 30;

let chartRiesgo = null;
let chartCostoVenta = null;
let chartVencimientos = null;

function diasHasta(fechaStr) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const f = new Date(fechaStr); f.setHours(0, 0, 0, 0);
  return Math.round((f - hoy) / 86400000);
}

// Mismo cálculo que velocidadDeVentaDeProducto() en
// backend/src/gealmiAiTools.js: unidades vendidas en los últimos 30 días,
// dividido 30 -- ritmo diario. Con eso, días de stock restantes al ritmo
// actual (null si no se vendió nada en la ventana: no hay ritmo que
// proyectar, no es "infinito", es "sin datos suficientes").
function calcularVelocidad(producto, ventas) {
  const limite = new Date(); limite.setDate(limite.getDate() - VENTANA_VELOCIDAD_DIAS);
  const unidades = ventas
    .filter(v => v.producto_id === producto.id && v.fecha && new Date(v.fecha) >= limite)
    .reduce((s, v) => s + (Number(v.cantidad) || 0), 0);
  const ritmoDiario = unidades / VENTANA_VELOCIDAD_DIAS;
  return {
    unidades,
    diasRestantes: ritmoDiario > 0 ? Math.round(Number(producto.stock) / ritmoDiario) : null
  };
}

export function renderInventarioDashboard(filasCrudas, backend) {
  const productos = filasCrudas || [];
  backend.listarDeModulo('ventas').then(ventas => {
    dibujar(productos, ventas || []);
  });
}

function dibujar(productos, ventas) {
  const conVelocidad = productos.map(p => ({ ...p, _velocidad: calcularVelocidad(p, ventas) }));

  dibujarKpis(conVelocidad);
  dibujarAlertas(conVelocidad);
  dibujarCategorias(conVelocidad);
  dibujarMasVendidos(ventas);
  dibujarVencimientos(conVelocidad);
  dibujarChartRiesgo(conVelocidad);
  dibujarChartCostoVenta(conVelocidad);
  dibujarChartVencimientosPorMes(conVelocidad);
}

function dibujarKpis(productos) {
  const valorCosto = productos.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.costo_unitario) || 0), 0);
  const valorVenta = productos.reduce((s, p) => s + (Number(p.stock) || 0) * (Number(p.precio_unitario) || 0), 0);
  const categorias = new Set(productos.map(p => p.categoria).filter(Boolean));

  const alertas = productos.map(p => nivelRiesgoStock(p.stock, p.stock_minimo)).filter(Boolean);
  const criticos = alertas.filter(r => r.nivel === 'critico').length;

  const sinMovimiento = productos.filter(p => (Number(p.stock) || 0) > 0 && p._velocidad.unidades === 0);

  document.getElementById('invKpis').innerHTML = [
    kpiCard({
      acento: 'teal', icono: '💰', label: 'Valor del inventario', value: fmtNum(valorCosto),
      sub: `${fmtNum(valorVenta)} a precio de venta`
    }),
    kpiCard({
      acento: 'blue', icono: '📦', label: 'Productos', value: fmtNum(productos.length),
      sub: `${categorias.size} categoría(s)`
    }),
    kpiCard({
      acento: alertas.length ? 'orange' : 'teal', icono: '⚠️', label: 'Alertas de stock', value: fmtNum(alertas.length),
      sub: criticos ? `${criticos} en nivel crítico` : (alertas.length ? 'Ninguno crítico todavía' : 'Todo el stock por encima del mínimo')
    }),
    kpiCard({
      acento: 'purple', icono: '🐌', label: 'Sin movimiento', value: fmtNum(sinMovimiento.length),
      sub: `Sin ventas en ${VENTANA_VELOCIDAD_DIAS} días`
    })
  ].join('');
}

function dibujarAlertas(productos) {
  const conRiesgo = productos
    .map(p => ({ p, riesgo: nivelRiesgoStock(p.stock, p.stock_minimo) }))
    .filter(r => r.riesgo)
    .sort((a, b) => (a.riesgo.nivel === b.riesgo.nivel ? 0 : a.riesgo.nivel === 'critico' ? -1 : 1));

  document.getElementById('invAlertas').innerHTML = conRiesgo.length ? conRiesgo.slice(0, 10).map(({ p, riesgo }) => {
    const dias = p._velocidad.diasRestantes;
    const sub = dias !== null ? `~${dias} día(s) de stock al ritmo actual` : 'Sin ventas recientes para estimar';
    return `<div class="rank-row">
      <span class="rank-name">${escapeHtml(p.nombre)}<div class="rank-sub">${sub}</div></span>
      <span class="stock-risk-badge stock-risk-${riesgo.nivel}">${riesgo.icono} ${riesgo.etiqueta}</span>
      <span class="rank-val">${fmtNum(Number(p.stock))} u.</span>
    </div>`;
  }).join('') : '<div class="rank-row">Ningún producto está en su stock mínimo o por debajo.</div>';
}

function dibujarCategorias(productos) {
  const porCategoria = new Map();
  productos.forEach(p => {
    const cat = p.categoria || 'Sin categoría';
    const valor = (Number(p.stock) || 0) * (Number(p.costo_unitario) || 0);
    porCategoria.set(cat, (porCategoria.get(cat) || 0) + valor);
  });
  const total = [...porCategoria.values()].reduce((s, v) => s + v, 0);
  const entradas = [...porCategoria.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  document.getElementById('invCategorias').innerHTML = entradas.length ? entradas.map(([cat, valor]) => {
    const pct = total ? (valor / total) * 100 : 0;
    return `<div class="cat-row">
      <div class="top"><span>${escapeHtml(cat)}</span><span>${fmtNum(valor)} · ${pct.toFixed(0)}%</span></div>
      <div class="cat-bar-bg"><div class="cat-bar-fill" style="width:${pct.toFixed(0)}%;"></div></div>
    </div>` ;
  }).join('') : '<div class="rank-row">Todavía no hay productos registrados.</div>';
}

function dibujarMasVendidos(ventas) {
  const limite = new Date(); limite.setDate(limite.getDate() - VENTANA_VELOCIDAD_DIAS);
  const porProducto = new Map();
  ventas.filter(v => v.fecha && new Date(v.fecha) >= limite).forEach(v => {
    const nombre = v.producto || 'Sin dato';
    porProducto.set(nombre, (porProducto.get(nombre) || 0) + (Number(v.cantidad) || 0));
  });
  const top = [...porProducto.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

  document.getElementById('invMasVendidos').innerHTML = top.length
    ? top.map((r, i) => `<div class="rank-row"><span class="rank-num">${i + 1}</span><span class="rank-name">${escapeHtml(r[0])}</span><span class="rank-val">${fmtNum(r[1])} u.</span></div>`).join('')
    : `<div class="rank-row">Sin ventas en los últimos ${VENTANA_VELOCIDAD_DIAS} días.</div>`;
}

function dibujarVencimientos(productos) {
  // Ventana -30/+30: sin el piso, un producto vencido hace años se quedaría
  // mostrándose para siempre (mismo criterio ya usado en pages/inicio.html).
  const vencen = productos
    .filter(p => p.fecha_vencimiento && diasHasta(p.fecha_vencimiento) <= 30 && diasHasta(p.fecha_vencimiento) >= -30)
    .sort((a, b) => new Date(a.fecha_vencimiento) - new Date(b.fecha_vencimiento));

  document.getElementById('invVencimientos').innerHTML = vencen.length ? vencen.slice(0, 8).map(p => {
    const dias = diasHasta(p.fecha_vencimiento);
    const urgente = dias <= 7;
    return `<div class="rank-row"><span class="rank-name">${escapeHtml(p.nombre)}</span><span class="rank-val" style="${urgente ? 'color:var(--danger);' : ''}">${escapeHtml(String(p.fecha_vencimiento).slice(0, 10))}${dias < 0 ? ' (vencido)' : ` (${dias} día${dias === 1 ? '' : 's'})`}</span></div>`;
  }).join('') : '<div class="rank-row">Ningún producto vence en los próximos 30 días.</div>';
}

// Distinto de la lista "Alertas de stock" (que muestra los productos uno
// por uno, ordenados): acá es la proporción del catálogo completo en cada
// nivel -- responde "¿qué tan grave es la situación en general?", no
// "¿cuáles son los peores?".
function dibujarChartRiesgo(productos) {
  let critico = 0, bajo = 0, normal = 0;
  productos.forEach(p => {
    const riesgo = nivelRiesgoStock(p.stock, p.stock_minimo);
    if (!riesgo) normal++;
    else if (riesgo.nivel === 'critico') critico++;
    else bajo++;
  });
  const COLOR_POR_NIVEL = { 'Normal': '#0F6E56', 'Bajo': '#C98A3C', 'Crítico': '#C4544B' };
  const entradas = [['Normal', normal], ['Bajo', bajo], ['Crítico', critico]].filter(([, n]) => n > 0);

  const wrap = document.getElementById('invChartRiesgoWrap');
  wrap.innerHTML = '<canvas id="invChartRiesgo"></canvas>';
  if (chartRiesgo) { chartRiesgo.destroy(); chartRiesgo = null; }
  if (!entradas.length) { wrap.innerHTML = '<div class="chart-empty">Todavía no hay productos registrados.</div>'; return; }
  const ctx = document.getElementById('invChartRiesgo').getContext('2d');
  chartRiesgo = crearGraficoDona(ctx, {
    etiquetas: entradas.map(e => e[0]), valores: entradas.map(e => e[1]),
    colores: entradas.map(e => COLOR_POR_NIVEL[e[0]])
  });
}

// Distinto de "Valor por categoría" (que muestra un solo número, el valor a
// costo): acá se comparan costo y precio de venta lado a lado, categoría
// por categoría -- deja ver dónde está el margen y dónde no.
function dibujarChartCostoVenta(productos) {
  const porCategoria = new Map();
  productos.forEach(p => {
    const cat = p.categoria || 'Sin categoría';
    const acc = porCategoria.get(cat) || { costo: 0, venta: 0 };
    acc.costo += (Number(p.stock) || 0) * (Number(p.costo_unitario) || 0);
    acc.venta += (Number(p.stock) || 0) * (Number(p.precio_unitario) || 0);
    porCategoria.set(cat, acc);
  });
  const entradas = [...porCategoria.entries()].sort((a, b) => b[1].venta - a[1].venta).slice(0, 8);

  const wrap = document.getElementById('invChartCostoVentaWrap');
  wrap.innerHTML = '<canvas id="invChartCostoVenta"></canvas>';
  if (chartCostoVenta) { chartCostoVenta.destroy(); chartCostoVenta = null; }
  if (!entradas.length) { wrap.innerHTML = '<div class="chart-empty">Todavía no hay productos registrados.</div>'; return; }
  const estilos = getComputedStyle(document.documentElement);
  const ctx = document.getElementById('invChartCostoVenta').getContext('2d');
  chartCostoVenta = crearGraficoBarrasComparativo(ctx, {
    etiquetas: entradas.map(e => e[0]),
    serieA: entradas.map(e => e[1].costo), serieB: entradas.map(e => e[1].venta),
    labelA: 'Costo', labelB: 'Valor de venta',
    colorA: estilos.getPropertyValue('--orange').trim(), colorB: estilos.getPropertyValue('--teal').trim()
  });
}

// Distinto de "Próximos vencimientos" (lista de productos puntuales, sólo
// los próximos 30 días): acá es un vistazo más amplio (6 meses) para
// planificar compras/promos con anticipación, no solo reaccionar a lo
// inminente.
function dibujarChartVencimientosPorMes(productos) {
  const hoy = new Date();
  const meses = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const conteoPorMes = new Map(meses.map(m => [m, 0]));
  productos.forEach(p => {
    if (!p.fecha_vencimiento) return;
    const mes = String(p.fecha_vencimiento).slice(0, 7);
    if (conteoPorMes.has(mes)) conteoPorMes.set(mes, conteoPorMes.get(mes) + 1);
  });

  const wrap = document.getElementById('invChartVencimientosWrap');
  wrap.innerHTML = '<canvas id="invChartVencimientos"></canvas>';
  if (chartVencimientos) { chartVencimientos.destroy(); chartVencimientos = null; }
  const totalVencimientos = [...conteoPorMes.values()].reduce((s, n) => s + n, 0);
  if (!totalVencimientos) { wrap.innerHTML = '<div class="chart-empty">Sin vencimientos en los próximos 6 meses.</div>'; return; }
  const etiquetas = meses.map(m => { const [y, mm] = m.split('-'); return new Date(Number(y), Number(mm) - 1, 1).toLocaleDateString('es-PE', { month: 'short', year: '2-digit' }); });
  const color = getComputedStyle(document.documentElement).getPropertyValue('--danger').trim();
  const ctx = document.getElementById('invChartVencimientos').getContext('2d');
  chartVencimientos = crearGraficoBarras(ctx, { etiquetas, valores: meses.map(m => conteoPorMes.get(m)), label: 'Productos que vencen', color });
}
