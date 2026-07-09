#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function getConfig() {
  return {
    targetUrl: process.env.TARGET_URL || DEFAULT_URL,
    staffId: process.env.STAFF_ID || DEFAULT_STAFF_ID,
    chromePath: process.env.CHROME_PATH || DEFAULT_CHROME_PATH,
    headed: process.env.HEADED === "1"
  };
}

function requirePlaywright() {
  try {
    return require("playwright");
  } catch (error) {
    console.error("Playwright is required. Run with NODE_PATH pointing to the Codex runtime node_modules.");
    console.error(error.message);
    process.exit(2);
  }
}

async function clickIfReady(page, selector, label, required = true) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) {
    if (required) throw new Error(`${label} missing: ${selector}`);
    return false;
  }
  if (!(await locator.isVisible().catch(() => false))) {
    if (required) throw new Error(`${label} hidden: ${selector}`);
    return false;
  }
  if (await locator.isDisabled().catch(() => false)) {
    if (required) throw new Error(`${label} disabled: ${selector}`);
    return false;
  }
  await locator.click({ timeout: 5000 });
  await page.waitForTimeout(450);
  return true;
}

async function compactText(page, selector) {
  const locator = page.locator(selector).first();
  if (!(await locator.count())) return "";
  return (await locator.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

async function dockSnapshot(page) {
  return page.evaluate(() => {
    const dock = document.querySelector(".practice-dock");
    if (!dock) return { exists: false, buttons: [], enabledOutOfView: [] };
    const dockRect = dock.getBoundingClientRect();
    const buttons = [...dock.querySelectorAll("button")].map((button) => {
      const rect = button.getBoundingClientRect();
      const text = button.innerText.trim() || button.getAttribute("aria-label") || button.dataset.action || "";
      return {
        text,
        action: button.dataset.action || "",
        disabled: button.disabled,
        visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    });
    return {
      exists: true,
      rect: {
        x: Math.round(dockRect.x),
        y: Math.round(dockRect.y),
        width: Math.round(dockRect.width),
        height: Math.round(dockRect.height),
        bottom: Math.round(dockRect.bottom)
      },
      buttons,
      enabledOutOfView: buttons.filter((button) => !button.disabled && !button.visible)
    };
  });
}

async function assertDockHealthy(page, label) {
  const snapshot = await dockSnapshot(page);
  if (!snapshot.exists) throw new Error(`${label}: dock missing`);
  if (snapshot.enabledOutOfView.length) {
    throw new Error(`${label}: enabled dock buttons out of viewport: ${JSON.stringify(snapshot.enabledOutOfView)}`);
  }
  const texts = snapshot.buttons.map((button) => button.text);
  for (const removed of ["判断正确", "全选", "随机"]) {
    if (texts.includes(removed)) throw new Error(`${label}: removed dock entry still visible: ${removed}`);
  }
  return snapshot;
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/?smoke=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    await page.waitForTimeout(1500);
  }
  await page.waitForFunction(() => Boolean(window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions)), null, { timeout: 10000 });
}

async function waitForFullBank(page) {
  await page.waitForFunction(
    () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 15000 }
  );
}

async function visibleOptionsMatchBank(page, label) {
  const result = await page.evaluate((scopeLabel) => {
    const questionText = document.querySelector(".question-card .question-text");
    const optionButtons = [...document.querySelectorAll(".question-card .option-button")];
    const domOptions = optionButtons.map((button) => ({
      key: button.dataset.key || "",
      text: button.querySelector(".option-text")?.textContent || ""
    }));
    const normalizedText = (questionText?.textContent || "").replace(/(全选|正确)$/u, "").trim();
    const bankQuestion = (window.QUIZ_BANK?.questions || []).find((question) => String(question.question || "").trim() === normalizedText);
    const bankOptions = (bankQuestion?.options || []).map((option) => ({
      key: option.key,
      text: option.text || ""
    }));
    return {
      label: scopeLabel,
      matchedQuestion: Boolean(bankQuestion),
      optionCount: domOptions.length,
      sameOrder: JSON.stringify(domOptions) === JSON.stringify(bankOptions),
      question: normalizedText.slice(0, 100),
      domOptions,
      bankOptions
    };
  }, label);
  if (!result.matchedQuestion) throw new Error(`${label}: visible question not found in bank: ${result.question}`);
  if (!result.optionCount) throw new Error(`${label}: no visible options`);
  if (!result.sameOrder) throw new Error(`${label}: option order differs from source bank: ${JSON.stringify(result)}`);
  return result;
}

