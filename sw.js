// sw.js — Service worker de GEALMI. Vive en la raíz a propósito (no en
// js/) para que su "scope" cubra TODO el sitio, incluidas las páginas bajo
// /pages/ -- un service worker solo puede controlar rutas iguales o por
// debajo de la carpeta donde vive.
//
// Estrategia deliberadamente conservadora, después de un bug real en esta
// misma sesión (usuarios.html sin <script src="lib/chart.js">, agravado
// porque cualquier caché vieja hubiera tapado el fix): NINGÚN HTML ni JS
// se sirve "cache-first para siempre" -- nunca queremos que alguien quede
// atrapado en una versión vieja del código sin darse cuenta.
//
//   - Navegación (los .html):        network-first -- si hay red, SIEMPRE
//                                     la versión nueva; el cache es solo
//                                     el salvavidas para cuando no hay red.
//   - JS/CSS/fuentes/imágenes propias: stale-while-revalidate -- responde
//                                     al toque desde cache (rápido), pero
//                                     SIEMPRE pide la versión fresca en
//                                     paralelo y la deja lista para la
//                                     PRÓXIMA carga. Nunca se queda pegado.
//   - /api/*  (el backend):          jamás se toca -- ni se cachea ni se
//                                     intercepta. Es una app multi-tenant
//                                     con datos reales de cada empresa; cachear
//                                     una respuesta de la API sería servirle
//                                     a alguien datos de otra sesión/momento.
//
// skipWaiting()/clients.claim(): la versión nueva del service worker toma
// control apenas se instala, no espera a que se cierren todas las pestañas.

const CACHE = 'khipu-shell-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Borra cualquier caché de una versión anterior del service worker --
      // así un CACHE nuevo (ej. 'khipu-shell-v2' el día que haga falta
      // invalidar todo de una) no deja basura vieja ocupando espacio.
      const nombres = await caches.keys();
      await Promise.all(nombres.filter(n => n !== CACHE).map(n => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Solo GET, solo mismo origen -- todo lo demás (POST/PUT/DELETE, y
  // cualquier request a api.khipucore.com u otro origen -- el dominio del
  // backend sigue siendo khipucore.com hasta que se compre el de GEALMI)
  // pasa de largo sin que este service worker lo toque para nada.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Nunca intercepta la API, aunque algún día se sirva desde el mismo
  // origen -- doble candado además del chequeo de origen de arriba.
  if (new URL(req.url).pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirst(req) {
  try {
    const fresca = await fetch(req);
    const cache = await caches.open(CACHE);
    cache.put(req, fresca.clone());
    return fresca;
  } catch {
    const cacheada = await caches.match(req);
    return cacheada || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const cacheada = await cache.match(req);
  const actualizando = fetch(req)
    .then(fresca => { cache.put(req, fresca.clone()); return fresca; })
    .catch(() => null);
  // Si hay algo en caché, se responde ya mismo (rápido) -- la versión
  // fresca queda guardada para la próxima vez, en segundo plano. Sin nada
  // en caché todavía (primera visita), se espera la respuesta de red.
  return cacheada || (await actualizando) || Response.error();
}
