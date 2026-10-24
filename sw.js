// 앱 껍데기만 캐시 (네트워크 우선, 실패하면 캐시) — 오프라인에서도 열리게
const CACHE = 'todotab-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './core.js', './sync.js', './config.js', './vendor/supabase.js', './manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request).then((r) => r || caches.match('./index.html'))));
});
