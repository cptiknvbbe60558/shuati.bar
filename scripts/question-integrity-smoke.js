#!/usr/bin/env node

const TARGET_URL = process.env.TARGET_URL || "http://127.0.0.1:4173";
const STAFF_ID = process.env.STAFF_ID || "704001";
const STORAGE_KEY = "customer-manager-quiz-state-v1";
const QUESTION_ID = "69bfb6c39703";
const EXPECTED = {
  question: "《中华人民共和国反洗钱法》自何时起施行？",
  answer: ["B"],
  options: [
    ["A", "2024年11月8日"],
    ["B", "2025年1月1日"],
    ["C", "2024年12月1日"],
    ["D", "2025年3月1日"]
  ]
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

async function runEngine(engine, device, name) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ ...device, locale: "zh-CN" });
  const handler = async (route, request) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(request.method() === "GET" ? { success: true, value: {} } : { success: true })
    });
  };
  await context.route("**/api/state/**", handler);
  await context.route("**/api/session/**", handler);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`${TARGET_URL}/?questionIntegrity=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    if (await page.locator("#staff-id").count()) {
      await page.locator("#staff-id").fill(STAFF_ID);
      await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    }
    await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
    const seededState = await page.evaluate(({ key, questionId }) => {
      const state = JSON.parse(localStorage.getItem(key) || "{}");
      state.mode = "practice";
      state.lastPracticeMode = "practice";
      state.currentId = questionId;
      state.lastPracticeId = questionId;
      state.practiceLocations = { ...(state.practiceLocations || {}), practice: questionId };
      state.selectedTypes = ["单选", "多选", "判断"];
      state.selectedCategories = window.QUIZ_BANK.categories.map((category) => category.id);
      state.studyMode = false;
      state.drafts = {};
      state.revealed = { [questionId]: true };
      state._savedAt = new Date().toISOString();
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem(`${key}-backup`, JSON.stringify(state));
      return state;
    }, { key: STORAGE_KEY, questionId: QUESTION_ID });
    await context.addInitScript(({ key, state }) => {
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    }, { key: STORAGE_KEY, state: seededState });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
    await page.waitForSelector('.option-button[data-key="D"]');

    const audit = await page.evaluate(({ questionId }) => {
      const bankQuestion = window.QUIZ_BANK.questions.find((question) => question.id === questionId);
      const optionRows = [...document.querySelectorAll(".option-button")].map((row) => ({
        key: row.querySelector(".option-key")?.textContent?.trim() || "",
        text: row.querySelector(".option-text")?.textContent?.trim() || "",
        visible: row.getBoundingClientRect().bottom <= window.innerHeight || document.scrollingElement.scrollHeight > window.innerHeight
      }));
      return {
        bankQuestion: bankQuestion ? {
          question: bankQuestion.question,
          answer: bankQuestion.answer,
          options: bankQuestion.options.map((option) => [option.key, option.text])
        } : null,
        screenQuestion: document.querySelector(".question-text")?.textContent?.trim() || "",
        screenOptions: optionRows,
        screenAnswer: document.querySelector(".answer-compare-correct strong")?.textContent?.trim() || "",
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      };
    }, { questionId: QUESTION_ID });

    const screenPairs = audit.screenOptions.map((option) => [option.key, option.text]);
    if (JSON.stringify(audit.bankQuestion) !== JSON.stringify(EXPECTED)) {
      throw new Error(`${name}: bank object mismatch: ${JSON.stringify(audit.bankQuestion)}`);
    }
    if (audit.screenQuestion !== EXPECTED.question) {
      throw new Error(`${name}: screen question mismatch: ${audit.screenQuestion}`);
    }
    if (JSON.stringify(screenPairs) !== JSON.stringify(EXPECTED.options)) {
      throw new Error(`${name}: screen options mismatch: ${JSON.stringify(screenPairs)}`);
    }
    if (audit.screenAnswer !== "B") throw new Error(`${name}: screen answer mismatch: ${audit.screenAnswer}`);
    if (audit.horizontalOverflow) throw new Error(`${name}: horizontal overflow detected`);
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
    await page.screenshot({ path: `/tmp/shuati-question-integrity-${name}.png`, fullPage: false });
    return { name, ...audit };
  } finally {
    await browser.close();
  }
}

async function run() {
  const { chromium, webkit, devices } = requirePlaywright();
  const device = devices["iPhone 14"];
  const results = [
    await runEngine(chromium, device, "chrome"),
    await runEngine(webkit, device, "safari")
  ];
  console.log(JSON.stringify({ ok: true, targetUrl: TARGET_URL, results }, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
