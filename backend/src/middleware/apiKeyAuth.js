// src/middleware/apiKeyAuth.js
// Autenticación de la API pública (/api/v1/*) -- separada A PROPÓSITO del
// JWT de sesión (middleware/auth.js). Una integración de un tercero (su BI,
// su contador, su ERP) no tiene una persona logueada detrás renovando un
// token cada 8h -- necesita una credencial de larga duración, por empresa,
// que se pueda revocar sin afectar a nadie más. Ver migración 042 para el
// formato exacto de la key y por qué "prefijo" no es secreto.
//
// Cómo se verifica la key (SHA-256, con las llaves viejas en bcrypt aún
// aceptadas) y por qué: ver src/apiKeyHash.js.

import { pool } from '../db.js';
import { permitir } from '../rateLimiter.js';
import { verificarApiKey, esHashBcrypt } from '../apiKeyHash.js';

const LARGO_PREFIJO = 'gealmi_'.length + 12; // 'gealmi_' + 12 chars de la parte al azar

// Las llaves guardadas con bcrypt (antes del cambio a SHA-256) cuestan ~60 ms de CPU por
// verificación hasta que se usan bien por primera vez y pasan a SHA-256. Mientras tanto se
// limitan esas verificaciones POR PREFIJO: así nadie que conozca un prefijo (se muestra en la
// pantalla de API keys) puede usarlas para saturar la CPU del servidor con llaves inventadas.
const MAX_VERIFICACIONES_BCRYPT_POR_MINUTO = 20;

// Rate limit por key VÁLIDA (no por IP -- varias integraciones legítimas pueden compartir la
// misma IP saliente, ej. detrás de un mismo proxy/nube). 120/min es generoso para "sacar mis
// datos hacia otro sistema" (el caso de uso real de esta v1, ver la Sub-fase B del roadmap)
// sin abrir la puerta a scraping masivo.
const MAX_PETICIONES_POR_MINUTO = 120;

const MENSAJE_LIMITE = 'Demasiadas solicitudes. Probá de nuevo en un minuto.';

export async function authApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!key) {
    return res.status(401).json({ error: 'Falta la API key. Mandala como "Authorization: Bearer <tu_api_key>".' });
  }

  try {
    const prefijo = key.slice(0, LARGO_PREFIJO);
    // Busca por prefijo (indexado) primero -- evita comparar contra TODAS las keys de la base en
    // cada request; solo se verifica contra las pocas filas (normalmente 0 o 1) que calzan el prefijo.
    const { rows } = await pool.query(
      `SELECT id, empresa_id, key_hash, activa FROM api_keys WHERE prefijo = $1`,
      [prefijo]
    );
    let filaValida = null;
    let hashNuevo = null;
    for (const fila of rows) {
      if (!fila.activa) continue;
      if (esHashBcrypt(fila.key_hash) && !permitir(`apikey-bcrypt:${prefijo}`, { maxIntentos: MAX_VERIFICACIONES_BCRYPT_POR_MINUTO, ventanaMs: 60 * 1000 })) {
        return res.status(429).json({ error: MENSAJE_LIMITE });
      }
      const resultado = await verificarApiKey(key, fila.key_hash);
      if (resultado.valida) { filaValida = fila; hashNuevo = resultado.hashNuevo; break; }
    }
    if (!filaValida) return res.status(401).json({ error: 'API key inválida o revocada.' });

    // El límite va DESPUÉS de validar y se cuenta por id de la key: una llave inventada nunca crea
    // un contador (antes se contaba por el texto que mandaran, y cada llave falsa dejaba su propia
    // entrada en memoria para siempre).
    if (!permitir(`apikey:${filaValida.id}`, { maxIntentos: MAX_PETICIONES_POR_MINUTO, ventanaMs: 60 * 1000 })) {
      return res.status(429).json({ error: MENSAJE_LIMITE });
    }

    // Llave válida guardada con bcrypt: se re-guarda como SHA-256 para que las siguientes
    // peticiones ya no paguen bcrypt. Fire-and-forget; el "AND key_hash = ..." evita pisar un
    // cambio concurrente (dos primeras peticiones a la vez hacen el mismo UPDATE, sin problema).
    if (hashNuevo) {
      pool.query(`UPDATE api_keys SET key_hash = $1 WHERE id = $2 AND key_hash = $3`, [hashNuevo, filaValida.id, filaValida.key_hash])
        .catch(err => console.error('No se pudo pasar la api key a SHA-256:', err.message));
    }

    // La empresa sigue activa Y su plan actual sigue incluyendo acceso a la
    // API -- una key generada en Profesional no debe seguir funcionando si
    // la empresa bajó a Básico después (ni si la empresa fue desactivada).
    const { rows: empresaRows } = await pool.query(
      `SELECT e.id, e.activo, COALESCE(p.acceso_api, false) AS acceso_api
       FROM empresas e LEFT JOIN planes p ON p.id = e.plan_id
       WHERE e.id = $1`,
      [filaValida.empresa_id]
    );
    const empresa = empresaRows[0];
    if (!empresa || !empresa.activo) return res.status(401).json({ error: 'API key inválida o revocada.' });
    if (!empresa.acceso_api) {
      return res.status(403).json({ error: 'Tu plan actual no incluye acceso a la API pública.' });
    }

    req.empresaId = filaValida.empresa_id;
    req.apiKeyId = filaValida.id;
    // Fire-and-forget, igual que registrarAuditoria() -- no vale la pena
    // que cada request de la API pública espere a este UPDATE ni que un
    // fallo acá tumbe la respuesta real.
    pool.query(`UPDATE api_keys SET ultimo_uso_el = now() WHERE id = $1`, [filaValida.id])
      .catch(err => console.error('No se pudo actualizar ultimo_uso_el de la api key:', err.message));
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo validar la API key.' });
  }
}
