// js/exportarPDF.js
// PDF real del "Resumen ejecutivo" de cada módulo (botón #exportPdfBtn de
// pages/*.html). Antes era window.print(): abría el diálogo de impresión del
// navegador y el resultado dependía del CSS de impresión y del navegador. Ahora
// se genera y se descarga un archivo .pdf directo, igual en todos lados.
//
// Dos fases, para no depender de ningún módulo en particular:
//   1. extraerModelo(): lee el <main> tal como está en pantalla y arma un
//      modelo neutro -- tarjetas KPI, paneles con su gráfico (canvas -> imagen),
//      rankings (.rank-row, .cat-row...) y tablas. Cualquier dashboard que use
//      los bloques comunes (.kpis, .panel, .sec-chart-panel, .hero) sale en el
//      PDF sin código extra; un módulo nuevo no necesita tocar este archivo.
//   2. dibujarPDF(): traduce ese modelo a jsPDF (A4 vertical) con encabezado,
//      pie numerado y saltos de página.
//
// jsPDF y autotable viven en lib/ (el CSP de vercel.json solo deja cargar
// scripts propios) y se piden recién al primer uso: no pesan en cada página.
// Versiones: jsPDF 4.2.1 (lib/jspdf.umd.min.js) y jspdf-autotable 5.0.8
// (lib/jspdf.plugin.autotable.min.js), ambas MIT, tal cual salen de
// node_modules/<paquete>/dist/. Para actualizar, reemplazar los dos archivos y
// volver a probar un PDF con gráficos (jsPDF 4 no usa eval: sirve con el CSP).
//
// Las funciones puras (limpiarTextoPDF, nombreArchivoPDF) no tocan el DOM a
// propósito: así se prueban desde Node (ver backend/tests/exportar-pdf.test.js).

const RUTA_JSPDF = '/lib/jspdf.umd.min.js';
const RUTA_AUTOTABLE = '/lib/jspdf.plugin.autotable.min.js';
const RUTA_LOGO = '/assets/brand/gealmi-apple-touch.png';

// A4 vertical, en milímetros.
const PAG = { w: 210, h: 297, margen: 14, arriba: 14, abajo: 18 };
const ANCHO_UTIL = PAG.w - 2 * PAG.margen; // 182
const SEPARACION_MITADES = 6;
const ANCHO_MITAD = (ANCHO_UTIL - SEPARACION_MITADES) / 2; // 88

// Tamaño (mm) con el que cada gráfico entra en la hoja.
const GRAFICO_COMPLETO = { w: ANCHO_UTIL, h: 78 };
const GRAFICO_MITAD = { w: ANCHO_MITAD, h: 62 };
const PX_POR_MM = 3.78; // 96 dpi: el gráfico se redibuja a este tamaño para que sus tipografías queden legibles
const ESCALA_GRAFICO = 3; // nitidez: píxeles reales por píxel CSS del gráfico

const COLOR = {
  tinta: [15, 23, 42], apagado: [75, 85, 99], linea: [226, 232, 240], suave: [241, 245, 249],
  cian: [60, 184, 146], verde: [10, 122, 92], rojo: [175, 75, 67], blanco: [255, 255, 255]
};
const ACENTOS = {
  teal: [60, 184, 146], blue: [28, 111, 150], green: [10, 122, 92],
  orange: [201, 138, 60], purple: [91, 79, 224], red: [175, 75, 67]
};

// ---------------------------------------------------------------------------
// Texto (funciones puras)
// ---------------------------------------------------------------------------

// Las fuentes estándar de jsPDF (Helvetica) solo traen Latin-1 + unos pocos
// signos de WinAnsi. Emojis, flechas (▲ ▼) y símbolos raros salen como basura,
// así que se descartan; tildes, ñ, «S/», «·», «—» y «…» sí están soportados.
// (el \n se conserva: separa líneas dentro de una celda.)
const NO_SOPORTADO = /[^\n -~ -ÿ–—‘’“”•…€™]/g;