async function findUnrevealedMultiple(page) {
  await clickIfReady(page, 'button[data-mode="multiple"]', "open multiple mode");
  for (let index = 0; index < 30; index += 1) {
    if (!(await page.locator(".answer-panel:not(.answer-placeholder)").count())) return true;
    await clickIfReady(page, 'button[data-action="next-question"]:not([disabled])', "next multiple question");
  }
  return false;
}

async function run() {
  const { chromium, devices } = requirePlaywright();
  const config = getConfig();
  const browser = await chromium.launch({
    headless: !config.headed,
    executablePath: config.chromePath
  });
  const context = await browser.newContext({ ...devices["iPhone 14"], locale: "zh-CN" });
  const page = await context.newPage();
  const browserErrors = [];
  const results = [];
  page.on("pageerror", (error) => browserErrors.push(`pageerror:${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console:${message.text()}`);
  });

  try {
    await login(page, config.targetUrl, config.staffId);
    await waitForFullBank(page);
    results.push({ step: "login", dock: await assertDockHealthy(page, "login") });
    results.push({ step: "single-order", order: await visibleOptionsMatchBank(page, "single") });

    const select = page.locator('select[data-action="category-select"]').first();
    if (await select.count()) {
      await select.selectOption("__all__");
      await page.waitForTimeout(700);
      const optionCount = await page.locator(".question-card .option-button").count();
      if (optionCount < 2) throw new Error("category all left the question card without options");
      results.push({ step: "category-all", optionCount, dock: await assertDockHealthy(page, "category-all") });
    }

    if (!(await findUnrevealedMultiple(page))) throw new Error("could not find an unrevealed multiple-choice question");
    results.push({ step: "multiple-order", order: await visibleOptionsMatchBank(page, "multiple") });
    await clickIfReady(page, ".question-card .option-button:nth-of-type(1)", "select first multiple option");
    await clickIfReady(page, ".question-card .option-button:nth-of-type(2)", "select second multiple option", false);
    const revealedAfterSelect = await page.locator(".answer-panel:not(.answer-placeholder)").count();
    const submitEnabled = await page.locator('button[data-action="submit-practice"]:not([disabled])').count();
    if (revealedAfterSelect) throw new Error("multiple choice revealed answer before submit");
    if (!submitEnabled) throw new Error("multiple choice submit did not enable after selecting options");
    results.push({ step: "multiple-no-auto-reveal", submitEnabled });

    await clickIfReady(page, 'button[data-mode="suite"]', "open suite mode");
    results.push({ step: "suite-home", dock: await assertDockHealthy(page, "suite-home") });
    await clickIfReady(
      page,
      'button[data-action="retry-suite-full"]:not([disabled]), button[data-action="start-suite-paper"]:not([disabled])',
      "enter suite run"
    );
    results.push({ step: "suite-order", order: await visibleOptionsMatchBank(page, "suite") });
    await clickIfReady(page, 'button[data-action="next-suite"]:not([disabled])', "suite next question");
    results.push({ step: "suite-next", dock: await assertDockHealthy(page, "suite-next") });

    await clickIfReady(page, 'button[data-mode="wrong"]', "open wrong mode");
    const wrongOptionCount = await page.locator(".question-card .option-button").count();
    if (wrongOptionCount < 2) throw new Error("wrong mode after suite is not a normal question view");
    results.push({ step: "wrong-after-suite", wrongOptionCount, dock: await assertDockHealthy(page, "wrong-after-suite") });

    await clickIfReady(page, 'button[data-mode="exam300"]', "open mock exam");
    results.push({ step: "exam-home", dock: await assertDockHealthy(page, "exam-home") });
    await clickIfReady(page, 'button[data-action="start-exam300"]:not([disabled])', "open exam start menu");
    if (!(await page.locator(".exam-start-sheet").count())) throw new Error("exam start menu did not open");
    await clickIfReady(page, 'button[data-action="start-exam-kind"][data-kind="random"]:not([disabled])', "start comprehensive mock exam");
    await page.waitForTimeout(700);
    results.push({ step: "exam-order", order: await visibleOptionsMatchBank(page, "exam") });

    if (browserErrors.length) {
      throw new Error(`browser errors: ${browserErrors.join("; ")}`);
    }
    console.log(JSON.stringify({ ok: true, targetUrl: config.targetUrl, staffId: config.staffId, results }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
