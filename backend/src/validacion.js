// src/validacion.js
// Validaciones compartidas por las rutas que arman su propio CRUD a mano (RRHH,
// Marketing): cada una devuelve el valor LIMPIO o lanza ErrorValidacion con un
// 400 claro, en vez de dejar que la base lo rebote como un 500 genérico.
// Nació dentro de src/rrhh/comun.js (que sigue re-exportándola).

import { fechaEnLima } from './rrhh/calculos.js';

export class ErrorValidacion extends Error {
  constructor(mensaje, status = 400) {
    super(mensaje);
    this.status = status;
  }
}

// Un solo lugar para el catch de todos los handlers: los ErrorValidacion salen
// tal cual (400/403/404/409 con su mensaje), y lo demás es un 500 genérico con
// el detalle solo en la consola.
export function responderError(res, err, mensajeGenerico) {
  if (err instanceof ErrorValidacion) return res.status(err.status).json({ error: err.message });
  // 23505 = violación de UNIQUE: casi siempre "ya existe", no un fallo del servidor.
  if (err?.code === '23505') return res.status(409).json({ error: err.detail ? 'Ya existe un registro con esos datos.' : 'Registro duplicado.' });
  console.error(err);
  return res.status(500).json({ error: mensajeGenerico });
}

export const hoyLima = () => fechaEnLima(Date.now());
export const tienePermiso = (req, permiso) => (req.usuario?.permisos || []).includes(permiso);

export function idPositivo(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function esFechaISO(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const vacio = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// Validadores: cada uno devuelve el valor LIMPIO (o null si es opcional y vino
// vacío) o lanza ErrorValidacion con el nombre del campo en el mensaje.
export const validar = {
  texto(v, nombre, { max = 250, requerido = false } = {}) {
    if (vacio(v)) {
      if (requerido) throw new ErrorValidacion(`${nombre} es requerido.`);
      return null;
    }
    if (typeof v !== 'string' && typeof v !== 'number') throw new ErrorValidacion(`${nombre} no es válido.`);
    const limpio = String(v).trim();
    if (limpio.length > max) throw new ErrorValidacion(`${nombre} no puede pasar de ${max} caracteres.`);
    return limpio;
  },

  fecha(v, nombre, { requerido = false } = {}) {
    if (vacio(v)) {
      if (requerido) throw new ErrorValidacion(`${nombre} es requerido.`);
      return null;
    }
    const s = String(v).trim().slice(0, 10);
    if (!esFechaISO(s)) throw new ErrorValidacion(`${nombre} debe ser una fecha válida (AAAA-MM-DD).`);
    return s;
  },

  numero(v, nombre, { min = 0, max = 1e9, requerido = false, porDefecto = null } = {}) {
    if (vacio(v)) {
      if (requerido) throw new ErrorValidacion(`${nombre} es requerido.`);
      return porDefecto;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ErrorValidacion(`${nombre} debe ser un número.`);
    if (n < min) throw new ErrorValidacion(`${nombre} no puede ser menor que ${min}.`);
    if (n > max) throw new ErrorValidacion(`${nombre} no puede ser mayor que ${max}.`);
    return n;
  },

  entero(v, nombre, opciones = {}) {
    const n = validar.numero(v, nombre, opciones);
    if (n !== null && !Number.isInteger(n)) throw new ErrorValidacion(`${nombre} debe ser un número entero.`);
    return n;
  },

  enumerado(v, nombre, lista, { requerido = false, porDefecto = null } = {}) {
    if (vacio(v)) {
      if (requerido) throw new ErrorValidacion(`${nombre} es requerido.`);
      return porDefecto;
    }
    if (!lista.includes(v)) throw new ErrorValidacion(`${nombre} debe ser uno de: ${lista.join(', ')}.`);
    return v;
  },

  // HH:MM (24 h).
  hora(v, nombre) {
    if (vacio(v)) return null;
    const s = String(v).trim().slice(0, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new ErrorValidacion(`${nombre} debe tener el formato HH:MM.`);
    return s;
  },

  // Solo https (y de un tamaño razonable): el enlace se muestra como <a href>,
  // así que nunca debe poder ser javascript: ni data:.
  https(v, nombre) {
    if (vacio(v)) return null;
    const s = String(v).trim();
    if (s.length > 500) throw new ErrorValidacion(`${nombre} no puede pasar de 500 caracteres.`);
    let url;
    try { url = new URL(s); } catch { throw new ErrorValidacion(`${nombre} debe ser un enlace válido.`); }
    if (url.protocol !== 'https:') throw new ErrorValidacion(`${nombre} debe empezar con https://`);
    return url.toString();
  }
};
