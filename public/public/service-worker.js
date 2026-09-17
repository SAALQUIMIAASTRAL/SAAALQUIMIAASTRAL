const CACHE = 'saa-v1';
const ASSETS = ['/', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Solo cachear GET de assets estáticos, no las llamadas a la API
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/auth') || url.pathname.startsWith('/carta') ||
      url.pathname.startsWith('/luna') || url.pathname.startsWith('/api') ||
      url.pathname.startsWith('/transitos') || url.pathname.startsWith('/horoscopo') ||
      url.pathname.startsWith('/eclipses') || url.pathname.startsWith('/sinastria') ||
      url.pathname.startsWith('/numerologia') || url.pathname.startsWith('/energia') ||
      url.pathname.startsWith('/home-summary') || url.pathname.startsWith('/diario') ||
      url.pathname.startsWith('/biblioteca') || url.pathname.startsWith('/asistente')) {
    return; // No cachear llamadas a la API
  }
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        if (response.ok && e.request.url.includes(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return response;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
