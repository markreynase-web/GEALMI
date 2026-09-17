// src/nubefact.js
// Facturación electrónica SUNAT vía la API REST de NubeFacT
// (https://www.nubefact.com/) -- campos y estructura tomados del manual
// oficial "Manual de Integración - Archivo JSON" (v3.0).
//
// Cliente delgado, SIN builder de negocio todavía: arma exactamente el
// payload que se le pase y lo manda. Construir el contenido real de una
// factura (montos, IGV, líneas -- "esto es lo que GEALMI le cobró a la
// empresa X por su suscripción del mes Y") depende del sistema de
// Contratación/Pagos, que todavía no existe (ver el documento maestro
// "Contratación y Facturación"). Este módulo solo resuelve la parte de
// "cómo hablar con NubeFact", igual que mailer.js resuelve "cómo hablar
// con Brevo": nunca lanza si faltan credenciales, mismo criterio en todo
// el proyecto.

// Tabla de códigos de error propios de NubeFact (sección "MANEJO DE
// ERRORES" del manual) -- para no tener que memorizarla cada vez que algo
// falla.
const CODIGOS_ERROR = {
  10: 'No se pudo autenticar: token incorrecto o eliminado.',
  11: 'La ruta (URL) no es correcta o no existe -- revisar NUBEFACT_RUTA en la cuenta de NubeFact, opción API-Integración.',
  12: 'Content-Type incorrecto en la solicitud.',
  20: 'El archivo enviado no cumple con el formato establecido.',
  21: 'No se pudo completar la operación.',
  22: 'Documento enviado fuera del plazo permitido.',
  23: 'Este documento ya existe en NubeFacT.',
  24: 'El documento indicado no existe o no fue enviado a NubeFacT.',
  40: 'Error interno desconocido de NubeFacT.',
  50: 'La cuenta de NubeFacT ha sido suspendida.',
  51: 'La cuenta de NubeFacT ha sido suspendida por falta de pago.'
};

// Leídas en el momento de la llamada, no al cargar el módulo -- mismo
// patrón que remitenteConfigurado()/enviarCorreoRecuperacion() en
// mailer.js. Leerlas como `const` al tope del archivo dependería de que
// dotenv.config() ya haya corrido antes por el orden de imports de
// server.js -- funciona hoy de casualidad, pero es frágil ante el día que
// ese orden cambie.
export function nubefactConfigurado() {
  return Boolean(process.env.NUBEFACT_RUTA && process.env.NUBEFACT_TOKEN);
}

/**
 * Llama a la API de NubeFact con el payload dado (debe incluir
 * "operacion"). Nunca lanza -- ni por credenciales faltantes ni por
 * errores de red/HTTP/NubeFact -- siempre devuelve { ok, ... } para que
 * quien llama decida qué hacer, mismo patrón que enviarCorreoRecuperacion()
 * en mailer.js.
 * @returns {Promise<{ok:true, datos:object} | {ok:false, motivo:string, codigo?:number, detalle?:string}>}
 */
async function llamarNubefact(payload) {
  if (!nubefactConfigurado()) {
    console.warn('[nubefact] NUBEFACT_RUTA o NUBEFACT_TOKEN no configurados -- no se envió nada.');
    return { ok: false, motivo: 'no_configurado' };
  }
  try {
    const res = await fetch(process.env.NUBEFACT_RUTA, {
      method: 'POST',
      headers: { Authorization: process.env.NUBEFACT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const cuerpo = await res.json().catch(() => ({}));
    // NubeFact responde 200 con { errors, codigo } en vez de un status HTTP
    // de error para sus propios errores de negocio (ver manual) -- hay que
    // revisar el cuerpo, no solo res.ok.
    if (cuerpo.errors) {
      // cuerpo.errors YA trae el mensaje real de NubeFact (ej. para el
      // código 21, "se acompaña el problema con un mensaje" -- ver manual)
      // -- nunca pisarlo con el texto genérico de la tabla. La tabla solo
      // sirve como contexto adicional cuando el mensaje de NubeFact por sí
      // solo no alcanza a explicar el código.
      const contexto = CODIGOS_ERROR[cuerpo.codigo];
      const detalle = contexto && contexto !== cuerpo.errors ? `${cuerpo.errors} (${contexto})` : cuerpo.errors;
      return { ok: false, motivo: 'error_nubefact', codigo: cuerpo.codigo, detalle };
    }
    if (!res.ok) {
      return { ok: false, motivo: 'error_http', status: res.status, detalle: cuerpo };
    }
    return { ok: true, datos: cuerpo };
  } catch (err) {
    return { ok: false, motivo: 'error_red', detalle: err.message };
  }
}

// OPERACIÓN 1: generar un comprobante (factura=1, boleta=2, nota de
// crédito=3, nota de débito=4 -- ver tipo_de_comprobante en el manual).
export function generarComprobante(datosComprobante) {
  return llamarNubefact({ operacion: 'generar_comprobante', ...datosComprobante });
}

// OPERACIÓN 2: consultar el estado de un comprobante ya emitido.
export function consultarComprobante({ tipo_de_comprobante, serie, numero }) {
  return llamarNubefact({ operacion: 'consultar_comprobante', tipo_de_comprobante, serie, numero });
}

// OPERACIÓN 3: anular un comprobante (o comunicar su baja).
export function anularComprobante({ tipo_de_comprobante, serie, numero, motivo }) {
  return llamarNubefact({ operacion: 'generar_anulacion', tipo_de_comprobante, serie, numero, motivo });
}

// OPERACIÓN 4: consultar el estado de una anulación.
export function consultarAnulacion({ tipo_de_comprobante, serie, numero }) {
  return llamarNubefact({ operacion: 'consultar_anulacion', tipo_de_comprobante, serie, numero });
}