export function limpiarTextoPDF(texto) {
  return String(texto ?? '')
    .replace(/[   \t\r\f\v]/g, ' ') // espacios "duros" (separador de miles, «p. m.») y tabuladores: a espacio normal
    .replace(/−/g, '-') // «−» tipográfico (los egresos): sin esto se perdería el signo
    .replace(/≤/g, '<=').replace(/≥/g, '>=')
    .replace(NO_SOPORTADO, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function fechaLocal(fecha) {
  const dos = n => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

export function nombreArchivoPDF(negocio, modulo, hoy = new Date()) {
  const base = [negocio, modulo, 'resumen ejecutivo', fechaLocal(hoy)]
    .map(parte => limpiarTextoPDF(parte))
    .filter(Boolean)
    .join(' - ')
    .replace(/[\\/:*?"<>|]/g, '') // caracteres que el sistema de archivos no acepta
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return `${base}.pdf`;
}

const PARECE_NUMERO = /^[-+]?\s*(S\/\.?|\$|€)?\s*[\d.,\s]+\s*%?$/;

// ---------------------------------------------------------------------------
// Carga de jsPDF + autotable (bajo demanda)
// ---------------------------------------------------------------------------

function cargarScript(src) {
  return new Promise((resolver, rechazar) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolver;
    s.onerror = () => rechazar(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

let promesaLibrerias = null;
export function cargarLibreriasPDF() {
  if (!promesaLibrerias) {
    promesaLibrerias = (async () => {
      if (!window.jspdf?.jsPDF) await cargarScript(RUTA_JSPDF);
      // El plugin se engancha solo a jsPDF al cargarse (versión UMD).
      if (!window.jspdf.jsPDF.API.autoTable) await cargarScript(RUTA_AUTOTABLE);
      if (!window.jspdf.jsPDF.API.autoTable) throw new Error('El complemento de tablas del PDF no se inicializó.');
      return window.jspdf.jsPDF;
    })().catch(err => { promesaLibrerias = null; throw err; }); // un fallo de red no debe quedar en caché
  }
  return promesaLibrerias;
}

async function cargarLogo() {
  try {
    const res = await fetch(RUTA_LOGO);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise(resolver => {
      const lector = new FileReader();
      lector.onload = () => resolver(lector.result);
      lector.onerror = () => resolver(null);
      lector.readAsDataURL(blob);
    });
  } catch {
    return null; // sin logo el PDF sale igual
  }
}

// ---------------------------------------------------------------------------
// Fase 1: leer la pantalla y armar el modelo
// ---------------------------------------------------------------------------

const IGNORAR = '.periodo-bar, .print-only, .debug-panel, script, style, [data-pdf-ignore]';
const ES_FILA = (el) => [...el.classList].some(c => /(^|-)row$/.test(c) || c === 'timeline-item' || c === 'ticket-card');

function visible(el) {
  return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// textContent pega los textos de los hijos sin separación ("Ana" + "ventas" =
// "Anaventas"): acá cada hijo va en su propia línea.
function textoDe(el) {
  if (!el) return '';
  const hijos = [...el.children].filter(visible);
  if (!hijos.length) return limpiarTextoPDF(el.textContent);
  const propio = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
  return limpiarTextoPDF([propio, ...hijos.map(textoDe)].filter(t => t && t.trim()).join('\n'));
}

function tituloDe(bloque) {
  const h = bloque.querySelector('h3, h4');
  if (!h) return { titulo: '', tag: '' };
  // Los avisos de interacción ("Clic para ver el perfil") no dicen nada en un papel.
  const tag = limpiarTextoPDF([...h.querySelectorAll('.tag')].map(t => t.textContent).filter(t => !/^\s*clic/i.test(t)).join(' · '));
  const copia = h.cloneNode(true);
  copia.querySelectorAll('.tag, a, button').forEach(n => n.remove());
  return { titulo: limpiarTextoPDF(copia.textContent), tag };
}

function periodoDe() {
  const tab = document.querySelector('.periodo-tab.activo');
  if (tab) {
    if (tab.dataset.periodo === 'personalizado') {
      const fechas = [...document.querySelectorAll('.periodo-custom-range input[type="date"]')].map(i => i.value).filter(Boolean);
      if (fechas.length === 2) return `Período: ${fechas[0]} al ${fechas[1]}`;
    }
    return `Período: ${limpiarTextoPDF(tab.textContent)}`;
  }
  const rango = document.getElementById('dateRangeWrap');
  if (visible(rango)) {
    const desde = document.getElementById('fechaDesde')?.value, hasta = document.getElementById('fechaHasta')?.value;
    if (desde && hasta) return `Período: ${desde} al ${hasta}`;
  }
  return 'Todo el período disponible';
}

// Redibuja el gráfico al tamaño (y nitidez) con que va a entrar en la hoja, lo
// captura y lo deja como estaba. En pantalla los gráficos son responsivos y
// miden lo que mida su tarjeta; en el PDF necesitan un tamaño predecible.
function capturarGrafico(canvas, { w, h }) {
  const anchoCss = Math.round(w * PX_POR_MM), altoCss = Math.round(h * PX_POR_MM);
  const chart = window.Chart?.getChart?.(canvas);
  if (!chart) return { imagen: canvas.toDataURL('image/png'), w, h }; // sin instancia: se usa el bitmap tal cual
  const dprPrevio = chart.options.devicePixelRatio;
  const maxAnchoPrevio = canvas.style.maxWidth, maxAltoPrevio = canvas.style.maxHeight;
  try {
    // El CSS de las tarjetas limita el canvas a su contenedor (max-width:100%);
    // Chart.js respeta ese tope y no dejaría agrandar el gráfico.
    canvas.style.maxWidth = 'none';
    canvas.style.maxHeight = 'none';
    chart.options.devicePixelRatio = ESCALA_GRAFICO;
    // Si la animación de entrada sigue en curso, update() no dibuja de inmediato (espera al
    // siguiente cuadro): se corta y se lleva el gráfico a su estado final.
    chart.stop();
    chart.update('none');
    chart.resize(anchoCss, altoCss);
    // resize() cambia el tamaño del canvas (lo deja en blanco) pero Chart.js redibuja con un
    // setTimeout: sin este update síncrono se capturaría un canvas vacío.
    chart.update('none');
    return { imagen: chart.canvas.toDataURL('image/png'), w, h };
  } finally {
    canvas.style.maxWidth = maxAnchoPrevio;
    canvas.style.maxHeight = maxAltoPrevio;
    chart.options.devicePixelRatio = dprPrevio;
    chart.resize();
    chart.update('none'); // vuelve a pintar ya, sin esperar al redibujado diferido (evita un parpadeo en blanco)
  }
}

function celdasDeFila(fila) {
  const origen = fila.classList.contains('cat-row') ? (fila.querySelector('.top') || fila) : fila;
  const hijos = [...origen.children].filter(visible);
  if (!hijos.length) return [textoDe(origen)].filter(Boolean);
  return hijos.map(textoDe).filter(Boolean); // descarta celdas sin texto (íconos, barras de progreso)
}

function tablaDe(tabla) {
  const columnasIgnoradas = new Set();
  const encabezado = [...tabla.querySelectorAll('thead th')];
  encabezado.forEach((th, i) => { if (th.classList.contains('col-acciones') || !th.textContent.trim()) columnasIgnoradas.add(i); });
  const head = encabezado.filter((_, i) => !columnasIgnoradas.has(i)).map(th => limpiarTextoPDF(th.textContent));
  const body = [...tabla.querySelectorAll('tbody tr')].filter(visible)
    .map(tr => [...tr.children].filter((_, i) => !columnasIgnoradas.has(i)).map(textoDe));
  return body.length ? { tipo: 'tabla', head, body } : null;
}

function contenidoDe(panel, tamanoGrafico) {
  const contenido = [];
  const nodos = [...panel.querySelectorAll('canvas, table, .chart-empty, .tabla-vacia, [class*="row"], .timeline-item, .ticket-card')];
  let filasPendientes = null;
  const cerrarFilas = () => {
    if (!filasPendientes) return;
    const conVarias = filasPendientes.some(f => f.length > 1);
    // Filas de un solo texto ("Sin ventas en este período.") son avisos, no una tabla.
    if (conVarias) contenido.push({ tipo: 'filas', filas: filasPendientes });
    else filasPendientes.forEach(f => contenido.push({ tipo: 'nota', texto: f.join(' ') }));
    filasPendientes = null;
  };
  let ultimaFila = null;
  for (const el of nodos) {
    if (!visible(el)) continue;
    if (ultimaFila && ultimaFila.contains(el)) continue; // hijos de una fila ya leída
    if (el.matches('canvas')) {
      cerrarFilas();
      contenido.push({ tipo: 'grafico', ...capturarGrafico(el, tamanoGrafico) });
    } else if (el.matches('table')) {
      cerrarFilas();
      const t = tablaDe(el);
      if (t) contenido.push(t);
    } else if (el.matches('.chart-empty, .tabla-vacia')) {
      cerrarFilas();
      const t = textoDe(el);
      if (t) contenido.push({ tipo: 'nota', texto: t });
    } else if (ES_FILA(el)) {
      const celdas = celdasDeFila(el);
      if (celdas.length) { (filasPendientes ??= []).push(celdas); ultimaFila = el; }
    }
  }
  cerrarFilas();
  return contenido;
}

function panelDe(el, mitad) {
  const { titulo, tag } = tituloDe(el);
  const contenido = contenidoDe(el, mitad ? GRAFICO_MITAD : GRAFICO_COMPLETO);
  if (!contenido.length) return null;
  return { tipo: 'panel', titulo, tag, contenido, mitad };
}

function kpisDe(contenedor) {
  return [...contenedor.querySelectorAll('.kpi-card')].filter(visible).map(card => {
    const delta = card.querySelector('.kpi-card-delta');
    return {
      label: textoDe(card.querySelector('.label')),
      value: textoDe(card.querySelector('.value')),
      sub: textoDe(card.querySelector('.sub')),
      delta: delta ? { dir: delta.classList.contains('down') ? 'down' : 'up', texto: limpiarTextoPDF(delta.textContent) } : null,
      acento: card.dataset.acento || 'teal'
    };
  }).filter(k => k.label || k.value);
}

// Cifra destacada arriba del dashboard: .hero (plantilla genérica) o .fin-hero (Finanzas: balance
// con su desglose de ingresos y egresos).
function heroDe(hero) {
  const delta = hero.querySelector('.stamp, .fin-hero-delta');
  const extras = [...hero.querySelectorAll('.fin-hero-desglose-item')].map(item => {
    const [etiqueta, valor] = [...item.children];
    return { label: textoDe(etiqueta), value: textoDe(valor), dir: valor?.classList.contains('egreso') ? 'down' : 'up' };
  }).filter(e => e.label && e.value);
  const bloque = {
    tipo: 'hero',
    label: textoDe(hero.querySelector('.label, .fin-hero-label')),
    value: textoDe(hero.querySelector('.value, .fin-hero-valor')),
    detalle: textoDe(delta),
    dir: delta?.classList.contains('down') ? 'down' : delta?.classList.contains('up') ? 'up' : null,
    meta: textoDe(hero.querySelector('.hero-meta')),
    extras
  };
  return bloque.value ? bloque : null;
}

function recorrer(nodo, bloques, descartados) {
  for (const el of nodo.children) {
    if (!visible(el) || el.matches(IGNORAR)) continue;
    if (el.matches('.kpis')) {
      const items = kpisDe(el);
      if (items.length) bloques.push({ tipo: 'kpis', items });
    } else if (el.matches('.hero, .fin-hero')) {
      const h = heroDe(el);
      if (h) bloques.push(h);
    } else if (el.matches('.panel, .sec-chart-panel')) {
      if (el.querySelector('.panel, .sec-chart-panel')) {
        // Contenedor de paneles (p. ej. "Otras métricas numéricas"): su título y luego cada panel hijo.
        const { titulo } = tituloDe(el);
        if (titulo) bloques.push({ tipo: 'seccion', titulo });
        recorrer(el, bloques, descartados);
      } else {
        // Los .sec-chart-panel de una .secundarios-grid van de a dos por fila (el último, si sobra, a todo el ancho),
        // igual que en pantalla.
        let mitad = false;
        if (el.matches('.sec-chart-panel') && el.parentElement?.matches('.secundarios-grid')) {
          const hermanos = [...el.parentElement.children].filter(visible);
          const i = hermanos.indexOf(el);
          mitad = !(i === hermanos.length - 1 && hermanos.length % 2 === 1);
        }
        const p = panelDe(el, mitad);
        if (p) bloques.push(p);
      }
    } else if (el.children.length) {
      recorrer(el, bloques, descartados); // contenedores (.inicio-columnas, .grid-2, ...): se sigue hacia adentro
    } else if (el.textContent.trim() && !/^H[1-6]$/.test(el.tagName)) { // los títulos ya se leen con el panel
      // Se informa (en el modelo, no en el PDF) para poder ver qué bloque de una pantalla nueva no se está leyendo.
      descartados.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''}: "${limpiarTextoPDF(el.textContent).slice(0, 50)}"`);
    }
  }
}

// Lee la pantalla ya dibujada y devuelve el modelo del PDF. Es SÍNCRONA a
// propósito: entre leer y capturar los gráficos nada más debe tocar el DOM.
export function extraerModelo() {
  const main = document.querySelector('main');
  if (!main) throw new Error('Esta página no tiene contenido para exportar.');

  // En "Vista Operativa" el <main> (KPIs y gráficos) está oculto; se muestra
  // solo mientras se lee -- sin ceder el control al navegador, así que no parpadea.
  const estabaOculto = getComputedStyle(main).display === 'none';
  const displayPrevio = main.style.display;
  if (estabaOculto) main.style.display = 'block';
  try {
    const bloques = [], descartados = [];
    recorrer(main, bloques, descartados);
    const modulo = limpiarTextoPDF(document.getElementById('topbarTitle')?.textContent) || limpiarTextoPDF(document.body.dataset.modulo);
    const negocio = limpiarTextoPDF(document.getElementById('bizName')?.value) || 'GEALMI';
    return {
      negocio, modulo, periodo: periodoDe(),
      // Formato corto (19/09/2026 19:04): el largo ("19 de setiembre de 2026 a las 7:04 p. m.") no cabe en el encabezado.
      generado: limpiarTextoPDF(new Date().toLocaleString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '')),
      bloques, descartados
    };
  } finally {
    if (estabaOculto) main.style.display = displayPrevio;
  }
}

// ---------------------------------------------------------------------------
// Fase 2: dibujar con jsPDF
// ---------------------------------------------------------------------------

function recortar(doc, texto, anchoMax) {
  if (doc.getTextWidth(texto) <= anchoMax) return texto;
  let t = texto;
  while (t.length > 1 && doc.getTextWidth(t + '…') > anchoMax) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

function asegurarEspacio(doc, est, alto) {
  if (est.libre) return; // dentro de un par de paneles: el espacio ya se reservó antes
  if (est.y + alto > PAG.h - PAG.abajo) { doc.addPage(); est.y = PAG.arriba; }
}

function dibujarEncabezado(doc, modelo, logo, est) {
  doc.setFillColor(...COLOR.tinta);
  doc.rect(0, 0, PAG.w, 26, 'F');
  doc.setFillColor(...COLOR.cian);
  doc.rect(0, 26, PAG.w, 0.9, 'F');
  let xTexto = PAG.margen;
  if (logo) {
    try { doc.addImage(logo, 'PNG', PAG.margen, 6, 14, 14); xTexto = PAG.margen + 18; } catch { /* logo ilegible: se omite */ }
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.setTextColor(...COLOR.blanco);
  doc.text(recortar(doc, modelo.negocio, PAG.w - xTexto - PAG.margen - 62), xTexto, 12.5);
  doc.setFontSize(9.5);
  doc.setTextColor(...COLOR.cian);
  doc.text(recortar(doc, `Resumen ejecutivo · ${modelo.modulo}`, PAG.w - xTexto - PAG.margen - 62), xTexto, 18.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...COLOR.blanco);
  doc.text(recortar(doc, modelo.periodo, 60), PAG.w - PAG.margen, 12.5, { align: 'right' });
  doc.text(recortar(doc, `Generado el ${modelo.generado}`, 60), PAG.w - PAG.margen, 18.5, { align: 'right' });
  est.y = 26.9 + 8;
}

function dibujarKPIs(doc, est, items) {
  const columnas = 3, hueco = 4, ancho = (ANCHO_UTIL - hueco * (columnas - 1)) / columnas, alto = 24;
  let yFila = est.y;
  items.forEach((k, i) => {
    const col = i % columnas;
    if (col === 0) { asegurarEspacio(doc, est, alto + hueco); yFila = est.y; }
    const x = PAG.margen + col * (ancho + hueco), interior = ancho - 8;
    doc.setFillColor(...COLOR.suave);
    doc.setDrawColor(...COLOR.linea);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, yFila, ancho, alto, 2, 2, 'FD');
    doc.setFillColor(...(ACENTOS[k.acento] || ACENTOS.teal));
    doc.rect(x, yFila + 3, 1.4, alto - 6, 'F');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(...COLOR.apagado);
    doc.text(recortar(doc, k.label.toUpperCase(), interior), x + 5, yFila + 5.5);

    let fs = 16;
    doc.setFontSize(fs);
    while (fs > 9 && doc.getTextWidth(k.value) > interior) { fs -= 1; doc.setFontSize(fs); } // un valor largo se achica en vez de cortarse
    doc.setTextColor(...COLOR.tinta);
    doc.text(recortar(doc, k.value || '—', interior), x + 5, yFila + 13);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.2);
    let yLinea = yFila + 17.5;
    if (k.delta) {
      doc.setTextColor(...(k.delta.dir === 'down' ? COLOR.rojo : COLOR.verde));
      doc.setFont('helvetica', 'bold');
      doc.text(recortar(doc, `${k.delta.dir === 'down' ? '-' : '+'} ${k.delta.texto}`, interior), x + 5, yLinea);
      doc.setFont('helvetica', 'normal');
      yLinea += 3.6;
    }
    if (k.sub) {
      doc.setTextColor(...COLOR.apagado);
      doc.text(recortar(doc, k.sub.replace(/\n/g, ' · '), interior), x + 5, yLinea);
    }
    if (col === columnas - 1 || i === items.length - 1) est.y = yFila + alto + hueco;
  });
}

function dibujarHero(doc, est, h) {
  const alto = 28;
  asegurarEspacio(doc, est, alto + 4);
  const x = PAG.margen, y = est.y;
  doc.setFillColor(...COLOR.suave);
  doc.setDrawColor(...COLOR.linea);
  doc.setLineWidth(0.2);
  doc.roundedRect(x, y, ANCHO_UTIL, alto, 2, 2, 'FD');
  doc.setFillColor(...ACENTOS.teal);
  doc.rect(x, y + 3, 1.4, alto - 6, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7);
  doc.setTextColor(...COLOR.apagado);
  doc.text(recortar(doc, (h.label || 'Total').toUpperCase(), 100), x + 6, y + 7);
  let fs = 24;
  doc.setFontSize(fs);
  while (fs > 12 && doc.getTextWidth(h.value) > 100) { fs -= 1; doc.setFontSize(fs); }
  doc.setTextColor(...COLOR.tinta);
  doc.text(h.value, x + 6, y + 17);
  if (h.detalle) {
    doc.setFont('helvetica', h.dir ? 'bold' : 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...(h.dir === 'down' ? COLOR.rojo : h.dir === 'up' ? COLOR.verde : COLOR.apagado));
    const signo = h.dir === 'down' ? '- ' : h.dir === 'up' ? '+ ' : ''; // la flecha (▲ ▼) no se puede dibujar: el signo la reemplaza
    doc.text(recortar(doc, signo + h.detalle.replace(/\n/g, ' · '), 100), x + 6, y + 23.5);
  }
  if (h.extras?.length) {
    // Desglose (p. ej. Ingresos / Egresos): etiqueta a la izquierda, cifra a la derecha, una línea por dato.
    const xEtiqueta = x + ANCHO_UTIL - 62, xValor = x + ANCHO_UTIL - 5;
    h.extras.slice(0, 3).forEach((e, i) => {
      const yLinea = y + 9 + i * 8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...COLOR.apagado);
      doc.text(recortar(doc, e.label, 30), xEtiqueta, yLinea);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...(e.dir === 'down' ? COLOR.rojo : COLOR.verde));
      doc.text(recortar(doc, e.value, 30), xValor, yLinea, { align: 'right' });
    });
  } else if (h.meta) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...COLOR.apagado);
    const lineas = doc.splitTextToSize(h.meta.replace(/\n/g, ' · '), 62).slice(0, 4);
    doc.text(lineas, x + ANCHO_UTIL - 4, y + 8, { align: 'right' });
  }
  est.y = y + alto + 5;
}

function dibujarSeccion(doc, est, titulo) {
  asegurarEspacio(doc, est, 16);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...COLOR.apagado);
  doc.text(recortar(doc, titulo.toUpperCase(), ANCHO_UTIL), PAG.margen, est.y + 3);
  est.y += 7;
}

function dibujarTituloPanel(doc, est, x, w, titulo, tag) {
  if (!titulo) return;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...COLOR.tinta);
  const anchoTag = tag ? Math.min(doc.getTextWidth(tag) + 2, w * 0.4) : 0;
  doc.text(recortar(doc, titulo, w - anchoTag - 2), x, est.y + 4);
  if (tag) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOR.apagado);
    doc.text(recortar(doc, tag, anchoTag), x + w, est.y + 4, { align: 'right' });
  }
  doc.setDrawColor(...COLOR.linea);
  doc.setLineWidth(0.3);
  doc.line(x, est.y + 6.2, x + w, est.y + 6.2);
  est.y += 8.5;
}

function estiloTabla(columnas, filas, tieneEncabezado) {
  // - una primera columna que es solo la posición del ranking (1, 2, 3...) va angosta y centrada;
  // - una columna de números/montos, o la última si es un valor corto ("3 u.", "525 · 100%"), va a la
  //   derecha y ajustada a su contenido;
  // - las etiquetas cortas (un estado como "Crítico") tampoco se estiran;
  // - el resto de las columnas se reparte el ancho que sobra.
  const estilos = {};
  const largo = (c) => Math.max(0, ...filas.map(f => String(f[c] ?? '').split('\n').reduce((m, l) => Math.max(m, l.length), 0)));
  for (let c = 0; c < columnas; c++) {
    const celdas = filas.map(f => f[c]).filter(v => v !== undefined && v !== '');
    if (!celdas.length) continue;
    const esPosicion = c === 0 && !tieneEncabezado && columnas > 1 && celdas.every(v => /^\d{1,3}$/.test(v));
    if (esPosicion) { estilos[c] = { cellWidth: 9, halign: 'center', textColor: COLOR.apagado }; continue; }
    const esUltima = c === columnas - 1 && columnas > 1;
    if (celdas.every(v => PARECE_NUMERO.test(v)) || (esUltima && largo(c) <= 18)) estilos[c] = { halign: 'right', cellWidth: 'wrap' };
    else if (columnas > 2 && largo(c) <= 12) estilos[c] = { cellWidth: 'wrap' };
  }
  // Al menos una columna debe quedar libre para absorber el ancho de la tabla: la de texto más largo.
  if (columnas > 1 && Array.from({ length: columnas }, (_, c) => estilos[c]?.cellWidth).every(w => w !== undefined)) {
    const masLarga = Array.from({ length: columnas }, (_, c) => c).filter(c => estilos[c].cellWidth === 'wrap').sort((a, b) => largo(b) - largo(a))[0];
    if (masLarga !== undefined) delete estilos[masLarga].cellWidth;
  }
  return estilos;
}

function dibujarTabla(doc, est, x, w, { head, body }) {
  const columnas = Math.max(head?.length || 0, ...body.map(f => f.length));
  const filas = body.map(f => Array.from({ length: columnas }, (_, i) => f[i] ?? ''));
  const tieneEncabezado = !!head?.length;
  doc.autoTable({
    startY: est.y,
    head: tieneEncabezado ? [head] : undefined,
    body: filas,
    margin: { left: x, right: PAG.w - x - w, top: PAG.arriba, bottom: PAG.abajo },
    tableWidth: w,
    theme: 'striped',
    styles: { font: 'helvetica', fontSize: 8.5, cellPadding: { top: 1.7, bottom: 1.7, left: 2, right: 2 }, textColor: COLOR.tinta, lineWidth: 0, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: COLOR.tinta, textColor: COLOR.blanco, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: COLOR.suave },
    columnStyles: estiloTabla(columnas, filas, tieneEncabezado),
    pageBreak: est.libre ? 'avoid' : 'auto',
    rowPageBreak: 'avoid'
  });
  est.y = doc.lastAutoTable.finalY + 4;
}

function alturaEstimada(panel, w) {
  let alto = panel.titulo ? 8.5 : 0;
  for (const c of panel.contenido) {
    if (c.tipo === 'grafico') alto += c.h + 4;
    else if (c.tipo === 'nota') alto += 5.5;
    else if (c.tipo === 'filas') alto += Math.min(c.filas.length, 8) * 6.6 + 4;
    else if (c.tipo === 'tabla') alto += (c.body.length + 1) * 6.6 + 4;
  }
  return alto;
}

// est.libre = true: se dibuja en una posición ya reservada (par de paneles), sin saltos de página.
function dibujarPanel(doc, est, panel, x = PAG.margen, w = ANCHO_UTIL) {
  const primero = panel.contenido[0];
  const minimo = primero.tipo === 'grafico' ? primero.h : primero.tipo === 'nota' ? 8 : 26;
  asegurarEspacio(doc, est, (panel.titulo ? 8.5 : 0) + minimo);
  dibujarTituloPanel(doc, est, x, w, panel.titulo, panel.tag);
  for (const c of panel.contenido) {
    if (c.tipo === 'grafico') {
      asegurarEspacio(doc, est, c.h + 4);
      doc.addImage(c.imagen, 'PNG', x, est.y, c.w, c.h, undefined, 'FAST');
      est.y += c.h + 4;
    } else if (c.tipo === 'nota') {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...COLOR.apagado);
      const lineas = doc.splitTextToSize(c.texto, w);
      asegurarEspacio(doc, est, lineas.length * 4 + 3);
      doc.text(lineas, x, est.y + 3.5);
      est.y += lineas.length * 4 + 3;
    } else if (c.tipo === 'filas') {
      dibujarTabla(doc, est, x, w, { body: est.libre ? c.filas.slice(0, 8) : c.filas });
    } else if (c.tipo === 'tabla') {
      dibujarTabla(doc, est, x, w, c);
    }
  }
  est.y += 3;
}

function dibujarPar(doc, est, a, b) {
  const alto = Math.max(alturaEstimada(a, ANCHO_MITAD), alturaEstimada(b, ANCHO_MITAD));
  asegurarEspacio(doc, est, alto + 3);
  const yInicio = est.y;
  let yFin = yInicio;
  [a, b].forEach((panel, i) => {
    const local = { y: yInicio, libre: true };
    dibujarPanel(doc, local, panel, PAG.margen + i * (ANCHO_MITAD + SEPARACION_MITADES), ANCHO_MITAD);
    yFin = Math.max(yFin, local.y);
  });
  est.y = yFin;
}

function dibujarPies(doc, modelo) {
  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    doc.setDrawColor(...COLOR.linea);
    doc.setLineWidth(0.2);
    doc.line(PAG.margen, PAG.h - 12, PAG.w - PAG.margen, PAG.h - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...COLOR.apagado);
    doc.text(recortar(doc, `GEALMI · ${modelo.negocio} · ${modelo.modulo}`, 130), PAG.margen, PAG.h - 7.5);
    doc.text(`Página ${i} de ${paginas}`, PAG.w - PAG.margen, PAG.h - 7.5, { align: 'right' });
  }
}

export function dibujarPDF(jsPDF, modelo, { logo = null } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  doc.setProperties({
    title: `${modelo.modulo} - Resumen ejecutivo`, subject: modelo.periodo, author: modelo.negocio, creator: 'GEALMI'
  });
  const est = { y: PAG.arriba };
  dibujarEncabezado(doc, modelo, logo, est);

  if (!modelo.bloques.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(...COLOR.apagado);
    doc.text('Todavía no hay datos para mostrar en este módulo.', PAG.margen, est.y + 6);
  }
  for (let i = 0; i < modelo.bloques.length; i++) {
    const b = modelo.bloques[i];
    if (b.tipo === 'kpis') dibujarKPIs(doc, est, b.items);
    else if (b.tipo === 'hero') dibujarHero(doc, est, b);
    else if (b.tipo === 'seccion') dibujarSeccion(doc, est, b.titulo);
    else if (b.tipo === 'panel') {
      const siguiente = modelo.bloques[i + 1];
      if (b.mitad && siguiente?.tipo === 'panel' && siguiente.mitad) { dibujarPar(doc, est, b, siguiente); i++; }
      else dibujarPanel(doc, est, b);
    }
  }
  dibujarPies(doc, modelo);
  return doc;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function generarResumenPDF() {
  const [jsPDF, logo] = await Promise.all([cargarLibreriasPDF(), cargarLogo()]);
  const modelo = extraerModelo(); // tras las esperas y sin ceder el control hasta terminar de capturar los gráficos
  return { doc: dibujarPDF(jsPDF, modelo, { logo }), nombre: nombreArchivoPDF(modelo.negocio, modelo.modulo), modelo };
}

export async function exportarResumenPDF() {
  const { doc, nombre } = await generarResumenPDF();
  doc.save(nombre);
  return nombre;
}
