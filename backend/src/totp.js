// src/totp.js
// 2FA por TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 dígitos) -- el formato que leen
// Google Authenticator, Authy, Microsoft Authenticator, 1Password, etc.
// Implementado sobre node:crypto (sin dependencias nuevas) y probado contra
// los vectores oficiales del RFC (ver tests/totp.test.js).
//
// Todo lo de acá es puro (no toca la base ni Express) salvo leer
// TOTP_ENCRYPTION_KEY del entorno para cifrar/descifrar.

import crypto from 'node:crypto';

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PASO_SEGUNDOS = 30;
const DIGITOS = 6;

export function codificarBase32(buffer) {
  let bits = 0;
  let acumulado = 0;
  let salida = '';
  for (const byte of buffer) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32[(acumulado >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_BASE32[(acumulado << (5 - bits)) & 31];
  return salida;
}

export function decodificarBase32(texto) {
  const limpio = String(texto).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let acumulado = 0;
  const bytes = [];
  for (const caracter of limpio) {
    const valor = ALFABETO_BASE32.indexOf(caracter);
    if (valor === -1) throw new Error('Secreto base32 inválido.');
    acumulado = (acumulado << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acumulado >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// 160 bits, el tamaño que recomienda el RFC 4226 para HMAC-SHA1.
export function generarSecreto() {
  return codificarBase32(crypto.randomBytes(20));
}

function hotp(secreto, contador) {
  const mensaje = Buffer.alloc(8);
  mensaje.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', secreto).update(mensaje).digest();
  const desplazamiento = hmac[hmac.length - 1] & 0x0f;
  const numero = ((hmac[desplazamiento] & 0x7f) << 24) |
    (hmac[desplazamiento + 1] << 16) |
    (hmac[desplazamiento + 2] << 8) |
    hmac[desplazamiento + 3];
  return String(numero % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

export function pasoDeTiempo(ahoraMs = Date.now()) {
  return Math.floor(ahoraMs / 1000 / PASO_SEGUNDOS);
}

// El código que mostraría la app autenticadora en ese instante. Lo usan los
// tests para hacer de "celular" -- el servidor solo necesita verificarCodigoTotp.
export function codigoTotp(secretoBase32, ahoraMs = Date.now()) {
  return hotp(decodificarBase32(secretoBase32), pasoDeTiempo(ahoraMs));
}

// Devuelve el intervalo (paso) al que corresponde el código, o null si no
// coincide. Tolera ±1 intervalo (relojes del celular y del servidor no son
// idénticos). Recorre SIEMPRE los tres intervalos y compara en tiempo
// constante: cuánto tarda no debe delatar qué tan cerca estuvo el código.
export function verificarCodigoTotp(secretoBase32, codigo, { ahoraMs = Date.now(), ventana = 1 } = {}) {
  const limpio = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpio)) return null;

  const secreto = decodificarBase32(secretoBase32);
  const pasoActual = pasoDeTiempo(ahoraMs);
  const recibido = Buffer.from(limpio);
  let coincidencia = null;
  for (let desvio = -ventana; desvio <= ventana; desvio++) {
    const paso = pasoActual + desvio;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secreto, paso)), recibido) && coincidencia === null) {
      coincidencia = paso;
    }
  }
  return coincidencia;
}

// URL que leen las apps autenticadoras (se dibuja como QR en el frontend).
export function urlOtpauth({ secreto, email, emisor = 'GEALMI' }) {
  const etiqueta = encodeURIComponent(`${emisor}:${email}`);
  return `otpauth://totp/${etiqueta}?secret=${secreto}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=${DIGITOS}&period=${PASO_SEGUNDOS}`;
}

// --- Cifrado del secreto en la base ---------------------------------------
// AES-256-GCM con TOTP_ENCRYPTION_KEY (64 caracteres hex = 32 bytes). Si la
// clave no está (o está mal formada) el 2FA queda deshabilitado en vez de
// guardar secretos en claro: ver cifradoDisponible().
// Formato guardado: v1:<iv>:<tag>:<cifrado>, todo en base64.
function claveCifrado() {
  const hex = process.env.TOTP_ENCRYPTION_KEY || '';
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

export function cifradoDisponible() {
  return claveCifrado() !== null;
}

export function cifrarSecreto(texto) {
  const clave = claveCifrado();
  if (!clave) throw new Error('TOTP_ENCRYPTION_KEY no está configurada.');
  const iv = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', clave, iv);
  const cifrado = Buffer.concat([cifrador.update(texto, 'utf8'), cifrador.final()]);
  return ['v1', iv.toString('base64'), cifrador.getAuthTag().toString('base64'), cifrado.toString('base64')].join(':');
}

export function descifrarSecreto(guardado) {
  const clave = claveCifrado();
  if (!clave) throw new Error('TOTP_ENCRYPTION_KEY no está configurada.');
  const [version, iv, tag, cifrado] = String(guardado).split(':');
  if (version !== 'v1' || !iv || !tag || !cifrado) throw new Error('Formato de secreto cifrado inválido.');
  const descifrador = crypto.createDecipheriv('aes-256-gcm', clave, Buffer.from(iv, 'base64'));
  descifrador.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([descifrador.update(Buffer.from(cifrado, 'base64')), descifrador.final()]).toString('utf8');
}

// --- Códigos de recuperación ----------------------------------------------
// 10 caracteres de un alfabeto sin caracteres confusos (0/O, 1/I/L): ~49 bits.
// Se guardan como HMAC con la clave del servidor -- aunque se filtrara la
// tabla, sin la clave no se puede probar un código por fuerza bruta offline.
const ALFABETO_CODIGOS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LARGO_CODIGO = 10;

export function generarCodigosRecuperacion(cantidad = 10) {
  return Array.from({ length: cantidad }, () => {
    let codigo = '';
    for (let i = 0; i < LARGO_CODIGO; i++) codigo += ALFABETO_CODIGOS[crypto.randomInt(ALFABETO_CODIGOS.length)];
    return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
  });
}

// Lo que escribe la persona puede traer minúsculas, espacios o guion de más.
export function normalizarCodigoRecuperacion(texto) {
  return String(texto ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashCodigoRecuperacion(codigoNormalizado) {
  const clave = claveCifrado();
  if (!clave) throw new Error('TOTP_ENCRYPTION_KEY no está configurada.');
  return crypto.createHmac('sha256', clave).update(`recuperacion-2fa:${codigoNormalizado}`).digest('hex');
}
