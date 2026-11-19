const PREFIX = 'voice-rec:' + self.registration.scope + ':';
const CACHE = PREFIX + '1.4.3';
const assets = ['index.html', 'manifest.json', 'icon-192.png', 'icon-512.png']
    .map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(assets.map(url => new Request(url, { cache: 'reload' })));
        await self.skipWaiting();
    })());
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith(PREFIX) && name !== CACHE)
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});
self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const page = url.origin + url.pathname;
    if (request.mode === 'navigate' && (page === self.registration.scope || page === assets[0])) {
        event.respondWith(fetch(request, { cache: 'no-cache' }).catch(async () =>
            (await caches.open(CACHE)).match(assets[0])));
    } else if (assets.includes(request.url)) {
        event.respondWith((async () => (await (await caches.open(CACHE)).match(request)) || fetch(request))());
    }
});
