#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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
    chromePath: process.env.CHROME_PATH || DEFAULT_CHROME_PATH,
    headed: process.env.HEADED === "1"
  };
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/?protectionSmoke=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(1000);
  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    await page.waitForTimeout(1500);
  }
  await page.waitForFunction(
    () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 20000 }
  );
}

async function clickRequired(page, selector, label) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) throw new Error(`${label} missing: ${selector}`);
  if (!(await locator.isVisible().catch(() => false))) throw new Error(`${label} hidden: ${selector}`);
  if (await locator.isDisabled().catch(() => false)) throw new Error(`${label} disabled: ${selector}`);
  await locator.click({ timeout: 7000 });
  await page.waitForTimeout(500);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readStoredState(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), STORAGE_KEY);
}

async function seedProtectedState(page, staffId) {
  const marker = "__protection_smoke_seed__";
  await page.addInitScript(({ key, markerKey }) => {
    const raw = sessionStorage.getItem(markerKey);
    if (!raw) return;
    localStorage.setItem(key, raw);
    localStorage.setItem(`${key}-backup`, raw);
    sessionStorage.removeItem(markerKey);
  }, { key: STORAGE_KEY, markerKey: marker });
  const seed = await page.evaluate(({ key, id }) => {
    const questions = window.QUIZ_BANK.questions;
    const findByType = (type) => questions.find((question) => question.type === type);
    const single = findByType("单选");
    const multiple = findByType("多选");
    const judge = findByType("判断");
    if (!single || !multiple || !judge) throw new Error("missing source questions for seed state");
    const now = new Date().toISOString();
    const state = {
      staffId: id,
      mode: "single",
      selectedCategories: window.QUIZ_BANK.categories.map((category) => category.id),
      selectedTypes: ["单选", "多选", "判断"],
      query: "",
      currentId: single.id,
      drafts: { [single.id]: ["A"] },
      revealed: { [single.id]: true },
      progress: {
        [single.id]: { attempts: 3, correct: 1, wrong: 2, lastCorrect: false, lastAt: now }
      },
      wrong: {
        [single.id]: {
          active: true,
          wrongCount: 2,
          correctStreak: 1,
          reviewCount: 2,
          lastAt: now
        }
      },
      favorites: { [multiple.id]: true },
      favoriteSync: { [multiple.id]: { active: true, updatedAt: now } },
      mastery: {
        [judge.id]: { correctStreak: 5, updatedAt: now }
      },
      notes: { [judge.id]: "reset should keep this note" },
      examExposure: { [multiple.id]: 4 },
      suiteExposure: { [single.id]: 7 },
      optionOrders: { [single.id]: ["D", "C", "B", "A"] },
      utilityPanel: "",
      categoryMenuOpen: false,
      examStartMenuOpen: false,
      studyMode: false,
      specialIndexes: { single: 2 },
      examSize: 50,
      lastPracticeMode: "single",
      lastPracticeId: single.id,
      exam: { active: true, ids: [single.id], answers: {}, submitted: false },
      suitePapers: [
        {
          id: "suite-protection-smoke",
          number: 999,
          title: "强化练习（保护测试）",
          createdAt: now,
          ids: [single.id, multiple.id, judge.id],
          priorityIds: [single.id, multiple.id],
          typeCounts: { "单选": 1, "多选": 1, "判断": 1 },
          optionOrders: {},
          attempts: [
            {
              runId: "run-protection-smoke",
              kind: "full",
              ids: [single.id, multiple.id, judge.id],
              answers: {},
              revealedIds: [],
              wrongIds: [single.id],
              score: {
                points: 0,
                rate: 0,
                correct: 0,
                total: 3,
                byType: {
                  "单选": { correct: 0, total: 1 },
                  "多选": { correct: 0, total: 1 },
                  "判断": { correct: 0, total: 1 }
                }
              },
              startedAt: Date.now(),
              finishedAt: Date.now()
            }
          ]
        }
      ],
      suite: null,
      _schemaVersion: 4,
      _savedAt: now,
      _assetVersion: "protection-smoke"
    };
    sessionStorage.setItem("__protection_smoke_seed__", JSON.stringify(state));
    return {
      singleId: single.id,
      multipleId: multiple.id,
      judgeId: judge.id
    };
  }, { key: STORAGE_KEY, id: staffId });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  return seed;
}

async function assertDockShape(page) {
  const dock = await page.evaluate(() => {
    const primary = [...document.querySelectorAll(".dock-primary-row button")].map((button) => ({
      text: button.innerText.trim() || button.getAttribute("aria-label") || "",
      action: button.dataset.action || ""
    }));
    const nav = [...document.querySelectorAll(".dock-nav-row button")].map((button) => button.innerText.trim());
    const all = [...document.querySelectorAll(".practice-dock button")].map((button) => button.innerText.trim());
    return { primary, nav, all };
  });
  const primaryActions = dock.primary.map((button) => button.action);
  assert(
    JSON.stringify(primaryActions) === JSON.stringify([
      "previous-question",
      "next-question",
      "submit-practice",
      "reveal-answer",
      "toggle-study-mode",
      "submit-practice",
      "previous-question",
      "next-question"
    ]),
    `primary dock actions changed: ${JSON.stringify(dock.primary)}`
  );
  assert(
    JSON.stringify(dock.nav) === JSON.stringify(["错题", "收藏", "强化练习", "模拟考试", "练习", "其他"]),
    `dock nav labels changed: ${JSON.stringify(dock.nav)}`
  );
  for (const removed of ["随机", "判断正确", "全选", "套题练习"]) {
    assert(!dock.all.includes(removed), `removed dock label is visible: ${removed}`);
  }
  return dock;
}

