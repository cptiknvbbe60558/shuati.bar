#!/usr/bin/env node

const DEFAULT_URL = "http://127.0.0.1:8787";
const DEFAULT_STAFF_ID = "704001";
const STORAGE_KEY = "customer-manager-quiz-state-v1";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requirePlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    console.error("Playwright is required. Set NODE_PATH to the Codex runtime node_modules.");
    throw error;
  }
}

async function installCloudMock(context) {
  const cloud = {
    protected: {},
    session: {},
    writes: []
  };

  const install = async (pattern, kind) => {
    await context.route(pattern, async (route, request) => {
      if (request.method() === "GET") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, value: cloud[kind] })
        });
        return;
      }
      if (request.method() === "POST") {
        const payload = request.postDataJSON();
        cloud[kind] = JSON.parse(JSON.stringify(payload || {}));
        cloud.writes.push({ kind, payload: cloud[kind] });
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, value: cloud[kind] })
        });
        return;
      }
      await route.fulfill({ status: 405, body: "method_not_allowed" });
    });
  };

  await install("**/api/state/**", "protected");
  await install("**/api/session/**", "session");
  return cloud;
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/?session-smoke=${Date.now()}`, {
    waitUntil: "domcontentloaded",
    timeout: 30000
  });
  await page.waitForTimeout(300);
  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
  }
  await page.waitForFunction(
    () => window.QUIZ_BANK?.questions?.length > 3000,
    null,
    { timeout: 20000 }
  );
  await page.waitForTimeout(500);
}

async function click(page, selector, label) {
  const target = page.locator(selector).first();
  assert(await target.count(), `${label}: missing ${selector}`);
  assert(await target.isVisible(), `${label}: hidden ${selector}`);
  assert(!(await target.isDisabled()), `${label}: disabled ${selector}`);
  await target.click();
  await page.waitForTimeout(250);
}

async function seedWrongQuestions(page) {
  return page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const questions = (window.QUIZ_BANK?.questions || [])
      .filter((question) => question.type === "单选" && (question.options || []).length >= 2)
      .slice(0, 2);
    if (questions.length !== 2) throw new Error("not enough questions to seed wrong practice");
    const now = new Date().toISOString();
    state.wrong = state.wrong && typeof state.wrong === "object" ? state.wrong : {};
    for (const question of questions) {
      state.wrong[question.id] = {
        correctStreak: 0,
        wrongCount: 1,
        reviewCount: 0,
        lastCorrect: false,
        lastAt: now,
        active: true
      };
    }
    state.wrongPracticeSession = {
      currentId: "",
	  reviewCurrentId: "",
      drafts: {},
      revealed: {},
      studyMode: false,
      updatedAt: ""
    };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return questions.map((question) => question.id);
  }, STORAGE_KEY);
}

async function readState(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}"), STORAGE_KEY);
}

async function enterWrongPractice(page) {
  await click(page, 'button[data-mode="wrong"]', "open wrong review");
  await click(
    page,
    'button[data-action="set-wrong-view"][data-view="practice"]',
    "open wrong practice"
  );
}

async function testWrongResume(page, cloud, wrongIds) {
  const seedAudit = await page.evaluate(({ key, ids }) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const bankIds = new Set((window.QUIZ_BANK?.questions || []).map((question) => question.id));
    return {
      wrongKeys: Object.keys(state.wrong || {}),
      records: ids.map((id) => state.wrong?.[id] || null),
      bankHasIds: ids.map((id) => bankIds.has(id)),
      wrongButtonDisabled: Boolean(document.querySelector('button[data-mode="wrong"]')?.disabled)
    };
  }, { key: STORAGE_KEY, ids: wrongIds });
  assert(
    wrongIds.every((id) => seedAudit.wrongKeys.includes(id))
      && seedAudit.bankHasIds.every(Boolean)
      && !seedAudit.wrongButtonDisabled,
    `seeded wrong records are not active after reload: ${JSON.stringify(seedAudit)}`
  );
  await enterWrongPractice(page);
  let state = await readState(page);
  assert(state.currentId === wrongIds[0], `wrong practice did not start at first question: ${state.currentId}`);

  await click(page, 'button[data-action="next-question"]', "move to second wrong question");
  await click(page, ".question-card .option-button", "answer second wrong question");
  await page.waitForTimeout(1100);

  state = await readState(page);
  const secondId = wrongIds[1];
  assert(state.currentId === secondId, `wrong practice did not stay on second question: ${state.currentId}`);
  assert(state.wrongPracticeSession.currentId === secondId, "local wrong session did not capture current question");
  assert(cloud.session.wrongPracticeSession?.currentId === secondId, "cloud wrong session did not capture current question");

  await click(page, 'button[data-mode="practice"]', "leave wrong practice");
  await enterWrongPractice(page);
  state = await readState(page);
  assert(state.currentId === secondId, `wrong practice resumed at the wrong question: ${state.currentId}`);
  assert(
    Array.isArray(state.drafts?.[secondId]) && state.drafts[secondId].length,
    "wrong practice answer was not restored"
  );
  return { secondId, state };
}

async function testWrongReviewResume(page, cloud, wrongIds) {
  await click(page, 'button[data-mode="wrong"]', "open wrong review for position test");
  await click(page, 'button[data-action="next-question"]', "move wrong review to second question");
  let state = await readState(page);
  const secondId = wrongIds[1];
  assert(state.currentId === secondId, `wrong review did not move to second question: ${state.currentId}`);
  assert(state.wrongPracticeSession.reviewCurrentId === secondId, "local wrong-review position was not captured");
  await page.waitForTimeout(1100);
  assert(cloud.session.wrongPracticeSession?.reviewCurrentId === secondId, "cloud wrong-review position was not captured");

  await click(page, 'button[data-mode="practice"]', "leave wrong review");
  await click(page, 'button[data-mode="wrong"]', "return to wrong review");
  state = await readState(page);
  assert(state.currentId === secondId, `wrong review resumed at the wrong question: ${state.currentId}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
  await click(page, 'button[data-mode="wrong"]', "return to wrong review after reload");
  state = await readState(page);
  assert(state.currentId === secondId, `wrong review lost position after reload: ${state.currentId}`);
  return secondId;
}

