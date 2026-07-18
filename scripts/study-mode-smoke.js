#!/usr/bin/env node

const TARGET_URL = process.env.TARGET_URL || "https://shuati.bar";
const STAFF_ID = process.env.STAFF_ID || "704001";

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
  const apiHandler = async (route, request) => {
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
  };
  await context.route("**/api/state/**", apiHandler);
  await context.route("**/api/session/**", apiHandler);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`${TARGET_URL}/?studyModeSmoke=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });
    if (await page.locator("#staff-id").count()) {
      await page.locator("#staff-id").fill(STAFF_ID);
      await page.locator('form[data-action="verify-staff"] button[type="submit"]').click();
    }
    await page.waitForFunction(() => window.QUIZ_BANK?.questions?.length > 3000, null, { timeout: 20000 });
    await page.locator('[data-action="set-mode"][data-mode="practice"]').click();

    const button = page.locator('[data-action="toggle-study-mode"]');
    await button.waitFor({ state: "visible", timeout: 10000 });
    if ((await button.getAttribute("aria-pressed")) === "true") await button.click();

    const off = await button.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundImage, color: style.color, border: style.borderColor };
    });
    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-action="toggle-study-mode"]')?.getAttribute("aria-pressed") === "true");

    const activeButton = page.locator('[data-action="toggle-study-mode"]');
    const on = await activeButton.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        active: element.classList.contains("active"),
        pressed: element.getAttribute("aria-pressed"),
        matchesActiveSelector: element.matches('.memorize-button[aria-pressed="true"]'),
        background: style.backgroundImage,
        color: style.color,
        border: style.borderColor
      };
    });

    if (!on.active || on.pressed !== "true") throw new Error(`${name}: study mode did not become active`);
    if (on.background === off.background && on.color === off.color && on.border === off.border) {
      throw new Error(`${name}: active study mode is visually identical to inactive mode: ${JSON.stringify({ off, on })}`);
    }
    if (!on.background.includes("gradient")) throw new Error(`${name}: active study mode gradient is missing`);
    if (errors.length) throw new Error(`${name}: ${errors.join("; ")}`);
    await page.screenshot({ path: `/tmp/shuati-study-mode-${name}.png`, fullPage: false });
    return { name, off, on };
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
