// js/exportarCSV.js
// Exportación a CSV de la tabla de cada módulo (Nivel 3 del roadmap:
// "Exportación de datos", Parte A). Todo ocurre en el navegador con los mismos
// datos y columnas que ya ve el usuario -- no hay endpoint nuevo, así que el
// alcance (empresa, sucursal restringida, permisos) es exactamente el del GET
// que llena la tabla.
//
// Las funciones puras (neutralizarFormula, construirCSV, nombreArchivoExport)
// no tocan el DOM ni `Papa` a propósito: así se pueden probar desde Node (ver
// backend/tests/exportar-csv.test.js).

export const LIMITE_FILAS_EXPORT = 5000; // mismo tope que el GET sin paginar (crudFactory.js)

// Excel/Sheets interpretan como FÓRMULA cualquier celda de un CSV que empiece
// con = + - @ (o tab/CR). Como el contenido lo escriben usuarios (un nombre de
// cliente, una nota...), sin esto alguien podría dejar `=HYPERLINK(...)` o
// `@SUM(...)` en un registro y ejecutarlo en la máquina de quien exporte
// (CSV injection, OWASP). Se antepone ' para que se abra como texto.
const EMPIEZA_COMO_FORMULA = /^[=+\-@\t\r]/;
// Excepción: números y teléfonos ("-50.25", "+51 (1) 555-1234") solo tienen
// dígitos y separadores, no pueden armar una fórmula ni llamar a nada -- si se
// les pusiera ' se romperían los montos negativos y los teléfonos con +51.
const SOLO_NUMERO_O_TELEFONO = /^[+-]?[\d\s().,-]*$/;
// Una fecha ISO completa (o timestamp) se recorta a AAAA-MM-DD. A propósito
// más estricto que tablaRegistros.js: una nota que solo EMPIECE con una fecha
// ("2026-03-05 llamar al cliente") no debe perder el resto del texto.
const FECHA_ISO_COMPLETA = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function neutralizarFormula(texto) {
  return EMPIEZA_COMO_FORMULA.test(texto) && !SOLO_NUMERO_O_TELEFONO.test(texto) ? `'${texto}` : texto;
}

function valorCelda(valor) {
  if (valor === null || valor === undefined) return '';
  let texto = typeof valor === 'object' ? JSON.stringify(valor) : String(valor);
  if (FECHA_ISO_COMPLETA.test(texto)) texto = texto.slice(0, 10);
  return neutralizarFormula(texto);
}

// `unparse` se inyecta (Papa.unparse en el navegador). BOM al inicio: sin él,
// Excel abre el UTF-8 como ANSI y rompe tildes y ñ. Fin de línea CRLF, el
// estándar de CSV (RFC 4180).
export function construirCSV(filas, columnas, unparse) {
  const encabezados = columnas.map(c => neutralizarFormula(String(c.label)));
  const datos = filas.map(fila => columnas.map(c => valorCelda(fila[c.key])));
  return '﻿' + unparse({ fields: encabezados, data: datos }, { newline: '\r\n' });
}

function fechaLocal(fecha) {
  const dos = n => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
}

export function nombreArchivoExport(modulo, { desde, hasta } = {}, hoy = new Date()) {
  const base = String(modulo).replace(/[^a-z0-9_-]/gi, '');
  const rango = (desde || hasta)
    ? `${desde || 'inicio'}_a_${hasta || fechaLocal(hoy)}`
    : fechaLocal(hoy);
  return `${base}_${rango}.csv`;
}

function descargarCSV(nombreArchivo, textoCSV) {
  const blob = new Blob([textoCSV], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const enlace = document.createElement('a');
  enlace.href = url;
  enlace.download = nombreArchivo;
  document.body.appendChild(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// `Papa` es el global de lib/papaparse.min.js (las páginas de módulo ya lo
// cargan por <script> antes de este módulo, igual que js/parsing.js).
export function exportarFilasCSV({ filas, columnas, modulo, filtros }) {
  const csv = construirCSV(filas, columnas, Papa.unparse);
  descargarCSV(nombreArchivoExport(modulo, filtros), csv);
}
