// js/inicioDashboard.js
// Rediseño de Inicio (2026-09-22), guiado por el mockup del dashboard que
// mandó el usuario: saludo + rango de fecha, 4 tarjetas KPI con sparkline,
// "Ingresos vs. gastos" (área), "Ventas por categoría" (dona), "Resumen
// financiero", tres mini-tablas (productos/stock/clientes) y una fila final
// con ventas recientes, tareas pendientes y el mapa de sucursales.
//
// GET /api/inicio/resumen sigue siendo la única llamada al cargar la página
// (ver backend/src/routes/inicio.js): cada sección es opcional y solo viene
// si la sesión puede verla. Todo lo que se pinta acá sale de datos reales --
// donde el mockup pedía algo que GEALMI no mide todavía (canal de venta,
// estado de una "orden", deuda de un cliente), se adaptó a lo más parecido
// que SÍ existe en vez de inventar el número (ver el informe de esta sesión).

import { cargarConfigEmpresa } from '../js/config.js';
import { renderSidebar } from '../components/sidebar.js';
import { renderTopbar } from '../components/topbar.js';
import { renderFooter } from '../components/footer.js';
import { obtenerSesion, haySesionActiva } from '../js/sesion.js';
import { obtenerJSON } from '../js/api.js';
import { fmtNum, fmtCorto, escapeHtml } from '../js/utils.js';
import { crearGraficoLineasComparativo, crearGraficoDona, PALETA_CATEGORICA } from '../js/charts.js';
import { kpiCard, deltaPorcentaje } from '../js/kpiCard.js';
import {
  ICONO_CART, ICONO_CHART_BAR, ICONO_USERS, ICONO_PACKAGE, ICONO_RECEIPT, ICONO_PERCENT,
  ICONO_ALERT_TRIANGLE, ICONO_FOLDER, ICONO_CASH, ICONO_PIN, ICONO_CALENDAR
} from '../js/iconos.js';

if (!haySesionActiva()) location.replace('login');

let config;
let chartInstance = null;
let donutInstance = null;
let pedidoSerie = 0; // descarta la respuesta de un período que el usuario ya dejó atrás

const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// ---------------------------------------------------------------------------
// Saludo + rango de fecha (hora y mes en Lima, no en la del navegador)
// ---------------------------------------------------------------------------

function pintarSaludo() {
  const sesion = obtenerSesion();
  const nombre = (sesion?.usuario?.nombre || '').split(' ')[0] || '';
  const horaLima = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', hour: '2-digit', hour12: false }).format(new Date()));
  const momento = horaLima < 12 ? 'Buenos días' : horaLima < 19 ? 'Buenas tardes' : 'Buenas noches';
  document.getElementById('iniSaludoTitulo').innerHTML =
    `${momento}${nombre ? `, ${escapeHtml(nombre)}` : ''}<span class="ini-saludo-mano" aria-hidden="true">👋</span>`;

  const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const desde = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const hasta = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
  const mes = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', month: 'short' }).format(hoy).replace('.', '').toLowerCase();
  document.getElementById('iniRangoTexto').textContent = `${String(desde.getDate()).padStart(2, '0')} - ${hasta.getDate()} de ${mes}. ${hoy.getFullYear()}`;
  document.getElementById('iniRangoIcono').innerHTML = ICONO_CALENDAR;
}

// ---------------------------------------------------------------------------
// Gráfico "Ingresos vs. gastos" (igual que antes: /inicio/finanzas-serie)
// ---------------------------------------------------------------------------

function seriesParaGrafico(serie) {
  const { modo, granularidad, puntos } = serie;
  if (modo === 'anio') {
    const ingresos = new Array(12).fill(0), egresos = new Array(12).fill(0);
    puntos.forEach(p => { const i = Number(p.clave.slice(5, 7)) - 1; ingresos[i] += p.ingresos; egresos[i] += p.egresos; });
    return { etiquetas: MESES, ingresos, egresos };
  }
  const etiqueta = granularidad === 'dia'
    ? (c) => { const [, m, d] = c.split('-'); return `${d}/${m}`; }
    : (c) => { const [y, m] = c.split('-'); return `${MESES[Number(m) - 1]} ${y}`; };
  return { etiquetas: puntos.map(p => etiqueta(p.clave)), ingresos: puntos.map(p => p.ingresos), egresos: puntos.map(p => p.egresos) };
}

