#!/usr/bin/env node

const TARGET_URL = process.env.TARGET_URL || "https://shuati.bar";
const STAFF_ID = process.env.STAFF_ID || "704001";
const STORAGE_KEY = "customer-manager-quiz-state-v1";
const QUESTION_ID = "39e3a0931b27";

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
  await context.route("**/api/state/**", async (route, request) => {
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
      body: JSON.stringify({ success: true })
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`${TARGET_URL}/?optionVisualSmoke=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    if (await page.locator("#staff-id").count()) {
      await page.locator("#staff-id").fill(STAFF_ID);
      await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    }
    await page.waitForFunction(
      () => window.QUIZ_BANK?.questions?.length > 3000,
      null,
      { timeout: 20000 }
    );
    await page.evaluate(({ key, questionId }) => {
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
      state.revealed = {};
      localStorage.setItem(key, JSON.stringify(state));
      localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    }, { key: STORAGE_KEY, questionId: QUESTION_ID });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000);
    await page.locator('.option-button[data-key="A"]').click();
    await page.waitForTimeout(350);

    const audit = await page.evaluate(() => {
      const inspect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const style = getComputedStyle(element);
        const keyStyle = getComputedStyle(element.querySelector(".option-key"));
        return {
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor,
          keyBackground: keyStyle.backgroundColor,
          width: Math.round(element.getBoundingClientRect().width)
        };
      };
      return {
        index: document.querySelector(".question-index")?.textContent?.trim() || "",
        correct: inspect(".option-button.correct"),
        wrong: inspect(".option-button.wrong")
      };
    });

    if (!audit.correct || !audit.wrong) throw new Error(`${name}: answer state rows are missing`);
    if (audit.correct.backgroundImage === "none" || audit.wrong.backgroundImage === "none") {
      throw new Error(`${name}: full-row gradients are missing: ${JSON.stringify(audit)}`);
    }
    if (audit.correct.keyBackground !== "rgb(47, 166, 111)" || audit.wrong.keyBackground !== "rgb(223, 102, 121)") {
      throw new Error(`${name}: semantic answer colors are inconsistent: ${JSON.stringify(audit)}`);
    }
    if (audit.correct.width < 300 || audit.wrong.width < 300) {
      throw new Error(`${name}: answer state does not cover the option row: ${JSON.stringify(audit)}`);
    }
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);

    await page.screenshot({ path: `/tmp/shuati-option-${name}.png`, fullPage: false });
    return { name, audit };
  } finally {
    await browser.close();
  }
}

async function run() {
  const { chromium, webkit, devices } = requirePlaywright();
  const device = devices["iPhone 14"];
  const results = [];
  results.push(await runEngine(chromium, device, "chrome"));
  results.push(await runEngine(webkit, device, "safari"));
  console.log(JSON.stringify({ ok: true, targetUrl: TARGET_URL, results }, null, 2));
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
