// js/dashboard.js
// Render principal del panel. Recibe la fuente de datos ya resuelta (filas/mapa/stats/cols)
// y actualiza todo el DOM: hero, KPIs, gráfico principal, rankings, categorías, tabla de debug.
//
// IMPORTANTE (seguridad): cualquier valor que venga del archivo del usuario (nombres de
// columna, valores de celdas) pasa por escapeHtml() antes de insertarse con innerHTML.
// Nunca insertes un valor del CSV directamente en un template string de innerHTML.

import { fmtNum, escapeHtml } from './utils.js';
import { rangoFechasDisponible, filtrarPeriodo, sincronizarSelectorDeRango } from './filters.js';
import {
  crearGraficoLineaFecha, crearGraficoBarras, crearGraficoDona,
  crearGraficoLineaSecundario, crearGraficoBarrasSecundario
} from './charts.js';

let mainChartInstance = null;
let catChartInstance = null;
let secundariosChartInstances = [];

function renderSecundarios(mapa, actual, tieneFecha, tieneCat1) {
  const section = document.getElementById('secundariosSection');
  const grid = document.getElementById('secundariosGrid');
  secundariosChartInstances.forEach(c => c.destroy());
  secundariosChartInstances = [];
  grid.innerHTML = '';

  const otrosNum = mapa.otrosNum || [];
  if (!otrosNum.length || (!tieneFecha && !tieneCat1)) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  otrosNum.forEach((col, idx) => {
    const canvasId = `secChart_${idx}`;
    const modoFecha = tieneFecha;
    const tag = modoFecha ? 'por fecha' : `por ${mapa.colCat1}`;
    grid.insertAdjacentHTML('beforeend',
      `<div class="sec-chart-panel"><h4>${escapeHtml(col)} <span class="tag">${escapeHtml(tag)}</span></h4><div class="chart-wrap"><canvas id="${canvasId}"></canvas></div></div>`
    );

    const agrupado = {};
    actual.forEach(r => {
      const v = r._extra ? r._extra[col] : NaN;
      if (isNaN(v)) return;
      const clave = modoFecha ? r._fecha : r._cat1;
      if (!clave) return;
      agrupado[clave] = (agrupado[clave] || 0) + v;
    });

    const ctx = document.getElementById(canvasId).getContext('2d');
    if (modoFecha) {
      const fechas = Object.keys(agrupado).sort();
      if (!fechas.length) {
        document.getElementById(canvasId).closest('.chart-wrap').innerHTML = '<div class="chart-empty">Sin datos numéricos válidos en esta columna.</div>';
        return;
      }
      secundariosChartInstances.push(crearGraficoLineaSecundario(ctx, {
        fechas, valores: fechas.map(f => agrupado[f]), label: col,
        color: '#0F6E56', colorFondo: 'rgba(15,110,86,0.15)'
      }));
    } else {
      const top = Object.entries(agrupado).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (!top.length) {
        document.getElementById(canvasId).closest('.chart-wrap').innerHTML = '<div class="chart-empty">Sin datos numéricos válidos en esta columna.</div>';
        return;
      }
      secundariosChartInstances.push(crearGraficoBarrasSecundario(ctx, {
        etiquetas: top.map(r => r[0]), valores: top.map(r => r[1]), label: col, color: '#B8871F'
      }));
    }
  });
}

function renderOtrasCategorias(mapa, actual, tieneNum) {
  const section = document.getElementById('otrasCategoriasSection');
  const grid = document.getElementById('otrasCategoriasGrid');
  grid.innerHTML = '';

  const otrasCat = mapa.otrasCat || [];
  if (!otrasCat.length) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  otrasCat.forEach(col => {
    const agrupado = {};
    actual.forEach(r => {
      const clave = (r._extraCat && r._extraCat[col]) || 'Sin dato';
      agrupado[clave] = (agrupado[clave] || 0) + (tieneNum ? (isNaN(r._numero) ? 0 : r._numero) : 1);
    });
    const top = Object.entries(agrupado).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxVal = Math.max(1, ...top.map(r => r[1]));
    const filas = top.map(([nombre, val]) =>
      `<div class="cat-row"><div class="top"><span>${escapeHtml(nombre)}</span><span>${fmtNum(val)}</span></div><div class="cat-bar-bg"><div class="cat-bar-fill" style="width:${(val / maxVal * 100).toFixed(0)}%"></div></div></div>`
    ).join('');
    grid.insertAdjacentHTML('beforeend',
      `<div class="sec-chart-panel"><h4>${escapeHtml(col)} <span class="tag">${tieneNum ? 'suma' : 'conteo'}</span></h4>${filas || '<div class="chart-empty">Sin datos</div>'}</div>`
    );
  });
}

