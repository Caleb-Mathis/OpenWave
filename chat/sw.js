const CACHE = 'wavest-offline-v3';

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    event.respondWith((async () => {
        try {
            const fresh = await fetch(request);
            const cache = await caches.open(CACHE);
            cache.put(request, fresh.clone());
            return fresh;
        } catch (err) {
            const cached = await caches.match(request);
            if (cached) return cached;
            if (request.mode === 'navigate') {
                const shell = await caches.match('./index.html');
                if (shell) return shell;
            }
            throw err;
        }
    })());
});
