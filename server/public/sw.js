/**
 * StreamSync - Service Worker (Phase 4 PWA)
 * Caches core UI app shell while passing streaming media, WebSocket, and dynamic API requests straight to network.
 */

const CACHE_NAME = 'streamsync-v1.2';
const STATIC_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/js/chat-rich.js',
  '/js/party-player.js',
  '/js/movie-browser.js',
  '/stickers/manifest.json',
  '/stickers/movie/0.svg',
  '/stickers/movie/1.svg',
  '/stickers/movie/2.svg',
  '/stickers/movie/3.svg',
  '/stickers/movie/4.svg',
  '/stickers/movie/5.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Bypass Service Worker entirely for WebSocket, API calls, and streaming chunks (.m3u8, .ts, .mp4)
  if (
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.endsWith('.m3u8') ||
    url.pathname.endsWith('.ts') ||
    url.pathname.endsWith('.mp4') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // 2. Cache-first strategy for static shell assets with network fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Background refresh
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});

