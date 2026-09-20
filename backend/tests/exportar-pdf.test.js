// tests/exportar-pdf.test.js
// PDF real del resumen ejecutivo. Prueba las funciones puras de js/exportarPDF.js
// (frontend): la limpieza de texto (las fuentes estándar de jsPDF solo soportan
// Latin-1, y un carácter no soportado sale como basura en el papel) y el nombre
// del archivo. El dibujo en sí depende del DOM y de Chart.js, y se comprueba en
// el navegador. No toca base de datos ni servidor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limpiarTextoPDF, nombreArchivoPDF } from '../../js/exportarPDF.js';

test('limpiarTextoPDF: conserva tildes, ñ y los signos que Helvetica sí dibuja', () => {
  const texto = 'Ñandú · Año — Órdenes… "comillas" «S/ 1,250.50» 50%';
  assert.equal(limpiarTextoPDF(texto), texto);
});

test('limpiarTextoPDF: quita emojis, flechas y símbolos que saldrían como basura', () => {
  assert.equal(limpiarTextoPDF('🏠 Inicio'), 'Inicio');
  assert.equal(limpiarTextoPDF('⚠️ Stock bajo'), 'Stock bajo');
  assert.equal(limpiarTextoPDF('▲ 12% vs. período anterior'), '12% vs. período anterior');
  assert.equal(limpiarTextoPDF('✏️🗑️'), '');
});

test('limpiarTextoPDF: el signo menos tipográfico (egresos) pasa a "-" y no se pierde', () => {
  // Finanzas pinta los egresos como "−100" (U+2212); sin esto el PDF diría "100" y un egreso parecería ingreso.
  assert.equal(limpiarTextoPDF('−100'), '-100');
  assert.equal(limpiarTextoPDF('≤ 5 y ≥ 2'), '<= 5 y >= 2');
});

test('limpiarTextoPDF: el salto de línea separa líneas dentro de una celda', () => {
  // Regresión: el filtro de caracteres borraba el \n y "Movimiento 0" + "General · 2026-09-20" salían pegados.
  assert.equal(limpiarTextoPDF('Movimiento 0\nGeneral · 2026-09-20'), 'Movimiento 0\nGeneral · 2026-09-20');
  assert.equal(limpiarTextoPDF('  uno  \n\n\n  dos  '), 'uno\ndos');
});

test('limpiarTextoPDF: espacios "duros" y tabuladores pasan a espacio normal', () => {
  assert.equal(limpiarTextoPDF('7:04 p. m.'), '7:04 p. m.');
  assert.equal(limpiarTextoPDF('a\tb'), 'a b');
  assert.equal(limpiarTextoPDF('12 345'), '12 345');
});

test('limpiarTextoPDF: tolera null, undefined y números', () => {
  assert.equal(limpiarTextoPDF(null), '');
  assert.equal(limpiarTextoPDF(undefined), '');
  assert.equal(limpiarTextoPDF(42), '42');
});

test('nombreArchivoPDF: negocio, módulo, tipo y fecha local, con extensión .pdf', () => {
  const hoy = new Date(2026, 8, 5); // 5 de septiembre de 2026 (mes 0-indexado)
  assert.equal(nombreArchivoPDF('Bodega El Sol', 'Ventas', hoy), 'Bodega El Sol - Ventas - resumen ejecutivo - 2026-09-05.pdf');
});

test('nombreArchivoPDF: quita lo que el sistema de archivos no acepta', () => {
  const nombre = nombreArchivoPDF('Cía. "A/B" <Perú>: S.A.?', 'Ventas|Caja', new Date(2026, 0, 2));
  assert.ok(!/[\\/:*?"<>|]/.test(nombre.replace(/\.pdf$/, '')), `nombre inválido: ${nombre}`);
  assert.ok(nombre.endsWith(' - 2026-01-02.pdf'));
});

test('nombreArchivoPDF: usa el día local, no el de UTC', () => {
  // 23:30 del 31 de diciembre en hora local: toISOString() diría el 1 de enero en zonas al oeste de UTC.
  assert.ok(nombreArchivoPDF('X', 'Y', new Date(2026, 11, 31, 23, 30)).includes('2026-12-31'));
});

test('nombreArchivoPDF: omite partes vacías y limita el largo', () => {
  assert.equal(nombreArchivoPDF('', '', new Date(2026, 2, 1)), 'resumen ejecutivo - 2026-03-01.pdf');
  const largo = nombreArchivoPDF('N'.repeat(300), 'Ventas', new Date(2026, 2, 1));
  assert.ok(largo.length <= 124, `demasiado largo: ${largo.length}`);
  assert.ok(largo.endsWith('.pdf'));
});
