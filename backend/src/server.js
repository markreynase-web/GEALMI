// src/server.js
// Servidor de la API. Sirve solo /api/*; el frontend (GEALMI) sigue
// sirviéndose aparte como archivos estáticos (ej. `python -m http.server`).

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import { requestId } from './middleware/requestId.js';
import { logger } from './logger.js';
import ventasRouter from './routes/ventas.js';
import inventarioRouter from './routes/inventario.js';
import sucursalesRouter from './routes/sucursales.js';
import cajasRouter from './routes/cajas.js';
import apiKeysRouter from './routes/apiKeys.js';
import twoFactorRouter from './routes/twoFactor.js';
import publicApiRouter from './routes/publicApi.js';
import clientesRouter from './routes/clientes.js';
import finanzasRouter from './routes/finanzas.js';
import authRouter from './routes/auth.js';
import usuariosRouter from './routes/usuarios.js';
import auditoriaRouter from './routes/auditoria.js';
import empresaRouter from './routes/empresa.js';
import vehiculosRouter from './routes/vehiculos.js';
import repuestosRouter from './routes/repuestos.js';
import postventaRouter from './routes/postventa.js';
import agendaRouter from './routes/agenda.js';
import tratamientosRouter from './routes/tratamientos.js';
import planesTratamientoRouter from './routes/planesTratamiento.js';
import segurosDentalesRouter from './routes/segurosDentales.js';
import recetasOpticasRouter from './routes/recetasOpticas.js';
import ordenesLaboratorioRouter from './routes/ordenesLaboratorio.js';
import segurosVisionRouter from './routes/segurosVision.js';
import comprasRouter from './routes/compras.js';
import rrhhRouter from './routes/rrhh.js';
import produccionRouter from './routes/produccion.js';
import superadminRouter from './routes/superadmin.js';
import gealmiAiRouter from './routes/gealmiAi.js';
import mascotasRouter from './routes/mascotas.js';
import atencionesVeterinariasRouter from './routes/atencionesVeterinarias.js';
import planesVeterinariosRouter from './routes/planesVeterinarios.js';
import segurosMascotasRouter from './routes/segurosMascotas.js';
import flotaRouter from './routes/flota.js';
import conductoresRouter from './routes/conductores.js';
import rutasRouter from './routes/rutas.js';
import turnosRouter from './routes/turnos.js';
import controlDocumentarioRouter from './routes/controlDocumentario.js';
import mesasRouter from './routes/mesas.js';
import comandasRouter from './routes/comandas.js';
import combosRouter from './routes/combos.js';
import comboVentasRouter from './routes/comboVentas.js';
import planesMembresiaRouter from './routes/planesMembresia.js';
import membresiasRouter from './routes/membresias.js';
import pagosMembresiaRouter from './routes/pagosMembresia.js';

dotenv.config();

const app = express();

// Primero que cualquier otra cosa -- así TODA respuesta, incluidas las de
// error y las de un preflight CORS, lleva X-Request-Id, y cualquier log de
// esta request (los de más abajo, o los que ya existían por ruta) puede
// leer req.requestId.
app.use(requestId);

// Fase 3, Eje A (Escalabilidad) -- Sub-bloque A3: comprime toda respuesta
// JSON con gzip/br cuando el cliente lo acepta (Accept-Encoding). Aditivo y
// transparente -- ningún consumidor de la API nota la diferencia salvo por
// el header Content-Encoding; útil sobre todo para los listados de hasta
// 5000 filas de crudFactory.js / ventas.js / finanzas.js.
app.use(compression());

