#!/usr/bin/env node

const DEFAULT_URL = "https://shuati.bar";
const DEFAULT_STAFF_ID = "704001";
const DEFAULT_CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STORAGE_KEY = "customer-manager-quiz-state-v1";

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
  const navButtons = await page.evaluate(() => [...document.querySelectorAll(".dock-nav-row > button")].map((button) => {
    const rect = button.getBoundingClientRect();
    return {
      text: button.innerText.trim() || button.getAttribute("aria-label") || "",
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
  }));
  if (navButtons.length !== 6) {
    throw new Error(`${label}: expected six dock navigation buttons: ${JSON.stringify(navButtons)}`);
  }
  const navLabels = navButtons.map((button) => button.text);
  const expectedNavLabels = ["错题", "收藏", "强化练习", "模拟考试", "练习", "其他"];
  if (JSON.stringify(navLabels) !== JSON.stringify(expectedNavLabels)) {
    throw new Error(`${label}: unexpected dock navigation labels: ${JSON.stringify(navLabels)}`);
  }
  if (new Set(navButtons.map((button) => button.rect.y)).size !== 1) {
    throw new Error(`${label}: dock navigation wrapped to multiple rows: ${JSON.stringify(navButtons)}`);
  }
  return snapshot;
}

async function assertContinuousPracticeOrder(page, label) {
  const before = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const ids = (window.QUIZ_BANK?.questions || []).map((question) => question.id);
    return {
      mode: state.mode,
      currentId: state.currentId,
      index: ids.indexOf(state.currentId),
      total: ids.length,
      selectedTypes: state.selectedTypes || []
    };
  }, STORAGE_KEY);
  if (before.mode !== "practice") throw new Error(`${label}: mode is not practice: ${JSON.stringify(before)}`);
  if (before.total < 3000) throw new Error(`${label}: full bank is not active: ${JSON.stringify(before)}`);
  if (JSON.stringify(before.selectedTypes) !== JSON.stringify(["单选", "多选", "判断"])) {
    throw new Error(`${label}: continuous practice does not include all types: ${JSON.stringify(before)}`);
  }
  await clickIfReady(page, 'button[data-action="next-question"]:not([disabled])', `${label} next question`);
  const after = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const ids = (window.QUIZ_BANK?.questions || []).map((question) => question.id);
    return { currentId: state.currentId, index: ids.indexOf(state.currentId) };
  }, STORAGE_KEY);
  if (after.index !== before.index + 1) {
    throw new Error(`${label}: next question did not follow source-bank order: ${JSON.stringify({ before, after })}`);
  }
  return { before, after };
}

async function assertPracticeTypeTransition(page) {
  const seeded = await page.evaluate((key) => {
    const seen = new Set();
    const idCounts = new Map();
    const bank = (window.QUIZ_BANK?.questions || []).flatMap((question) => {
      const signature = `${question.id}|${(question.options || []).map((option) => `${option.key}:${option.text}`).join(",")}`;
      if (seen.has(signature)) return [];
      seen.add(signature);
      const count = (idCounts.get(question.id) || 0) + 1;
      idCounts.set(question.id, count);
      return [{ ...question, id: count > 1 ? `${question.id}__v${count - 1}` : question.id }];
    });
    const transitionIndex = bank.findIndex((question, index) => index < bank.length - 1 && question.type !== bank[index + 1].type);
    if (transitionIndex < 0) throw new Error("source bank has no adjacent type transition");
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    state.mode = "practice";
    state.lastPracticeMode = "practice";
    state.currentId = bank[transitionIndex].id;
    state.lastPracticeId = bank[transitionIndex].id;
    state.practiceLocations = { ...(state.practiceLocations || {}), practice: bank[transitionIndex].id };
    state.selectedTypes = ["单选", "多选", "判断"];
    state.selectedCategories = window.QUIZ_BANK.categories.map((category) => category.id);
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return {
      beforeId: bank[transitionIndex].id,
      beforeType: bank[transitionIndex].type,
      afterId: bank[transitionIndex + 1].id,
      afterType: bank[transitionIndex + 1].type,
      transitionIndex
    };
  }, STORAGE_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFullBank(page);
  await clickIfReady(page, 'button[data-action="next-question"]:not([disabled])', "cross type boundary");
  const actual = await page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const question = (window.QUIZ_BANK?.questions || []).find((item) => item.id === state.currentId);
    return { id: state.currentId, type: question?.type || "" };
  }, STORAGE_KEY);
  if (actual.id !== seeded.afterId || actual.type !== seeded.afterType) {
    throw new Error(`continuous practice failed at a type boundary: ${JSON.stringify({ seeded, actual })}`);
  }
  return { seeded, actual };
}

