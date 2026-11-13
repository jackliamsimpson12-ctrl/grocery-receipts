// Grocery Receipt Tracker - service worker
// Network-first strategy for the app shell, falling back to cache when offline.

const CACHE_VERSION = 'receipt-tracker-v5';
const SHELL_FILES = [
  './',
  './index.html',
  './app.jsx',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg',
  './apple-touch-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll(SHELL_FILES).catch((err) => {
        // Don't fail install if a font or CDN resource can't be pre-cached.
        console.warn('SW install cache.addAll partial failure:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first for same-origin shell files; cache-first fallback for everything else (fonts/CDN)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSameOrigin = url.origin === self.location.origin;

  if (isSameOrigin) {
    // Network-first: try the network, cache a fresh copy, fall back to cache offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
    );
  } else {
    // Cross-origin (fonts, esm.sh, Claude API): cache-first for fonts/CDN scripts, network passthrough otherwise.
    if (url.hostname.includes('fonts.g') || url.hostname.includes('esm.sh') || url.hostname.includes('unpkg.com')) {
      event.respondWith(
        caches.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((res) => {
            const resClone = res.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, resClone));
            return res;
          }).catch(() => cached);
        })
      );
    }
    // Otherwise (e.g. Claude API calls) let the browser handle it normally - no caching.
  }
});