async function resetProgressThroughUi(page) {
  page.once("dialog", async (dialog) => {
    if (!dialog.message().includes("收藏、错题、笔记和工号会永久保留")) {
      throw new Error(`unexpected reset confirmation: ${dialog.message()}`);
    }
    await dialog.accept();
  });
  await clickRequired(page, 'button[data-action="toggle-utility-panel"]', "open utility panel");
  await clickRequired(page, 'button[data-action="set-utility-panel"][data-panel="bank"]', "open bank panel");
  await clickRequired(page, 'button[data-action="reset-progress"]', "reset progress");
}

async function assertResetPreservedProtected(page, seed) {
  const stored = await readStoredState(page);
  assert(stored.staffId === "704001", `staff id was not preserved: ${stored.staffId}`);
  assert(stored.wrong?.[seed.singleId]?.active !== false, "wrong record was removed by reset");
  assert(stored.favorites?.[seed.multipleId] === true, "favorite was removed by reset");
  assert(stored.favoriteSync?.[seed.multipleId]?.active === true, "favorite sync was removed by reset");
  assert(stored.notes?.[seed.judgeId] === "reset should keep this note", "note was removed by reset");
  assert(Array.isArray(stored.suitePapers) && stored.suitePapers.some((paper) => paper.id === "suite-protection-smoke"), "suite papers were removed by reset");
  assert(stored.suiteExposure?.[seed.singleId] === 7, "suite exposure was removed by reset");
  assert(stored.mastery?.[seed.judgeId]?.correctStreak === 5, "mastery record was removed by reset");
  assert(!Object.keys(stored.progress || {}).length, "progress was not cleared by reset");
  assert(!Object.keys(stored.drafts || {}).length, "drafts were not cleared by reset");
  assert(!Object.keys(stored.revealed || {}).length, "revealed answers were not cleared by reset");
  assert(!Object.keys(stored.examExposure || {}).length, "exam exposure was not cleared by reset");
  assert(stored.exam === null, "active exam was not cleared by reset");
  return {
    wrong: Object.keys(stored.wrong || {}).length,
    favorites: Object.keys(stored.favorites || {}).length,
    notes: Object.keys(stored.notes || {}).length,
    suitePapers: stored.suitePapers.length
  };
}

async function assertNoServiceWorkerResidue(page) {
  await page.waitForTimeout(1500);
  return page.evaluate(async () => {
    const registrations = "serviceWorker" in navigator
      ? await navigator.serviceWorker.getRegistrations()
      : [];
    const cacheKeys = "caches" in window ? await caches.keys() : [];
    return {
      registrations: registrations.length,
      controlled: Boolean(navigator.serviceWorker?.controller),
      cacheKeys: cacheKeys.filter((key) => key.startsWith("quiz-pwa-") || key.startsWith("shuati-bar-"))
    };
  });
}

async function run() {
  const { chromium, devices } = requirePlaywright();
  const config = getConfig();
  const browser = await chromium.launch({
    headless: !config.headed,
    executablePath: config.chromePath
  });
  let remoteValue = {};
  const apiWrites = [];
  const context = await browser.newContext({ ...devices["iPhone 14"], locale: "zh-CN" });
  const apiHandler = async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, value: remoteValue })
      });
      return;
    }
    if (request.method() === "POST") {
      apiWrites.push(JSON.parse(request.postData() || "{}"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, storedAt: new Date().toISOString() })
      });
      return;
    }
    await route.continue();
  };
  await context.route("**/api/state/**", apiHandler);
  await context.route("**/api/session/**", apiHandler);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });

  try {
    await login(page, config.targetUrl, config.staffId);
    const seed = await seedProtectedState(page, config.staffId);
    remoteValue = {};
    const beforeReset = await readStoredState(page);
    assert(beforeReset.staffId === config.staffId, "seeded staff id did not load");
    const dock = await assertDockShape(page);
    const sw = await assertNoServiceWorkerResidue(page);
    assert(sw.registrations === 0, `service worker registrations remain: ${JSON.stringify(sw)}`);
    assert(sw.cacheKeys.length === 0, `old quiz caches remain: ${JSON.stringify(sw)}`);
    await resetProgressThroughUi(page);
    const preserved = await assertResetPreservedProtected(page, seed);
    if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join("; ")}`);
    console.log(JSON.stringify({
      ok: true,
      targetUrl: config.targetUrl,
      staffId: config.staffId,
      dock,
      serviceWorker: sw,
      preserved,
      interceptedApiWrites: apiWrites.length
    }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