function mensajeEnGrafico(texto) {
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  document.getElementById('panelChart').querySelector('.chart-wrap').innerHTML = `<div class="chart-empty">${escapeHtml(texto)}</div>`;
}

function dibujarGrafico(serie) {
  const { etiquetas, ingresos, egresos } = seriesParaGrafico(serie);
  const wrap = document.getElementById('panelChart').querySelector('.chart-wrap');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  if (!ingresos.some(v => v) && !egresos.some(v => v)) {
    wrap.innerHTML = '<div class="chart-empty">Todavía no hay movimientos de Finanzas para graficar en este período.</div>';
    return;
  }
  wrap.innerHTML = '<canvas id="chartIngresosEgresos"></canvas>';
  const estilos = getComputedStyle(document.documentElement);
  const colorA = estilos.getPropertyValue('--teal').trim();
  const colorB = estilos.getPropertyValue('--coral').trim();
  const ctx = document.getElementById('chartIngresosEgresos').getContext('2d');
  chartInstance = crearGraficoLineasComparativo(ctx, {
    etiquetas, serieA: ingresos, serieB: egresos, labelA: 'Ingresos', labelB: 'Gastos', colorA, colorB
  });
}

async function cambiarPeriodoDelGrafico() {
  const modo = document.getElementById('chartPeriodo').value;
  const desde = document.getElementById('chartDesde').value;
  const hasta = document.getElementById('chartHasta').value;
  if (modo === 'personalizado') {
    if (!desde || !hasta) { mensajeEnGrafico('Elige la fecha de inicio y la de fin para ver el gráfico.'); return; }
    if (hasta < desde) { mensajeEnGrafico('La fecha "hasta" no puede ser anterior a "desde".'); return; }
  }
  const consulta = new URLSearchParams({ modo });
  if (modo === 'personalizado') { consulta.set('desde', desde); consulta.set('hasta', hasta); }
  const mio = ++pedidoSerie;
  const serie = await obtenerJSON(config.apiBaseUrl, `/inicio/finanzas-serie?${consulta}`);
  if (mio !== pedidoSerie) return;
  if (!serie) { mensajeEnGrafico('No se pudo cargar el gráfico. Intenta de nuevo.'); return; }
  dibujarGrafico(serie);
}

// ---------------------------------------------------------------------------
// Mini-tablas reutilizables (Productos más vendidos / Stock bajo / Clientes
// recientes / Ventas recientes): mismo esqueleto <table>, cada una arma sus
// propias filas.
// ---------------------------------------------------------------------------

function iniTabla(columnas, filas, vacioTexto) {
  if (!filas.length) return `<p class="tabla-vacia">${escapeHtml(vacioTexto)}</p>`;
  return `<table class="ini-mini-tabla"><tbody>${filas.map((f, i) => `<tr>${columnas.map(c => c(f, i)).join('')}</tr>`).join('')}</tbody></table>`;
}

// `icono` ya viene armado (cuadroIcono() o avatarIniciales(), ambos se pintan solos) --
// iniTabla() no le agrega ningún envoltorio extra, para que un avatar circular no termine
// metido dentro de un cuadro pensado para un ícono SVG.
const colIcono = (icono) => `<td class="ini-mini-icono">${icono}</td>`;
const colNombre = (texto, sub) => `<td class="ini-mini-nombre">${escapeHtml(texto)}${sub ? `<span class="ini-mini-sub">${escapeHtml(sub)}</span>` : ''}</td>`;
const colValor = (texto, clase = '') => `<td class="ini-mini-valor num ${clase}">${texto}</td>`;
const cuadroIcono = (icono, clase) => `<span class="ini-mini-icono-cuadro ${clase || ''}">${icono}</span>`;

function avatarIniciales(nombre, indice) {
  const inicial = (nombre || '?').trim().charAt(0).toUpperCase();
  const paleta = ['teal', 'blue', 'purple', 'orange', 'coral'];
  return `<span class="ini-avatar ini-avatar-${paleta[indice % paleta.length]}">${escapeHtml(inicial)}</span>`;
}

// ---------------------------------------------------------------------------
// Secciones (cada una pinta su(s) panel(es) y, si aplica, agrega su KPI)
// ---------------------------------------------------------------------------

