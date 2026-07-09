#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STORAGE_KEY = "customer-manager-quiz-state-v1";
const WRONG_MASTERY_TARGET = 5;
const SUITE_RULE = {
  "单选": { count: 90, priorityQuota: Math.round(90 * 0.45) },
  "多选": { count: 45, priorityQuota: Math.round(45 * 0.45) },
  "判断": { count: 20, priorityQuota: Math.round(20 * 0.45) }
};

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function installStateApiMock(context) {
  const apiWrites = [];
  await context.route("**/api/state/**", async (route, request) => {
    if (request.method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, value: {} })
      });
      return;
    }
    if (["POST", "PUT", "PATCH"].includes(request.method())) {
      apiWrites.push({
        method: request.method(),
        postData: request.postData() || ""
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true })
      });
      return;
    }
    await route.continue();
  });
  return apiWrites;
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/?suiteRulesSmoke=${Date.now()}`, {
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
  await page.waitForTimeout(650);
}

async function seedSuiteState(page, staffId) {
  return page.evaluate(({ key, id, target }) => {
    const byType = {};
    for (const question of window.QUIZ_BANK.questions) {
      byType[question.type] = byType[question.type] || [];
      byType[question.type].push(question);
    }
    for (const [type, rule] of Object.entries(target)) {
      if ((byType[type] || []).length < rule.count + rule.priorityQuota + 8) {
        throw new Error(`not enough ${type} questions for suite rules smoke`);
      }
    }

    const now = new Date().toISOString();
    const wrong = {};
    const favorites = {};
    const favoriteSync = {};
    const mastery = {};
    const suiteExposure = {};
    const activePriorityIds = {};
    const prioritySeedIds = {};
    let streakTestId = "";
    let streakTestAnswer = "";

    for (const [type, rule] of Object.entries(target)) {
      const questions = byType[type];
      const activePriority = questions.slice(0, rule.priorityQuota + 5);
      activePriorityIds[type] = activePriority.map((question) => question.id);
      prioritySeedIds[type] = [];

      activePriority.forEach((question, index) => {
        prioritySeedIds[type].push(question.id);
        if (index % 3 === 2) {
          favorites[question.id] = true;
          favoriteSync[question.id] = { active: true, updatedAt: now };
          return;
        }
        wrong[question.id] = {
          correctStreak: 0,
          wrongCount: 2 + index,
          reviewCount: index % 4,
          lastCorrect: false,
          lastAt: now
        };
      });

      const exposureStart = rule.priorityQuota + 5;
      questions.slice(exposureStart, exposureStart + 30).forEach((question, index) => {
        suiteExposure[question.id] = index % 7;
      });

      const mastered = questions.slice(exposureStart + 30, exposureStart + 36);
      mastered.forEach((question) => {
        mastery[question.id] = { correctStreak: 5, lastCorrect: true, lastAt: now };
      });
    }

    const firstSingle = byType["单选"][0];
    streakTestId = firstSingle.id;
    streakTestAnswer = firstSingle.answer[0];
    wrong[streakTestId] = {
      correctStreak: 4,
      wrongCount: 9,
      reviewCount: 0,
      lastCorrect: true,
      lastAt: now
    };

    const state = {
      staffId: id,
      mode: "single",
      selectedCategories: window.QUIZ_BANK.categories.map((category) => category.id),
      selectedTypes: ["单选", "多选", "判断"],
      query: "",
      currentId: streakTestId,
      drafts: {},
      revealed: {},
      progress: {},
      wrong,
      favorites,
      favoriteSync,
      mastery,
      notes: {},
      examExposure: {},
      suiteExposure,
      optionOrders: {},
      utilityPanel: "",
      categoryMenuOpen: false,
      examStartMenuOpen: false,
      studyMode: false,
      specialIndexes: {},
      examSize: 300,
      lastPracticeMode: "single",
      lastPracticeId: streakTestId,
      exam: null,
      suitePapers: [],
      suite: null,
      _schemaVersion: 4,
      _savedAt: now,
      _assetVersion: "suite-rules-smoke"
    };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return {
      streakTestId,
      streakTestAnswer,
      activePriorityIds,
      prioritySeedIds
    };
  }, { key: STORAGE_KEY, id: staffId, target: SUITE_RULE });
}

async function answerStreakTest(page, seed) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 20000 }
  );
  await clickRequired(page, `.question-card .option-button[data-key="${seed.streakTestAnswer}"]`, "answer seeded wrong question correctly");
  return page.evaluate(({ key, id, target }) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const entry = state.wrong?.[id] || {};
    const activeWrong = Object.values(state.wrong || {}).filter((record) => {
      return record && typeof record === "object" && (Number(record.correctStreak) || 0) < target;
    }).length;
    return {
      correctStreak: Number(entry.correctStreak) || 0,
      lastCorrect: Boolean(entry.lastCorrect),
      activeWrong
    };
  }, { key: STORAGE_KEY, id: seed.streakTestId, target: WRONG_MASTERY_TARGET });
}

async function startSuite(page) {
  await clickRequired(page, 'button[data-mode="suite"]', "open 强化练习");
  await clickRequired(page, 'button[data-action="start-suite-paper"]:not([disabled])', "start suite paper");
  await page.waitForSelector(".question-card .option-button", { timeout: 10000 });
}

async function inspectSuite(page, seed) {
  return page.evaluate(({ key, target, seedData }) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const latestPaper = [...(state.suitePapers || [])].sort((left, right) => (right.number || 0) - (left.number || 0))[0];
    const bankById = new Map(window.QUIZ_BANK.questions.map((question) => [question.id, question]));
    if (!latestPaper) throw new Error("no suite paper was generated");

    const ids = latestPaper.ids || [];
    const uniqueIds = new Set(ids);
    const typeCounts = {};
    const priorityCounts = {};
    const unexpectedPriority = [];
    const optionOrderMismatches = [];
    const visibleOptions = [...document.querySelectorAll(".question-card .option-button")].map((button) => ({
      key: button.dataset.key || "",
      text: button.querySelector(".option-text")?.textContent || ""
    }));
    const visibleQuestionText = (document.querySelector(".question-card .question-text")?.textContent || "").trim();
    const visibleQuestion = window.QUIZ_BANK.questions.find((question) => String(question.question || "").trim() === visibleQuestionText);

    for (const id of ids) {
      const question = bankById.get(id);
      if (!question) continue;
      typeCounts[question.type] = (typeCounts[question.type] || 0) + 1;
      const expectedOrder = (question.options || []).map((option) => option.key);
      const paperOrder = latestPaper.optionOrders?.[id] || [];
      if (expectedOrder.length > 1 && JSON.stringify(expectedOrder) !== JSON.stringify(paperOrder)) {
        optionOrderMismatches.push({ id, expectedOrder, paperOrder });
      }
    }

    for (const id of latestPaper.priorityIds || []) {
      const question = bankById.get(id);
      if (!question) {
        unexpectedPriority.push({ id, reason: "missing_question" });
        continue;
      }
      priorityCounts[question.type] = (priorityCounts[question.type] || 0) + 1;
      const activeSeeds = new Set(seedData.activePriorityIds[question.type] || []);
      if (!activeSeeds.has(id)) unexpectedPriority.push({ id, type: question.type, reason: "not_seeded_priority" });
      if (id === seedData.streakTestId) unexpectedPriority.push({ id, type: question.type, reason: "mastered_wrong_still_priority" });
    }

    const visibleBankOptions = visibleQuestion
      ? (visibleQuestion.options || []).map((option) => ({ key: option.key, text: option.text || "" }))
      : [];

    return {
      paperTitle: latestPaper.title,
      paperNumber: latestPaper.number,
      total: ids.length,
      uniqueTotal: uniqueIds.size,
      typeCounts,
      priorityCounts,
      priorityTotal: (latestPaper.priorityIds || []).length,
      unexpectedPriority,
      optionOrderMismatches,
      activeSuiteIds: state.suite?.ids?.length || 0,
      activeSuiteKind: state.suite?.kind || "",
      visibleQuestionFound: Boolean(visibleQuestion),
      visibleOptions,
      visibleBankOptions,
      visibleOrderMatchesBank: JSON.stringify(visibleOptions) === JSON.stringify(visibleBankOptions)
    };
  }, { key: STORAGE_KEY, target: SUITE_RULE, seedData: seed });
}

function assertSuiteRules(result) {
  assert(result.paperTitle === "强化练习（一）", `unexpected paper title: ${result.paperTitle}`);
  assert(result.total === 155, `suite total is not 155: ${result.total}`);
  assert(result.uniqueTotal === 155, `suite has duplicate questions: ${result.uniqueTotal}/${result.total}`);
  assert(result.activeSuiteIds === 155, `active suite run did not include 155 ids: ${result.activeSuiteIds}`);
  assert(result.activeSuiteKind === "full", `active suite kind is not full: ${result.activeSuiteKind}`);
  for (const [type, rule] of Object.entries(SUITE_RULE)) {
    assert(result.typeCounts[type] === rule.count, `${type} count mismatch: ${result.typeCounts[type]} !== ${rule.count}`);
    assert(result.priorityCounts[type] === rule.priorityQuota, `${type} priority quota mismatch: ${result.priorityCounts[type]} !== ${rule.priorityQuota}`);
  }
  assert(result.priorityTotal === 70, `priority total should be 70: ${result.priorityTotal}`);
  assert(!result.unexpectedPriority.length, `unexpected priority ids: ${JSON.stringify(result.unexpectedPriority)}`);
  assert(!result.optionOrderMismatches.length, `paper option orders differ from source bank: ${JSON.stringify(result.optionOrderMismatches.slice(0, 3))}`);
  assert(result.visibleQuestionFound, "visible suite question was not found in source bank");
  assert(result.visibleOrderMatchesBank, `visible suite option order differs from source bank: ${JSON.stringify(result.visibleOptions)} vs ${JSON.stringify(result.visibleBankOptions)}`);
}

async function run() {
  const { chromium, devices } = requirePlaywright();
  const config = getConfig();
  const browser = await chromium.launch({
    headless: !config.headed,
    executablePath: config.chromePath
  });
  const context = await browser.newContext({ ...devices["iPhone 14"], locale: "zh-CN" });
  const apiWrites = await installStateApiMock(context);
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });

  try {
    await login(page, config.targetUrl, config.staffId);
    const seed = await seedSuiteState(page, config.staffId);
    const mastery = await answerStreakTest(page, seed);
    assert(mastery.correctStreak === WRONG_MASTERY_TARGET, `wrong streak did not reach 5: ${JSON.stringify(mastery)}`);
    assert(mastery.lastCorrect, `wrong streak lastCorrect not set: ${JSON.stringify(mastery)}`);

    await startSuite(page);
    const suite = await inspectSuite(page, seed);
    assertSuiteRules(suite);
    if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join("; ")}`);

    console.log(JSON.stringify({
      ok: true,
      targetUrl: config.targetUrl,
      staffId: config.staffId,
      mastery,
      suite: {
        paperTitle: suite.paperTitle,
        total: suite.total,
        typeCounts: suite.typeCounts,
        priorityCounts: suite.priorityCounts,
        priorityTotal: suite.priorityTotal,
        activeSuiteIds: suite.activeSuiteIds,
        visibleOrderMatchesBank: suite.visibleOrderMatchesBank
      },
      interceptedWrites: apiWrites.length
    }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
