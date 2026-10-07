// Cache only the public application shell. Tokens, API data and uploads stay online-only.
const CACHE = 'pi-companion-shell-v4';
const SHELL = ['/', '/manifest.webmanifest', '/favicon.png', '/apple-touch-icon.png', '/pwa-icon.svg', '/pwa-maskable.svg', '/pwa-192.png', '/pwa-512.png', '/pwa-maskable-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key.startsWith('pi-companion-shell-') && key !== CACHE).map((key) => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        // A closed tunnel can answer with a gateway HTML page, not just a fetch rejection.
        // Keep the public app shell so it can explain the failed API connection and offer retry.
        .then(async (response) => response.status >= 500 ? (await caches.match('/')) || response : response)
        .catch(async () => (await caches.match('/')) || Response.error())
    );
    return;
  }

  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/_app/immutable/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type !== 'opaque') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
          }
          return response;
        });
      })
    );
  }
});
