// tests/rrhh-calculos.test.js
// Paso 8 (RRHH) -- la lógica pura de src/rrhh/calculos.js: jornada y
// sobretiempo, semanas ISO, saldo de vacaciones, gratificación/CTS estimadas y
// validación de RUC / documento. Sin base de datos ni servidor.
//
// Ojo con lo que NO prueban estos tests: que los montos coincidan con lo que
// diría un contador (el archivo lo advierte: son referenciales). Prueban que la
// cuenta hace lo que dice, con casos hechos a mano.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diasCalendario, mesesCompletos, claveSemana, minutosDelDiaEnLima, fechaEnLima, calcularJornada,
  resumenAsistencia, LIMITE_SEMANAL_MINUTOS, saldoVacaciones, estimarBeneficios, esRucValido, esDocumentoIdentidadValido
} from '../src/rrhh/calculos.js';

// Lima es UTC-5 todo el año: 08:00 en Lima = 13:00Z.
const lima = (fecha, hhmm) => new Date(`${fecha}T${hhmm}:00-05:00`).toISOString();

test('diasCalendario cuenta ambos extremos', () => {
  assert.equal(diasCalendario('2026-09-01', '2026-09-01'), 1);
  assert.equal(diasCalendario('2026-09-01', '2026-09-03'), 3);
  assert.equal(diasCalendario('2026-02-27', '2026-03-02'), 4, 'cruza fin de febrero (2026 no es bisiesto)');
});

test('mesesCompletos: el mes cuenta al cumplirse el día', () => {
  assert.equal(mesesCompletos('2026-01-31', '2026-02-28'), 0);
  assert.equal(mesesCompletos('2025-09-20', '2026-09-20'), 12);
  assert.equal(mesesCompletos('2025-09-20', '2026-09-19'), 11);
  assert.equal(mesesCompletos('2026-01-15', '2026-03-14'), 1);
  assert.equal(mesesCompletos('2026-05-01', '2026-01-01'), 0, 'fechas al revés no dan negativo');
});

test('claveSemana sigue la semana ISO (lunes a domingo, la 1 trae el primer jueves)', () => {
  assert.equal(claveSemana('2026-01-01'), '2026-S01');
  assert.equal(claveSemana('2025-12-29'), '2026-S01', 'el lunes 29/12/2025 ya es de la semana 1 de 2026');
  assert.equal(claveSemana('2026-09-20'), '2026-S38');
  assert.equal(claveSemana('2026-09-21'), '2026-S39', 'el lunes empieza otra semana');
  assert.equal(claveSemana('2026-12-31'), '2026-S53');
  assert.equal(claveSemana('2027-01-03'), '2026-S53');
  assert.equal(claveSemana('2027-01-04'), '2027-S01');
});

test('la hora y la fecha se leen en Lima, no en UTC', () => {
  assert.equal(minutosDelDiaEnLima('2026-09-21T13:10:00Z'), 8 * 60 + 10);
  assert.equal(fechaEnLima('2026-09-21T03:00:00Z'), '2026-09-20', '22:00 del día anterior en Lima');
  assert.equal(fechaEnLima('2026-09-21T05:00:00Z'), '2026-09-21');
});

test('calcularJornada: día normal, con refrigerio descontado', () => {
  const j = calcularJornada({
    entrada: lima('2026-09-21', '08:00'), salida_refrigerio: lima('2026-09-21', '13:00'),
    retorno_refrigerio: lima('2026-09-21', '14:00'), salida: lima('2026-09-21', '17:00')
  }, { jornada_horas_dia: 8, hora_entrada: '08:00' });
  assert.equal(j.minutos_brutos, 540);
  assert.equal(j.minutos_refrigerio, 60);
  assert.equal(j.minutos_trabajados, 480);
  assert.equal(j.minutos_sobretiempo, 0);
  assert.equal(j.minutos_tardanza, 0);
  assert.equal(j.completo, true);
  assert.equal(j.refrigerio_marcado, true);
});

test('calcularJornada: sobretiempo y tardanza', () => {
  const j = calcularJornada({
    entrada: lima('2026-09-21', '08:10'), salida_refrigerio: lima('2026-09-21', '13:00'),
    retorno_refrigerio: lima('2026-09-21', '14:00'), salida: lima('2026-09-21', '19:30')
  }, { jornada_horas_dia: 8, hora_entrada: '08:00' });
  // 08:10 a 19:30 = 11 h 20 min (680); menos 1 h de refrigerio = 620; jornada de 8 h (480) => 140 de sobretiempo.
  assert.equal(j.minutos_trabajados, 620);
  assert.equal(j.minutos_sobretiempo, 140);
  assert.equal(j.minutos_tardanza, 10);
});

