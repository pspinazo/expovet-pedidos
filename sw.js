/**
 * Service worker: cache-first para el "app shell".
 * - Las llamadas a la API (POST / script.google.com / /api) NUNCA se cachean.
 * - Al cambiar SHELL_VERSION se descarga el shell nuevo y se borran cachés viejas.
 * Rutas relativas para funcionar bajo un subpath de GitHub Pages (ej. /expovet-pedidos/).
 */
const SHELL_VERSION = 'v1.2.1';
const CACHE_NAME = `expovet-shell-${SHELL_VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/config.js',
  './js/utils.js',
  './js/db.js',
  './js/api.js',
  './js/sync.js',
  './js/dashboard.js',
  './js/app.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // cache:'reload' evita guardar copias viejas del caché HTTP del navegador
      .then((cache) => cache.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('expovet-shell-') && k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/** true si la petición es a la API o no es cacheable. */
function isBypass(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true; // script.google.com, googleusercontent, etc.
  if (/\/api(\/|$)/.test(url.pathname)) return true;     // mock server local
  return false;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (isBypass(request, url)) return; // deja pasar a la red sin tocar

  // Navegaciones (incluye ?api=...): siempre devolver el index.html del shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true })
        .then((cached) => cached || fetch(request))
        .catch(() => caches.match('./', { ignoreSearch: true }))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, copy));
        }
        return res;
      });
    })
  );
});

// Permite que la página pida activar una versión nueva inmediatamente.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
