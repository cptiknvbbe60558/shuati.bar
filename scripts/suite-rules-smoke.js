#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STORAGE_KEY = "customer-manager-quiz-state-v1";
const WRONG_EXIT_TARGET = 5;
const NORMAL_SUITE_EXIT_TARGET = 10;
const WRONG_SUITE_EXIT_TARGET = 15;
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
  const handler = async (route, request) => {
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
  };
  await context.route("**/api/state/**", handler);
  await context.route("**/api/session/**", handler);
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
  const marker = "__suite_rules_smoke_seed__";
  await page.addInitScript(({ key, markerKey }) => {
    const raw = sessionStorage.getItem(markerKey);
    if (!raw) return;
    localStorage.setItem(key, raw);
    localStorage.setItem(`${key}-backup`, raw);
    sessionStorage.removeItem(markerKey);
  }, { key: STORAGE_KEY, markerKey: marker });
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
    const masteredIds = [];
    const reviewStageIds = [];
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
        mastery[question.id] = { correctStreak: 10, lastCorrect: true, lastAt: now };
        masteredIds.push(question.id);
      });

      const normalReview = questions[exposureStart + 36];
      mastery[normalReview.id] = { correctStreak: 5, lastCorrect: true, lastAt: now };
      reviewStageIds.push(normalReview.id);
      const wrongReview = questions[exposureStart + 37];
      wrong[wrongReview.id] = {
        correctStreak: 10,
        wrongCount: 3,
        reviewCount: 5,
        lastCorrect: true,
        lastAt: now
      };
      reviewStageIds.push(wrongReview.id);
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
    sessionStorage.setItem("__suite_rules_smoke_seed__", JSON.stringify(state));
    return {
      streakTestId,
      streakTestAnswer,
      activePriorityIds,
      prioritySeedIds,
      masteredIds,
      reviewStageIds
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
  }, { key: STORAGE_KEY, id: seed.streakTestId, target: WRONG_EXIT_TARGET });
}

async function startSuite(page) {
  await clickRequired(page, 'button[data-mode="suite"]', "open 强化练习");
  await clickRequired(page, 'button[data-action="start-suite-paper"]:not([disabled])', "start suite paper");
  await page.waitForSelector(".question-card .option-button", { timeout: 10000 });
}

async function seedScarcePriorityState(page, staffId) {
  return page.evaluate(({ key, id, target }) => {
    const byType = {};
    for (const question of window.QUIZ_BANK.questions) {
      byType[question.type] = byType[question.type] || [];
      byType[question.type].push(question);
    }

    const now = new Date().toISOString();
    const wrong = {};
    const favorites = {};
    const favoriteSync = {};
    const mastery = {};
    const suiteExposure = {};
    const expectedPriorityIds = [];
    const activeWrongIds = [];
    const historicalWrongIds = [];
    const seenNormalIds = [];

    for (const [type, rule] of Object.entries(target)) {
      const typed = byType[type];
      typed.slice(0, 2).forEach((question) => {
        wrong[question.id] = {
          correctStreak: 0,
          wrongCount: 3,
          reviewCount: 0,
          lastCorrect: false,
          lastAt: now
        };
        activeWrongIds.push(question.id);
        expectedPriorityIds.push(question.id);
      });

      const favorite = typed[2];
      favorites[favorite.id] = true;
      favoriteSync[favorite.id] = { active: true, updatedAt: now };
      expectedPriorityIds.push(favorite.id);

      typed.slice(3, 3 + rule.priorityQuota + 8).forEach((question) => {
        wrong[question.id] = {
          correctStreak: 15,
          wrongCount: 4,
          reviewCount: 5,
          lastCorrect: true,
          lastAt: now
        };
        mastery[question.id] = { correctStreak: 10, lastCorrect: true, lastAt: now };
        historicalWrongIds.push(question.id);
      });

      const seenStart = 3 + rule.priorityQuota + 8;
      typed.slice(seenStart, seenStart + rule.count + 8).forEach((question) => {
        suiteExposure[question.id] = 9;
        seenNormalIds.push(question.id);
      });
    }

    const previous = JSON.parse(localStorage.getItem(key) || "{}");
    const state = {
      ...previous,
      staffId: id,
      mode: "single",
      wrong,
      favorites,
      favoriteSync,
      mastery,
      suiteExposure,
      suitePapers: [],
      suite: null,
      wrongEliminationExposure: {},
      wrongEliminationPapers: [],
      wrongEliminationSuite: null,
      drafts: {},
      revealed: {},
      studyMode: false,
      _savedAt: now
    };
    sessionStorage.setItem("__suite_rules_smoke_seed__", JSON.stringify(state));
    return { expectedPriorityIds, activeWrongIds, historicalWrongIds, seenNormalIds };
  }, { key: STORAGE_KEY, id: staffId, target: SUITE_RULE });
}