test('calcularJornada: llegar temprano no es tardanza, y sin hora pactada no hay tardanza', () => {
  const temprano = calcularJornada({ entrada: lima('2026-09-21', '07:45'), salida: lima('2026-09-21', '16:45') }, { hora_entrada: '08:00' });
  assert.equal(temprano.minutos_tardanza, 0);
  const sinPactada = calcularJornada({ entrada: lima('2026-09-21', '10:00'), salida: lima('2026-09-21', '18:00') }, {});
  assert.equal(sinPactada.minutos_tardanza, 0);
});

test('calcularJornada: no inventa un refrigerio que nadie marcó', () => {
  const j = calcularJornada({ entrada: lima('2026-09-21', '08:00'), salida: lima('2026-09-21', '17:00') }, { jornada_horas_dia: 8 });
  assert.equal(j.minutos_refrigerio, 0);
  assert.equal(j.refrigerio_marcado, false, 'el reporte lo puede señalar');
  assert.equal(j.minutos_trabajados, 540);
  const soloSalida = calcularJornada({ entrada: lima('2026-09-21', '08:00'), salida_refrigerio: lima('2026-09-21', '13:00'), salida: lima('2026-09-21', '17:00') }, {});
  assert.equal(soloSalida.minutos_refrigerio, 0, 'sin regreso marcado no se descuenta nada');
});

test('calcularJornada: sin salida no hay sobretiempo y la jornada figura incompleta', () => {
  const j = calcularJornada({ entrada: lima('2026-09-21', '08:00') }, { jornada_horas_dia: 8 });
  assert.equal(j.completo, false);
  assert.equal(j.minutos_trabajados, 0);
  assert.equal(j.minutos_sobretiempo, 0);
});

test('calcularJornada: un turno que cruza la medianoche', () => {
  const j = calcularJornada({ entrada: lima('2026-09-21', '22:00'), salida: lima('2026-09-22', '06:00') }, { jornada_horas_dia: 8 });
  assert.equal(j.minutos_brutos, 480);
  assert.equal(j.minutos_sobretiempo, 0);
});

test('calcularJornada respeta la jornada pactada de cada trabajador (part-time de 4 h)', () => {
  const j = calcularJornada({ entrada: lima('2026-09-21', '09:00'), salida: lima('2026-09-21', '14:00') }, { jornada_horas_dia: 4 });
  assert.equal(j.minutos_sobretiempo, 60);
});

function dia(empleado_id, fecha, horas) {
  return { empleado_id, fecha, minutos_trabajados: horas * 60, minutos_sobretiempo: 0, minutos_tardanza: 0, completo: true };
}

test('resumenAsistencia suma por trabajador y marca las semanas sobre 48 h', () => {
  // Lunes a sábado de la semana 39 de 2026 (21 al 26 de setiembre): 6 días x 9 h = 54 h.
  const filas = ['21', '22', '23', '24', '25', '26'].map(d => dia(1, `2026-09-${d}`, 9));
  // Otro trabajador: 5 días x 9 h = 45 h, no pasa el límite.
  for (const d of ['21', '22', '23', '24', '25']) filas.push(dia(2, `2026-09-${d}`, 9));
  const r = resumenAsistencia(filas);
  const a = r.find(x => x.empleado_id === 1), b = r.find(x => x.empleado_id === 2);
  assert.equal(a.dias, 6);
  assert.equal(a.minutos_trabajados, 54 * 60);
  assert.deepEqual(a.semanas_sobre_el_limite, [{ semana: '2026-S39', minutos: 54 * 60 }]);
  assert.equal(b.semanas_sobre_el_limite.length, 0);
  assert.equal(LIMITE_SEMANAL_MINUTOS, 48 * 60);
});

test('resumenAsistencia cuenta tardanzas y jornadas sin salida', () => {
  const r = resumenAsistencia([
    { ...dia(1, '2026-09-21', 8), minutos_tardanza: 15 },
    { ...dia(1, '2026-09-22', 0), completo: false },
    dia(1, '2026-09-23', 8)
  ])[0];
  assert.equal(r.tardanzas, 1);
  assert.equal(r.minutos_tardanza, 15);
  assert.equal(r.sin_salida, 1);
});

test('saldoVacaciones: 30 días al año en el régimen general, 15 en MYPE', () => {
  const base = { fecha_contratacion: '2025-09-20', hoy: '2026-09-20' };
  const general = saldoVacaciones({ ...base, regimen: 'general', dias_tomados: 10 });
  assert.equal(general.meses_servicio, 12);
  assert.equal(general.dias_ganados, 30);
  assert.equal(general.saldo, 20);
  assert.match(general.referencial, /contador/i, 'lleva su aviso de estimación');
  assert.equal(saldoVacaciones({ ...base, regimen: 'mype_micro' }).dias_ganados, 15);
  assert.equal(saldoVacaciones({ ...base, regimen: 'mype_pequena' }).dias_ganados, 15);
});

