// tests/markdown-lite.test.js
// Paso 7 -- js/markdownLite.js pinta las respuestas de GEALMI AI. Lo que se
// prueba sobre todo es la SEGURIDAD: el texto viene de un modelo y de lo que
// escribe el usuario, así que nada de eso puede terminar como HTML activo.
// Función pura importada directo desde el frontend; no toca base ni servidor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderizarMarkdown } from '../../js/markdownLite.js';

test('párrafos: separados por línea en blanco, con salto de línea dentro del mismo párrafo', () => {
  assert.equal(renderizarMarkdown('Hola\nmundo\n\nOtro párrafo'), '<p>Hola<br>mundo</p><p>Otro párrafo</p>');
});

test('negrita, cursiva y código en línea', () => {
  assert.equal(renderizarMarkdown('Tus **ventas** subieron, *poco* y `S/ 1,250`'),
    '<p>Tus <strong>ventas</strong> subieron, <em>poco</em> y <code>S/ 1,250</code></p>');
});

test('lo que está dentro de `código` no se interpreta como negrita', () => {
  assert.equal(renderizarMarkdown('usa `**tal cual**` aquí'), '<p>usa <code>**tal cual**</code> aquí</p>');
});

test('listas con guiones y numeradas', () => {
  assert.equal(renderizarMarkdown('- uno\n- **dos**\n- tres'), '<ul><li>uno</li><li><strong>dos</strong></li><li>tres</li></ul>');
  assert.equal(renderizarMarkdown('1. primero\n2) segundo'), '<ol><li>primero</li><li>segundo</li></ol>');
});

test('un párrafo seguido de una lista no las mezcla', () => {
  assert.equal(renderizarMarkdown('Resumen:\n- a\n- b'), '<p>Resumen:</p><ul><li>a</li><li>b</li></ul>');
});

test('encabezados con # se muestran como un título en negrita (sin etiquetas h1-h6)', () => {
  assert.equal(renderizarMarkdown('## Resumen del mes'), '<p class="md-titulo"><strong>Resumen del mes</strong></p>');
});

test('tabla simple con encabezado y filas; las filas cortas se completan', () => {
  const html = renderizarMarkdown('| Producto | Total |\n|---|---:|\n| Leche | S/ 50 |\n| Pan |');
  assert.match(html, /<th>Producto<\/th><th>Total<\/th>/);
  assert.match(html, /<td>Leche<\/td><td>S\/ 50<\/td>/);
  assert.match(html, /<td>Pan<\/td><td><\/td>/);
});

test('SEGURIDAD: el HTML crudo se escapa, nunca se ejecuta', () => {
  const html = renderizarMarkdown('<script>alert(1)</script> <img src=x onerror=alert(2)>');
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('SEGURIDAD: dentro de negritas, listas, tablas y código tampoco pasa HTML', () => {
  const casos = [
    '**<b onclick=1>x</b>**',
    '- <a href="javascript:alert(1)">clic</a>',
    '| <i>a</i> |\n|---|\n| <u onmouseover=1>b</u> |',
    '`<svg onload=1>`',
    '# <iframe src=x>'
  ];
  for (const caso of casos) {
    const html = renderizarMarkdown(caso);
    assert.ok(!/<(script|img|iframe|svg|a|i|u|b)\b/.test(html.replace(/<\/?(p|strong|em|code|ul|ol|li|table|thead|tbody|tr|th|td|div)\b[^>]*>/g, '')), `HTML activo en: ${caso} -> ${html}`);
  }
});

test('SEGURIDAD: los enlaces Markdown no se convierten en <a>: quedan como texto', () => {
  const html = renderizarMarkdown('[clic aquí](javascript:alert(1))');
  assert.ok(!html.includes('<a'));
  assert.ok(!html.includes('href'));
});

test('entradas raras no rompen: vacío, null, solo espacios, una sola barra', () => {
  assert.equal(renderizarMarkdown(''), '');
  assert.equal(renderizarMarkdown(null), '');
  assert.equal(renderizarMarkdown(undefined), '');
  assert.equal(renderizarMarkdown('   \n  \n'), '');
  assert.equal(renderizarMarkdown('a | b'), '<p>a | b</p>', 'una línea con | sin separador no es tabla');
});
