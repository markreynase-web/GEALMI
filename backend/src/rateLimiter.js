// src/rateLimiter.js
// Limitador de tasa mínimo, en memoria (sin Redis ni tabla nueva) -- pensado
// para endpoints públicos de bajo volumen y alto riesgo de abuso (hoy, solo
// recuperación de contraseña, ver routes/auth.js). Vive en memoria del
// proceso: se reinicia en cada redeploy y no se comparte entre instancias --
// para el despliegue actual de GEALMI (un solo servicio en Render) es
// protección real. Si algún día el backend corre en más de una instancia a
// la vez, esto deja de ser confiable para todas las instancias juntas y
// haría falta algo compartido (una tabla, o Redis).

const intentos = new Map(); // clave -> timestamps[] (ms) de intentos recientes

/**
 * @param {string} clave - qué se está limitando (ej. un email normalizado)
 * @param {object} opciones
 * @param {number} opciones.maxIntentos
 * @param {number} opciones.ventanaMs
 * @returns {boolean} true si este intento está permitido
 */
export function permitir(clave, { maxIntentos, ventanaMs }) {
  const ahora = Date.now();
  const historial = (intentos.get(clave) || []).filter(t => ahora - t < ventanaMs);
  if (historial.length >= maxIntentos) {
    intentos.set(clave, historial);
    return false;
  }
  historial.push(ahora);
  intentos.set(clave, historial);
  return true;
}
