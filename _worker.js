const INDEX_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const SERVICE_WORKER_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const ASSET_NO_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const NO_CACHE_ASSET_PATHS = new Set([
  "/app.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/data/starter.js",
  "/data/questions.js"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/index.html") {
      const rootUrl = new URL("/", url.origin);
      if (url.search) rootUrl.search = url.search;
      const response = await env.ASSETS.fetch(new Request(rootUrl, request));
      return withHeaders(response, {
        "Cache-Control": INDEX_CACHE_CONTROL
      }, 200);
    }

    const response = await env.ASSETS.fetch(request);
    const headers = {};

    if (request.method === "GET" && url.pathname === "/") {
      headers["Cache-Control"] = INDEX_CACHE_CONTROL;
    }

    if (request.method === "GET" && url.pathname === "/service-worker.js") {
      headers["Cache-Control"] = SERVICE_WORKER_CACHE_CONTROL;
      headers["Service-Worker-Allowed"] = "/";
    }

    if (request.method === "GET" && NO_CACHE_ASSET_PATHS.has(url.pathname)) {
      headers["Cache-Control"] = ASSET_NO_CACHE_CONTROL;
    }

    return Object.keys(headers).length ? withHeaders(response, headers) : response;
  }
};

function withHeaders(response, extraHeaders, forcedStatus) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: forcedStatus || response.status,
    statusText: response.statusText,
    headers
  });
}
