const CACHE_PREFIXES = ["quiz-pwa-", "shuati-bar-"];

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (self.caches) {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((key) => CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
            .map((key) => caches.delete(key))
        );
      }
      await self.registration.unregister();
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", () => {
  // Intentionally do not intercept. The app is online-first now; user data is
  // protected by local backups and cloud sync instead of service-worker cache.
});
