/**
 * Service Worker：应用外壳预缓存，支持完整离线使用。
 * 导航请求 network-first（保证能拿到新版本），静态资源 stale-while-revalidate（离线秒开）。
 * 版本号变化时自动清理旧缓存；前端发现新版本后提示用户刷新。
 */

const VERSION = 'v1.1.0';
const CACHE_PREFIX = 'dagongren-cashflow-';
const CACHE_NAME = CACHE_PREFIX + VERSION;

const SHELL = [
  './',
  './index.html',
  './widget.html',
  './widget/CashflowWidget.js',
  './manifest.webmanifest',
  './css/theme.css',
  './css/base.css',
  './css/components.css',
  './js/app.js',
  './js/widget-page.js',
  './js/engine.js',
  './js/time.js',
  './js/store.js',
  './js/ui.js',
  './js/number.js',
  './js/quotes.js',
  './js/effects.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
  } else {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (
      (await cache.match(request)) ||
      (await cache.match('./index.html')) ||
      new Response('离线且尚未缓存应用外壳，请联网后重试。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      })
    );
  }
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  event.waitUntil(network);
  return cached || (await network) || new Response('', { status: 504 });
}
