// src/rateLimiter.js
// Limitador de tasa mínimo, en memoria (sin Redis ni tabla nueva) -- pensado
// para endpoints públicos de bajo volumen y alto riesgo de abuso (recuperación
// de contraseña, login, 2FA, mensajes y la API pública, ver quién lo usa con
// `grep permitir src`). Vive en memoria del proceso: se reinicia en cada
// redeploy y no se comparte entre instancias -- para el despliegue actual de
// GEALMI (un solo servicio en Render) es protección real. Si algún día el
// backend corre en más de una instancia a la vez, esto deja de ser confiable
// para todas las instancias juntas y haría falta algo compartido (una tabla, o
// Redis).
//
// Memoria acotada: varias claves salen de lo que manda quien llama (el email de
// un login, por ejemplo), así que un atacante podría inventar claves nuevas sin
// parar. Por eso cada entrada guarda cuándo VENCE (su último intento + la
// ventana), lo vencido se barre cada tanto, y hay un tope duro de claves.

const MAX_CLAVES = 50000;
const BARRER_CADA = 500; // llamadas a permitir() entre barridos

// clave -> { marcas: timestamps (ms) de los intentos dentro de la ventana, vence: ms }
const intentos = new Map();
let llamadasDesdeElBarrido = 0;

function barrer(ahora) {
  for (const [clave, entrada] of intentos) {
    if (entrada.vence <= ahora) intentos.delete(clave);
  }
  // Tope duro: si aun así hay demasiadas, se sueltan las menos recientes (el Map conserva
  // el orden en que se reinsertó cada clave, y permitir() la reinserta en cada uso).
  let sobran = intentos.size - MAX_CLAVES;
  if (sobran > 0) {
    for (const clave of intentos.keys()) {
      if (sobran-- <= 0) break;
      intentos.delete(clave);
    }
  }
}

/**
 * @param {string} clave - qué se está limitando (ej. un email normalizado)
 * @param {object} opciones
 * @param {number} opciones.maxIntentos
 * @param {number} opciones.ventanaMs
 * @returns {boolean} true si este intento está permitido
 */
export function permitir(clave, { maxIntentos, ventanaMs }) {
  const ahora = Date.now();
  if (++llamadasDesdeElBarrido >= BARRER_CADA || intentos.size > MAX_CLAVES) {
    llamadasDesdeElBarrido = 0;
    barrer(ahora);
  }
  const previo = intentos.get(clave);
  const marcas = previo ? previo.marcas.filter(t => ahora - t < ventanaMs) : [];
  const permitido = marcas.length < maxIntentos;
  if (permitido) marcas.push(ahora);
  // Un intento bloqueado no se anota: la ventana la sigue marcando el último intento que sí pasó.
  const ultima = marcas.length ? marcas[marcas.length - 1] : ahora;
  intentos.delete(clave); // reinsertar = "usada hace poco" para el tope duro
  intentos.set(clave, { marcas, vence: ultima + ventanaMs });
  return permitido;
}

// Solo para las pruebas (tests/api-key-hash.test.js): tamaño actual y reinicio.
export const _paraPruebas = {
  tamano: () => intentos.size,
  reiniciar: () => { intentos.clear(); llamadasDesdeElBarrido = 0; },
  MAX_CLAVES,
  BARRER_CADA
};
