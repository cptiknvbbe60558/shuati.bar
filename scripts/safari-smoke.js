#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const STORAGE_KEY = "customer-manager-quiz-state-v1";

function requirePlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    console.error("Playwright is required. Run with NODE_PATH pointing to the Codex runtime node_modules.");
    console.error(error.message);
    process.exit(2);
  }
}

function getConfig() {
  return {
    targetUrl: process.env.TARGET_URL || DEFAULT_URL,
    staffId: process.env.STAFF_ID || DEFAULT_STAFF_ID,
    headed: process.env.HEADED === "1"
  };
}

async function installStateApiMock(context, staffId) {
  const remoteValue = {
    staffId,
    wrong: {},
    favorites: {},
    favoriteSync: {},
    notes: {},
    mastery: {},
    suiteExposure: {},
    suitePapers: []
  };
  const writes = [];
  await context.route("**/api/state/**", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, value: remoteValue })
      });
      return;
    }
    if (["POST", "PUT", "PATCH"].includes(request.method())) {
      writes.push({ method: request.method(), postData: request.postData() || "" });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true })
      });
      return;
    }
    await route.continue();
  });
  return writes;
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/reset?safariSmoke=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForURL(/(\?|&)clean=/, { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);

  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    await page.waitForTimeout(1800);
  }

  await page.waitForFunction(
    () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 20000 }
  );
}

async function serviceWorkerState(page) {
  return page.evaluate(async () => {
    const hasServiceWorker = "serviceWorker" in navigator;
    const registrations = hasServiceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    const cacheKeys = "caches" in window ? await caches.keys() : [];
    return {
      hasServiceWorker,
      controlled: Boolean(navigator.serviceWorker?.controller),
      registrations: registrations.length,
      cacheKeys: cacheKeys.filter((key) => key.startsWith("quiz-pwa-") || key.startsWith("shuati-bar-"))
    };
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const { webkit, devices } = requirePlaywright();
  const config = getConfig();
  const browser = await webkit.launch({ headless: !config.headed });
  const context = await browser.newContext({ ...devices["iPhone 14"], locale: "zh-CN" });
  const writes = await installStateApiMock(context, config.staffId);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });

  try {
    await login(page, config.targetUrl, config.staffId);
    const title = await page.title();
    const count = await page.evaluate(() => window.QUIZ_BANK?.questions?.length || 0);
    const dockLabels = await page.evaluate(() => (
      [...document.querySelectorAll(".practice-dock button")].map((button) => button.innerText.trim() || button.getAttribute("aria-label") || "")
    ));
    const sw = await serviceWorkerState(page);
    const storedStaffId = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").staffId || "", STORAGE_KEY);

    assert(title === "客户经理刷题", `unexpected title: ${title}`);
    assert(count > 3000, `full bank did not load in WebKit: ${count}`);
    assert(storedStaffId === config.staffId, `staff id was not stored locally: ${storedStaffId}`);
    assert(dockLabels.includes("强化练习"), `suite nav missing in WebKit dock: ${JSON.stringify(dockLabels)}`);
    assert(!dockLabels.includes("随机"), `removed random button visible in WebKit dock: ${JSON.stringify(dockLabels)}`);
    assert(sw.registrations === 0, `service worker registration remains in WebKit: ${JSON.stringify(sw)}`);
    assert(!sw.controlled, `page is controlled by service worker in WebKit: ${JSON.stringify(sw)}`);
    assert(sw.cacheKeys.length === 0, `old quiz caches remain in WebKit: ${JSON.stringify(sw)}`);
    if (browserErrors.length) throw new Error(`WebKit browser errors: ${browserErrors.join("; ")}`);

    console.log(JSON.stringify({
      ok: true,
      targetUrl: config.targetUrl,
      staffId: config.staffId,
      title,
      questionCount: count,
      serviceWorker: sw,
      interceptedWrites: writes.length,
      dockLabels
    }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