// V-08 (auditoría de seguridad): headers HTTP de defensa en profundidad.
// Este servidor SOLO devuelve JSON (el frontend lo sirve Vercel aparte, ver
// vercel.json en la raíz del repo -- ahí van los headers que de verdad
// protegen las páginas HTML, incluido frame-ancestors, que el spec de CSP
// ignora si se manda por <meta> en vez de header real). Por eso acá la CSP
// puede ser la más estricta posible: default-src 'none', esta API nunca
// necesita cargar ni ejecutar nada por sí misma.
app.use(helmet({
  // Todas las directivas relevantes van explícitas -- helmet completa con
  // sus propios defaults cualquier directiva que no se liste acá (ej.
  // font-src/style-src/img-src traían "https:" de fábrica la primera vez
  // que se probó esto, no lo que se había decidido). default-src 'none' +
  // cada directiva puesta a mano es la única forma de que la política real
  // sea la que dice el comentario de arriba, no la que helmet asuma.
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'none'"],
      imgSrc: ["'none'"],
      fontSrc: ["'none'"],
      connectSrc: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  // El frontend consume esta API desde OTRO origen (Vercel, no Render) --
  // el default de helmet (Cross-Origin-Resource-Policy: same-origin)
  // bloquearía esas respuestas aunque CORS las permita. cross-origin es
  // correcto acá a propósito, no un descuido.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // COEP exige que todo recurso cross-origin declare explícitamente que
  // puede embeberse -- no tiene sentido para una API JSON consumida por
  // fetch(), y activado por error podría romper la llamada desde el frontend.
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'sameorigin' },
  // Render sirve https://khipucore.onrender.com con HTTPS real (confirmado:
  // API_BASE_URL en el frontend ya es https:// a mano) y redirige HTTP a
  // HTTPS -- no hay ningún escenario legítimo de HTTP directo en producción.
  // max-age prudente (180 días), sin includeSubDomains ni preload a propósito.
  hsts: { maxAge: 15552000, includeSubDomains: false, preload: false }
  // X-Content-Type-Options: nosniff y quitar X-Powered-By quedan en el
  // comportamiento por defecto de helmet (ambos ON) -- es exactamente lo
  // que se pidió, no hace falta configurarlos a mano.
}));
app.use((req, res, next) => {
  // helmet ya no trae un middleware propio de Permissions-Policy (el spec
  // cambió mucho entre versiones) -- se setea a mano, solo con las APIs que
  // se comprobó que GEALMI no usa en ningún lado del frontend (grep de
  // mediaDevices/geolocation/bluetooth/usb/payment en todo el repo: cero
  // resultados).
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()');
  next();
});

// V-09 (auditoría de seguridad): antes, "" || '*' hacía que la AUSENCIA de
// CORS_ORIGIN terminara siendo indistinguible de haberla puesto a mano en
// '*' -- cualquier origen quedaba permitido por accidente. Ahora, sin la
// variable, origenesPermitidos queda vacío y NINGÚN origen cross-origin
// pasa (fail-closed). Un '*' explícito en la variable sigue funcionando
// igual que antes -- eso es una elección deliberada de quien despliega, no
// el comportamiento por defecto.
const origenesPermitidos = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (!origenesPermitidos.length) {
  // Mismo criterio que el aviso de JWT_SECRET de arriba: no tumba el
  // servidor (Render sigue pudiendo healthcheckear /api/salud), pero deja
  // bien visible en los logs que ningún origen cross-origin va a poder usar
  // la API hasta que se configure -- en vez de fallar en silencio (o, peor,
  // fallar abierto).
  console.error(
    'Falta CORS_ORIGIN en las variables de entorno -- por seguridad, NINGÚN origen cross-origin va a poder usar esta API hasta que la configures (ver .env.example).'
  );
}

app.use(cors({
  origin: (origenPeticion, callback) => {
    if (origenesPermitidos.includes('*') || !origenPeticion || origenesPermitidos.includes(origenPeticion)) {
      return callback(null, true);
    }
    callback(new Error(`Origen no permitido por CORS: ${origenPeticion}`));
  }
}));
app.use(express.json());

// Endpoint de salud: el frontend lo usa para saber si el backend está disponible
// antes de intentar leer/escribir datos (si no responde, cae a modo local).
app.get('/api/salud', (req, res) => res.json({ ok: true }));

if (!process.env.JWT_SECRET) {
  console.error(
    'Falta JWT_SECRET en el archivo .env. Copia .env.example a .env y ponle ' +
    'cualquier texto largo y aleatorio antes de usar el login.'
  );
}

