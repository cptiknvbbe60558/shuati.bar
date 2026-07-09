#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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

async function waitForFullBank(page) {
  await page.waitForFunction(
    () => window.QUIZ_BANK && Array.isArray(window.QUIZ_BANK.questions) && window.QUIZ_BANK.questions.length > 3000,
    null,
    { timeout: 20000 }
  );
}

async function login(page, targetUrl, staffId) {
  await page.goto(`${targetUrl}/?suiteDeep=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  if (await page.locator("#staff-id").count()) {
    await page.locator("#staff-id").fill(staffId);
    await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    await page.waitForTimeout(1800);
  }
  await waitForFullBank(page);
}

async function clickButton(page, selector, label) {
  const button = page.locator(selector).first();
  if (!(await button.count())) throw new Error(`${label} missing: ${selector}`);
  if (!(await button.isVisible().catch(() => false))) throw new Error(`${label} hidden: ${selector}`);
  if (await button.isDisabled().catch(() => false)) throw new Error(`${label} disabled: ${selector}`);
  await button.click({ timeout: 7000 });
  await page.waitForTimeout(650);
}

async function dockSnapshot(page) {
  return page.evaluate(() => {
    const dock = document.querySelector(".practice-dock");
    if (!dock) return { exists: false, buttons: [], enabledOutOfView: [] };
    const dockRect = dock.getBoundingClientRect();
    const buttons = [...dock.querySelectorAll("button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        text: button.innerText.trim() || button.getAttribute("aria-label") || button.dataset.action || "",
        action: button.dataset.action || "",
        disabled: button.disabled,
        visible: rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          bottom: Math.round(rect.bottom)
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
  return snapshot;
}

async function assertSuiteReportLayout(page, label) {
  const layout = await page.evaluate(() => {
    const screen = document.querySelector(".suite-report-wrap");
    const area = document.querySelector(".suite-report-area");
    const dock = document.querySelector(".suite-report-dock");
    const header = document.querySelector(".suite-report-header");
    const score = document.querySelector(".suite-score-card");
    const firstReview = document.querySelector(".exam-review-card");
    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        bottom: Math.round(rect.bottom),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      scrollY: Math.round(scrollY),
      hasReport: Boolean(screen),
      screen: rectOf(screen),
      area: rectOf(area),
      dock: rectOf(dock),
      header: rectOf(header),
      score: rectOf(score),
      firstReview: rectOf(firstReview),
      areaScroll: area
        ? {
            top: Math.round(area.scrollTop),
            height: Math.round(area.scrollHeight),
            client: Math.round(area.clientHeight)
          }
        : null
    };
  });
  if (!layout.hasReport) throw new Error(`${label}: suite report missing`);
  if (!layout.area || !layout.dock) throw new Error(`${label}: report area/dock missing: ${JSON.stringify(layout)}`);
  if (layout.area.bottom > layout.dock.top + 1) {
    throw new Error(`${label}: report area overlaps dock: ${JSON.stringify(layout)}`);
  }
  if (!layout.firstReview) throw new Error(`${label}: report has no review card`);
  return layout;
}

async function assertReportScrollable(page, label) {
  const metrics = await page.evaluate(() => {
    const area = document.querySelector(".suite-report-area");
    const dock = document.querySelector(".suite-report-dock");
    if (!area || !dock) return null;
    const beforeDock = dock.getBoundingClientRect();
    area.scrollTop = area.scrollHeight;
    const afterDock = dock.getBoundingClientRect();
    return {
      scrollTop: Math.round(area.scrollTop),
      scrollHeight: Math.round(area.scrollHeight),
      clientHeight: Math.round(area.clientHeight),
      dockTopBefore: Math.round(beforeDock.top),
      dockTopAfter: Math.round(afterDock.top),
      dockBottomAfter: Math.round(afterDock.bottom)
    };
  });
  if (!metrics) throw new Error(`${label}: missing report scroll area`);
  if (metrics.scrollHeight <= metrics.clientHeight) throw new Error(`${label}: report is unexpectedly not scrollable`);
  if (metrics.scrollTop <= 0) throw new Error(`${label}: report area did not scroll`);
  if (Math.abs(metrics.dockTopAfter - metrics.dockTopBefore) > 2) {
    throw new Error(`${label}: dock moved while report scrolled: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

async function assertQuestionRunVisible(page, label) {
  await page.waitForSelector(".question-card .option-button", { timeout: 7000 });
  const state = await page.evaluate(() => {
    const card = document.querySelector(".question-card");
    const report = document.querySelector(".suite-report-wrap");
    const options = [...document.querySelectorAll(".question-card .option-button")];
    const rect = card?.getBoundingClientRect();
    return {
      optionCount: options.length,
      hasReport: Boolean(report),
      card: rect
        ? {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height)
          }
        : null
    };
  });
  if (state.hasReport) throw new Error(`${label}: report still visible after entering question run`);
  if (state.optionCount < 2) throw new Error(`${label}: question run has too few options: ${JSON.stringify(state)}`);
  return state;
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
    await clickButton(page, 'button[data-mode="suite"]', "open suite");
    results.push({ step: "suite-home-dock", dock: await assertDockHealthy(page, "suite home") });

    await clickButton(
      page,
      'button[data-action="retry-suite-full"]:not([disabled]), button[data-action="start-suite-paper"]:not([disabled])',
      "enter suite run"
    );
    results.push({ step: "suite-run-dock", dock: await assertDockHealthy(page, "suite run") });

    await clickButton(page, 'button[data-action="finish-suite"]:not([disabled])', "finish suite");
    await page.waitForSelector(".suite-report-wrap", { timeout: 7000 });
    results.push({ step: "suite-report-layout", layout: await assertSuiteReportLayout(page, "suite report") });
    results.push({ step: "suite-report-scroll", metrics: await assertReportScrollable(page, "suite report") });
    results.push({ step: "suite-report-dock", dock: await assertDockHealthy(page, "suite report") });

    await clickButton(
      page,
      '.suite-report-dock button[data-action="retry-suite-wrong"]:not([disabled]), .suite-report-header button[data-action="suite-review-wrong"]:not([disabled])',
      "enter suite wrong retry"
    );
    results.push({ step: "suite-wrong-run", run: await assertQuestionRunVisible(page, "suite wrong retry") });
    results.push({ step: "suite-wrong-dock", dock: await assertDockHealthy(page, "suite wrong retry") });

    await clickButton(page, 'button[data-action="finish-suite"]:not([disabled])', "finish wrong retry");
    await page.waitForSelector(".suite-report-wrap", { timeout: 7000 });
    results.push({ step: "wrong-retry-report-layout", layout: await assertSuiteReportLayout(page, "wrong retry report") });

    if (browserErrors.length) throw new Error(`browser errors: ${browserErrors.join("; ")}`);
    console.log(JSON.stringify({ ok: true, targetUrl: config.targetUrl, staffId: config.staffId, results }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
