// Service Worker — estrategia "red primero" (network-first).
// Nunca sirve una copia vieja atascada: siempre intenta traer la versión más reciente
// del servidor primero, y solo usa la copia guardada si no hay conexión a internet.

const CACHE_NAME = 'saa-cache-v185';

self.addEventListener('install', (evento) => {
  self.skipWaiting(); // Activa esta versión nueva de inmediato, sin esperar a que se cierren pestañas viejas
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    (async () => {
      // Borra cualquier caché de una versión anterior a esta
      const nombres = await caches.keys();
      await Promise.all(nombres.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)));
      await self.clients.claim(); // Toma control de las pestañas abiertas de inmediato
    })()
  );
});

// Solo cacheamos archivos ESTÁTICOS de la app (HTML, JS, CSS, imágenes, fuentes).
// NUNCA rutas de la API (/perfil, /mis-datos, /diario, etc.) — esas siempre son datos
// personales y en vivo, y cachearlas podría mostrar datos viejos o, en un dispositivo
// compartido, datos de otra persona si no hay internet. Esas rutas van siempre directo
// a la red, sin pasar por este Service Worker.
const DESTINOS_CACHEABLES = ['document', 'script', 'style', 'image', 'manifest', 'font', ''];
function esArchivoEstatico(request) {
  if (request.destination === 'document' || request.destination === 'script' ||
      request.destination === 'style' || request.destination === 'image' ||
      request.destination === 'manifest' || request.destination === 'font') return true;
  // Algunos navegadores no reportan "destination" para ciertos <script>/<link> — revisamos
  // por extensión como respaldo, y por si es la página principal (index.html o "/").
  const ruta = new URL(request.url).pathname;
  return ruta === '/' || /\.(html|js|css|png|jpg|jpeg|svg|webp|woff2?|ico|json)$/i.test(ruta);
}

self.addEventListener('fetch', (evento) => {
  if (evento.request.method !== 'GET') return;
  if (!esArchivoEstatico(evento.request)) return; // deja pasar las rutas de la API tal cual, sin cachear

  evento.respondWith(
    (async () => {
      try {
        // 1) Siempre intenta la red primero (la versión más nueva)
        const respuestaRed = await fetch(evento.request);
        // Si funcionó, guarda una copia por si se pierde la conexión después
        const cache = await caches.open(CACHE_NAME);
        cache.put(evento.request, respuestaRed.clone());
        return respuestaRed;
      } catch (e) {
        // 2) Si no hay internet, usa la copia guardada (mejor que nada)
        const copiaGuardada = await caches.match(evento.request);
        if (copiaGuardada) return copiaGuardada;
        throw e;
      }
    })()
  );
});