// V-08 (hallazgo de Cache-Control): todo lo que sigue de acá para abajo es
// auth (login, recuperación de contraseña, /me) o alguno de los ~30 módulos
// de datos por-empresa/por-usuario -- nunca debería quedar en un caché
// compartido (proxies, CDN) ni en el historial/back-forward-cache del
// navegador. /api/salud ya respondió arriba y nunca llega hasta este
// middleware -- por eso no hace falta una excepción explícita por ruta,
// alcanza con el ORDEN: esto va después de /api/salud, antes de todo lo demás.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/ventas', ventasRouter);
app.use('/api/inventario', inventarioRouter);
app.use('/api/sucursales', sucursalesRouter);
app.use('/api/cajas', cajasRouter);
app.use('/api/api-keys', apiKeysRouter);
app.use('/api/2fa', twoFactorRouter);
// /api/v1: API PÚBLICA para integraciones de terceros -- autenticada con
// API keys (middleware/apiKeyAuth.js), nunca con el JWT de sesión que usa
// todo lo de arriba. Prefijo propio a propósito, ver routes/publicApi.js.
app.use('/api/v1', publicApiRouter);
app.use('/api/clientes', clientesRouter);
app.use('/api/finanzas', finanzasRouter);
app.use('/api/usuarios', usuariosRouter);
app.use('/api/auditoria', auditoriaRouter);
app.use('/api/empresa', empresaRouter);
app.use('/api/vehiculos', vehiculosRouter);
app.use('/api/repuestos', repuestosRouter);
app.use('/api/postventa', postventaRouter);
app.use('/api/agenda', agendaRouter);
app.use('/api/tratamientos', tratamientosRouter);
app.use('/api/planes_tratamiento', planesTratamientoRouter);
app.use('/api/seguros_dentales', segurosDentalesRouter);
app.use('/api/recetas_opticas', recetasOpticasRouter);
app.use('/api/ordenes_laboratorio', ordenesLaboratorioRouter);
app.use('/api/seguros_vision', segurosVisionRouter);
app.use('/api/compras', comprasRouter);
app.use('/api/rrhh', rrhhRouter);
app.use('/api/produccion', produccionRouter);
app.use('/api/superadmin', superadminRouter);
app.use('/api/gealmi-ai', gealmiAiRouter);
app.use('/api/mascotas', mascotasRouter);
app.use('/api/atenciones_veterinarias', atencionesVeterinariasRouter);
app.use('/api/planes_veterinarios', planesVeterinariosRouter);
app.use('/api/seguros_mascotas', segurosMascotasRouter);
app.use('/api/flota', flotaRouter);
app.use('/api/conductores', conductoresRouter);
app.use('/api/rutas', rutasRouter);
app.use('/api/turnos', turnosRouter);
app.use('/api/control_documentario', controlDocumentarioRouter);
app.use('/api/mesas', mesasRouter);
app.use('/api/comandas', comandasRouter);
app.use('/api/combos', combosRouter);
app.use('/api/combo_ventas', comboVentasRouter);
app.use('/api/planes_membresia', planesMembresiaRouter);
app.use('/api/membresias', membresiasRouter);
app.use('/api/pagos_membresia', pagosMembresiaRouter);

app.use((req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

// Manejador global -- solo atrapa lo que ninguna ruta ya haya atrapado por
// su cuenta (casi todas tienen su propio try/catch con console.error, ver
// diagnóstico de observabilidad; esto cubre lo que se escapa de eso, ej.
// un JSON malformado que rompe express.json() antes de llegar a cualquier
// ruta). Log estructurado con pino: requestId para poder correlacionar
// esta línea con cualquier otra de la misma request, y contexto de quién
// y qué -- nunca el body crudo sin pasar por el redact ya configurado en
// logger.js.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode: 500,
    usuario_id: req.usuario?.id ?? null,
    empresa_id: req.usuario?.empresa_id ?? null,
    body: req.body,
    err
  }, 'Error no controlado');
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// PORT: la mayoría de los hosts (Render, Railway, Heroku...) asignan el
// puerto ellos mismos por esta variable y esperan que el server escuche ahí.
// API_PORT se mantiene como respaldo para desarrollo local con .env propio.
const PORT = process.env.PORT || process.env.API_PORT || 3001;
app.listen(PORT, () => {
  console.log(`API de Ventas escuchando en http://localhost:${PORT}`);
  console.log('Si no has corrido las migraciones todavía: npm run migrate');
});
