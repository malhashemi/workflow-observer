// Retirement endpoint for previously installed Observer workers. No caching or fetch handler.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.clients.claim();
  for (const name of await caches.keys())
    if (/^observer-v[\d.]+$/.test(name)) await caches.delete(name);
  await self.registration.unregister();
})()));