async function assertLongQuestionLayout(page) {
  const seeded = await page.evaluate((key) => {
    const bank = window.QUIZ_BANK?.questions || [];
    const score = (question) => String(question.question || "").length
      + (question.options || []).reduce((sum, option) => sum + String(option.text || "").length, 0);
    const question = [...bank].sort((left, right) => score(right) - score(left))[0];
    if (!question) throw new Error("source bank is empty");
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    state.mode = "practice";
    state.lastPracticeMode = "practice";
    state.currentId = question.id;
    state.lastPracticeId = question.id;
    state.practiceLocations = { ...(state.practiceLocations || {}), practice: question.id };
    state.selectedTypes = ["单选", "多选", "判断"];
    state.selectedCategories = window.QUIZ_BANK.categories.map((category) => category.id);
    state.studyMode = false;
    state.revealed = { ...(state.revealed || {}), [question.id]: false };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return { id: question.id, type: question.type, contentLength: score(question) };
  }, STORAGE_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFullBank(page);
  const layout = await page.evaluate(() => {
    const card = document.querySelector(".question-card");
    const dock = document.querySelector(".practice-dock");
    const question = document.querySelector(".question-text");
    const option = document.querySelector(".option-text");
    const nav = [...document.querySelectorAll(".dock-nav-row > button")];
    const cardRect = card?.getBoundingClientRect();
    const dockRect = dock?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      cardBeforeDock: Boolean(cardRect && dockRect && cardRect.bottom <= dockRect.top),
      cardOverflowY: card ? getComputedStyle(card).overflowY : "",
      cardScrollable: Boolean(card && card.scrollHeight > card.clientHeight),
      questionFont: question ? getComputedStyle(question).fontSize : "",
      optionFont: option ? getComputedStyle(option).fontSize : "",
      navRows: new Set(nav.map((button) => Math.round(button.getBoundingClientRect().y))).size,
      navAllVisible: nav.every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
      })
    };
  });
  if (layout.horizontalOverflow) throw new Error(`long question causes horizontal overflow: ${JSON.stringify(layout)}`);
  if (!layout.cardBeforeDock) throw new Error(`long question overlaps the dock: ${JSON.stringify(layout)}`);
  if (layout.cardOverflowY !== "auto") throw new Error(`long question card is not its own scroll owner: ${JSON.stringify(layout)}`);
  if (layout.questionFont !== "16px" || layout.optionFont !== "14px") {
    throw new Error(`long question changed typography: ${JSON.stringify(layout)}`);
  }
  if (layout.navRows !== 1 || !layout.navAllVisible) throw new Error(`long question broke dock layout: ${JSON.stringify(layout)}`);
  return { seeded, layout };
}

