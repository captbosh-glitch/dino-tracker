// Dino Tracker service worker: keeps the app, its reference data and the art it has shown on the device,
// so places you've already looked up still open without a connection.
const VERSION = 'dt-shell-v7';
const MEDIA = 'dt-media-v1';
const SHELL = [
  './', 'index.html', 'app.css', 'app.js', 'data.js', 'manifest.webmanifest',
  'data/genera.json', 'data/snapshot.json', 'data/hotspots.json',
  'icons/favicon.png', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'art/logo.png', 'art/wordmark.png', 'art/hero.jpg', 'art/track.jpg', 'art/birds.jpg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== MEDIA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET') return;
  // fossil records, place lookups and map tiles always come fresh; the app falls back to saved results itself
  if (/paleobiodb|zippopotam|openstreetmap/.test(url.host)) return;
  if (url.origin === location.origin && /\/art\//.test(url.pathname)) {
    e.respondWith(caches.open(MEDIA).then(async c => (await c.match(req)) || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  // app files and fonts: answer from cache at once, refresh in the background
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: req.mode === 'navigate' });
    const net = fetch(req).then(r => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