export function renderTodo(fuente, opciones = {}) {
  const { filas, mapa, stats, cols } = fuente;
  const dom = {
    dateRangeWrap: document.getElementById('dateRangeWrap'),
    fechaDesde: document.getElementById('fechaDesde'),
    fechaHasta: document.getElementById('fechaHasta'),
  };
  sincronizarSelectorDeRango(mapa, filas, dom);
  const desdeStr = mapa.colFecha ? dom.fechaDesde.value : '';
  const hastaStr = mapa.colFecha ? dom.fechaHasta.value : '';
  const { actual, anterior, rango } = mapa.colFecha ? filtrarPeriodo(filas, desdeStr, hastaStr) : { actual: filas, anterior: [] };

  const tieneNum = !!mapa.colNum, tieneFecha = !!mapa.colFecha, tieneCat1 = !!mapa.colCat1, tieneCat2 = !!mapa.colCat2;
  const sumaActual = tieneNum ? actual.reduce((s, r) => s + (isNaN(r._numero) ? 0 : r._numero), 0) : actual.length;

  // Nombres de columna (mapa.colNum, mapa.colCat1, etc.) vienen del encabezado del CSV:
  // son datos del usuario y se escapan igual que cualquier valor de celda.
  document.getElementById('heroLabel').textContent = tieneNum ? `Total de ${mapa.colNum}` : 'Total de registros';
  document.getElementById('heroTotal').textContent = fmtNum(sumaActual);

  const stampEl = document.getElementById('heroDelta');
  const esRangoParcial = tieneFecha && rango && !(desdeStr === rango.min && hastaStr === rango.max);
  if (esRangoParcial && anterior.length) {
    const sumaAnterior = tieneNum ? anterior.reduce((s, r) => s + (isNaN(r._numero) ? 0 : r._numero), 0) : anterior.length;
    const delta = sumaAnterior > 0 ? ((sumaActual - sumaAnterior) / sumaAnterior * 100) : 0;
    stampEl.textContent = (delta >= 0 ? "＋" : "") + delta.toFixed(0) + "% vs periodo anterior equivalente";
    stampEl.className = "stamp " + (delta >= 0 ? "up" : "down");
  } else {
    stampEl.textContent = `${actual.length} registros`;
    stampEl.className = "stamp neutral";
  }
  // textContent es seguro por sí mismo (no interpreta HTML), pero mantenemos la nota
  // porque cols.join(', ') incluye nombres de columna del usuario.
  document.getElementById('heroMeta').textContent = `${actual.length} filas · columnas: ${cols.join(', ')}`;

  document.getElementById('kpi1Label').textContent = tieneNum ? `Promedio de ${mapa.colNum}` : (tieneCat1 ? `Categorías únicas (${mapa.colCat1})` : 'Registros');
  document.getElementById('kpi1Value').textContent = tieneNum ? fmtNum(actual.length ? sumaActual / actual.length : 0) : (tieneCat1 ? new Set(actual.map(r => r._cat1)).size : actual.length);
  document.getElementById('kpiCount').textContent = actual.length;
  document.getElementById('kpi3Label').textContent = tieneCat1 ? `Top ${mapa.colCat1}` : '—';

  const porCat1 = {};
  if (tieneCat1) actual.forEach(r => porCat1[r._cat1] = (porCat1[r._cat1] || 0) + (tieneNum ? (isNaN(r._numero) ? 0 : r._numero) : 1));
  const rankingCat1 = Object.entries(porCat1).sort((a, b) => b[1] - a[1]);
  // textContent: seguro aunque r[0] sea un valor de categoría arbitrario del CSV.
  document.getElementById('kpi3Value').textContent = rankingCat1[0] ? rankingCat1[0][0] : "—";

  document.getElementById('rankTitle').textContent = tieneCat1 ? `Top ${mapa.colCat1}` : 'Top valores';
  document.getElementById('rankList').innerHTML = rankingCat1.slice(0, 5).map((r, i) =>
    `<div class="rank-row"><span class="rank-num">${i + 1}</span><span class="rank-name">${escapeHtml(r[0])}</span><span class="rank-val">${fmtNum(r[1])}</span></div>`
  ).join('') || '<div class="rank-row">No se detectó una columna de categoría</div>';

  document.getElementById('catTitle').textContent = tieneCat1 ? `Distribución por ${mapa.colCat1}` : 'Distribución';
  const catEntries = Object.entries(porCat1).sort((a, b) => b[1] - a[1]).slice(0, 8);
  // Dona en vez de las barras de progreso de antes: "distribución" es
  // justamente lo que un gráfico circular comunica mejor (proporción del
  // total), y el catChartWrap tiene su propio id fijo -- no se busca a
  // través del <canvas>, que puede no existir si la vez anterior no había
  // categoría (mismo motivo que el arreglo de mainChartWrap más abajo).
  const catWrap = document.getElementById('catChartWrap');
  catWrap.innerHTML = '<canvas id="catChart"></canvas>';
  if (catChartInstance) { catChartInstance.destroy(); catChartInstance = null; }
  if (!catEntries.length) {
    catWrap.innerHTML = '<div class="chart-empty">Sin columna de categoría detectada</div>';
  } else {
    const ctxCat = document.getElementById('catChart').getContext('2d');
    // Chart.js dibuja las etiquetas como texto en el canvas (leyenda/tooltip),
    // no vía innerHTML -- no hace falta (ni conviene) escapeHtml() acá, igual
    // que en las etiquetas del gráfico de barras más abajo.
    catChartInstance = crearGraficoDona(ctxCat, {
      etiquetas: catEntries.map(e => e[0]),
      valores: catEntries.map(e => e[1])
    });
  }

  document.getElementById('secTitle').textContent = tieneCat2 ? `Por ${mapa.colCat2}` : 'Otra dimensión';
  if (tieneCat2) {
    const porCat2 = {};
    actual.forEach(r => porCat2[r._cat2] = (porCat2[r._cat2] || 0) + (tieneNum ? (isNaN(r._numero) ? 0 : r._numero) : 1));
    document.getElementById('secList').innerHTML = Object.entries(porCat2).sort((a, b) => b[1] - a[1]).slice(0, 5).map((r, i) =>
      `<div class="rank-row"><span class="rank-num">${i + 1}</span><span class="rank-name">${escapeHtml(r[0])}</span><span class="rank-val">${fmtNum(r[1])}</span></div>`
    ).join('');
  } else {
    document.getElementById('secList').innerHTML = '<div class="rank-row">No se detectó una segunda columna de categoría</div>';
  }

  // Se busca por el id fijo del wrapper, no por .closest() desde el canvas:
  // si el renderTodo() anterior no tenía fecha ni categoría para graficar,
  // #mainChart ya no existe (se reemplazó por el div "sin datos") y
  // document.getElementById('mainChart') hubiera devuelto null.
  const chartWrap = document.getElementById('mainChartWrap');
  chartWrap.innerHTML = '<canvas id="mainChart"></canvas>';
  const ctx = document.getElementById('mainChart').getContext('2d');
  if (mainChartInstance) { mainChartInstance.destroy(); mainChartInstance = null; }

  if (opciones.dibujarGraficoPrincipal) {
    // El caller (js/app.js) decide cómo se ve el gráfico principal para su
    // módulo (ej. Finanzas: comparativo ingresos/egresos) en vez de la
    // detección automática de fecha/categoría genérica de acá abajo.
    // dashboard.js sigue siendo el único dueño de mainChartInstance (crea y
    // destruye el canvas), solo delega qué dibujar adentro.
    document.getElementById('chartTitle').innerHTML = opciones.tituloGraficoPrincipal || 'Vista principal';
    mainChartInstance = opciones.dibujarGraficoPrincipal(ctx, actual, fuente);
    if (!mainChartInstance) {
      chartWrap.innerHTML = '<div class="chart-empty">Todavía no hay datos para graficar.</div>';
    }
  } else if (tieneFecha) {
    document.getElementById('chartTitle').innerHTML = `Evolución por fecha <span class="tag" id="chartTag">${escapeHtml(tieneNum ? mapa.colNum : 'conteo')}</span>`;
    const porDia = {};
    actual.forEach(r => { if (r._fecha) porDia[r._fecha] = (porDia[r._fecha] || 0) + (tieneNum ? (isNaN(r._numero) ? 0 : r._numero) : 1); });
    const fechas = Object.keys(porDia).sort();

    if (fechas.length === 0) {
      chartWrap.innerHTML = '<div class="chart-empty">No se pudieron interpretar las fechas de esta columna. Revisa el formato en tu archivo (ej. AAAA-MM-DD o DD/MM/AAAA).</div>';
    } else {
      mainChartInstance = crearGraficoLineaFecha(ctx, {
        fechas, valores: fechas.map(f => porDia[f]), label: tieneNum ? mapa.colNum : 'conteo',
        color: '#E85C4A', colorFondo: 'rgba(232,92,74,0.15)'
      });
    }
  } else if (tieneCat1) {
    document.getElementById('chartTitle').innerHTML = `Por ${escapeHtml(mapa.colCat1)} <span class="tag" id="chartTag">${escapeHtml(tieneNum ? mapa.colNum : 'conteo')}</span>`;
    const top10 = rankingCat1.slice(0, 10);
    mainChartInstance = crearGraficoBarras(ctx, {
      etiquetas: top10.map(r => r[0]), valores: top10.map(r => r[1]), label: tieneNum ? mapa.colNum : 'conteo', color: '#1A4FBF'
    });
  } else {
    document.getElementById('chartTitle').innerHTML = `Vista principal <span class="tag" id="chartTag">—</span>`;
    chartWrap.innerHTML = '<div class="chart-empty">No se detectó una columna de fecha ni de categoría para graficar.</div>';
  }

  renderSecundarios(mapa, actual, tieneFecha, tieneCat1);
  renderOtrasCategorias(mapa, actual, tieneNum);

  const debugBody = document.querySelector('#debugTable tbody');
  const rolPorCol = {};
  if (mapa.colFecha) rolPorCol[mapa.colFecha] = { rol: 'Fecha', clase: 'role-fecha' };
  if (mapa.colNum) rolPorCol[mapa.colNum] = { rol: 'Numérico principal', clase: 'role-numerico' };
  (mapa.otrosNum || []).forEach(c => rolPorCol[c] = { rol: 'Numérico secundario', clase: 'role-numerico' });
  if (mapa.colCat1) rolPorCol[mapa.colCat1] = { rol: 'Categoría principal', clase: 'role-categoria' };
  if (mapa.colCat2) rolPorCol[mapa.colCat2] = { rol: 'Categoría secundaria', clase: 'role-categoria' };
  (mapa.otrasCat || []).forEach(c => rolPorCol[c] = { rol: 'Categoría adicional', clase: 'role-categoria' });
  debugBody.innerHTML = cols.map(c => {
    const r = rolPorCol[c] || { rol: 'No usada', clase: 'role-otro' };
    const validos = stats && stats[c] ? `${Math.round((stats[c].nonEmpty) / (actual.length || 1) * 100)}% con datos` : '—';
    return `<tr><td>${escapeHtml(c)}</td><td><span class="role-badge ${r.clase}">${r.rol}</span></td><td>${validos}</td></tr>`;
  }).join('');
}

export function redimensionarTodosLosGraficos() {
  if (mainChartInstance) mainChartInstance.resize();
  if (catChartInstance) catChartInstance.resize();
  secundariosChartInstances.forEach(c => c.resize());
}