async function testSuiteResume(page, cloud) {
  await click(page, 'button[data-mode="suite"]', "open reinforcement practice");
  await click(
    page,
    'button[data-action="retry-suite-full"]:not([disabled]), button[data-action="start-suite-paper"]:not([disabled])',
    "start reinforcement practice"
  );
  await click(page, ".question-card .option-button", "answer reinforcement question");
  const submit = page.locator('button[data-action="suite-submit-answer"]:not([disabled])').first();
  if (await submit.count()) {
    await submit.click();
    await page.waitForTimeout(250);
  }
  await click(page, 'button[data-action="next-suite"]', "move reinforcement practice forward");
  await page.waitForTimeout(1100);

  const before = await readState(page);
  assert(before.suite?.active && !before.suite?.submitted, "reinforcement practice is not active");
  assert(before.suite.index > 0, `reinforcement practice did not move forward: ${before.suite.index}`);
  assert(cloud.session.suiteSession?.value?.runId === before.suite.runId, "cloud suite run id was not saved");
  assert(cloud.session.suiteSession?.value?.index === before.suite.index, "cloud suite index was not saved");

  await click(page, 'button[data-mode="practice"]', "leave reinforcement practice");
  await click(page, 'button[data-mode="suite"]', "resume reinforcement practice");
  const after = await readState(page);
  assert(after.suite?.runId === before.suite.runId, "reinforcement run changed after mode switch");
  assert(after.suite?.index === before.suite.index, "reinforcement index changed after mode switch");
  return before;
}

async function testWrongEliminationResume(page, cloud) {
  const seed = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const activeWrongIds = Object.entries(state.wrong || {})
      .filter(([, record]) => record?.active !== false && (Number(record?.correctStreak) || 0) < 5)
      .map(([id]) => id);
    return {
      activeWrongIds,
      standardSuitePaperCount: (state.suitePapers || []).length
    };
  }, STORAGE_KEY);
  assert(seed.activeWrongIds.length > 1, "not enough active wrong questions for elimination practice");

  await click(page, 'button[data-mode="wrong_elimination"]', "open wrong elimination");
  await click(
    page,
    'button[data-action="start-suite-paper"]:not([disabled])',
    "start wrong elimination paper"
  );
  await page.waitForSelector(".question-card .option-button", { timeout: 10000 });

  let state = await readState(page);
  assert(state.wrongEliminationSuite?.active, "wrong elimination session is not active");
  assert(!state.wrongEliminationSuite?.submitted, "wrong elimination session started as submitted");
  const generatedIds = state.wrongEliminationSuite.ids || [];
  assert(generatedIds.length > 0 && generatedIds.length <= 155, `wrong elimination size is invalid: ${generatedIds.length}`);
  assert(
    generatedIds.every((id) => seed.activeWrongIds.includes(id)),
    "wrong elimination included a question outside the active wrong bank"
  );
  assert(
    (state.suitePapers || []).length === seed.standardSuitePaperCount,
    "wrong elimination modified reinforcement papers"
  );
  assert(
    (state.wrongEliminationPapers || []).length === 1,
    "wrong elimination paper was not saved independently"
  );

  await click(page, 'button[data-action="next-suite"]', "move wrong elimination forward");
  await page.waitForTimeout(1100);
  const before = await readState(page);
  assert(before.wrongEliminationSuite.index === 1, `wrong elimination did not move to index 1: ${before.wrongEliminationSuite.index}`);
  assert(
    cloud.session.wrongEliminationSession?.value?.runId === before.wrongEliminationSuite.runId,
    "cloud wrong elimination run id was not saved"
  );
  assert(
    cloud.session.wrongEliminationSession?.value?.index === before.wrongEliminationSuite.index,
    "cloud wrong elimination index was not saved"
  );

  await click(page, 'button[data-mode="practice"]', "leave wrong elimination");
  await click(page, 'button[data-mode="wrong_elimination"]', "resume wrong elimination");
  state = await readState(page);
  assert(state.wrongEliminationSuite.runId === before.wrongEliminationSuite.runId, "wrong elimination run changed after mode switch");
  assert(state.wrongEliminationSuite.index === before.wrongEliminationSuite.index, "wrong elimination index changed after mode switch");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
  state = await readState(page);
  assert(state.mode === "wrong_elimination", `wrong elimination mode was not restored after reload: ${state.mode}`);
  assert(state.wrongEliminationSuite.index === before.wrongEliminationSuite.index, "wrong elimination index changed after reload");

  await click(page, 'button[data-action="finish-suite"]', "finish wrong elimination paper");
  await click(page, 'button[data-action="retry-suite-full"]', "redo wrong elimination paper");
  state = await readState(page);
  assert(state.wrongEliminationSuite.index === 0, "explicit wrong elimination redo did not return to first question");
  assert(!Object.keys(state.wrongEliminationSuite.answers || {}).length, "explicit wrong elimination redo kept old answers");
  assert(state.wrongEliminationSuite.runId !== before.wrongEliminationSuite.runId, "explicit wrong elimination redo reused the old run");
  return state;
}

