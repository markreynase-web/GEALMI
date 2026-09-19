// src/logger.js
// Logger centralizado (pino). No se usa pino-http a propósito: su
// serializer de request/response trae su propia forma interna del objeto,
// menos predecible -- acá se arma a mano, en cada call site, exactamente
// la forma que se necesita (ver server.js), así los "paths" de redacción
// de abajo coinciden con certeza con lo que de verdad se loguea, sin
// depender de la forma interna de una librería de terceros.
//
// serializers.err: sin esto, un Error nativo se serializa como "{}" --
// sus propiedades (message, stack) no son enumerables por defecto, y
// JSON.stringify las ignora. pino.stdSerializers.err las saca a mano.
//
// redact: la garantía real de este archivo. Los paths listados quedan
// censurados en CUALQUIER log que use este logger, sin depender de que
// quien escriba un log nuevo se acuerde de sanitizar a mano. Alcance
// actual: password/contraseña/token del body, y el header Authorization
// (JWT) -- ninguno de los dos aparece hoy en la forma de log que arma el
// manejador global de errores (no incluye headers), pero queda la regla
// puesta como defensa en profundidad para cualquier log futuro que sí
// los incluya.

import pino from 'pino';

export const logger = pino({
  redact: {
    paths: [
      'body.password',
      'body.contrasena',
      'body.confirmarPassword',
      'body.confirmarContrasena',
      'body.token',
      // POST /login/empresa recibe un JWT de corta duración (preAuthToken)
      // en el body -- mismo criterio que cualquier otro token.
      'body.preAuthToken',
      // 2FA (POST /login/2fa, /2fa/activar, /2fa/desactivar): el código de la
      // app, el de recuperación y el desafío del login son credenciales.
      'body.codigo',
      'body.codigoRecuperacion',
      'body.desafioToken',
      // GET /reset-password/validar recibe el token de reset por query
      // string, no por body -- mismo criterio que body.token, ruta distinta.
      'query.token',
      'headers.authorization',
      // body-parser adjunta el texto CRUDO del request como err.body cuando
      // el JSON no puede parsearse -- es texto libre sin estructura, así
      // que no hay campos individuales que sanitizar: se censura entero.
      // Encontrado corriendo la prueba real de este mismo bloque, no
      // anticipado en el diseño original.
      'err.body'
    ],
    censor: '[REDACTED]'
  },
  serializers: {
    err: pino.stdSerializers.err
  }
});