function seccionVentas(v, kpis) {
  kpis.push({ orden: 1, html: kpiCard({
    acento: 'teal', icono: ICONO_CART, label: 'Ventas', value: fmtNum(v.total_mes),
    sub: `${v.cantidad_mes} venta(s) este mes`, delta: deltaPorcentaje(v.total_mes, v.total_mes_anterior), tendencia: v.tendencia
  }) });

  document.getElementById('panelTopProductos').style.display = '';
  document.getElementById('listaTopProductos').innerHTML = iniTabla([
    (p) => colIcono(cuadroIcono(ICONO_PACKAGE, 'teal')),
    (p) => colNombre(p.nombre),
    (p) => colValor(fmtNum(p.monto))
  ], v.top_productos, 'Todavía no hay ventas registradas.');

  if (v.recientes?.length) {
    document.getElementById('panelVentasRecientes').style.display = '';
    document.getElementById('listaVentasRecientes').innerHTML = iniTabla([
      (r) => colIcono(cuadroIcono(ICONO_CART, 'teal')),
      (r) => colNombre(r.producto, r.cliente || ''),
      (r) => `<td class="ini-mini-badge"><span class="ini-badge">${escapeHtml(r.categoria || 'Sin categoría')}</span></td>`,
      (r) => colValor(fmtNum(r.monto))
    ], v.recientes, 'Todavía no hay ventas registradas.');
  }

  // Dona "Ventas por categoría": top 5 + "Otros" si hay más -- de otro modo la leyenda se
  // llena de categorías con una sola venta y se vuelve ilegible.
  const panelDonut = document.getElementById('panelDonutCategorias');
  panelDonut.style.display = '';
  const categorias = v.por_categoria || [];
  const top5 = categorias.slice(0, 5);
  const restoMonto = categorias.slice(5).reduce((s, c) => s + c.monto, 0);
  const etiquetas = top5.map(c => c.categoria).concat(restoMonto > 0 ? ['Otros'] : []);
  const valores = top5.map(c => c.monto).concat(restoMonto > 0 ? [restoMonto] : []);
  document.getElementById('donutCategoriasVacio').style.display = valores.some(x => x) ? 'none' : '';
  if (valores.some(x => x)) {
    if (donutInstance) { donutInstance.destroy(); donutInstance = null; }
    donutInstance = crearGraficoDona(document.getElementById('donutCategorias').getContext('2d'), { etiquetas, valores, colores: PALETA_CATEGORICA });
  }
}

function seccionInventario(inv, kpis) {
  // Sin historial diario de stock: mostrar un % inventado sería justo lo que este proyecto
  // decidió no hacer nunca (ver memoria del rediseño). La tarjeta se queda sin tendencia/delta.
  kpis.push({ orden: 4, html: kpiCard({
    acento: 'orange', icono: ICONO_PACKAGE, label: 'Productos en stock', value: fmtNum(inv.total),
    sub: inv.alertas_total ? `<span style="color:var(--coral);">${inv.alertas_total} con stock bajo</span>` : 'Todo el stock por encima del mínimo'
  }) });

  document.getElementById('panelStockBajo').style.display = '';
  document.getElementById('listaStockBajo').innerHTML = iniTabla([
    (p) => colIcono(cuadroIcono(ICONO_PACKAGE, 'coral')),
    (p) => colNombre(p.nombre),
    (p) => colValor(`${fmtNum(p.stock)} u.`, 'ini-valor-coral'),
    (p) => colValor(`mín. ${fmtNum(p.stock_minimo)}`)
  ], inv.alertas.slice(0, 6), 'Ningún producto está en su stock mínimo o por debajo.');

  document.getElementById('panelVencimientos').style.display = '';
  document.getElementById('listaVencimientos').innerHTML = inv.vencimientos.length
    ? inv.vencimientos.map(p => {
        const urgente = p.dias <= 7;
        return `<div class="rank-row"><span class="rank-name">${escapeHtml(p.nombre)}</span><span class="rank-val" style="${urgente ? 'color:var(--coral);' : ''}">${escapeHtml(p.fecha_vencimiento)}${p.dias < 0 ? ' (vencido)' : ` (${p.dias} día${p.dias === 1 ? '' : 's'})`}</span></div>`;
      }).join('')
    : '<div class="rank-row">Ningún producto vence en los próximos 30 días.</div>';
}

