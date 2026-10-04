/**
 * Service worker — makes the installed app open without a connection.
 *
 * Strategy: network first, cache as the fallback. Every request that reaches
 * the network refreshes the cache, so a student online always sees the latest
 * pages and form list, and a student offline sees the last copy they loaded.
 * Nothing is ever served stale while the network answers, which is why there
 * is no versioned asset list to keep in sync with deploys.
 *
 * Only same-origin GET requests are handled. The forms themselves live on
 * Google and are never touched.
 */

const CACHE = 'difrana-v1';

const SHELL = [
  './',
  'index.html',
  'teacher.html',
  'about.html',
  'assets/css/tokens.css',
  'assets/css/base.css',
  'assets/css/components.css',
  'assets/css/brand.css',
  'assets/js/app.js',
  'assets/js/ui.js',
  'assets/js/search.js',
  'assets/js/store.js',
  'assets/data/exams.json',
  'assets/fonts/plex-ar-400.woff2',
  'assets/fonts/plex-ar-700.woff2',
  'assets/fonts/amiri-700-sub.woff2',
  'assets/fonts/lalezar-sub.woff2',
  'assets/img/mark-144.webp',
  'assets/img/mark-360.webp',
  'assets/img/mark-720.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // One missing file must not abort the whole install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        if (cached) return cached;
        if (request.mode === 'navigate') return (await caches.match('index.html')) || Response.error();
        return Response.error();
      }),
  );
});
