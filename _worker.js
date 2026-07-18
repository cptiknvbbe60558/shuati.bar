const INDEX_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const SERVICE_WORKER_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const ASSET_NO_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const NO_CACHE_ASSET_PATHS = new Set([
  "/app.js",
  "/styles.css",
  "/theme.css",
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

    if (url.pathname.startsWith("/api/session/")) {
      return handleSessionApi(request, env, url);
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

  if (!env.SHUATI_DB && !env.SHUATI_STATE) {
    return json({ success: false, error: "state_storage_not_configured" }, 503, headers);
  }

  const staffId = decodeURIComponent(url.pathname.slice("/api/state/".length)).trim();
  if (!isVerifiedStaffId(staffId)) {
    return json({ success: false, error: "invalid_staff_id" }, 400, headers);
  }

  const key = `staff:${staffId}:protected`;

  if (request.method === "GET") {
    const d1Value = await readD1State(env, staffId);
    if (d1Value) return json({ success: true, value: d1Value }, 200, headers);
    const kvValue = env.SHUATI_STATE
      ? await env.SHUATI_STATE.get(key, { type: "json" })
      : null;
    return json({ success: true, value: kvValue || {} }, 200, headers);
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
    const wroteD1 = await writeD1State(env, staffId, payload);
    if (!wroteD1) {
      if (!env.SHUATI_STATE) {
        return json({
          success: false,
          error: "state_write_failed",
          retryAfterMs: 30 * 60 * 1000
        }, 200, headers);
      }
      try {
        await env.SHUATI_STATE.put(key, JSON.stringify(payload));
      } catch (error) {
        console.error("state_write_failed", {
          staffId,
          message: error?.message || String(error)
        });
        return json({
          success: false,
          error: "state_write_failed",
          retryAfterMs: 30 * 60 * 1000
        }, 200, headers);
      }
    }
    return json({ success: true }, 200, headers);
  }

  return json({ success: false, error: "method_not_allowed" }, 405, headers);
}

async function handleSessionApi(request, env, url) {
  const headers = {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  };
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }
  if (!env.SHUATI_DB && !env.SHUATI_STATE) {
    return json({ success: false, error: "state_storage_not_configured" }, 503, headers);
  }

  const staffId = decodeURIComponent(url.pathname.slice("/api/session/".length)).trim();
  if (!isVerifiedStaffId(staffId)) {
    return json({ success: false, error: "invalid_staff_id" }, 400, headers);
  }

  const storageId = `session:${staffId}`;
  const key = `staff:${staffId}:session`;
  const readCurrent = async () => {
    const d1Value = await readD1State(env, storageId);
    if (d1Value) return d1Value;
    return env.SHUATI_STATE
      ? (await env.SHUATI_STATE.get(key, { type: "json" })) || {}
      : {};
  };

  if (request.method === "GET") {
    return json({ success: true, value: await readCurrent() }, 200, headers);
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

    const merged = mergeSessionPayload(await readCurrent(), payload);
    const wroteD1 = await writeD1State(env, storageId, merged);
    if (!wroteD1) {
      if (!env.SHUATI_STATE) {
        return json({ success: false, error: "state_write_failed" }, 503, headers);
      }
      try {
        await env.SHUATI_STATE.put(key, JSON.stringify(merged));
      } catch (error) {
        console.error("session_write_failed", {
          staffId,
          message: error?.message || String(error)
        });
        return json({ success: false, error: "state_write_failed" }, 503, headers);
      }
    }
    return json({ success: true, value: merged }, 200, headers);
  }

  return json({ success: false, error: "method_not_allowed" }, 405, headers);
}

function mergeSessionPayload(current = {}, incoming = {}) {
  const chooseNewer = (left, right, stamp) => {
    const leftAt = Date.parse(stamp(left) || "") || 0;
    const rightAt = Date.parse(stamp(right) || "") || 0;
    return rightAt >= leftAt ? right : left;
  };
  return {
    version: Math.max(Number(current.version) || 0, Number(incoming.version) || 0, 1),
    updatedAt: new Date().toISOString(),
    wrongPracticeSession: chooseNewer(
      current.wrongPracticeSession || {},
      incoming.wrongPracticeSession || {},
      (value) => value?.updatedAt
    ),
    suiteSession: chooseNewer(
      current.suiteSession || {},
      incoming.suiteSession || {},
      (value) => value?.updatedAt
    ),
    wrongEliminationSession: chooseNewer(
      current.wrongEliminationSession || {},
      incoming.wrongEliminationSession || {},
      (value) => value?.updatedAt
    )
  };
}

function isVerifiedStaffId(value) {
  if (!/^\d{6}$/.test(String(value || ""))) return false;
  const number = Number(value);
  return number >= 704001 && number <= 704099;
}

async function readD1State(env, staffId) {
  if (!env.SHUATI_DB) return null;
  try {
    const row = await env.SHUATI_DB
      .prepare("SELECT data FROM staff_state WHERE staff_id = ?")
      .bind(staffId)
      .first();
    if (!row?.data) return null;
    return JSON.parse(row.data);
  } catch (error) {
    console.error("state_d1_read_failed", {
      staffId,
      message: error?.message || String(error)
    });
    return null;
  }
}

async function writeD1State(env, staffId, payload) {
  if (!env.SHUATI_DB) return false;
  try {
    const updatedAt = new Date().toISOString();
    await env.SHUATI_DB
      .prepare(`
        INSERT INTO staff_state (staff_id, data, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(staff_id) DO UPDATE SET
          data = excluded.data,
          updated_at = excluded.updated_at
      `)
      .bind(staffId, JSON.stringify(payload), updatedAt)
      .run();
    return true;
  } catch (error) {
    console.error("state_d1_write_failed", {
      staffId,
      message: error?.message || String(error)
    });
    return false;
  }
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