function seccionClientes(c, kpis) {
  kpis.push({ orden: 3, html: kpiCard({
    acento: 'purple', icono: ICONO_USERS, label: 'Clientes', value: fmtNum(c.total),
    sub: c.top[0] ? `Top: ${escapeHtml(c.top[0].nombre)}` : 'Todavía no hay clientes.', tendencia: c.tendencia
  }) });

  const panel = document.getElementById('panelClientesRecientes');
  const filas = c.recientes ?? [];
  if (filas.length) {
    panel.style.display = '';
    document.getElementById('listaClientesRecientes').innerHTML = iniTabla([
      (cl, i) => colIcono(avatarIniciales(cl.nombre, i)),
      (cl) => colNombre(cl.nombre),
      (cl) => colValor(`${fmtNum(cl.compras)} compra${cl.compras === 1 ? '' : 's'}`),
      (cl) => colValor(cl.ultima_compra ? cl.ultima_compra.split('-').reverse().join('/') : '—')
    ], filas, 'Todavía no hay compras registradas.');
  }
}

function seccionFinanzas(f, kpis) {
  const { ingresos_mes, egresos_mes, neto_mes, neto_mes_anterior } = f;

  kpis.push({ orden: 2, html: kpiCard({
    acento: 'blue', icono: ICONO_CHART_BAR, label: 'Utilidad neta', value: fmtNum(neto_mes),
    sub: `Ingresos ${fmtCorto(ingresos_mes)} · Gastos ${fmtCorto(egresos_mes)}`,
    delta: deltaPorcentaje(neto_mes, neto_mes_anterior), tendencia: f.tendencia
  }) });

  document.getElementById('panelChart').style.display = '';
  document.getElementById('chartPeriodo').addEventListener('change', (e) => {
    document.getElementById('chartPeriodoCustom').style.display = e.target.value === 'personalizado' ? '' : 'none';
    cambiarPeriodoDelGrafico();
  });
  document.getElementById('chartDesde').addEventListener('change', cambiarPeriodoDelGrafico);
  document.getElementById('chartHasta').addEventListener('change', cambiarPeriodoDelGrafico);
  dibujarGrafico(f.serie); // "Este año" ya vino en el resumen

  const margen = (actual, anterior) => (anterior ? (actual / anterior) * 100 : null);
  const margenMes = margen(neto_mes, ingresos_mes);
  const margenAnterior = margen(f.neto_mes_anterior, f.ingresos_mes_anterior);
  const deltaMargen = margenMes !== null && margenAnterior !== null
    ? deltaPorcentaje(margenMes, margenAnterior) : null;

  document.getElementById('panelResumenFinanciero').style.display = '';
  document.getElementById('listaResumenFinanciero').innerHTML = [
    { icono: ICONO_CART, clase: 'teal', label: 'Ingresos', valor: fmtNum(ingresos_mes), delta: deltaPorcentaje(ingresos_mes, f.ingresos_mes_anterior) },
    { icono: ICONO_RECEIPT, clase: 'coral', label: 'Gastos', valor: fmtNum(egresos_mes), delta: deltaPorcentaje(egresos_mes, f.egresos_mes_anterior) },
    { icono: ICONO_CHART_BAR, clase: 'blue', label: 'Utilidad neta', valor: fmtNum(neto_mes), delta: deltaPorcentaje(neto_mes, neto_mes_anterior) },
    { icono: ICONO_PERCENT, clase: 'purple', label: 'Margen de utilidad', valor: margenMes !== null ? `${margenMes.toFixed(1)}%` : '—', delta: deltaMargen }
  ].map(r => `<div class="ini-fin-row">
    <span class="ini-fin-icono ${r.clase}">${r.icono}</span>
    <span class="ini-fin-label">${r.label}</span>
    <span class="ini-fin-valor num">${r.valor}</span>
    ${r.delta ? `<span class="ini-fin-delta ${r.delta.direccion}" title="${escapeHtml(r.delta.texto.replace('vs. período anterior', 'vs. mes anterior'))}">${r.delta.direccion === 'up' ? '▲' : '▼'} ${r.delta.texto.match(/^[\d.]+%/)[0]}</span>` : '<span class="ini-fin-delta"></span>'}
  </div>`).join('');
}

// ---------------------------------------------------------------------------
// Tareas y pendientes + Mapa de sucursales
// ---------------------------------------------------------------------------

