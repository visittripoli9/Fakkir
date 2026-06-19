/* FAKKIR service worker — offline-capable app shell.
 * Strategy:
 *   - app shell (html/css/js): cache-first (fast, offline play)
 *   - data.json: stale-while-revalidate (instant load, refresh in background)
 *   - images: stale-while-revalidate (instant from cache, but refresh in the
 *     background so updated category art replaces old copies on the next view)
 */
const CACHE = 'fakkir-v32';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/styles.css?v=32',
  './assets/js/theme-init.js?v=32',
  './assets/js/config.js?v=32',
  './assets/js/fx.js?v=32',
  './assets/js/app.js?v=32',
  './assets/js/sw-register.js?v=32',
  './assets/data.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // never intercept Supabase / cross-origin API or font calls — let the network handle them
  if (url.origin !== self.location.origin) return;

  // data.json: stale-while-revalidate — serve the cached copy INSTANTLY (no
  // network wait on load) while refreshing it in the background for next time
  if (url.pathname.endsWith('/data.json')) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((cached) => {
          const network = fetch(req).then((res) => {
            if (res && res.status === 200) c.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // images: stale-while-revalidate — serve cache immediately, update it in the
  // background so refreshed artwork is picked up without a manual cache clear
  if (/\/assets\/img\//.test(url.pathname)) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then((cached) => {
          const network = fetch(req).then((res) => {
            if (res && res.status === 200 && res.type === 'basic') c.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // app shell + other assets: cache-first, then network (and cache the result)
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached)
    )
  );
});
