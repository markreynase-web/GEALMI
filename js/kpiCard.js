// js/kpiCard.js
// Tarjeta KPI reutilizable entre dashboards bespoke (Inicio, Ventas, y los
// que sigan -- Rediseño v3: "cada módulo tiene su propia experiencia" pero
// comparten los mismos bloques de UI). Antes vivía duplicado como función
// local dentro del <script> inline de pages/inicio.html; se movió acá para
// que Ventas (y los próximos módulos bespoke) no tengan que reescribirlo.

import { escapeHtml } from './utils.js';

// Mini-gráfico de área inline (sin Chart.js -- es puramente decorativo y
// entra directo por innerHTML como el resto de la tarjeta). Solo tiene
// sentido con una tendencia REAL detrás (ver backend/src/routes/inicio.js,
// tendenciaDiaria()); nunca se inventa una serie para rellenar una tarjeta.
function sparklineSvg(valores) {
  if (!Array.isArray(valores) || valores.length < 2) return '';
  const w = 72, h = 30;
  const max = Math.max(...valores), min = Math.min(...valores);
  const rango = max - min || 1;
  const paso = w / (valores.length - 1);
  const linea = valores.map((v, i) => `${(i * paso).toFixed(1)},${(h - ((v - min) / rango) * (h - 3) - 1.5).toFixed(1)}`).join(' ');
  return `<svg class="kpi-card-spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <polyline points="0,${h} ${linea} ${w},${h}" class="kpi-card-spark-area"/>
    <polyline points="${linea}" class="kpi-card-spark-linea"/>
  </svg>`;
}

export function kpiCard({ acento, icono, label, value, sub, barra = 85, delta = null, tendencia = null }) {
  const deltaHtml = delta
    ? `<div class="kpi-card-delta ${delta.direccion}">${delta.direccion === 'up' ? '▲' : '▼'} ${delta.texto}</div>`
    : '';
  // tendencia reemplaza la barra de progreso genérica por un sparkline arriba, junto al
  // ícono -- la barra de progreso (0-100%, para módulos sin una serie temporal real) se
  // queda para los dashboards que ya la usan (Ventas y los que siguieron su patrón).
  const spark = tendencia ? sparklineSvg(tendencia) : '';
  return `<div class="kpi-card" data-acento="${acento}">
    <div class="kpi-card-top">
      <div class="kpi-card-icon">${icono}</div>
      ${spark ? `<div class="kpi-card-spark ${delta?.direccion === 'down' ? 'down' : 'up'}">${spark}</div>` : ''}
    </div>
    <div class="label">${escapeHtml(label)}</div>
    <div class="value num">${value}</div>
    ${deltaHtml}
    <div class="sub">${sub || ''}</div>
    ${!spark ? `<div class="kpi-card-bar"><div class="kpi-card-bar-fill" style="width:${barra}%"></div></div>` : ''}
  </div>`;
}

// Compara dos sumas ya calculadas (período actual vs. anterior) y arma el
// objeto {direccion, texto} que espera kpiCard(). null si el período
// anterior es 0 -- un "% vs. anterior" calculado desde cero sería un
// número inventado, no una tendencia real.
//
// Math.abs(anterior) en el denominador (no `anterior` a secas): para sumas o
// conteos SIEMPRE positivos (ventas, clientes...) no cambia nada. Pero un
// balance/neto SÍ puede ser negativo -- sin el valor absoluto, un balance
// anterior negativo invertiría el signo del cambio (ver el mismo ajuste que
// ya existía por separado en pages/inicio.html y js/finanzasDashboard.js
// antes de centralizarlo acá).
export function deltaPorcentaje(actual, anterior, sufijo = 'vs. período anterior') {
  if (!anterior) return null;
  const pct = ((actual - anterior) / Math.abs(anterior)) * 100;
  return { direccion: pct >= 0 ? 'up' : 'down', texto: `${Math.abs(pct).toFixed(1)}% ${sufijo}` };
}

// Caso especial de deltaPorcentaje: mes calendario actual vs. mes calendario
// anterior, sumando un campo monto sobre filas con un campo fecha. Lo usa
// Inicio, donde el "período" siempre es el mes -- no un rango que el
// usuario elige (a diferencia de Ventas, que sí tiene su propio selector).
export function calcularDeltaMensual(filas, campoFecha, campoMonto, filtroTipo) {
  const hoy = new Date();
  const mesActual = hoy.getMonth(), anioActual = hoy.getFullYear();
  const refPrevio = new Date(anioActual, mesActual - 1, 1);
  const sumaMes = (mes, anio) => filas
    .filter(f => (!filtroTipo || filtroTipo(f)) && f[campoFecha])
    .filter(f => { const d = new Date(f[campoFecha]); return d.getMonth() === mes && d.getFullYear() === anio; })
    .reduce((s, f) => s + (Number(f[campoMonto]) || 0), 0);
  return deltaPorcentaje(sumaMes(mesActual, anioActual), sumaMes(refPrevio.getMonth(), refPrevio.getFullYear()));
}