async function testCloudRecovery(page, cloud, staffId, wrongSecondId, suiteBefore, eliminationBefore) {
  const local = await readState(page);
  cloud.protected = JSON.parse(JSON.stringify(local));
  await page.evaluate(() => localStorage.clear());
  await login(page, page.url().split("/?")[0], staffId);

  await click(page, 'button[data-mode="suite"]', "open recovered reinforcement practice");
  let state = await readState(page);
  assert(state.suite?.runId === suiteBefore.suite.runId, "cloud recovery lost reinforcement run");
  assert(state.suite?.index === suiteBefore.suite.index, "cloud recovery lost reinforcement index");

  await click(page, 'button[data-mode="wrong_elimination"]', "open recovered wrong elimination");
  state = await readState(page);
  assert(
    state.wrongEliminationSuite?.runId === eliminationBefore.wrongEliminationSuite.runId,
    "cloud recovery lost wrong elimination run"
  );
  assert(
    state.wrongEliminationSuite?.index === eliminationBefore.wrongEliminationSuite.index,
    "cloud recovery lost wrong elimination index"
  );

  await enterWrongPractice(page);
  state = await readState(page);
  assert(state.currentId === wrongSecondId, `cloud recovery lost wrong-practice position: ${state.currentId}`);

  const restart = page.locator('button[data-action="restart-wrong-practice"]').first();
  assert(await restart.count(), "wrong-practice restart button is missing");
  await restart.click();
  await page.waitForTimeout(300);
  state = await readState(page);
  const activeWrongIds = Object.entries(state.wrong || {})
    .filter(([, record]) => record?.active !== false && (record?.correctStreak || 0) < 5)
    .map(([id]) => id);
  assert(state.currentId === activeWrongIds[0], "restart did not return to the first wrong question");
  assert(!Object.keys(state.wrongPracticeSession?.drafts || {}).length, "restart did not clear wrong-practice answers");
  assert(!Object.keys(state.wrongPracticeSession?.revealed || {}).length, "restart did not hide wrong-practice answers");
  assert(await page.locator(".answer-panel.answer-placeholder").count(), "restart did not restore unanswered view");
}

async function run() {
  const playwright = requirePlaywright();
  const browserName = process.env.BROWSER === "webkit" ? "webkit" : "chromium";
  const targetUrl = process.env.TARGET_URL || DEFAULT_URL;
  const staffId = process.env.STAFF_ID || DEFAULT_STAFF_ID;
  const browserType = playwright[browserName];
  const launchOptions = browserName === "chromium" && process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH }
    : {};
  const browser = await browserType.launch({ headless: true, ...launchOptions });
  const context = await browser.newContext({ ...playwright.devices["iPhone 14"], locale: "zh-CN" });
  const cloud = await installCloudMock(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await login(page, targetUrl, staffId);
    const wrongIds = await seedWrongQuestions(page);
    cloud.protected = JSON.parse(JSON.stringify(await readState(page)));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
	const wrongReviewId = await testWrongReviewResume(page, cloud, wrongIds);
    const wrong = await testWrongResume(page, cloud, wrongIds);
    const suite = await testSuiteResume(page, cloud);
    const elimination = await testWrongEliminationResume(page, cloud);
    await testCloudRecovery(page, cloud, staffId, wrong.secondId, suite, elimination);
    assert(!errors.length, `browser errors: ${errors.join("; ")}`);
    console.log(JSON.stringify({
      ok: true,
      browser: browserName,
      targetUrl,
	  wrongReviewResumeId: wrongReviewId,
      wrongResumeId: wrong.secondId,
      suiteRunId: suite.suite.runId,
      suiteIndex: suite.suite.index,
	  wrongEliminationRunId: elimination.wrongEliminationSuite.runId,
	  wrongEliminationIndex: elimination.wrongEliminationSuite.index,
      cloudWrites: cloud.writes.length
    }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