async function assertWrappedOptionsStayContained(page) {
  const seeded = await page.evaluate((key) => {
    const bank = window.QUIZ_BANK?.questions || [];
    const question = bank.find((item) => item.id === "09257ed3e6b5")
      || bank.find((item) => item.type === "多选" && (item.options || []).some((option) => String(option.text || "").length > 45));
    if (!question) throw new Error("wrapped-option regression question is missing");
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    state.mode = "multiple";
    state.lastPracticeMode = "multiple";
    state.currentId = question.id;
    state.lastPracticeId = question.id;
    state.practiceLocations = { ...(state.practiceLocations || {}), multiple: question.id };
    state.selectedTypes = ["多选"];
    state.selectedCategories = window.QUIZ_BANK.categories.map((category) => category.id);
    state.drafts = { ...(state.drafts || {}), [question.id]: (question.options || []).map((option) => option.key) };
    state.revealed = { ...(state.revealed || {}), [question.id]: true };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return { id: question.id, optionCount: question.options.length };
  }, STORAGE_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForFullBank(page);
  const layout = await page.evaluate(() => {
    const card = document.querySelector(".question-card");
    if (card) card.scrollTop = card.scrollHeight;
    const buttons = [...document.querySelectorAll(".question-card .option-button")];
    const rows = buttons.map((button, index) => {
      const text = button.querySelector(".option-text");
      const buttonRect = button.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const nextRect = buttons[index + 1]?.getBoundingClientRect();
      return {
        key: button.dataset.key || "",
        textInside: textRect.top >= buttonRect.top - 0.5 && textRect.bottom <= buttonRect.bottom + 0.5,
        noNextOverlap: !nextRect || buttonRect.bottom <= nextRect.top + 0.5,
        buttonHeight: Math.round(buttonRect.height),
        textHeight: Math.round(textRect.height)
      };
    });
    const cardRect = card?.getBoundingClientRect();
    const lastRect = buttons.at(-1)?.getBoundingClientRect();
    return {
      rows,
      lastOptionVisible: Boolean(cardRect && lastRect && lastRect.bottom <= cardRect.bottom + 0.5),
      bottomGap: cardRect && lastRect ? Math.round(cardRect.bottom - lastRect.bottom) : -1
    };
  });
  if (
    layout.rows.length !== seeded.optionCount
    || layout.rows.some((item) => !item.textInside || !item.noNextOverlap)
    || !layout.lastOptionVisible
    || layout.bottomGap < 8
  ) {
    throw new Error(`wrapped option escaped its row: ${JSON.stringify({ seeded, layout })}`);
  }
  return { seeded, layout };
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

async function seedWrongRecord(page) {
  return page.evaluate((key) => {
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const question = (window.QUIZ_BANK?.questions || []).find((item) => item.type === "单选" && (item.options || []).length >= 2);
    if (!question) throw new Error("no single-choice question available for wrong-mode smoke seed");
    const now = new Date().toISOString();
    state.wrong = state.wrong && typeof state.wrong === "object" ? state.wrong : {};
    state.wrong[question.id] = {
      correctStreak: 0,
      wrongCount: 1,
      reviewCount: 0,
      lastCorrect: false,
      lastAt: now,
      active: true
    };
    localStorage.setItem(key, JSON.stringify(state));
    localStorage.setItem(`${key}-backup`, JSON.stringify(state));
    return question.id;
  }, STORAGE_KEY);
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

async function assertScopedPracticeOrdinal(page, label) {
  const result = await page.evaluate(({ scopeLabel, key }) => {
    const questionText = document.querySelector(".question-card .question-text")?.textContent || "";
    const normalizedText = questionText.replace(/(全选|正确)$/u, "").trim();
    const seen = new Set();
    const idCounts = new Map();
    const bank = (window.QUIZ_BANK?.questions || []).flatMap((question) => {
      const signature = `${question.id}|${(question.options || []).map((option) => `${option.key}:${option.text}`).join(",")}`;
      if (seen.has(signature)) return [];
      seen.add(signature);
      const count = (idCounts.get(question.id) || 0) + 1;
      idCounts.set(question.id, count);
      return [{ ...question, id: count > 1 ? `${question.id}__v${count - 1}` : question.id }];
    });
    const categories = window.QUIZ_BANK?.categories || [];
    const categoryOrder = new Map(categories.map((category, index) => [category.id, index]));
    const sourceOrder = new Map(bank.map((question, index) => [question.id, index]));
    const state = JSON.parse(localStorage.getItem(key) || "{}");
    const selectedCategories = new Set(state.selectedCategories || categories.map((category) => category.id));
    const selectedTypes = new Set(state.selectedTypes || ["单选", "多选", "判断"]);
    const scoped = bank
      .filter((question) => selectedCategories.has(question.category) && selectedTypes.has(question.type))
      .sort((left, right) => {
        const categoryDelta = (categoryOrder.get(left.category) ?? Number.MAX_SAFE_INTEGER)
          - (categoryOrder.get(right.category) ?? Number.MAX_SAFE_INTEGER);
        return categoryDelta || (sourceOrder.get(left.id) || 0) - (sourceOrder.get(right.id) || 0);
      });
    const scopedIndex = scoped.findIndex((question) => String(question.question || "").trim() === normalizedText);
    return {
      label: scopeLabel,
      visible: document.querySelector(".question-index")?.textContent?.trim() || "",
      expected: scopedIndex >= 0 ? `${scopedIndex + 1}/${scoped.length}` : "",
      scopedIndex,
      scopedTotal: scoped.length,
      mode: state.mode
    };
  }, { scopeLabel: label, key: STORAGE_KEY });
  if (result.scopedIndex < 0 || result.visible !== result.expected) {
    throw new Error(`${label}: incorrect scoped question ordinal: ${JSON.stringify(result)}`);
  }
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
  const apiWrites = await installStateApiMock(context);
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
    const seededWrongId = await seedWrongRecord(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFullBank(page);
    results.push({ step: "login", dock: await assertDockHealthy(page, "login") });
    await clickIfReady(page, 'button[data-mode="practice"]', "open continuous practice");
    results.push({
      step: "practice-order",
      order: await visibleOptionsMatchBank(page, "practice"),
      ordinal: await assertScopedPracticeOrdinal(page, "practice"),
      sequence: await assertContinuousPracticeOrder(page, "practice")
    });
    results.push({ step: "practice-type-transition", transition: await assertPracticeTypeTransition(page) });
    results.push({ step: "long-question-layout", audit: await assertLongQuestionLayout(page), dock: await assertDockHealthy(page, "long-question-layout") });
    results.push({ step: "wrapped-options-contained", audit: await assertWrappedOptionsStayContained(page), dock: await assertDockHealthy(page, "wrapped-options-contained") });

    await clickIfReady(page, 'button[data-action="toggle-favorite"]', "favorite wrapped-option question");
    await clickIfReady(page, 'button[data-mode="favorite"]', "open favorites mode");
    const favoriteEntry = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        mode: saved.mode,
        currentId: saved.currentId,
        favorite: Boolean(saved.favorites?.[saved.currentId]),
        activeLabel: document.querySelector(".dock-nav-row > .active")?.textContent?.trim() || "",
        optionCount: document.querySelectorAll(".question-card .option-button").length
      };
    }, STORAGE_KEY);
    if (favoriteEntry.mode !== "favorite" || !favoriteEntry.favorite || favoriteEntry.activeLabel !== "收藏" || favoriteEntry.optionCount < 2) {
      throw new Error(`favorites entry is not usable: ${JSON.stringify(favoriteEntry)}`);
    }
    results.push({ step: "favorites-entry", favoriteEntry, dock: await assertDockHealthy(page, "favorites-entry") });

    await clickIfReady(page, 'button[data-mode="single"]', "open single mode");
    results.push({
      step: "single-order",
      order: await visibleOptionsMatchBank(page, "single"),
      ordinal: await assertScopedPracticeOrdinal(page, "single")
    });

    const select = page.locator('select[data-action="category-select"]').first();
    if (await select.count()) {
      await select.selectOption("__all__");
      await page.waitForTimeout(700);
      const optionCount = await page.locator(".question-card .option-button").count();
      if (optionCount < 2) throw new Error("category all left the question card without options");
      results.push({ step: "category-all", optionCount, dock: await assertDockHealthy(page, "category-all") });
    }

    if (!(await findUnrevealedMultiple(page))) throw new Error("could not find an unrevealed multiple-choice question");
    results.push({
      step: "multiple-order",
      order: await visibleOptionsMatchBank(page, "multiple"),
      ordinal: await assertScopedPracticeOrdinal(page, "multiple")
    });
    const revealButton = page.locator('button[data-action="reveal-answer"]').first();
    if (!(await revealButton.count()) || await revealButton.isDisabled()) {
      throw new Error("practice answer button is not available for multiple-choice questions");
    }
    await revealButton.click();
    await page.waitForTimeout(350);
    if (!(await page.locator(".answer-panel:not(.answer-placeholder)").count())) {
      throw new Error("practice answer button did not reveal the answer");
    }
    results.push({ step: "practice-answer-button", multipleRevealWorks: true });
    await clickIfReady(page, 'button[data-action="next-question"]:not([disabled])', "next after answer reveal");
    if (!(await findUnrevealedMultiple(page))) throw new Error("could not find another unrevealed multiple-choice question");
    await clickIfReady(page, ".question-card .option-button:nth-of-type(1)", "select first multiple option");
    await clickIfReady(page, ".question-card .option-button:nth-of-type(2)", "select second multiple option", false);
    const revealedAfterSelect = await page.locator(".answer-panel:not(.answer-placeholder)").count();
    const submitEnabled = await page.locator('button[data-action="submit-practice"]:not([disabled])').count();
    if (revealedAfterSelect) throw new Error("multiple choice revealed answer before submit");
    if (!submitEnabled) throw new Error("multiple choice submit did not enable after selecting options");
    results.push({ step: "multiple-no-auto-reveal", submitEnabled });

    const practiceBeforeSuite = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        mode: saved.mode,
        currentId: saved.currentId,
        visibleIndex: document.querySelector(".question-index")?.textContent?.trim() || ""
      };
    }, STORAGE_KEY);

    await clickIfReady(page, 'button[data-mode="suite"]', "open suite mode");
    results.push({ step: "suite-home", dock: await assertDockHealthy(page, "suite-home") });
    await clickIfReady(
      page,
      'button[data-action="retry-suite-full"]:not([disabled]), button[data-action="start-suite-paper"]:not([disabled])',
      "enter suite run"
    );
    results.push({ step: "suite-order", order: await visibleOptionsMatchBank(page, "suite") });
    await clickIfReady(page, '.question-card .option-button:nth-of-type(1)', "answer one suite question before switching modes");
    await clickIfReady(page, 'button[data-action="next-suite"]:not([disabled])', "suite next question");
    results.push({ step: "suite-next", dock: await assertDockHealthy(page, "suite-next") });

    const suiteBeforeSwitch = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        runId: saved.suite?.runId || "",
        paperId: saved.suite?.paperId || "",
        index: saved.suite?.index ?? -1,
        answerCount: Object.keys(saved.suite?.answers || {}).length,
        outcomeCount: Object.keys(saved.suite?.outcomes || {}).length
      };
    }, STORAGE_KEY);
    await clickIfReady(page, 'button[data-mode="practice"]', "leave active suite for practice");
    const practiceAfterSuite = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        mode: saved.mode,
        currentId: saved.currentId,
        visibleIndex: document.querySelector(".question-index")?.textContent?.trim() || "",
        optionCount: document.querySelectorAll(".question-card .option-button").length
      };
    }, STORAGE_KEY);
    if (
      practiceAfterSuite.mode !== practiceBeforeSuite.mode
      || practiceAfterSuite.currentId !== practiceBeforeSuite.currentId
      || practiceAfterSuite.visibleIndex !== practiceBeforeSuite.visibleIndex
      || practiceAfterSuite.optionCount < 2
    ) {
      throw new Error(`practice location was not resumed after suite switch: ${JSON.stringify({ practiceBeforeSuite, practiceAfterSuite })}`);
    }
    results.push({ step: "practice-resume-after-suite", practiceBeforeSuite, practiceAfterSuite });
    await clickIfReady(page, 'button[data-mode="suite"]', "resume active suite");
    const suiteAfterReturn = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        runId: saved.suite?.runId || "",
        paperId: saved.suite?.paperId || "",
        index: saved.suite?.index ?? -1,
        answerCount: Object.keys(saved.suite?.answers || {}).length,
        outcomeCount: Object.keys(saved.suite?.outcomes || {}).length,
        hasQuestion: Boolean(document.querySelector(".question-card .option-button"))
      };
    }, STORAGE_KEY);
    if (
      !suiteBeforeSwitch.runId
      || suiteBeforeSwitch.runId !== suiteAfterReturn.runId
      || suiteBeforeSwitch.paperId !== suiteAfterReturn.paperId
      || suiteBeforeSwitch.index !== suiteAfterReturn.index
      || suiteBeforeSwitch.answerCount !== suiteAfterReturn.answerCount
      || suiteBeforeSwitch.outcomeCount !== suiteAfterReturn.outcomeCount
      || !suiteAfterReturn.hasQuestion
    ) {
      throw new Error(`suite progress was not resumed after mode switch: ${JSON.stringify({ suiteBeforeSwitch, suiteAfterReturn })}`);
    }
    results.push({ step: "suite-resume-after-mode-switch", suiteBeforeSwitch, suiteAfterReturn });

    await clickIfReady(page, 'button[data-mode="wrong"]', "open wrong mode");
    const wrongOptionCount = await page.locator(".question-card .option-button").count();
    if (wrongOptionCount < 2) throw new Error("wrong mode after suite is not a normal question view");
    const wrongReviewVisible = await page.locator(".answer-panel:not(.answer-placeholder)").count();
    const wrongReviewEnabledOptions = await page.locator(".question-card .option-button:not([disabled])").count();
    if (!wrongReviewVisible || wrongReviewEnabledOptions) {
      throw new Error(`wrong review is not read-only with answer visible: ${JSON.stringify({ wrongReviewVisible, wrongReviewEnabledOptions })}`);
    }
    results.push({ step: "wrong-after-suite", seededWrongId, wrongOptionCount, wrongReviewVisible, dock: await assertDockHealthy(page, "wrong-after-suite") });

    await clickIfReady(page, 'button[data-action="set-wrong-view"][data-view="practice"]:not([disabled])', "start wrong practice");
    const wrongPractice = await page.evaluate((key) => {
      const saved = JSON.parse(localStorage.getItem(key) || "{}");
      return {
        active: Boolean(saved.wrongPractice),
        answerHidden: Boolean(document.querySelector(".answer-panel.answer-placeholder")),
        enabledOptions: document.querySelectorAll(".question-card .option-button:not([disabled])").length,
        activeButton: Boolean(document.querySelector('button[data-action="set-wrong-view"][data-view="practice"].active'))
      };
    }, STORAGE_KEY);
    if (!wrongPractice.active || !wrongPractice.answerHidden || !wrongPractice.enabledOptions || !wrongPractice.activeButton) {
      throw new Error(`wrong practice did not become answerable: ${JSON.stringify(wrongPractice)}`);
    }
    results.push({ step: "wrong-practice", wrongPractice });

    await clickIfReady(page, 'button[data-mode="exam300"]', "open mock exam");
    results.push({ step: "exam-home", dock: await assertDockHealthy(page, "exam-home") });

    await clickIfReady(page, 'button[data-mode="practice"]', "return to continuous practice from exam home");
    const restoredOptionCount = await page.locator(".question-card .option-button").count();
    if (restoredOptionCount < 2) throw new Error("returning from exam home did not restore the practice question card");
    results.push({
      step: "practice-after-exam",
      restoredOptionCount,
      order: await visibleOptionsMatchBank(page, "practice-after-exam"),
      dock: await assertDockHealthy(page, "practice-after-exam")
    });

    await clickIfReady(page, 'button[data-mode="exam300"]', "reopen mock exam");
    await clickIfReady(page, 'button[data-action="start-exam300"]:not([disabled])', "open exam start menu");
    if (!(await page.locator(".exam-start-sheet").count())) throw new Error("exam start menu did not open");
    await clickIfReady(page, 'button[data-action="start-exam-kind"][data-kind="random"]:not([disabled])', "start comprehensive mock exam");
    await page.waitForTimeout(700);
    results.push({ step: "exam-order", order: await visibleOptionsMatchBank(page, "exam") });

    if (browserErrors.length) {
      throw new Error(`browser errors: ${browserErrors.join("; ")}`);
    }
    console.log(JSON.stringify({ ok: true, targetUrl: config.targetUrl, staffId: config.staffId, interceptedWrites: apiWrites.length, results }, null, 2));
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
