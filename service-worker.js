const CACHE_NAME = "quiz-pwa-v80-suite-polish";
const ASSET_VERSION = "20260708_2120_suite_polish";
const FULL_BANK_URL = `./data/questions.js?v=${ASSET_VERSION}`;
const ASSETS = [
  `./styles.css?v=${ASSET_VERSION}`,
  `./app.js?v=${ASSET_VERSION}`,
  `./data/starter.js?v=${ASSET_VERSION}`,
  `./manifest.webmanifest?v=${ASSET_VERSION}`,
  "./assets/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(ASSETS.map(async (asset) => {
        const response = await fetch(asset, { cache: "reload", redirect: "follow" });
        if (isCacheableResponse(response)) await cache.put(asset, response);
      }))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (event.request.mode === "navigate") {
    // Let Safari handle document navigation itself. Cloudflare Pages redirects
    // /index.html to /, and WebKit treats a rejected redirected SW response as
    // a hard page failure.
    return;
  }

  if (url.pathname.endsWith("/data/questions.js")) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(FULL_BANK_URL);
        if (cached) return cached;

        const response = await fetch(FULL_BANK_URL);
        if (isCacheableResponse(response)) await cache.put(FULL_BANK_URL, response.clone());
        return response;
      })
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (isCacheableResponse(response)) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, response.clone());
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        return Response.error();
      })
  );
});

function isCacheableResponse(response) {
  return Boolean(
    response
    && response.ok
    && !response.redirected
    && response.type !== "opaqueredirect"
  );
}
