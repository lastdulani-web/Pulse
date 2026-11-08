// Pulse service worker: cache the app shell so the app opens fully offline.
// Bump VERSION whenever you change any file, so phones pick up the update.
const VERSION = 'pulse-v10';
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'css/styles.css',
  'fonts/Outfit-Light.ttf', 'fonts/Outfit-Regular.ttf', 'fonts/Outfit-Medium.ttf', 'fonts/Outfit-SemiBold.ttf', 'fonts/Outfit-Bold.ttf', 'fonts/Outfit-ExtraBold.ttf',
  'js/app.js', 'js/db.js', 'js/meta.js', 'js/player.js',
  'assets/pulse-splash-v5.png', 'assets/pulse-logo-v5.png', 'assets/art-tile-v5.png',
  'icons/icon-192-v5.png', 'icons/icon-512-v5.png', 'icons/icon-maskable-512-v5.png', 'icons/apple-touch-icon-v5.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))
    )
  );
});
