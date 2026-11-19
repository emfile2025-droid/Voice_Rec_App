const CACHE_PREFIX = 'voice-rec:' + self.registration.scope + ':';
const CACHE_NAME = CACHE_PREFIX + '2.1.0';
const APP_FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];
const appUrls = new Set(APP_FILES.map(path => new URL(path, self.registration.scope).href));

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(APP_FILES.map(path => new Request(path, { cache: 'reload' })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    const url = new URL(request.url);
    url.search = '';
    if (request.method !== 'GET' || !appUrls.has(url.href)) return;

    event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        try {
            const response = await fetch(request, { cache: 'no-cache' });
            if (response.ok) {
                try {
                    await cache.put(url.href, response.clone());
                } catch (error) {
                    console.warn('VoiceREC cache update failed', error);
                }
            }
            return response;
        } catch (error) {
            const cached = await cache.match(url.href);
            if (cached) return cached;
            throw error;
        }
    })());
});