async function inspectScarcePrioritySuite(page, seed) {
  return page.evaluate(({ key, seedData }) => {
    const uniqueQuestions = (source) => {
      const seen = new Set();
      const idCounts = new Map();
      const unique = [];
      for (const question of source || []) {
        const signature = question.id + "|" + (question.options || []).map((option) => `${option.key}:${option.text}`).join(",");
        if (seen.has(signature)) continue;
        seen.add(signature);
        const count = (idCounts.get(question.id) || 0) + 1;
        idCounts.set(question.id, count);
        unique.push(count > 1 ? { ...question, id: `${question.id}__v${count - 1}` } : question);
      }
      return unique;
    };
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const paper = [...(state.suitePapers || [])].sort((left, right) => (right.number || 0) - (left.number || 0))[0];
    if (!paper) throw new Error("scarce-priority suite paper missing");
    const bankById = new Map(uniqueQuestions(window.QUIZ_BANK.questions).map((question) => [question.id, question]));
    const expectedPriority = new Set(seedData.expectedPriorityIds || []);
    const historical = new Set(seedData.historicalWrongIds || []);
    const seenNormal = new Set(seedData.seenNormalIds || []);
    const typeCounts = {};
    for (const id of paper.ids || []) {
      const type = bankById.get(id)?.type;
      if (type) typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
    return {
      total: paper.ids?.length || 0,
      uniqueTotal: new Set(paper.ids || []).size,
      priorityTotal: paper.priorityIds?.length || 0,
      unexpectedPriority: (paper.priorityIds || []).filter((id) => !expectedPriority.has(id)),
      missingPriority: [...expectedPriority].filter((id) => !(paper.priorityIds || []).includes(id)),
      historicalInPaper: (paper.ids || []).filter((id) => historical.has(id)),
      seenNormalInPaper: (paper.ids || []).filter((id) => seenNormal.has(id)),
      typeCounts
    };
  }, { key: STORAGE_KEY, seedData: seed });
}

async function startAndInspectWrongElimination(page, seed) {
  await clickRequired(page, 'button[data-mode="wrong_elimination"]', "open 消灭错题");
  await clickRequired(page, 'button[data-action="start-suite-paper"]:not([disabled])', "start wrong elimination paper");
  await page.waitForSelector(".question-card .option-button", { timeout: 10000 });
  return page.evaluate(({ key, seedData }) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const paper = [...(state.wrongEliminationPapers || [])].sort((left, right) => (right.number || 0) - (left.number || 0))[0];
    if (!paper) throw new Error("wrong elimination paper missing");
    const activeWrong = new Set(seedData.activeWrongIds || []);
    return {
      total: paper.ids?.length || 0,
      uniqueTotal: new Set(paper.ids || []).size,
      outsideActiveWrong: (paper.ids || []).filter((id) => !activeWrong.has(id))
    };
  }, { key: STORAGE_KEY, seedData: seed });
}

