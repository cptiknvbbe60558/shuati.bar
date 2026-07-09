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

    if (request.method === "GET" && (url.pathname === "/reset" || url.pathname === "/reset/")) {
      return serviceWorkerResetPage();
    }

    if (url.pathname.startsWith("/api/state/")) {
      return handleStateApi(request, env, url);
    }

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

async function handleStateApi(request, env, url) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (!env.SHUATI_STATE) {
    return json({ success: false, error: "state_storage_not_configured" }, 503, headers);
  }

  const staffId = decodeURIComponent(url.pathname.slice("/api/state/".length)).trim();
  if (!isVerifiedStaffId(staffId)) {
    return json({ success: false, error: "invalid_staff_id" }, 400, headers);
  }

  const key = `staff:${staffId}:protected`;

  if (request.method === "GET") {
    const value = await env.SHUATI_STATE.get(key, { type: "json" });
    return json({ success: true, value: value || {} }, 200, headers);
  }

  if (request.method === "POST") {
    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ success: false, error: "invalid_json" }, 400, headers);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return json({ success: false, error: "invalid_payload" }, 400, headers);
    }
    await env.SHUATI_STATE.put(key, JSON.stringify(payload), {
      metadata: {
        staffId,
        updatedAt: new Date().toISOString()
      }
    });
    return json({ success: true }, 200, headers);
  }

  return json({ success: false, error: "method_not_allowed" }, 405, headers);
}

function isVerifiedStaffId(value) {
  if (!/^\d{6}$/.test(String(value || ""))) return false;
  const number = Number(value);
  return number >= 704001 && number <= 704099;
}

function json(payload, status, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers
  });
}

function serviceWorkerResetPage() {
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>正在清理刷题缓存</title>
  <style>
    body {
      margin: 0;
      min-height: 100svh;
      display: grid;
      place-items: center;
      background: #f7f8fb;
      color: #1d1d1f;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
    }
    main {
      width: min(86vw, 420px);
      padding: 28px;
      border: 1px solid rgba(60, 60, 67, 0.12);
      border-radius: 28px;
      background: rgba(255, 255, 255, 0.84);
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.12);
      text-align: center;
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      backdrop-filter: blur(24px) saturate(1.4);
    }
    h1 { margin: 0 0 10px; font-size: 22px; line-height: 1.2; }
    p { margin: 0; color: rgba(60, 60, 67, 0.68); font-size: 14px; line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <h1>正在清理旧缓存</h1>
    <p>完成后会自动进入刷题页面。</p>
  </main>
  <script>
    (async () => {
      try {
        if ("serviceWorker" in navigator) {
          const registrations = await navigator.serviceWorker.getRegistrations();
          await Promise.all(registrations.map((registration) => registration.unregister()));
        }
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((key) => caches.delete(key)));
        }
      } catch (error) {
        console.warn(error);
      }
      location.replace("/?clean=" + Date.now());
    })();
  </script>
</body>
</html>`, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Clear-Site-Data": "\"cache\""
    }
  });
}

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
