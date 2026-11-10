/* OVA ATLAS app shell v8.8. Only static same-origin app files are cached. */
'use strict';
const CACHE_NAME = 'ova-atlas-shell-v8.8';
const SHELL_ASSETS = [
  './index.html', './manifest.webmanifest',
  './icons/atlas-180.png', './icons/atlas-192.png', './icons/atlas-512.png'
];
const assetURLs = new Set(SHELL_ASSETS.map(p => new URL(p,self.registration.scope).href));
const indexURL = new URL('./index.html', self.registration.scope).href;
const rootURL = new URL('./',self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('ova-atlas-shell-') && key !== CACHE_NAME) {
        await caches.delete(key);
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  // Excludes POSTs, cross-origin traffic, blob/data images, project files,
  // edit APIs, arbitrary query URLs, and personal browser assets.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search || url.hash) return;
  const navigation = request.mode === 'navigate' && (url.href === rootURL || url.href === indexURL);
  if (!navigation && !assetURLs.has(url.href)) return;

  if (navigation) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(indexURL, response.clone());
        }
        return response;
      } catch (error) {
        const cached = await caches.match(indexURL);
        if (cached) return cached;
        throw error;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    return fetch(request);  // No arbitrary URLs are stored.
  })());
});
