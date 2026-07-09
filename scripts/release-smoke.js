#!/usr/bin/env node

const { spawn } = require("node:child_process");

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const NODE_PATH = "/Users/daasipilin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";

const targetUrl = process.env.TARGET_URL || DEFAULT_URL;
const staffId = process.env.STAFF_ID || DEFAULT_STAFF_ID;
const nodePath = process.env.NODE_PATH || NODE_PATH;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestHead(url, options = {}) {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: options.redirect || "follow"
  });
  return {
    url,
    status: response.status,
    cacheControl: response.headers.get("cache-control") || "",
    contentType: response.headers.get("content-type") || "",
    serviceWorkerAllowed: response.headers.get("service-worker-allowed") || ""
  };
}

async function requestJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const payload = await response.json();
  return { status: response.status, payload };
}

function summarizeProtectedState(payload) {
  const value = payload?.value || {};
  return {
    success: Boolean(payload?.success),
    wrong: Object.keys(value.wrong || {}).length,
    favorites: Object.keys(value.favorites || {}).length,
    suitePapers: Array.isArray(value.suitePapers) ? value.suitePapers.length : 0,
    updatedAt: value.updatedAt || value._protectedUpdatedAt || null
  };
}

function assertProtectedNotDecreased(before, after) {
  for (const key of ["wrong", "favorites", "suitePapers"]) {
    assert(
      after[key] >= before[key],
      `protected ${key} decreased from ${before[key]} to ${after[key]}`
    );
  }
}

async function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}`], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_PATH: nodePath,
        TARGET_URL: targetUrl,
        STAFF_ID: staffId
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${script} failed with code ${code}\n${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${script} did not emit JSON: ${error.message}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function run() {
  const url = new URL(targetUrl);
  const wwwHost = url.hostname.startsWith("www.") ? url.hostname : `www.${url.hostname}`;
  const wwwUrl = `${url.protocol}//${wwwHost}`;
  const protectedStateBefore = summarizeProtectedState((await requestJson(`${targetUrl}/api/state/${staffId}`)).payload);
  const checks = {
    root: await requestHead(targetUrl),
    www: await requestHead(wwwUrl),
    reset: await requestHead(`${targetUrl}/reset`),
    serviceWorker: await requestHead(`${targetUrl}/service-worker.js`),
    app: await requestHead(`${targetUrl}/app.js`),
    questions: await requestHead(`${targetUrl}/data/questions.js`),
    protectedStateBefore
  };

  assert(checks.root.status === 200, `root is not 200: ${JSON.stringify(checks.root)}`);
  assert(checks.www.status === 200, `www is not 200: ${JSON.stringify(checks.www)}`);
  assert(checks.reset.status === 200, `reset is not 200: ${JSON.stringify(checks.reset)}`);
  assert(checks.serviceWorker.status === 200, `service worker is not 200: ${JSON.stringify(checks.serviceWorker)}`);
  assert(checks.serviceWorker.cacheControl.includes("no-store"), `service worker can be cached: ${checks.serviceWorker.cacheControl}`);
  assert(checks.serviceWorker.serviceWorkerAllowed === "/", `service worker allowed header missing: ${checks.serviceWorker.serviceWorkerAllowed}`);
  assert(checks.app.cacheControl.includes("no-store"), `app.js can be cached stale: ${checks.app.cacheControl}`);
  assert(checks.questions.cacheControl.includes("no-store"), `questions.js can be cached stale: ${checks.questions.cacheControl}`);
  assert(checks.protectedStateBefore.success, `protected state read failed: ${JSON.stringify(checks.protectedStateBefore)}`);

  const backup = await runScript("backup-state.js");
  assert(backup.ok, `state backup failed: ${JSON.stringify(backup)}`);

  const browser = {
    safari: await runScript("safari-smoke.js"),
    protection: await runScript("protection-smoke.js"),
    mobile: await runScript("mobile-regression-smoke.js"),
    suiteReport: await runScript("suite-report-smoke.js")
  };
  const protectedStateAfter = summarizeProtectedState((await requestJson(`${targetUrl}/api/state/${staffId}`)).payload);
  assert(protectedStateAfter.success, `protected state reread failed: ${JSON.stringify(protectedStateAfter)}`);
  assertProtectedNotDecreased(protectedStateBefore, protectedStateAfter);
  checks.protectedStateAfter = protectedStateAfter;

  console.log(JSON.stringify({
    ok: true,
    targetUrl,
    staffId,
    checks,
    backup: {
      ok: backup.ok,
      outputPath: backup.outputPath,
      staffCount: backup.staffCount,
      totals: backup.totals
    },
    browser: {
      safari: {
        ok: browser.safari.ok,
        title: browser.safari.title,
        questionCount: browser.safari.questionCount,
        serviceWorker: browser.safari.serviceWorker,
        interceptedWrites: browser.safari.interceptedWrites
      },
      protection: {
        ok: browser.protection.ok,
        preserved: browser.protection.preserved,
        serviceWorker: browser.protection.serviceWorker,
        dockNav: browser.protection.dock.nav
      },
      mobile: {
        ok: browser.mobile.ok,
        steps: browser.mobile.results.map((result) => result.step)
      },
      suiteReport: {
        ok: browser.suiteReport.ok,
        steps: browser.suiteReport.results.map((result) => result.step)
      }
    }
  }, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
