// js/markdownLite.js
// Convierte a HTML el subconjunto de Markdown que usa GEALMI AI en sus
// respuestas: **negrita**, *cursiva*, `código`, listas con guiones o numeradas,
// encabezados (#) y tablas simples con "|". Nada más: sin enlaces, sin imágenes,
// sin HTML crudo.
//
// SEGURIDAD: el texto viene de un modelo y de las preguntas del usuario, o sea
// que NO es de confianza. Todo se escapa con escapeHtml() ANTES de agregar
// cualquier etiqueta, así que lo único que puede terminar en el HTML son las
// etiquetas fijas que se escriben acá. Función pura (sin DOM): se prueba desde
// Node (ver backend/tests/markdown-lite.test.js).

import { escapeHtml } from './utils.js';

// Negrita, cursiva y código sobre texto YA escapado. El código se aparta primero
// para que lo que hay entre ` ` no se interprete como negrita/cursiva.
function enLinea(textoEscapado) {
  return textoEscapado.split(/(`[^`\n]+`)/).map((trozo) => {
    if (/^`[^`\n]+`$/.test(trozo)) return `<code>${trozo.slice(1, -1)}</code>`;
    return trozo
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
  }).join('');
}

const RE_VINETA = /^\s*[-*•]\s+(.*)$/;
const RE_NUMERADA = /^\s*\d+[.)]\s+(.*)$/;
const RE_ENCABEZADO = /^\s{0,3}#{1,6}\s+(.*)$/;
const esFilaTabla = (linea) => linea.includes('|') && linea.trim().length > 1;
const esSeparadorTabla = (linea) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linea) && linea.includes('-');

function celdas(linea) {
  return linea.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function esInicioDeBloque(linea, siguiente) {
  return RE_VINETA.test(linea) || RE_NUMERADA.test(linea) || RE_ENCABEZADO.test(linea)
    || (esFilaTabla(linea) && siguiente !== undefined && esSeparadorTabla(siguiente));
}

export function renderizarMarkdown(texto) {
  const lineas = String(texto ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  while (i < lineas.length) {
    const linea = lineas[i];
    if (!linea.trim()) { i++; continue; }

    if (esFilaTabla(linea) && i + 1 < lineas.length && esSeparadorTabla(lineas[i + 1])) {
      const encabezado = celdas(linea);
      const filas = [];
      i += 2;
      while (i < lineas.length && esFilaTabla(lineas[i]) && lineas[i].trim()) { filas.push(celdas(lineas[i])); i++; }
      html.push(
        `<div class="md-tabla"><table><thead><tr>${encabezado.map(c => `<th>${enLinea(escapeHtml(c))}</th>`).join('')}</tr></thead>` +
        `<tbody>${filas.map(f => `<tr>${encabezado.map((_, k) => `<td>${enLinea(escapeHtml(f[k] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      );
      continue;
    }

    const lista = RE_VINETA.test(linea) ? { etiqueta: 'ul', re: RE_VINETA } : RE_NUMERADA.test(linea) ? { etiqueta: 'ol', re: RE_NUMERADA } : null;
    if (lista) {
      const items = [];
      while (i < lineas.length && lista.re.test(lineas[i])) { items.push(lineas[i].match(lista.re)[1]); i++; }
      html.push(`<${lista.etiqueta}>${items.map(t => `<li>${enLinea(escapeHtml(t))}</li>`).join('')}</${lista.etiqueta}>`);
      continue;
    }

    const encabezado = linea.match(RE_ENCABEZADO);
    if (encabezado) { html.push(`<p class="md-titulo"><strong>${enLinea(escapeHtml(encabezado[1]))}</strong></p>`); i++; continue; }

    // Párrafo: líneas seguidas hasta la próxima en blanco o el próximo bloque.
    const parrafo = [];
    while (i < lineas.length && lineas[i].trim() && (parrafo.length === 0 || !esInicioDeBloque(lineas[i], lineas[i + 1]))) {
      parrafo.push(enLinea(escapeHtml(lineas[i])));
      i++;
    }
    html.push(`<p>${parrafo.join('<br>')}</p>`);
  }
  return html.join('');
}