test('saldoVacaciones: proporcional a los meses y detenido en la fecha de cese', () => {
  const medio = saldoVacaciones({ regimen: 'general', fecha_contratacion: '2026-03-20', hoy: '2026-09-20' });
  assert.equal(medio.dias_ganados, 15, '6 meses = medio año');
  const cesado = saldoVacaciones({ regimen: 'general', fecha_contratacion: '2025-09-20', fecha_cese: '2026-03-20', hoy: '2026-09-20' });
  assert.equal(cesado.meses_servicio, 6, 'después del cese ya no se gana nada');
  const sobregirado = saldoVacaciones({ regimen: 'general', fecha_contratacion: '2026-08-20', hoy: '2026-09-20', dias_tomados: 10 });
  assert.equal(sobregirado.saldo, -7.5, 'el saldo puede quedar negativo (adelanto)');
});

test('estimarBeneficios (régimen general): gratificación de julio-dic y CTS de mayo-oct', () => {
  const r = estimarBeneficios({ salario: 1800, regimen: 'general', fecha_contratacion: '2024-03-10', hoy: '2026-09-20' });
  assert.equal(r.aplica, true);
  assert.equal(r.gratificacion.meses, 2, 'julio y agosto completos; setiembre aún no');
  assert.equal(r.gratificacion.monto, 600);
  assert.equal(r.gratificacion.bonificacion_extraordinaria, 54, '9 % de la gratificación');
  assert.equal(r.gratificacion.total, 654);
  assert.equal(r.cts.meses, 4, 'mayo a agosto');
  assert.equal(r.cts.remuneracion_computable, 2100, 'sueldo + 1/6 de una gratificación');
  assert.equal(r.cts.monto, 700);
  assert.match(r.referencial, /REFERENCIAL/);
});

test('estimarBeneficios: quien entró a mitad del período recibe la parte proporcional', () => {
  const r = estimarBeneficios({ salario: 1800, regimen: 'general', fecha_contratacion: '2026-08-15', hoy: '2026-09-20' });
  assert.equal(r.gratificacion.meses, 1);
  assert.equal(r.gratificacion.monto, 300);
  assert.equal(r.cts.monto, 175);
});

test('estimarBeneficios: la pequeña empresa recibe la mitad y la microempresa no recibe', () => {
  const base = { salario: 1800, fecha_contratacion: '2024-03-10', hoy: '2026-09-20' };
  assert.equal(estimarBeneficios({ ...base, regimen: 'mype_pequena' }).gratificacion.monto, 300);
  const micro = estimarBeneficios({ ...base, regimen: 'mype_micro' });
  assert.equal(micro.aplica, false);
  assert.equal(micro.gratificacion.monto, 0);
  assert.equal(micro.cts.monto, 0);
  assert.equal(estimarBeneficios({ ...base, regimen: 'otro' }).aplica, false, '"otro" no se estima: se define con el contador');
});

test('estimarBeneficios: en enero corre la CTS de noviembre-abril del año anterior', () => {
  const r = estimarBeneficios({ salario: 1200, regimen: 'general', fecha_contratacion: '2020-01-01', hoy: '2027-01-15' });
  assert.match(r.cts.periodo, /nov-abr/);
  assert.equal(r.cts.meses, 2, 'noviembre y diciembre');
  assert.match(r.gratificacion.periodo, /ene-jun/);
  assert.equal(r.gratificacion.meses, 0, 'enero recién empieza: ningún mes completo');
});

test('esRucValido: dígito verificador y prefijo', () => {
  assert.equal(esRucValido('20131312955'), true, 'RUC real de una entidad pública');
  assert.equal(esRucValido('20131312956'), false, 'dígito verificador incorrecto');
  assert.equal(esRucValido('30131312955'), false, 'prefijo que no existe');
  assert.equal(esRucValido('1234'), false);
  assert.equal(esRucValido(''), false);
  assert.equal(esRucValido(null), false);
  assert.equal(esRucValido('2013131295a'), false);
});

test('esDocumentoIdentidadValido: DNI o carnet/pasaporte, sin espacios ni símbolos', () => {
  assert.equal(esDocumentoIdentidadValido('12345678'), true);
  assert.equal(esDocumentoIdentidadValido('AB1234567'), true);
  assert.equal(esDocumentoIdentidadValido('1234567'), false, 'muy corto');
  assert.equal(esDocumentoIdentidadValido('1234567890123'), false, 'muy largo');
  assert.equal(esDocumentoIdentidadValido('12 345678'), false);
  assert.equal(esDocumentoIdentidadValido("1234567'"), false);
});
