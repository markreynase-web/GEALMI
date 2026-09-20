// src/rrhh/calculos.js
// Lógica pura de RRHH (sin base de datos ni Express): jornada y sobretiempo,
// saldo de vacaciones, beneficios estimados y validación de documentos.
// Separada a propósito para poder probarla directo (ver tests/rrhh-calculos.test.js).
//
// AVISO LEGAL: todo lo que estima dinero o días (vacaciones, gratificación, CTS)
// es REFERENCIAL. Está basado en las reglas generales del régimen laboral privado
// del Perú (D. Leg. 728 / 713, Ley 29351, Ley 30334, D.S. 004-2006-TR para el
// registro de asistencia) y en la Ley MYPE (D. Leg. 1086), tal como las entiende
// el equipo de GEALMI, pero NO fue validado por un contador ni por un abogado
// laboral. No debe usarse como liquidación ni prometerse como cumplimiento legal
// sin esa revisión. Cada función que estima algo lo dice en su resultado.

export const ZONA_HORARIA = 'America/Lima';

const DIA_MS = 86400000;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const aUTC = (fechaISO) => new Date(`${String(fechaISO).slice(0, 10)}T00:00:00Z`);
const aISO = (d) => d.toISOString().slice(0, 10);

// Días calendario entre dos fechas, ambas incluidas ("del 1 al 3" = 3 días).
export function diasCalendario(inicio, fin) {
  return Math.round((aUTC(fin) - aUTC(inicio)) / DIA_MS) + 1;
}

// Meses completos de servicio entre dos fechas (el mes cuenta al cumplirse el día).
export function mesesCompletos(desde, hasta) {
  const a = aUTC(desde), b = aUTC(hasta);
  if (b < a) return 0;
  let meses = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) meses -= 1;
  return Math.max(0, meses);
}

