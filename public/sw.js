const CACHE = 'north-south-v6-2';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './assets/north-south-logo.jpg', './assets/icon-192.png', './assets/icon-512.png',
  './assets/favicon.ico', './assets/app.js', './assets/app.css'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  // Cuando hay conexión se usa siempre el deploy más nuevo. La caché queda
  // únicamente como respaldo para poder abrir la PWA sin internet.
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone());
      }
      return response;
    } catch {
      return (await caches.match(event.request)) || (await caches.match('./index.html'));
    }
  })());
});
