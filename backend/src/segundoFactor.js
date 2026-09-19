// src/segundoFactor.js
// Verificación del segundo factor (2FA) contra la base. La comparten el login
// (routes/auth.js, POST /login/2fa) y las acciones sensibles de la pantalla de
// Seguridad (routes/twoFactor.js). El límite de intentos NO va acá: lo aplica
// cada ruta con su propia clave (ver rateLimiter.js).

import { pool } from './db.js';
import { descifrarSecreto, verificarCodigoTotp, normalizarCodigoRecuperacion, hashCodigoRecuperacion } from './totp.js';

/**
 * @param {number} usuarioId
 * @param {{ codigo?: string, codigoRecuperacion?: string }} factor - un código de la app o uno de recuperación
 * @returns {Promise<{ ok: boolean, medio?: 'totp'|'recuperacion', motivo?: 'sin_2fa'|'incorrecto'|'reutilizado' }>}
 */
export async function verificarSegundoFactor(usuarioId, { codigo, codigoRecuperacion } = {}) {
  const { rows } = await pool.query(
    'SELECT totp_secreto_cifrado, totp_activado_el FROM usuarios WHERE id = $1 AND activo = true',
    [usuarioId]
  );
  const usuario = rows[0];
  if (!usuario || !usuario.totp_activado_el) return { ok: false, motivo: 'sin_2fa' };

  if (codigo) {
    const paso = verificarCodigoTotp(descifrarSecreto(usuario.totp_secreto_cifrado), codigo);
    if (paso === null) return { ok: false, motivo: 'incorrecto' };
    // Cada código sirve UNA vez. La condición va DENTRO del UPDATE (no un
    // "leer y luego comparar"): si dos requests llegan a la vez con el mismo
    // código, solo una encuentra totp_ultimo_paso < paso y gana.
    const { rowCount } = await pool.query(
      'UPDATE usuarios SET totp_ultimo_paso = $2 WHERE id = $1 AND (totp_ultimo_paso IS NULL OR totp_ultimo_paso < $2)',
      [usuarioId, paso]
    );
    return rowCount === 1 ? { ok: true, medio: 'totp' } : { ok: false, motivo: 'reutilizado' };
  }

  if (codigoRecuperacion) {
    const hash = hashCodigoRecuperacion(normalizarCodigoRecuperacion(codigoRecuperacion));
    // Igual: marcar como usado y comprobar que existía sin usar es UNA sola
    // operación atómica.
    const { rowCount } = await pool.query(
      'UPDATE codigos_recuperacion_2fa SET usado_el = now() WHERE usuario_id = $1 AND codigo_hash = $2 AND usado_el IS NULL',
      [usuarioId, hash]
    );
    return rowCount === 1 ? { ok: true, medio: 'recuperacion' } : { ok: false, motivo: 'incorrecto' };
  }

  return { ok: false, motivo: 'incorrecto' };
}