// Semana ISO ("2026-S38"): el lunes empieza la semana, y la 1 es la que trae el primer jueves del año.
export function claveSemana(fechaISO) {
  const d = aUTC(fechaISO);
  const diaSemana = (d.getUTCDay() + 6) % 7; // lunes = 0
  d.setUTCDate(d.getUTCDate() - diaSemana + 3); // el jueves de esa semana
  const primerJueves = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round(((d - primerJueves) / DIA_MS - 3 + ((primerJueves.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-S${String(semana).padStart(2, '0')}`;
}

// Minutos desde la medianoche, en hora de Lima, de un instante.
export function minutosDelDiaEnLima(instante) {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: ZONA_HORARIA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instante));
  return Number(partes.find(p => p.type === 'hour').value) * 60 + Number(partes.find(p => p.type === 'minute').value);
}

// La fecha calendario (AAAA-MM-DD) que es en Lima en ese instante.
export function fechaEnLima(instante) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA_HORARIA, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instante));
  return p; // en-CA da AAAA-MM-DD
}

// ---------------------------------------------------------------------------
// Jornada y sobretiempo (registro de asistencia)
// ---------------------------------------------------------------------------

// marcas: { entrada, salida_refrigerio, retorno_refrigerio, salida } (instantes).
// config: { jornada_horas_dia, hora_entrada ("HH:MM[:SS]" pactada) } del trabajador.
// El refrigerio se descuenta SOLO si se marcaron su salida y su regreso: no se
// inventa uno que nadie registró (en ese caso `refrigerio_marcado` queda en false
// para que el reporte lo señale). El sobretiempo se cuenta recién cuando hay salida.
export function calcularJornada(marcas, { jornada_horas_dia = 8, hora_entrada = null } = {}) {
  const t = (v) => (v ? new Date(v).getTime() : null);
  const e = t(marcas.entrada), sr = t(marcas.salida_refrigerio), rr = t(marcas.retorno_refrigerio), s = t(marcas.salida);
  const minutos = (a, b) => Math.round((b - a) / 60000);

  const refrigerio = sr && rr && rr > sr ? minutos(sr, rr) : 0;
  const brutos = e && s && s > e ? minutos(e, s) : 0;
  const trabajados = Math.max(0, brutos - refrigerio);
  const jornadaMin = Math.round(Number(jornada_horas_dia) * 60);
  const sobretiempo = s ? Math.max(0, trabajados - jornadaMin) : 0;

  let tardanza = 0;
  if (e && hora_entrada) {
    const [hh, mm] = String(hora_entrada).split(':').map(Number);
    tardanza = Math.max(0, minutosDelDiaEnLima(marcas.entrada) - (hh * 60 + mm));
  }
  return {
    minutos_brutos: brutos, minutos_refrigerio: refrigerio, minutos_trabajados: trabajados,
    minutos_sobretiempo: sobretiempo, minutos_tardanza: tardanza,
    completo: !!(e && s), refrigerio_marcado: !!(sr && rr)
  };
}

export const LIMITE_SEMANAL_MINUTOS = 48 * 60; // jornada máxima semanal (D.S. 007-2002-TR)

// filas: registros ya calculados, cada uno con { empleado_id, fecha, minutos_trabajados,
// minutos_sobretiempo, minutos_tardanza, completo }. Devuelve un resumen por trabajador.
export function resumenAsistencia(filas) {
  const porEmpleado = new Map();
  for (const f of filas) {
    if (!porEmpleado.has(f.empleado_id)) {
      porEmpleado.set(f.empleado_id, { empleado_id: f.empleado_id, dias: 0, minutos_trabajados: 0, minutos_sobretiempo: 0, minutos_tardanza: 0, tardanzas: 0, sin_salida: 0, semanas: new Map() });
    }
    const r = porEmpleado.get(f.empleado_id);
    r.dias += 1;
    r.minutos_trabajados += f.minutos_trabajados;
    r.minutos_sobretiempo += f.minutos_sobretiempo;
    r.minutos_tardanza += f.minutos_tardanza;
    if (f.minutos_tardanza > 0) r.tardanzas += 1;
    if (!f.completo) r.sin_salida += 1;
    const semana = claveSemana(f.fecha);
    r.semanas.set(semana, (r.semanas.get(semana) || 0) + f.minutos_trabajados);
  }
  return [...porEmpleado.values()].map(({ semanas, ...r }) => ({
    ...r,
    semanas_sobre_el_limite: [...semanas].filter(([, min]) => min > LIMITE_SEMANAL_MINUTOS).map(([semana, min]) => ({ semana, minutos: min }))
  }));
}

// ---------------------------------------------------------------------------
// Vacaciones
// ---------------------------------------------------------------------------

export const REGIMENES = ['general', 'mype_micro', 'mype_pequena', 'otro'];
// Días de vacaciones por año de servicio: 30 en el régimen general (D. Leg. 713) y 15 en la microempresa y la pequeña empresa (D. Leg. 1086).
export const DIAS_VACACIONES_ANUALES = { general: 30, mype_micro: 15, mype_pequena: 15, otro: 30 };

export function saldoVacaciones({ regimen = 'general', fecha_contratacion, fecha_cese = null, dias_tomados = 0, hoy }) {
  const tope = fecha_cese && String(fecha_cese).slice(0, 10) < hoy ? String(fecha_cese).slice(0, 10) : hoy;
  const meses = mesesCompletos(fecha_contratacion, tope);
  const porAnio = DIAS_VACACIONES_ANUALES[regimen] ?? 30;
  const ganados = +(porAnio * meses / 12).toFixed(2);
  return {
    regimen, dias_por_anio: porAnio, meses_servicio: meses, dias_ganados: ganados, dias_tomados: Number(dias_tomados) || 0,
    saldo: +(ganados - (Number(dias_tomados) || 0)).toFixed(2),
    referencial: 'Estimación proporcional a los meses completos de servicio. La regla legal (récord vacacional, acumulación, fraccionamiento) puede variar el saldo exacto: valídalo con tu contador.'
  };
}

// ---------------------------------------------------------------------------
// Gratificación y CTS estimadas
// ---------------------------------------------------------------------------

// Proporción del beneficio que corresponde por régimen: general 100 %, pequeña
// empresa 50 %, microempresa y "otro" 0 (sin el beneficio, o depende del contrato).
const FACTOR_BENEFICIOS = { general: 1, mype_pequena: 0.5, mype_micro: 0, otro: 0 };
const BONIFICACION_EXTRAORDINARIA = 0.09; // Ley 30334: 9 % de la gratificación (equivale al aporte a EsSalud)

function ventanaMeses(hoy, semestres) {
  // semestres: lista de { inicioMes (0-11), meses: 6, etiqueta } -> devuelve el que contiene a "hoy".
  const d = aUTC(hoy);
  const anio = d.getUTCFullYear(), mes = d.getUTCMonth();
  for (const s of semestres) {
    const inicioAnio = s.inicioMes > mes ? anio - 1 : anio;
    const inicio = new Date(Date.UTC(inicioAnio, s.inicioMes, 1));
    const fin = new Date(Date.UTC(inicioAnio, s.inicioMes + s.meses, 0));
    if (d >= inicio && d <= fin) return { inicio: aISO(inicio), fin: aISO(fin), etiqueta: s.etiqueta(inicio, fin) };
  }
  return null;
}

// Meses (en fracción de mes completo) trabajados dentro de [inicio, fin], sin pasar de "hoy" ni del cese.
function mesesEnVentana(ventana, fecha_contratacion, fecha_cese, hoy) {
  const desde = String(fecha_contratacion).slice(0, 10) > ventana.inicio ? String(fecha_contratacion).slice(0, 10) : ventana.inicio;
  let hasta = hoy < ventana.fin ? hoy : ventana.fin;
  if (fecha_cese && String(fecha_cese).slice(0, 10) < hasta) hasta = String(fecha_cese).slice(0, 10);
  if (hasta < desde) return 0;
  // Un mes por cada mes calendario completo; el mes en curso no cuenta hasta cumplirse.
  const siguiente = aISO(new Date(aUTC(hasta).getTime() + DIA_MS));
  return Math.min(6, mesesCompletos(desde, siguiente));
}

export function estimarBeneficios({ salario, regimen = 'general', fecha_contratacion, fecha_cese = null, hoy }) {
  const factor = FACTOR_BENEFICIOS[regimen] ?? 0;
  const sueldo = Number(salario) || 0;
  const aviso = 'ESTIMACIÓN REFERENCIAL: no incluye descuentos (AFP/ONP, renta de 5.ª categoría), cambios de remuneración dentro del período ni casos especiales. No es una liquidación: valídala con tu contador.';

  // Gratificaciones: julio (enero-junio) y diciembre (julio-diciembre).
  const ventanaGrat = ventanaMeses(hoy, [
    { inicioMes: 0, meses: 6, etiqueta: (i) => `${i.getUTCFullYear()} · Fiestas Patrias (ene-jun)` },
    { inicioMes: 6, meses: 6, etiqueta: (i) => `${i.getUTCFullYear()} · Navidad (jul-dic)` }
  ]);
  const mesesGrat = mesesEnVentana(ventanaGrat, fecha_contratacion, fecha_cese, hoy);
  const gratificacion = +(sueldo * mesesGrat / 6 * factor).toFixed(2);
  const bonificacion = +(gratificacion * BONIFICACION_EXTRAORDINARIA).toFixed(2);

  // CTS: mayo (noviembre-abril) y noviembre (mayo-octubre). Remuneración computable = sueldo + 1/6 de la última gratificación.
  const ventanaCts = ventanaMeses(hoy, [
    { inicioMes: 4, meses: 6, etiqueta: (i) => `${i.getUTCFullYear()} · Depósito de noviembre (may-oct)` },
    { inicioMes: 10, meses: 6, etiqueta: (i) => `${i.getUTCFullYear() + 1} · Depósito de mayo (nov-abr)` }
  ]);
  const mesesCts = mesesEnVentana(ventanaCts, fecha_contratacion, fecha_cese, hoy);
  const gratUltima = sueldo * factor; // una gratificación completa equivale a un sueldo
  const remuneracionComputable = +(sueldo + gratUltima / 6).toFixed(2);
  const cts = +(remuneracionComputable / 12 * mesesCts * factor).toFixed(2);

  return {
    regimen, aplica: factor > 0, proporcion_del_regimen: factor,
    gratificacion: { periodo: ventanaGrat.etiqueta, meses: mesesGrat, monto: gratificacion, bonificacion_extraordinaria: bonificacion, total: +(gratificacion + bonificacion).toFixed(2) },
    cts: { periodo: ventanaCts.etiqueta, meses: mesesCts, remuneracion_computable: remuneracionComputable, monto: cts },
    referencial: aviso
  };
}

// ---------------------------------------------------------------------------
// Validaciones de identidad
// ---------------------------------------------------------------------------

// DNI (8 dígitos) o carnet de extranjería / pasaporte (8-12 letras y números).
export function esDocumentoIdentidadValido(valor) {
  return /^[0-9A-Za-z]{8,12}$/.test(String(valor ?? '').trim());
}

// RUC peruano: 11 dígitos, empieza en 10, 15, 16, 17 o 20, y el último es el dígito verificador (módulo 11).
export function esRucValido(valor) {
  const ruc = String(valor ?? '').trim();
  if (!/^(10|15|16|17|20)\d{9}$/.test(ruc)) return false;
  const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const suma = pesos.reduce((acc, p, i) => acc + p * Number(ruc[i]), 0);
  const resto = 11 - (suma % 11);
  const digito = resto === 10 ? 0 : resto === 11 ? 1 : resto;
  return digito === Number(ruc[10]);
}
