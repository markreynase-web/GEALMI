// src/apiKeyHash.js
// Cómo se guarda y se verifica una API key de la API pública.
//
// Una API key es "gealmi_" + 40 caracteres hex al azar (crypto.randomBytes(20)):
// 160 bits de aleatoriedad, de los que solo 48 se muestran (el prefijo). Con 112
// bits secretos NO hay nada que adivinar por fuerza bruta, aunque la huella sea
// rápida -- lo que la protege es que es aleatoria, no que la comparación sea lenta.
// bcrypt es para contraseñas de personas (predecibles); aplicado a esto solo
// cuesta ~60 ms de CPU por petición (se midió), en un servidor de un solo hilo
// que atiende a todas las empresas. Por eso una key nueva se guarda con SHA-256.
//
// Formato de key_hash (la columna es VARCHAR(255) y no cambia):
//   'sha256:<64 hex>'   -- el formato actual;
//   '$2a$10$...'        -- el formato anterior (bcrypt). Se sigue aceptando para que
//                          NINGUNA llave existente deje de funcionar, y en cuanto una
//                          se usa bien por primera vez se re-guarda como SHA-256
//                          (verificarApiKey devuelve `hashNuevo`). No hace falta
//                          migración: el texto de la key solo se conoce cuando llega.

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const PREFIJO_SHA256 = 'sha256:';

export const esHashSha256 = (hash) => typeof hash === 'string' && hash.startsWith(PREFIJO_SHA256);
export const esHashBcrypt = (hash) => typeof hash === 'string' && /^\$2[aby]\$/.test(hash);

export function hashDeApiKey(key) {
  return PREFIJO_SHA256 + crypto.createHash('sha256').update(String(key), 'utf8').digest('hex');
}

// Compara sin que el tiempo de respuesta delate cuántos caracteres coinciden.
function igualesEnTiempoConstante(a, b) {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return bufferA.length === bufferB.length && crypto.timingSafeEqual(bufferA, bufferB);
}

/**
 * @returns {Promise<{ valida: boolean, hashNuevo: string|null }>}
 *   hashNuevo: cuando la key era válida pero estaba guardada con bcrypt, el hash
 *   SHA-256 con el que hay que reemplazarlo. Un formato desconocido nunca se acepta.
 */
export async function verificarApiKey(key, hashGuardado) {
  if (esHashSha256(hashGuardado)) {
    return { valida: igualesEnTiempoConstante(hashDeApiKey(key), hashGuardado), hashNuevo: null };
  }
  if (esHashBcrypt(hashGuardado)) {
    const valida = await bcrypt.compare(String(key), hashGuardado);
    return { valida, hashNuevo: valida ? hashDeApiKey(key) : null };
  }
  return { valida: false, hashNuevo: null };
}
