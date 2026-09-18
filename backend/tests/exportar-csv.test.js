// tests/exportar-csv.test.js
// Nivel 3 -- Exportación de datos, Parte A. Prueba las funciones puras de
// js/exportarCSV.js (frontend), sobre todo la neutralización de fórmulas: es
// lo que evita que un registro con `=HYPERLINK(...)` se ejecute en Excel al
// abrir el CSV. No toca base de datos ni servidor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { neutralizarFormula, construirCSV, nombreArchivoExport } from '../../js/exportarCSV.js';

const require = createRequire(import.meta.url);
const Papa = require('../../lib/papaparse.min.js');
const unparse = Papa.unparse;

const COLUMNAS = [
  { key: 'fecha', label: 'Fecha' },
  { key: 'nombre', label: 'Nombre' },
  { key: 'monto', label: 'Monto' },
  { key: 'notas', label: 'Notas' }
];

// Quita el BOM y vuelve a leer el CSV con el mismo Papa que usa la importación.
function leerDeVuelta(csv) {
  return Papa.parse(csv.replace(/^﻿/, ''), { header: true, skipEmptyLines: true }).data;
}

test('neutralizarFormula: antepone \' a lo que Excel ejecutaría como fórmula', () => {
  for (const peligroso of [
    '=1+1',
    '=HYPERLINK("http://evil.example","clic")',
    '@SUM(A1:A9)',
    "+cmd|' /C calc'!A0",
    "-2+3+cmd|' /C calc'!A0",
    '\t=1+1',
    '\r=1+1'
  ]) {
    assert.equal(neutralizarFormula(peligroso), `'${peligroso}`, `debería neutralizar ${JSON.stringify(peligroso)}`);
  }
});

test('neutralizarFormula: no toca teléfonos, montos negativos, fechas ni texto normal', () => {
  for (const seguro of [
    '+51 999 888 777', '+51 (1) 555-1234', '-50.25', '-1,200.50', '(01) 555-1234',
    '2026-09-19', 'Bodega El Sol', 'x=1', 'a@b.com', '', '-'
  ]) {
    assert.equal(neutralizarFormula(seguro), seguro, `no debería tocar ${JSON.stringify(seguro)}`);
  }
});

test('construirCSV: BOM, encabezados con las etiquetas de la tabla y CRLF', () => {
  const csv = construirCSV([{ fecha: '2026-09-19', nombre: 'Ana', monto: '10.50', notas: '' }], COLUMNAS, unparse);
  assert.ok(csv.startsWith('﻿'), 'sin BOM Excel rompe las tildes');
  assert.equal(csv.replace('﻿', ''), 'Fecha,Nombre,Monto,Notas\r\n2026-09-19,Ana,10.50,');
});

test('construirCSV: tildes/ñ intactas; comas, comillas y saltos de línea van entre comillas y dan la vuelta completa', () => {
  const filas = [
    { fecha: '2026-09-19', nombre: 'Ñandú, S.A.C.', monto: '1200.00', notas: 'dijo "urgente"\nllamar mañana' }
  ];
  const [leida] = leerDeVuelta(construirCSV(filas, COLUMNAS, unparse));
  assert.equal(leida.Nombre, 'Ñandú, S.A.C.');
  assert.equal(leida.Notas, 'dijo "urgente"\nllamar mañana');
});

test('construirCSV: null/undefined salen vacíos y los timestamps ISO se recortan a AAAA-MM-DD', () => {
  const [leida] = leerDeVuelta(construirCSV(
    [{ fecha: '2026-03-05T00:00:00.000Z', nombre: null, monto: undefined, notas: '' }], COLUMNAS, unparse
  ));
  assert.equal(leida.Fecha, '2026-03-05');
  assert.equal(leida.Nombre, '');
  assert.equal(leida.Monto, '');
});

test('construirCSV: una nota que solo EMPIEZA con una fecha no pierde el resto del texto', () => {
  const [leida] = leerDeVuelta(construirCSV(
    [{ fecha: '2026-03-05', nombre: 'Ana', monto: '1', notas: '2026-03-05 llamar al cliente por el pedido' }], COLUMNAS, unparse
  ));
  assert.equal(leida.Notas, '2026-03-05 llamar al cliente por el pedido');
});

test('construirCSV: una celda con fórmula sale neutralizada; teléfonos y negativos, intactos', () => {
  const filas = [
    { fecha: '2026-09-19', nombre: '=HYPERLINK("http://evil.example","clic")', monto: '-50.25', notas: '+51 999 888 777' },
    { fecha: '2026-09-19', nombre: '@SUM(A1)', monto: '10', notas: "+cmd|' /C calc'!A0" }
  ];
  const [a, b] = leerDeVuelta(construirCSV(filas, COLUMNAS, unparse));
  assert.equal(a.Nombre, '\'=HYPERLINK("http://evil.example","clic")');
  assert.equal(a.Monto, '-50.25');
  assert.equal(a.Notas, '+51 999 888 777');
  assert.equal(b.Nombre, "'@SUM(A1)");
  assert.equal(b.Notas, "'+cmd|' /C calc'!A0");
});

test('construirCSV: una etiqueta de columna con fórmula también se neutraliza (encabezado)', () => {
  const csv = construirCSV([], [{ key: 'x', label: '=cmd' }], unparse);
  assert.equal(csv.replace('﻿', '').split('\r\n')[0], "'=cmd");
});

test('nombreArchivoExport: sin rango usa la fecha de hoy; con rango, el rango', () => {
  const hoy = new Date(2026, 8, 19); // 19 set 2026, hora local
  assert.equal(nombreArchivoExport('ventas', {}, hoy), 'ventas_2026-09-19.csv');
  assert.equal(nombreArchivoExport('ventas', { desde: '2026-01-01', hasta: '2026-03-31' }, hoy), 'ventas_2026-01-01_a_2026-03-31.csv');
  assert.equal(nombreArchivoExport('ventas', { desde: '2026-01-01' }, hoy), 'ventas_2026-01-01_a_2026-09-19.csv');
  assert.equal(nombreArchivoExport('ventas', { hasta: '2026-03-31' }, hoy), 'ventas_inicio_a_2026-03-31.csv');
});

test('nombreArchivoExport: el nombre del módulo no puede colar rutas ni caracteres raros', () => {
  assert.equal(nombreArchivoExport('../../etc/passwd', {}, new Date(2026, 8, 19)), 'etcpasswd_2026-09-19.csv');
});
