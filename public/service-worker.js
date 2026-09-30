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

self.addEventListener('fetch', (evento) => {
  // Solo nos interesa cachear peticiones GET normales (no APIs, no POST)
  if (evento.request.method !== 'GET') return;

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
