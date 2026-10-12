// RDS PWA service worker — app shell cache + safe network strategy.
// Bump CACHE when you change the launcher/icons to push an update.
const CACHE = 'rds-shell-v1';
const SHELL = ['/app', '/launcher.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                                   // never touch POST/PUT (OTP, orders, payments)
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                         // leave cross-origin (maps, CDNs) alone
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) return;  // live data: always network
  // navigations & static: network first, fall back to cache when offline
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/app')))
  );
});