async function inspectSuite(page, seed) {
  return page.evaluate(({ key, target, seedData }) => {
    const uniqueQuestions = (source) => {
      const seen = new Set();
      const idCounts = new Map();
      const unique = [];
      for (const question of source || []) {
        const key = question.id + "|" + (question.options || []).map((option) => `${option.key}:${option.text}`).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        const count = (idCounts.get(question.id) || 0) + 1;
        idCounts.set(question.id, count);
        unique.push(count > 1 ? { ...question, id: `${question.id}__v${count - 1}` } : question);
      }
      return unique;
    };
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const latestPaper = [...(state.suitePapers || [])].sort((left, right) => (right.number || 0) - (left.number || 0))[0];
    const normalizedQuestions = uniqueQuestions(window.QUIZ_BANK.questions);
    const bankById = new Map(normalizedQuestions.map((question) => [question.id, question]));
    if (!latestPaper) throw new Error("no suite paper was generated");

    const ids = latestPaper.ids || [];
    const uniqueIds = new Set(ids);
    const typeCounts = {};
    const priorityCounts = {};
    const unexpectedPriority = [];
    const optionOrderMismatches = [];
    const masteredInPaper = ids.filter((id) => (seedData.masteredIds || []).includes(id));
    const reviewStageMissing = (seedData.reviewStageIds || []).filter((id) => !ids.includes(id));
    const visibleOptions = [...document.querySelectorAll(".question-card .option-button")].map((button) => ({
      key: button.dataset.key || "",
      text: button.querySelector(".option-text")?.textContent || ""
    }));
    const visibleQuestionText = (document.querySelector(".question-card .question-text")?.textContent || "").trim();
    const visibleQuestion = normalizedQuestions.find((question) => String(question.question || "").trim() === visibleQuestionText);

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
      masteredInPaper,
      reviewStageMissing,
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
  assert(!result.masteredInPaper.length, `mastered questions displaced normal coverage: ${JSON.stringify(result.masteredInPaper)}`);
  assert(!result.reviewStageMissing.length, `mastered review stages were not sampled: ${JSON.stringify(result.reviewStageMissing)}`);
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
    assert(mastery.correctStreak === WRONG_EXIT_TARGET, `wrong streak did not reach 5: ${JSON.stringify(mastery)}`);
    assert(mastery.lastCorrect, `wrong streak lastCorrect not set: ${JSON.stringify(mastery)}`);

    await startSuite(page);
    const suite = await inspectSuite(page, seed);
    assertSuiteRules(suite);

    const scarceSeed = await seedScarcePriorityState(page, config.staffId);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
      null,
      { timeout: 20000 }
    );
    await startSuite(page);
    const scarceSuite = await inspectScarcePrioritySuite(page, scarceSeed);
    assert(scarceSuite.total === 155, `scarce-priority suite total mismatch: ${scarceSuite.total}`);
    assert(scarceSuite.uniqueTotal === 155, `scarce-priority suite has duplicates: ${scarceSuite.uniqueTotal}`);
    assert(scarceSuite.priorityTotal === scarceSeed.expectedPriorityIds.length, `priority was forced to 45%: ${scarceSuite.priorityTotal}`);
    assert(!scarceSuite.unexpectedPriority.length, `unexpected scarce priority: ${JSON.stringify(scarceSuite.unexpectedPriority)}`);
    assert(!scarceSuite.missingPriority.length, `available priority was skipped: ${JSON.stringify(scarceSuite.missingPriority)}`);
    assert(!scarceSuite.historicalInPaper.length, `historical/mastered wrong questions forced into suite: ${JSON.stringify(scarceSuite.historicalInPaper)}`);
    assert(!scarceSuite.seenNormalInPaper.length, `seen normal questions displaced unseen coverage: ${JSON.stringify(scarceSuite.seenNormalInPaper)}`);
    for (const [type, rule] of Object.entries(SUITE_RULE)) {
      assert(scarceSuite.typeCounts[type] === rule.count, `scarce ${type} count mismatch: ${scarceSuite.typeCounts[type]}`);
    }

    const wrongElimination = await startAndInspectWrongElimination(page, scarceSeed);
    assert(wrongElimination.total === scarceSeed.activeWrongIds.length, `wrong elimination did not use current wrong count: ${wrongElimination.total}`);
    assert(wrongElimination.uniqueTotal === wrongElimination.total, `wrong elimination has duplicates: ${wrongElimination.uniqueTotal}/${wrongElimination.total}`);
    assert(!wrongElimination.outsideActiveWrong.length, `wrong elimination included non-wrong questions: ${JSON.stringify(wrongElimination.outsideActiveWrong)}`);
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
      scarceSuite,
      wrongElimination,
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
