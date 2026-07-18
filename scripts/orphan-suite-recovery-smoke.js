#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:4173";
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installApiMock(context) {
  const handler = async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, value: {} })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true, value: {} })
    });
  };
  await context.route("**/api/state/**", handler);
  await context.route("**/api/session/**", handler);
}

async function waitForFullBank(page) {
  await page.waitForFunction(
    () => window.QUIZ_BANK && !window.QUIZ_BANK.isStarter && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 30000 }
  );
}

async function seedOrphanSession(page, { staffId, mode }) {
  const marker = `__orphan_suite_recovery_${mode}__`;
  await page.goto(`${process.env.TARGET_URL || DEFAULT_URL}/?orphanSeed=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(500);
  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
  }
  await waitForFullBank(page);

  await page.addInitScript(({ key, markerKey }) => {
    const raw = sessionStorage.getItem(markerKey);
    if (!raw) return;
    localStorage.setItem(key, raw);
    localStorage.setItem(`${key}-backup`, raw);
    sessionStorage.removeItem(markerKey);
  }, { key: STORAGE_KEY, markerKey: marker });

  await page.evaluate(({ id, targetMode, markerKey }) => {
    const rules = { "单选": 90, "多选": 45, "判断": 20 };
    const ids = [];
    for (const [type, count] of Object.entries(rules)) {
      ids.push(...window.QUIZ_BANK.questions.filter((question) => question.type === type).slice(0, count).map((question) => question.id));
    }
    const now = new Date().toISOString();
    const paperId = `${targetMode === "suite" ? "suite" : "wrong-suite"}-orphan-smoke`;
    const session = {
      active: true,
      paperId,
      runId: `run-${targetMode}-orphan-smoke`,
      kind: "full",
      ids,
      index: targetMode === "suite" ? 47 : 66,
      answers: { [ids[0]]: [window.QUIZ_BANK.questions.find((question) => question.id === ids[0]).answer[0]] },
      revealed: {},
      outcomes: {},
      submitted: false,
      startedAt: Date.now() - 60000
    };
    const state = {
      staffId: id,
      mode: targetMode,
      selectedCategories: window.QUIZ_BANK.categories.map((category) => category.id),
      selectedTypes: ["单选", "多选", "判断"],
      query: "",
      currentId: ids[0],
      drafts: {},
      revealed: {},
      progress: {},
      wrong: {},
      favorites: {},
      favoriteSync: {},
      mastery: {},
      notes: {},
      examExposure: {},
      suiteExposure: {},
      wrongEliminationExposure: {},
      optionOrders: {},
      specialIndexes: {},
      suitePapers: [],
      suite: targetMode === "suite" ? session : null,
      suiteSessionUpdatedAt: targetMode === "suite" ? now : "",
      wrongEliminationPapers: [],
      wrongEliminationSuite: targetMode === "wrong_elimination" ? session : null,
      wrongEliminationSessionUpdatedAt: targetMode === "wrong_elimination" ? now : "",
      _schemaVersion: 5,
      _savedAt: now
    };
    sessionStorage.setItem(markerKey, JSON.stringify(state));
  }, { id: staffId, targetMode: mode, markerKey: marker });

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFullBank(page);
  await page.waitForTimeout(800);
}

async function assertRecovered(page, mode) {
  const missingText = mode === "suite" ? "强化练习不存在" : "消灭错题不存在";
  assert(!(await page.getByText(missingText, { exact: false }).count()), `${mode} still shows missing paper`);
  assert(await page.locator(".question-card").count(), `${mode} question card did not recover`);
  const snapshot = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), STORAGE_KEY);
  const session = mode === "suite" ? snapshot.suite : snapshot.wrongEliminationSuite;
  const papers = mode === "suite" ? snapshot.suitePapers : snapshot.wrongEliminationPapers;
  if (!Array.isArray(papers) || !papers.some((paper) => paper.id === session?.paperId)) {
    console.error("recovery snapshot", JSON.stringify({
      mode,
      stateMode: snapshot.mode,
      paperId: session?.paperId,
      index: session?.index,
      paperIds: (papers || []).map((paper) => paper.id),
      pageText: (await page.locator("body").innerText()).slice(0, 500)
    }, null, 2));
  }
  assert(Array.isArray(papers) && papers.some((paper) => paper.id === session.paperId), `${mode} paper was not reconstructed`);
  assert(session.index === (mode === "suite" ? 47 : 66), `${mode} position was reset`);
  assert(Object.keys(session.answers || {}).length === 1, `${mode} saved answer was lost`);
  assert((papers.find((paper) => paper.id === session.paperId)?.ids || []).length === 155, `${mode} recovered paper is incomplete`);
}

async function run() {
  const { chromium } = requirePlaywright();
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || DEFAULT_CHROME_PATH,
    headless: process.env.HEADED !== "1"
  });
  try {
    for (const [mode, staffId] of [["suite", "704001"], ["wrong_elimination", "704002"]]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await installApiMock(context);
      const page = await context.newPage();
      await seedOrphanSession(page, { staffId, mode });
      await assertRecovered(page, mode);
      await context.close();
    }
    console.log(JSON.stringify({ ok: true, checks: ["suite paper recovered", "wrong elimination paper recovered", "position retained", "answers retained"] }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