function seccionPendientes(resumen) {
  const items = [];
  if (resumen.inventario?.alertas_total) {
    items.push({ icono: ICONO_ALERT_TRIANGLE, clase: 'orange', texto: `${resumen.inventario.alertas_total} producto${resumen.inventario.alertas_total === 1 ? '' : 's'} con stock bajo`, enlace: 'inventario' });
  }
  const p = resumen.pendientes || {};
  if (p.compras_por_recibir) items.push({ icono: ICONO_RECEIPT, clase: 'blue', texto: `${p.compras_por_recibir} compra${p.compras_por_recibir === 1 ? '' : 's'} por recibir`, enlace: 'compras' });
  if (p.cajas_abiertas) items.push({ icono: ICONO_CASH, clase: 'purple', texto: `${p.cajas_abiertas} caja${p.cajas_abiertas === 1 ? '' : 's'} abierta${p.cajas_abiertas === 1 ? '' : 's'}`, enlace: 'cajas' });
  if (p.documentos_por_vencer) items.push({ icono: ICONO_FOLDER, clase: 'coral', texto: `${p.documentos_por_vencer} documento${p.documentos_por_vencer === 1 ? '' : 's'} de RRHH por vencer`, enlace: 'rrhh' });

  if (!items.length) return;
  document.getElementById('panelPendientes').style.display = '';
  document.getElementById('listaPendientes').innerHTML = items.map(i => `
    <a class="ini-pendiente-row" href="${i.enlace}">
      <span class="ini-pendiente-icono ${i.clase}">${i.icono}</span>
      <span class="ini-pendiente-texto">${i.texto}</span>
    </a>`).join('');
}

function seccionSucursales(lista) {
  if (!lista?.length) return;
  document.getElementById('panelSucursales').style.display = '';
  const max = Math.max(...lista.map(s => Math.abs(s.neto_mes)), 1);
  document.getElementById('listaSucursales').innerHTML = lista.map(s => {
    const delta = deltaPorcentaje(s.neto_mes, s.neto_mes_anterior);
    return `<div class="ini-sucursal-row">
      <span class="ini-sucursal-icono">${ICONO_PIN}</span>
      <div class="ini-sucursal-info">
        <div class="ini-sucursal-top">
          <span class="ini-sucursal-nombre">${escapeHtml(s.nombre)}</span>
          <span class="ini-sucursal-valor num">${fmtCorto(s.neto_mes)}</span>
        </div>
        <div class="ini-sucursal-bar-bg"><div class="ini-sucursal-bar-fill" style="width:${Math.max(4, Math.min(100, (Math.abs(s.neto_mes) / max) * 100)).toFixed(0)}%"></div></div>
      </div>
      ${delta ? `<span class="ini-sucursal-delta ${delta.direccion}">${delta.direccion === 'up' ? '▲' : '▼'} ${delta.texto.replace('vs. período anterior', '')}</span>` : ''}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------

(async function iniciar() {
  config = await cargarConfigEmpresa();
  renderSidebar(config, 'inicio');
  await renderTopbar(config);
  renderFooter();
  pintarSaludo();

  const resumen = await obtenerJSON(config.apiBaseUrl, '/inicio/resumen');
  if (!resumen) {
    document.getElementById('kpisResumen').innerHTML = '<div class="rank-row">No se pudo cargar el resumen. Revisa tu conexión y recarga la página.</div>';
    return;
  }

  const kpis = [];
  if (resumen.ventas) seccionVentas(resumen.ventas, kpis);
  if (resumen.inventario) seccionInventario(resumen.inventario, kpis);
  if (resumen.clientes) seccionClientes(resumen.clientes, kpis);
  if (resumen.finanzas) seccionFinanzas(resumen.finanzas, kpis);
  seccionPendientes(resumen);
  seccionSucursales(resumen.sucursales);

  if (!kpis.length) {
    document.getElementById('sinPermisos').style.display = '';
    return;
  }
  document.getElementById('kpisResumen').innerHTML = kpis.sort((a, b) => a.orden - b.orden).map(k => k.html).join('');

  // Cada fila de 3 paneles se muestra si AL MENOS UNO de sus paneles quedó visible --
  // el permiso que activa cada panel es independiente (ventas.ver, finanzas.ver...), así
  // que la fila no puede depender de uno solo de ellos.
  const mostrarFilaSiHayPanel = (filaId, panelIds) => {
    if (panelIds.some(id => document.getElementById(id).style.display === '')) {
      document.getElementById(filaId).style.display = '';
    }
  };
  mostrarFilaSiHayPanel('filaGraficos', ['panelChart', 'panelDonutCategorias', 'panelResumenFinanciero']);
  mostrarFilaSiHayPanel('filaListas', ['panelTopProductos', 'panelStockBajo', 'panelClientesRecientes']);
  mostrarFilaSiHayPanel('filaFinal', ['panelVentasRecientes', 'panelPendientes', 'panelSucursales']);
})();
