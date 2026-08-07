const CACHE = 'north-south-v3';
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
  event.respondWith(
    caches.match(event.request).then(cached => {
      const network = fetch(event.request).then(response => {
        if (response.ok) caches.open(CACHE).then(cache => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => null);
      return cached || network.then(response => response || caches.match('./index.html'));
    })
  );
});
