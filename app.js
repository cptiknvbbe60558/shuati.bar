(function () {
  const app = document.getElementById("app");
  if (!window.QUIZ_BANK || !Array.isArray(window.QUIZ_BANK.questions) || !window.QUIZ_BANK.questions.length) {
    app.innerHTML = `
      <section class="empty-state">
        <div>
          <h2>题库没有加载</h2>
          <p>请刷新页面；如果还是这样，说明网络没有把题库文件下载完整。</p>
        </div>
      </section>
    `;
    return;
  }

  let bank = window.QUIZ_BANK;

  const STORAGE_KEY = "customer-manager-quiz-state-v1";
  const TYPES = ["单选", "多选", "判断"];
  const TYPE_MODE_MAP = {
    single: "单选",
    multiple: "多选",
    judge: "判断"
  };
  const MODE_BY_TYPE = {
    "单选": "single",
    "多选": "multiple",
    "判断": "judge"
  };
  const MODES = [
    ["single", "单选"],
    ["multiple", "多选"],
    ["judge", "判断"],
    ["wrong", "错题"],
    ["favorite", "收藏"],
    ["judgeCorrect", "判断正确"],
    ["allSelect", "全选"],
    ["exam300", "模拟考试"]
  ];
  const HEADER_TYPE_MODES = MODES.filter(([mode]) => TYPE_MODE_MAP[mode]);
  const DOCK_MODES = MODES.filter(([mode]) => !TYPE_MODE_MAP[mode]);
  const VALID_MODES = [...MODES, ["search", "搜题"]];
  const PRACTICE_MODES = ["single", "multiple", "judge"];
  const EXAM_KIND_LABELS = {
    random: "模拟随机",
    single: "模拟单选",
    multiple: "模拟多选",
    judge: "模拟判断"
  };
  const EXAM_DURATION_MS = 60 * 60 * 1000;
  const SPECIAL_REVIEW_MODES = ["judgeCorrect", "allSelect"];
  const FULL_TYPE_COUNTS = {
    single: 1204,
    multiple: 965,
    judge: 974
  };
  const FULL_JUDGE_CORRECT_COUNT = 562;
  const FULL_ALL_SELECT_COUNT = 402;
  const ASSET_VERSION = "20260630_0045_shuati_domain";
  const REMOTE_SYNC_ENABLED = !["shuati.bar", "www.shuati.bar"].includes(window.location.hostname);

  let questions = bank.questions || [];
  let categories = bank.categories || [];
  let questionById = new Map(questions.map((question) => [question.id, question]));
  let categoryIds = new Set(categories.map((category) => category.id));
  let installPrompt = null;
  let verifyError = "";
  let fullBankLoadStarted = false;
  let fullBankLoadStartedAt = 0;
  let fullBankRetryTimer = null;
  let remoteSyncTimer = null;
  let remoteSyncReady = false;
  let remoteSyncStaffId = "";
  let examTimer = null;
  if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
  }

  const defaultState = {
    staffId: "",
    mode: "single",
    selectedCategories: categories.map((category) => category.id),
    selectedTypes: TYPES,
    query: "",
    currentId: questions[0] ? questions[0].id : "",
    drafts: {},
    revealed: {},
    progress: {},
    wrong: {},
    favorites: {},
    notes: {},
    examExposure: {},
    optionOrders: {},
    utilityPanel: "",
    categoryMenuOpen: false,
    examStartMenuOpen: false,
    studyMode: false,
    specialIndexes: {},
    examSize: 50,
    lastPracticeMode: "single",
    lastPracticeId: questions[0] ? questions[0].id : "",
    exam: null
  };

  let state = loadState();
  sanitizeState();
  if (isVerifiedStaffId(state.staffId)) {
    restorePracticeLocation();
    sanitizeState();
  }

  app.addEventListener("click", onClick);
  app.addEventListener("input", onInput);
  app.addEventListener("change", onChange);
  app.addEventListener("submit", onSubmit);
  document.addEventListener(
    "dblclick",
    (event) => {
      if (document.body.classList.contains("practice-fit")) event.preventDefault();
    },
    { passive: false }
  );

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    render();
  });

  setupBottomBarSizing();
  setupAutoHideTopbar();
  render();
  if (isVerifiedStaffId(state.staffId)) {
    loadFullQuestionBank();
    initializeRemoteState();
  }
  registerServiceWorker();

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      return {
        ...defaultState,
        ...saved,
        drafts: { ...defaultState.drafts, ...(saved.drafts || {}) },
        revealed: { ...defaultState.revealed, ...(saved.revealed || {}) },
        progress: { ...defaultState.progress, ...(saved.progress || {}) },
        wrong: { ...defaultState.wrong, ...(saved.wrong || {}) },
        favorites: { ...defaultState.favorites, ...(saved.favorites || {}) },
        notes: { ...defaultState.notes, ...(saved.notes || {}) },
        examExposure: { ...defaultState.examExposure, ...(saved.examExposure || {}) },
        optionOrders: { ...defaultState.optionOrders, ...(saved.optionOrders || {}) },
        specialIndexes: { ...defaultState.specialIndexes, ...(saved.specialIndexes || {}) },
        utilityPanel: defaultState.utilityPanel,
        categoryMenuOpen: false,
        examStartMenuOpen: false,
        studyMode: Boolean(saved.studyMode),
        lastPracticeMode: saved.lastPracticeMode || defaultState.lastPracticeMode,
        lastPracticeId: saved.lastPracticeId || defaultState.lastPracticeId
      };
    } catch {
      return { ...defaultState };
    }
  }

  function saveState() {
    rememberPracticeLocation();
    const snapshot = {
      ...state,
      utilityPanel: "",
      categoryMenuOpen: false,
      examStartMenuOpen: false
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    if (REMOTE_SYNC_ENABLED && remoteSyncReady && remoteSyncStaffId === state.staffId) {
      scheduleRemoteStateSave();
    }
  }

  async function initializeRemoteState() {
    if (!REMOTE_SYNC_ENABLED) return;
    if (!isVerifiedStaffId(state.staffId)) return;
    const staffId = state.staffId;
    remoteSyncReady = false;
    remoteSyncStaffId = staffId;
    try {
      const response = await fetch(`/api/progress?staffId=${encodeURIComponent(staffId)}`, {
        cache: "no-store"
      });
      if (response.ok) {
        const payload = await response.json();
        if (state.staffId !== staffId) return;
        mergeRemoteState(payload);
        sanitizeState();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        render();
      }
    } catch {
      // Local progress remains authoritative when the computer is unreachable.
    } finally {
      if (state.staffId === staffId) {
        remoteSyncReady = true;
        scheduleRemoteStateSave();
      }
    }
  }

  function mergeRemoteState(payload = {}) {
    state.progress = mergeProgressRecords(state.progress, payload.progress || {});
    state.wrong = mergeWrongRecords(state.wrong, payload.wrong || {});
    state.favorites = { ...(payload.favorites || {}), ...state.favorites };
    state.notes = { ...(payload.notes || {}), ...state.notes };
    state.examExposure = mergeMaxNumberMap(state.examExposure, payload.examExposure || {});
  }

  function scheduleRemoteStateSave() {
    if (!remoteSyncReady || !isVerifiedStaffId(state.staffId)) return;
    if (remoteSyncTimer) clearTimeout(remoteSyncTimer);
    remoteSyncTimer = setTimeout(saveRemoteState, 450);
  }

  async function saveRemoteState() {
    remoteSyncTimer = null;
    const staffId = state.staffId;
    if (!remoteSyncReady || !isVerifiedStaffId(staffId) || remoteSyncStaffId !== staffId) return;
    const payload = {
      version: 1,
      staffId,
      updatedAt: new Date().toISOString(),
      progress: state.progress,
      wrong: state.wrong,
      favorites: state.favorites,
      notes: state.notes,
      examExposure: state.examExposure
    };
    try {
      await fetch(`/api/progress?staffId=${encodeURIComponent(staffId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true
      });
    } catch {
      // The next local change retries the backup automatically.
    }
  }

  function sanitizeState() {
    if (!isVerifiedStaffId(state.staffId)) state.staffId = "";
    state.selectedCategories = (state.selectedCategories || []).filter((id) =>
      categoryIds.has(id)
    );
    if (!state.selectedCategories.length && categories.length) {
      state.selectedCategories = categories.map((category) => category.id);
    }
    state.selectedTypes = (state.selectedTypes || []).filter((type) => TYPES.includes(type));
    if (!state.selectedTypes.length) state.selectedTypes = [...TYPES];
    if (state.mode === "practice") state.mode = "single";
    if (state.mode === "exam") state.mode = "exam300";
    if (state.mode === "memory") state.mode = "single";
    if (!VALID_MODES.some(([mode]) => mode === state.mode)) state.mode = "single";
    if (!["", "note", "stats", "filter", "progress", "bank"].includes(state.utilityPanel)) {
      state.utilityPanel = "";
    }
    state.categoryMenuOpen = Boolean(state.categoryMenuOpen);
    state.examStartMenuOpen = Boolean(state.examStartMenuOpen);
    state.studyMode = Boolean(state.studyMode);
    if (!PRACTICE_MODES.includes(state.lastPracticeMode)) state.lastPracticeMode = "single";
    syncSelectedTypesForMode();
    if (!questionById.has(state.currentId) && questions[0] && !bank.isStarter) {
      state.currentId = questions[0].id;
    }
    state.examSize = clamp(Number(state.examSize) || 50, 1, Math.max(1, questions.length));
    state.specialIndexes = state.specialIndexes && typeof state.specialIndexes === "object"
      ? state.specialIndexes
      : {};
    pruneWrongRecords();
  }

  function render() {
    if (!isVerifiedStaffId(state.staffId)) {
      document.body.classList.remove("practice-fit", "utility-open");
      app.innerHTML = renderStaffVerification();
      scheduleExamTimer();
      return;
    }

    const base = getBaseFilteredQuestions();
    const modeQuestions = getModeQuestions(state.mode, base);
    if (!["exam300", "search"].includes(state.mode)) {
      ensureCurrent(modeQuestions);
    }

    const compact = !["exam300", "search"].includes(state.mode);
    document.body.classList.toggle("practice-fit", compact);
    document.body.classList.toggle("utility-open", Boolean(state.utilityPanel));

    app.innerHTML = `
      <main class="layout ${compact ? "practice-layout" : ""}">
        <section class="workspace ${compact ? "practice-workspace" : ""}">
          ${renderModeContent(base, modeQuestions)}
        </section>
      </main>
      ${renderUtilitySheet(base)}
      ${renderCategoryMenuOverlay()}
      ${renderExamStartMenuOverlay(base)}
    `;
    scheduleExamTimer();
  }

  function renderBankTools() {
    return `
      <section class="panel bank-panel">
        <div class="brand">
          <div class="brand-mark">题</div>
          <div>
            <h1>${escapeHtml(bank.title || "客户经理刷题")}</h1>
            <p>${bankSubtitle()}</p>
          </div>
        </div>
        <div class="top-actions">
          ${installPrompt ? '<button class="solid-button" data-action="install">安装</button>' : ""}
          <button class="soft-button ${state.mode === "search" ? "active" : ""}" data-action="set-mode" data-mode="search">搜题</button>
          <button class="soft-button" data-action="export-progress">导出进度</button>
          <button class="soft-button" data-action="import-progress">导入进度</button>
          <button class="danger-button" data-action="reset-progress">清空记录</button>
        </div>
      </section>
    `;
  }

  function renderUtilitySheet(baseQuestions) {
    const current = questionById.get(state.currentId);
    const panels = [
      ["note", "笔记"],
      ["stats", "面板"],
      ["filter", "筛选"],
      ["progress", "进度"],
      ["bank", "题库"]
    ];
    const panel = state.utilityPanel || "note";
    return `
      <button class="glass-menu-button" data-action="toggle-utility-panel" aria-label="更多">
        <span></span><span></span><span></span>
      </button>
      ${state.utilityPanel ? `
        <div class="utility-backdrop" data-action="close-utility-panel"></div>
        <section class="utility-sheet" role="dialog" aria-label="更多功能">
          <div class="utility-grabber"></div>
          <nav class="utility-nav" aria-label="更多功能">
            ${panels.map(([id, label]) => `
              <button class="chip ${panel === id ? "active" : ""}" data-action="set-utility-panel" data-panel="${id}">
                ${label}
              </button>
            `).join("")}
          </nav>
          <div class="utility-body">
            ${renderUtilityPanelContent(panel, baseQuestions, current)}
          </div>
        </section>
      ` : ""}
      <input class="file-input" id="import-file" type="file" accept="application/json" />
    `;
  }

  function renderUtilityPanelContent(panel, baseQuestions, current) {
    if (panel === "note") return renderNotePanel(current);
    if (panel === "stats") return renderStats();
    if (panel === "filter") return renderFilters(baseQuestions);
    if (panel === "progress") return renderCategoryProgress();
    return renderBankTools();
  }

  function renderNotePanel(question) {
    if (!question) return renderEmpty("暂无当前题目", "回到刷题页后可以记录这道题的易错点。");
    return `
      <section class="panel">
        <div class="section-title">
          <h3>笔记</h3>
          <span>${state.notes[question.id] ? "已保存" : "空"}</span>
        </div>
        <textarea class="note-box" data-action="note" data-id="${question.id}" placeholder="这道题的易错点">${escapeHtml(state.notes[question.id] || "")}</textarea>
      </section>
    `;
  }

  function renderStaffVerification() {
    return `
      <main class="verify-shell">
        <section class="verify-card">
          <div class="brand verify-brand">
            <div class="brand-mark">题</div>
            <div>
              <h1>${escapeHtml(bank.title || "客户经理刷题")}</h1>
              <p>首次访问请输入工号</p>
            </div>
          </div>
          <form class="verify-form" data-action="verify-staff">
            <label for="staff-id">工号</label>
            <input
              id="staff-id"
              class="search-input verify-input"
              data-action="staff-id"
              inputmode="numeric"
              autocomplete="off"
              maxlength="6"
              placeholder=""
              autofocus
            />
            <button class="solid-button verify-submit" type="submit">进入刷题</button>
            <p class="verify-error" aria-live="polite">${verifyError ? escapeHtml(verifyError) : ""}</p>
          </form>
        </section>
      </main>
    `;
  }

  function renderModeTabs(extraClass = "", compact = false, modes = MODES) {
    return `
      <nav class="mode-tabs ${extraClass}" aria-label="刷题模式">
        ${modes.map(([mode, label]) => {
          const count = modeCount(mode);
          return `
            <button class="tab-button ${state.mode === mode ? "active" : ""}" data-action="set-mode" data-mode="${mode}">
              ${label}${!compact && count ? ` ${count}` : ""}
            </button>
          `;
        }).join("")}
      </nav>
    `;
  }

  function renderHeaderTypeTabs(questionType) {
    const activeMode = MODE_BY_TYPE[questionType] || state.mode;
    return `
      <nav class="header-type-tabs" aria-label="题型切换">
        ${HEADER_TYPE_MODES.map(([mode, label]) => `
          <button
            class="header-type-tab ${activeMode === mode ? "active" : ""}"
            data-action="set-mode"
            data-mode="${mode}"
            type="button"
          >${label}</button>
        `).join("")}
      </nav>
    `;
  }

  function renderHeaderCategorySelect(question) {
    const allSelected = state.selectedCategories.length === categories.length;
    const selectedId = state.selectedCategories.length === 1 ? state.selectedCategories[0] : "";
    const mixed = !allSelected && !selectedId;
    return `
      <select class="category-select" data-action="category-select" aria-label="选择题库分类">
        ${mixed ? '<option value="__mixed__" selected disabled hidden>部分分类</option>' : ""}
        <option value="__all__" ${allSelected ? "selected" : ""}>全部分类</option>
        ${categories.map((category) => `
          <option value="${escapeAttr(category.id)}" ${selectedId === category.id ? "selected" : ""}>
            ${escapeHtml(category.name)}
          </option>
        `).join("")}
      </select>
    `;
  }

  function renderCategoryMenuOverlay() {
    return "";
  }

  function bankSubtitle() {
    const total = bank.totalQuestions || questions.length;
    const loading = bank.isStarter ? " · 完整题库加载中" : "";
    return `${questions.length}/${total} 题 · ${categories.length} 类 · 本机记录${loading}`;
  }

  function renderModeContent(baseQuestions, modeQuestions) {
    if (bank.isStarter) return renderFullBankLoading(state.mode);
    if (state.mode === "exam300") return `${renderExam300()}${renderModeTabs()}`;
    if (state.mode === "search") return `${renderSearch(baseQuestions)}${renderModeTabs()}`;
    return renderPractice(modeQuestions);
  }

  function renderFullBankLoading(mode) {
    loadFullQuestionBank({ forceStale: true });
    const details = {
      single: `完整题库加载后进入单选 ${FULL_TYPE_COUNTS.single} 题。`,
      multiple: `完整题库加载后进入多选 ${FULL_TYPE_COUNTS.multiple} 题。`,
      judge: `完整题库加载后进入判断 ${FULL_TYPE_COUNTS.judge} 题。`,
      judgeCorrect: `这个模块只放判断答案为正确 ${FULL_JUDGE_CORRECT_COUNT} 题。`,
      allSelect: `这个模块只放多选全选 ${FULL_ALL_SELECT_COUNT} 题。`,
      exam300: "完整题库加载后再开始模拟考试。",
      wrong: "完整题库加载后再查看错题。",
      favorite: "完整题库加载后再查看收藏。",
      search: "完整题库加载后再搜题。"
    };
    return `
      <section class="practice-screen">
        <div class="practice-study-area empty-practice-area">
          ${renderEmpty("完整题库加载中", details[mode] || "完整题库加载后自动进入刷题。")}
        </div>
        ${renderPracticeDock({ revealed: true, canSubmit: false, disabledNavigation: true })}
      </section>
    `;
  }

  function renderStats() {
    const progressItems = Object.values(state.progress);
    const attempts = progressItems.reduce((sum, item) => sum + (item.attempts || 0), 0);
    const correctAttempts = progressItems.reduce((sum, item) => sum + (item.correct || 0), 0);
    const answered = attempts;
    const accuracy = attempts ? Math.round((correctAttempts / attempts) * 100) : 0;
    const wrongCount = activeWrongIds().length;
    const favoriteCount = Object.keys(state.favorites).filter((id) => questionById.has(id)).length;

    return `
      <section class="panel">
        <div class="section-title">
          <h2>今日面板</h2>
          <span>${formatDate(new Date())}</span>
        </div>
        <div class="stat-grid">
          <div class="stat"><strong>${answered}</strong><span>已刷题</span></div>
          <div class="stat"><strong>${accuracy}%</strong><span>正确率</span></div>
          <div class="stat"><strong>${wrongCount}</strong><span>错题</span></div>
          <div class="stat"><strong>${favoriteCount}</strong><span>收藏</span></div>
        </div>
      </section>
    `;
  }

  function renderFilters(baseQuestions) {
    const selectedAll = state.selectedCategories.length === categories.length;
    return `
      <section class="panel">
        <div class="section-title">
          <h2>筛选</h2>
          <span>${baseQuestions.length} 题</span>
        </div>
        <div class="field">
          <label for="query">关键词</label>
          <input id="query" class="search-input" data-action="query" value="${escapeAttr(state.query)}" placeholder="题干、选项、依据" />
        </div>
        <div class="field">
          <label>题型</label>
          <div class="chip-list">
            ${TYPES.map((type) => `
              <button class="chip ${state.selectedTypes.includes(type) ? "active" : ""}" data-action="toggle-type" data-type="${type}">
                ${type}
              </button>
            `).join("")}
          </div>
        </div>
        <div class="field">
          <label>分类</label>
          <div class="chip-list">
            <button class="chip ${selectedAll ? "active" : ""}" data-action="select-all-categories">全部</button>
            ${categories.map((category) => `
              <button class="chip ${state.selectedCategories.includes(category.id) ? "active" : ""}" data-action="toggle-category" data-id="${category.id}">
                ${escapeHtml(category.name)}
              </button>
            `).join("")}
          </div>
        </div>
      </section>
    `;
  }

  function renderCategoryProgress() {
    return `
      <section class="panel">
        <div class="section-title">
          <h2>分类进度</h2>
          <span>${questions.length} 题</span>
        </div>
        <div class="progress-list">
          ${categories.map((category) => {
            const ids = questions
              .filter((question) => question.category === category.id)
              .map((question) => question.id);
            const answered = ids.filter((id) => state.progress[id]).length;
            const pct = ids.length ? Math.round((answered / ids.length) * 100) : 0;
            return `
              <div class="progress-row">
                <div class="progress-meta">
                  <span>${escapeHtml(category.name)}</span>
                  <span>${answered}/${ids.length}</span>
                </div>
                <div class="progress-bar" style="--value: ${pct}%"><span></span></div>
              </div>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }

  function renderPractice(list) {
    if (!list.length) {
      return `
        <section class="practice-screen">
          <div class="practice-study-area empty-practice-area">
            ${renderEmpty("这里暂时没有题", "换一个分类、题型或关键词，题目就会回来。")}
          </div>
          ${renderPracticeDock({ revealed: true, canSubmit: false, disabledNavigation: true })}
        </section>
      `;
    }

    const specialMode = isSpecialReviewMode();
    const specialIndex = specialMode ? getSpecialReviewIndex(list) : -1;
    const question = specialMode ? list[specialIndex] : (questionById.get(state.currentId) || list[0]);
    const index = specialMode ? specialIndex : Math.max(0, list.findIndex((item) => item.id === question.id));
    const selected = getDraft(question.id);
    const revealed = Boolean(state.revealed[question.id] || state.studyMode);
    const last = state.progress[question.id];

    return `
      <section class="practice-screen">
        <div class="practice-study-area">
          ${renderQuestionCard({
            question,
            index,
            total: list.length,
            selected,
            revealed,
            lastCorrect: last ? last.lastCorrect : null
          })}
        </div>
        ${renderPracticeDock({
          revealed,
          canSubmit: selected.length && !revealed && !state.studyMode,
          allowReveal: question.type !== "多选",
          studyMode: state.studyMode
        })}
      </section>
    `;
  }

  function renderPracticeDock({ revealed, canSubmit, disabledNavigation = false, allowReveal = true, studyMode = false }) {
    return `
      <div class="practice-dock">
        <div class="toolbar practice-toolbar">
          <div class="dock-action-group">
            <button class="soft-button" data-action="reveal-answer" ${revealed || disabledNavigation || !allowReveal ? "disabled" : ""}>答案</button>
            <button class="soft-button memorize-button ${studyMode ? "active" : ""}" data-action="toggle-study-mode" aria-pressed="${studyMode ? "true" : "false"}">背题</button>
            <button class="soft-button" data-action="random-question" ${disabledNavigation ? "disabled" : ""}>随机</button>
            <button class="solid-button" data-action="submit-practice" ${canSubmit ? "" : "disabled"}>提交</button>
          </div>
          <div class="dock-step-group">
            <button class="soft-button nav-icon-button" data-action="previous-question" aria-label="上一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">◀</span></button>
            <button class="soft-button nav-icon-button" data-action="next-question" aria-label="下一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">▶</span></button>
          </div>
        </div>
        <div class="dock-nav-row">
          ${renderModeTabs("dock-tabs dock-secondary-tabs", true, DOCK_MODES)}
          <button class="dock-menu-button" data-action="toggle-utility-panel" aria-label="更多">
            <span></span><span></span><span></span>
          </button>
        </div>
      </div>
    `;
  }

  function renderQuestionCard({ question, index, total, selected, revealed, lastCorrect, typeSwitcher = true }) {
    const presentedOptions = getPresentedOptions(question);
    const answerText = formatPresentedAnswer(question, presentedOptions);
    const selectedAnswer = formatPracticeSelection(question, selected, presentedOptions);
    const selectedCorrect = Boolean(selected.length && isCorrect(question, selected));
    const favorite = Boolean(state.favorites[question.id]);
    const density = questionDensity(question);
    const statusBadge = lastCorrect === null || lastCorrect === undefined
      ? ""
      : `<span class="badge ${lastCorrect ? "green" : "coral"}">${lastCorrect ? "上次正确" : "上次错误"}</span>`;

    return `
      <article class="question-card ${revealed ? "revealed" : ""} ${density}">
        <div class="question-head">
          <div class="badges">
            ${typeSwitcher ? renderHeaderCategorySelect(question) : `<span class="badge blue category-badge">${escapeHtml(question.categoryName)}</span>`}
            ${typeSwitcher ? renderHeaderTypeTabs(question.type) : `<span class="badge green">${escapeHtml(question.type)}</span>`}
            <button class="favorite-star ${favorite ? "active" : ""}" data-action="toggle-favorite" data-id="${escapeAttr(question.id)}" aria-label="${favorite ? "取消收藏" : "收藏"}" aria-pressed="${favorite ? "true" : "false"}">
              <svg class="favorite-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path class="star-fill" d="M12 3.6l2.47 5.01 5.53.8-4 3.9.94 5.5L12 16.21l-4.94 2.6.94-5.5-4-3.9 5.53-.8L12 3.6z"></path>
                <path class="star-line" d="M12 3.6l2.47 5.01 5.53.8-4 3.9.94 5.5L12 16.21l-4.94 2.6.94-5.5-4-3.9 5.53-.8L12 3.6z"></path>
              </svg>
            </button>
            <span class="badge blue actual-category-badge">${escapeHtml(shortCategoryName(question.categoryName))}</span>
            ${statusBadge}
          </div>
          <div class="question-index">${index + 1}/${total}</div>
        </div>
        <h2 class="question-text">${renderQuestionText(question, Boolean(state.studyMode && typeSwitcher))}</h2>
        <div class="options">
          ${presentedOptions.map((option) => {
            const isSelected = selected.includes(option.originalKey);
            const isCorrectOption = question.answer.includes(option.originalKey);
            const displayKey = displayOptionKey(option);
            const keyClass = displayKey.length > 1 ? "option-key wide" : "option-key";
            const classes = [
              "option-button",
              isSelected ? "selected" : "",
              revealed && isCorrectOption ? "correct" : "",
              revealed && isSelected && !isCorrectOption ? "wrong" : ""
            ].filter(Boolean).join(" ");
            return `
              <button class="${classes}" data-action="option" data-key="${escapeAttr(option.originalKey)}" ${revealed ? "disabled" : ""}>
                <span class="${keyClass}">${escapeHtml(displayKey)}</span>
                <span class="option-text">${escapeHtml(option.text)}</span>
              </button>
            `;
          }).join("")}
        </div>
      </article>
      <section class="answer-panel answer-panel-outside ${revealed ? "" : "answer-placeholder"}">
        ${revealed ? `
          <div class="answer-compare" aria-label="答题结果">
            <div class="answer-compare-cell answer-compare-correct">
              <span>正确答案</span>
              <strong>${escapeHtml(answerText)}</strong>
            </div>
            <div class="answer-compare-cell ${selectedCorrect ? "answer-compare-mine-correct" : "answer-compare-mine-wrong"}">
              <span>我的答案</span>
              <strong>${escapeHtml(selectedAnswer)}</strong>
            </div>
          </div>
        ` : ""}
      </section>
    `;
  }

  function questionDensity(question) {
    const questionLength = String(question.question || "").length;
    const optionLength = (question.options || []).reduce((sum, option) => sum + String(option.text || "").length, 0);
    const optionCount = (question.options || []).length;
    if (questionLength > 230 || optionLength > 320 || optionCount > 6) return "density-micro";
    if (questionLength > 145 || optionLength > 210 || optionCount > 5) return "density-ultra";
    if (questionLength > 95 || optionLength > 140 || optionCount > 4) return "density-tight";
    if (questionLength > 62 || optionLength > 92) return "density-medium";
    return "density-relaxed";
  }

  function renderQuestionText(question, showStudyCue) {
    const cue = showStudyCue ? studyCueLabel(question) : "";
    return `${escapeHtml(question.question)}${cue}`;
  }

  function studyCueLabel(question) {
    if (question.type === "多选" && isAllSelectAnswer(question)) {
      return '<span class="study-cue study-cue-all">全选</span>';
    }
    if (question.type === "判断" && isJudgeCorrectAnswer(question)) {
      return '<span class="study-cue study-cue-correct">正确</span>';
    }
    return "";
  }

  function isAllSelectAnswer(question) {
    if (question.type !== "多选") return false;
    const optionKeys = normalizeAnswerKeys((question.options || []).map((option) => option.key));
    const answerKeys = normalizeAnswerKeys(question.answer);
    return optionKeys.length > 1 && answerKeys.length === optionKeys.length && optionKeys.every((key, index) => key === answerKeys[index]);
  }

  function isJudgeCorrectAnswer(question) {
    if (question.type !== "判断") return false;
    const answerKey = question.answer[0];
    const option = (question.options || []).find((item) => item.key === answerKey);
    return option?.text === "正确" || answerKey === "正确" || answerKey === "对";
  }

  function normalizeAnswerKeys(values) {
    return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort(sortByOption);
  }

  function shortCategoryName(value) {
    return String(value || "").replace(/试题$/, "");
  }

  function renderExam300() {
    const exam = state.exam && state.exam.kind === "balanced300" ? state.exam : null;
    if (!exam || !exam.active) {
      const counts = typeCounts(examSourceQuestions());
      const coverage = examCoverageStats();
      const wrongStats = wrongReviewStats();
      const ready =
        counts["单选"] >= 300 ||
        counts["多选"] >= 300 ||
        counts["判断"] >= 300 ||
        TYPES.every((type) => counts[type] >= 100);
      return `
        <section class="exam-header exam-hero">
          <div>
            <h2>模拟考试</h2>
            <p>可选单题型 300 题，或随机 300 题；错题优先穿插，1 小时倒计时。</p>
          </div>
          <div class="toolbar-group">
            <button class="solid-button" data-action="start-exam300" ${ready ? "" : "disabled"}>开始</button>
          </div>
        </section>
        <section class="result-card">
          <div class="stat-grid">
            <div class="stat"><strong>${wrongStats.active}</strong><span>待复练错题</span></div>
            <div class="stat"><strong>${wrongStats.onceCorrect}</strong><span>已连对 1 次</span></div>
            <div class="stat"><strong>${wrongStats.reviewed}</strong><span>已穿插过</span></div>
            <div class="stat"><strong>300</strong><span>本次题量</span></div>
          </div>
        </section>
        <section class="panel coverage-panel">
          <div class="section-title">
            <h3>模拟覆盖</h3>
            <span>${coverage.total.seen}/${coverage.total.count}</span>
          </div>
          <div class="stat-grid">
            <div class="stat"><strong>${coverage.total.rate}%</strong><span>全题库</span></div>
            <div class="stat"><strong>${coverage.total.rounds}</strong><span>模拟次数</span></div>
          </div>
          <div class="progress-list coverage-list">
            ${TYPES.map((type) => `
              <div class="progress-row">
                <div class="progress-meta">
                  <span>${type}</span>
                  <span>${coverage[type].seen}/${coverage[type].count} · ${coverage[type].rate}%</span>
                </div>
                <div class="progress-bar" style="--value: ${coverage[type].rate}%"><span></span></div>
              </div>
            `).join("")}
          </div>
          <div class="toolbar coverage-toolbar">
            <div class="toolbar-group">
              <button class="soft-button" data-action="reset-exam-coverage" ${coverage.total.seen ? "" : "disabled"}>重置覆盖</button>
            </div>
          </div>
        </section>
      `;
    }
    return renderExamShell(exam, exam.title || "模拟考试");
  }

  function renderExamStartMenuOverlay() {
    if (!state.examStartMenuOpen) return "";
    const source = examSourceQuestions();
    const counts = typeCounts(source);
    const cards = [
      ["single", "模拟单选", "只做单选 300 题", counts["单选"] >= 300],
      ["multiple", "模拟多选", "只做多选 300 题", counts["多选"] >= 300],
      ["judge", "模拟判断", "只做判断 300 题", counts["判断"] >= 300],
      ["random", "模拟随机", "单选、判断、多选各 100 题", TYPES.every((type) => counts[type] >= 100)]
    ];
    return `
      <button class="exam-start-backdrop" data-action="close-exam-start" aria-label="关闭模拟选择" type="button"></button>
      <section class="exam-start-sheet" role="dialog" aria-label="选择模拟考试类型">
        <div class="exam-start-title">
          <strong>选择模拟考试</strong>
          <span>${source.length} 题范围</span>
        </div>
        ${cards.map(([kind, title, detail, enabled]) => `
          <button class="exam-kind-option" data-action="start-exam-kind" data-kind="${kind}" type="button" ${enabled ? "" : "disabled"}>
            <span>${title}</span>
            <small>${detail}</small>
          </button>
        `).join("")}
      </section>
    `;
  }

  function renderExamShell(exam, title) {
    const visibleIds = getVisibleExamIds(exam);
    if (!visibleIds.length) {
      return renderEmpty("没有错题", "这套题目前没有错题，可以切回全部题目查看。");
    }

    const ids = visibleIds;
    if (exam.index >= ids.length) exam.index = 0;
    const currentId = ids[exam.index] || ids[0];
    const question = questionById.get(currentId);
    if (!question) {
      return renderEmpty("试卷为空", "重新开始一套模拟考试即可。");
    }

    const selected = exam.answers && exam.answers[question.id] ? exam.answers[question.id] : [];
    const submitted = Boolean(exam.submitted);
    const score = submitted ? examScore(exam) : null;
    const lastCorrect = submitted ? isCorrect(question, selected) : null;
    const wrongIds = exam.wrongIds || [];
    const headerTitle = submitted && exam.reviewWrongOnly ? "错题复盘" : title;

    if (submitted) {
      return renderExamReviewList(exam, headerTitle, score, wrongIds);
    }

    return `
      <section class="exam-header">
        <div>
          <h2>${submitted ? headerTitle : title}</h2>
          <p>已答 ${answeredExamCount(exam)}/${exam.ids.length} · <span class="exam-timer" data-ended-at="${exam.startedAt + (exam.durationMs || EXAM_DURATION_MS)}">${formatExamRemaining(exam)}</span></p>
        </div>
        <div class="toolbar-group">
          <button class="soft-button" data-action="new-exam">新试卷</button>
          <button class="solid-button" data-action="finish-exam">交卷</button>
        </div>
      </section>
      <div class="exam-grid">
        ${ids.map((id, idx) => {
          const answer = exam.answers && exam.answers[id] ? exam.answers[id] : [];
          const resultClass = submitted
            ? isCorrect(questionById.get(id), answer) ? "correct" : "wrong"
            : answer.length ? "answered" : "";
          return `
            <button class="number-button ${idx === exam.index ? "current" : ""} ${resultClass}" data-action="exam-jump" data-index="${idx}">
              ${idx + 1}
            </button>
          `;
        }).join("")}
      </div>
      ${renderExamQuestion(question, exam.index, ids.length, selected, submitted, lastCorrect)}
      <div class="toolbar ${submitted ? "toolbar-after-answer" : ""}">
        <div class="toolbar-group">
          <button class="soft-button" data-action="previous-exam">上一题</button>
          <button class="soft-button" data-action="next-exam">下一题</button>
        </div>
      </div>
    `;
  }

  function renderExamReviewList(exam, title, score, wrongIds) {
    const ids = getVisibleExamIds(exam);
    const allCount = exam.ids.length;
    const reviewCount = ids.length;
    return `
      <section class="exam-header exam-review-header">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p>答对 ${score.correct}/${score.total} · 错 ${wrongIds.length} · 正确率 ${score.rate}% · 当前显示 ${reviewCount}/${allCount}</p>
        </div>
        <div class="toolbar-group">
          ${!exam.reviewWrongOnly && wrongIds.length ? '<button class="soft-button" data-action="review-exam-wrong">只看错题</button>' : ""}
          ${exam.reviewWrongOnly ? '<button class="soft-button" data-action="review-exam-all">全部题目</button>' : ""}
          <button class="soft-button" data-action="retry-wrong">错题练习</button>
          <button class="solid-button" data-action="new-exam">新试卷</button>
        </div>
      </section>
      ${renderExamScore(score)}
      <section class="exam-review-list">
        ${ids.map((id) => renderExamReviewItem(exam, id)).join("")}
      </section>
    `;
  }

  function renderExamReviewItem(exam, id) {
    const question = questionById.get(id);
    if (!question) return "";
    const orderIndex = Math.max(0, exam.ids.indexOf(id));
    const selected = exam.answers[id] || [];
    const presentedOptions = getPresentedOptions(question);
    const correct = isCorrect(question, selected);
    const correctAnswer = formatPresentedAnswer(question, presentedOptions);
    const selectedAnswer = formatPresentedSelection(question, selected, presentedOptions);

    return `
      <article class="exam-review-card ${correct ? "is-correct" : "is-wrong"}">
        <div class="exam-review-top">
          <div class="badges">
            <span class="badge green">${escapeHtml(question.type)}</span>
            <span class="badge blue">${escapeHtml(question.categoryName)}</span>
            <span class="badge ${correct ? "green" : "coral"}">${correct ? "正确" : "错误"}</span>
          </div>
          <span class="question-index">${orderIndex + 1}/${exam.ids.length}</span>
        </div>
        <h3>${escapeHtml(question.question)}</h3>
        <div class="review-answer-row">
          <span class="answer-pill correct">正确答案：${escapeHtml(correctAnswer)}</span>
          <span class="answer-pill ${correct ? "correct" : "wrong"}">我的答案：${escapeHtml(selectedAnswer)}</span>
        </div>
        <div class="review-options">
          ${presentedOptions.map((option) => {
            const isCorrectOption = question.answer.includes(option.originalKey);
            const isSelected = selected.includes(option.originalKey);
            const displayKey = displayOptionKey(option);
            const keyClass = displayKey.length > 1 ? "option-key wide" : "option-key";
            const classes = [
              "review-option",
              isCorrectOption ? "correct-answer" : "",
              isSelected && !isCorrectOption ? "wrong-answer" : "",
              isSelected && isCorrectOption ? "selected-correct" : ""
            ].filter(Boolean).join(" ");
            return `
              <div class="${classes}">
                <span class="${keyClass}">${escapeHtml(displayKey)}</span>
                <span class="option-text">${escapeHtml(option.text)}</span>
              </div>
            `;
          }).join("")}
        </div>
        <div class="review-explanation">
          <strong>解析</strong>
          <p>${escapeHtml(question.explanation || "暂无解析")}</p>
        </div>
      </article>
    `;
  }

  function renderExamQuestion(question, index, total, selected, revealed, lastCorrect) {
    const html = renderQuestionCard({
      question,
      index,
      total,
      selected,
      revealed,
      lastCorrect,
      typeSwitcher: false
    });
    return html.replaceAll('data-action="option"', 'data-action="exam-option"');
  }

  function renderExamScore(score) {
    return `
      <section class="result-card">
        <div class="result-score">
          <div class="score-ring" style="--value: ${score.rate}%">${score.rate}%</div>
          <div>
            <h2>${score.correct >= score.total * 0.8 ? "手感不错" : "继续压错题"}</h2>
            <p class="footer-note">本次 ${score.total} 题，答对 ${score.correct} 题，答错或未答 ${score.total - score.correct} 题。</p>
          </div>
        </div>
      </section>
    `;
  }

  function renderSearch(baseQuestions) {
    const query = state.query.trim();
    const results = query ? baseQuestions : baseQuestions.slice(0, 80);
    return `
      <section class="search-header">
        <div>
          <h2>题库检索</h2>
          <p>${query ? `找到 ${results.length} 题` : "显示当前筛选范围前 80 题"}</p>
        </div>
        ${query ? '<button class="soft-button" data-action="clear-query">清除关键词</button>' : ""}
      </section>
      <div class="search-results">
        ${results.slice(0, 120).map((question) => `
          <article class="search-card" data-action="search-jump" data-id="${question.id}">
            <div class="badges">
              <span class="badge green">${escapeHtml(question.type)}</span>
              <span class="badge blue">${escapeHtml(question.categoryName)}</span>
            </div>
            <h3>${escapeHtml(question.question)}</h3>
            <p>答案：${escapeHtml(formatAnswer(question))}</p>
          </article>
        `).join("")}
      </div>
    `;
  }

  function renderEmpty(title, detail) {
    return `
      <section class="empty-state">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(detail)}</p>
        </div>
      </section>
    `;
  }

  function onSubmit(event) {
    const form = event.target.closest("form[data-action]");
    if (!form) return;
    event.preventDefault();
    if (form.dataset.action === "verify-staff") verifyStaffId();
  }

  function onClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;

    if (action === "verify-staff") {
      verifyStaffId();
      return;
    }

    if (action === "toggle-utility-panel") {
      state.categoryMenuOpen = false;
      state.examStartMenuOpen = false;
      state.utilityPanel = state.utilityPanel ? "" : "note";
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "close-utility-panel") {
      state.utilityPanel = "";
      state.categoryMenuOpen = false;
      state.examStartMenuOpen = false;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "set-utility-panel") {
      state.categoryMenuOpen = false;
      state.examStartMenuOpen = false;
      state.utilityPanel = target.dataset.panel || "note";
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "set-mode") {
      const nextMode = target.dataset.mode;
      if (!VALID_MODES.some(([mode]) => mode === nextMode)) return;
      if ((nextMode === "wrong" && state.mode === "wrong") || (nextMode === "favorite" && state.mode === "favorite")) {
        restorePracticeLocation();
        state.utilityPanel = "";
        state.categoryMenuOpen = false;
        state.examStartMenuOpen = false;
        saveAndRender();
        resetViewportScroll();
        return;
      }
      state.mode = nextMode;
      state.utilityPanel = "";
      state.categoryMenuOpen = false;
      state.examStartMenuOpen = false;
      syncSelectedTypesForMode();
      if (state.mode === "wrong" || state.mode === "favorite") state.selectedTypes = [...TYPES];
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "toggle-category-menu") {
      state.utilityPanel = "";
      state.examStartMenuOpen = false;
      state.categoryMenuOpen = !state.categoryMenuOpen;
      saveAndRender();
      return;
    }

    if (action === "close-category-menu") {
      state.categoryMenuOpen = false;
      saveAndRender();
      return;
    }

    if (action === "pick-category") {
      applyCategoryFilter(target.dataset.id);
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "toggle-category") {
      toggleArrayValue(state.selectedCategories, target.dataset.id);
      if (!state.selectedCategories.length) {
        state.selectedCategories = categories.map((category) => category.id);
      }
      state.exam = null;
      state.categoryMenuOpen = false;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "select-all-categories") {
      applyCategoryFilter("__all__", { closeUtilityPanel: false });
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "toggle-type") {
      if (TYPE_MODE_MAP[state.mode]) {
        state.mode = MODE_BY_TYPE[target.dataset.type] || "single";
        state.selectedTypes = [target.dataset.type];
        state.exam = null;
        saveAndRender();
        resetViewportScroll();
        return;
      }
      toggleArrayValue(state.selectedTypes, target.dataset.type);
      if (!state.selectedTypes.length) state.selectedTypes = [...TYPES];
      state.exam = null;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "option") {
      const question = currentPracticeQuestion();
      if (!question) return;
      updateDraft(question.id, target.dataset.key);
      autoSubmitPracticeIfReady(question);
      saveAndRender();
      return;
    }

    if (action === "submit-practice") {
      submitPractice();
      return;
    }

    if (action === "reveal-answer") {
      const question = currentPracticeQuestion();
      if (question?.type === "多选") return;
      state.revealed[question.id] = true;
      saveAndRender();
      return;
    }

    if (action === "toggle-study-mode") {
      state.studyMode = !state.studyMode;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "next-question" || action === "previous-question" || action === "random-question") {
      movePractice(action);
      resetViewportScroll();
      return;
    }

    if (action === "toggle-favorite") {
      toggleObjectKey(state.favorites, target.dataset.id || state.currentId);
      saveAndRender();
      return;
    }

    if (action === "clear-query") {
      state.query = "";
      saveAndRender();
      return;
    }

    if (action === "start-exam300") {
      state.examStartMenuOpen = true;
      state.utilityPanel = "";
      state.categoryMenuOpen = false;
      saveAndRender();
      return;
    }

    if (action === "close-exam-start") {
      state.examStartMenuOpen = false;
      saveAndRender();
      return;
    }

    if (action === "start-exam-kind") {
      startExam300(target.dataset.kind || "random");
      return;
    }

    if (action === "reset-exam-coverage") {
      if (confirm("只重置模拟考试覆盖记录？错题、收藏和笔记会保留。")) {
        state.examExposure = {};
        saveAndRender();
      }
      return;
    }

    if (action === "new-exam") {
      state.exam = null;
      state.examStartMenuOpen = false;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "finish-exam") {
      finishExam();
      return;
    }

    if (action === "exam-option") {
      updateExamAnswer(target.dataset.key);
      return;
    }

    if (action === "exam-jump") {
      state.exam.index = Number(target.dataset.index) || 0;
      saveAndRender();
      return;
    }

    if (action === "review-exam-wrong") {
      if (state.exam) {
        state.exam.reviewWrongOnly = true;
        state.exam.index = 0;
      }
      saveAndRender();
      return;
    }

    if (action === "review-exam-all") {
      if (state.exam) {
        state.exam.reviewWrongOnly = false;
        state.exam.index = 0;
      }
      saveAndRender();
      return;
    }

    if (action === "next-exam" || action === "previous-exam") {
      moveExam(action);
      return;
    }

    if (action === "retry-wrong") {
      state.mode = "wrong";
      state.exam = null;
      state.examStartMenuOpen = false;
      state.selectedTypes = [...TYPES];
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "search-jump") {
      state.currentId = target.dataset.id;
      const question = questionById.get(state.currentId);
      state.mode = MODE_BY_TYPE[question?.type] || "single";
      state.examStartMenuOpen = false;
      saveAndRender();
      resetViewportScroll();
      return;
    }

    if (action === "export-progress") {
      exportProgress();
      return;
    }

    if (action === "import-progress") {
      const input = document.getElementById("import-file");
      if (input) input.click();
      return;
    }

    if (action === "reset-progress") {
      if (confirm("清空刷题记录、错题、收藏和笔记？")) {
        state = {
          ...defaultState,
          staffId: state.staffId,
          selectedCategories: state.selectedCategories,
          selectedTypes: state.selectedTypes
        };
        if (!TYPE_MODE_MAP[state.mode]) state.mode = "single";
        state.examStartMenuOpen = false;
        saveAndRender();
        resetViewportScroll();
      }
      return;
    }

    if (action === "install" && installPrompt) {
      installPrompt.prompt();
      installPrompt.userChoice.finally(() => {
        installPrompt = null;
        render();
      });
    }
  }

  function onInput(event) {
    const target = event.target;
    if (target.dataset.action === "staff-id") {
      target.value = target.value.replace(/\D/g, "").slice(0, 6);
      verifyError = "";
      const error = document.querySelector(".verify-error");
      if (error) error.textContent = "";
      return;
    }
    if (target.dataset.action === "query") {
      state.query = target.value;
      state.exam = null;
      saveAndRender();
    }
    if (target.dataset.action === "note") {
      state.notes[target.dataset.id] = target.value;
      saveState();
      const label = target.closest(".panel")?.querySelector(".section-title span");
      if (label) label.textContent = target.value ? "已保存" : "空";
    }
  }

  function verifyStaffId() {
    const input = document.getElementById("staff-id");
    const value = String(input?.value || "").trim();
    if (!isVerifiedStaffId(value)) {
      verifyError = "请输入 704001 到 704099 之间的工号";
      if (input) input.focus();
      render();
      return;
    }
    verifyError = "";
    state.staffId = value;
    remoteSyncReady = false;
    remoteSyncStaffId = value;
    restorePracticeLocation();
    saveAndRender();
    window.scrollTo({ top: 0 });
    setTimeout(loadFullQuestionBank, 200);
    initializeRemoteState();
  }

  function onChange(event) {
    const target = event.target;
    if (target.dataset.action === "category-select") {
      applyCategoryFilter(target.value);
      saveAndRender();
      resetViewportScroll();
      return;
    }
    if (target.id === "import-file" && target.files && target.files[0]) {
      importProgress(target.files[0]);
      target.value = "";
    }
  }

  function applyCategoryFilter(categoryId, options = {}) {
    const closeUtilityPanel = options.closeUtilityPanel !== false;
    if (categoryId === "__all__") {
      state.selectedCategories = categories.map((category) => category.id);
    } else if (categoryIds.has(categoryId)) {
      state.selectedCategories = [categoryId];
    }
    state.categoryMenuOpen = false;
    state.examStartMenuOpen = false;
    if (closeUtilityPanel) state.utilityPanel = "";
    state.exam = null;
  }

  function submitPractice() {
    const question = currentPracticeQuestion();
    if (!question) return;
    const selected = getDraft(question.id);
    if (!selected.length) return;
    const correct = isCorrect(question, selected);
    recordAttempt(question.id, selected, correct);
    state.revealed[question.id] = true;
    saveAndRender();
  }

  function autoSubmitPracticeIfReady(question) {
    if (!question || state.revealed[question.id]) return;
    if (question.type === "多选") return;
    const id = question.id;
    const selected = getDraft(id);
    if (!selected.length) return;

    recordAttempt(id, selected, isCorrect(question, selected));
    state.revealed[id] = true;
  }

  function recordAttempt(id, selected, correct) {
    const previous = state.progress[id] || {
      attempts: 0,
      correct: 0,
      wrong: 0,
      lastCorrect: null,
      lastAnswer: [],
      lastAt: ""
    };
    state.progress[id] = {
      attempts: previous.attempts + 1,
      correct: previous.correct + (correct ? 1 : 0),
      wrong: previous.wrong + (correct ? 0 : 1),
      lastCorrect: correct,
      lastAnswer: selected,
      lastAt: new Date().toISOString()
    };
    recordWrongMastery(id, correct);
  }

  function recordWrongMastery(id, correct) {
    const previous = wrongEntry(id);
    if (correct) {
      if (!previous) return;
      const nextStreak = (previous.correctStreak || 0) + 1;
      state.wrong[id] = {
        ...previous,
        correctStreak: Math.min(nextStreak, 2),
        lastCorrect: true,
        lastAt: new Date().toISOString()
      };
      return;
    }

    state.wrong[id] = {
      ...(previous || {}),
      correctStreak: 0,
      wrongCount: (previous?.wrongCount || 0) + 1,
      lastCorrect: false,
      lastAt: new Date().toISOString()
    };
  }

  function movePractice(action) {
    const list = getModeQuestions(state.mode, getBaseFilteredQuestions());
    if (!list.length) return;
    if (isSpecialReviewMode()) {
      const currentIndex = getSpecialReviewIndex(list);
      const nextIndex = nextPracticeIndex(list, currentIndex, action);
      setSpecialReviewIndex(nextIndex, list);
      saveAndRender();
      return;
    }
    const currentIndex = Math.max(0, list.findIndex((question) => question.id === state.currentId));
    const nextIndex = nextDistinctPracticeIndex(list, currentIndex, action);
    state.currentId = list[nextIndex].id;
    saveAndRender();
  }

  function nextPracticeIndex(list, currentIndex, action) {
    if (list.length <= 1) return currentIndex;
    if (action === "random-question") {
      const candidates = list.map((_, index) => index).filter((index) => index !== currentIndex);
      return candidates[Math.floor(Math.random() * candidates.length)] || 0;
    }
    const step = action === "previous-question" ? -1 : 1;
    return (currentIndex + step + list.length) % list.length;
  }

  function nextDistinctPracticeIndex(list, currentIndex, action) {
    if (list.length <= 1) return currentIndex;
    const currentId = list[currentIndex]?.id || state.currentId;
    if (action === "random-question") {
      const candidates = list
        .map((question, index) => ({ question, index }))
        .filter((item) => item.question.id !== currentId);
      return candidates.length
        ? candidates[Math.floor(Math.random() * candidates.length)].index
        : currentIndex;
    }

    const step = action === "previous-question" ? -1 : 1;
    let nextIndex = currentIndex;
    for (let offset = 0; offset < list.length; offset += 1) {
      nextIndex = (nextIndex + step + list.length) % list.length;
      if (list[nextIndex].id !== currentId) return nextIndex;
    }
    return currentIndex;
  }

  function startExam300(kind = "random") {
    const ids = [];
    const priorityIds = [];
    const source = examSourceQuestions();
    const normalizedKind = ["single", "multiple", "judge", "random"].includes(kind) ? kind : "random";

    if (TYPE_MODE_MAP[normalizedKind]) {
      const typedQuestions = source.filter((question) => question.type === TYPE_MODE_MAP[normalizedKind]);
      const picked = pickExam300TypeQuestions(typedQuestions, 300);
      ids.push(...picked.ids);
      priorityIds.push(...picked.priorityIds);
    } else {
      for (const type of TYPES) {
        const typedQuestions = source.filter((question) => question.type === type);
        const picked = pickExam300TypeQuestions(typedQuestions, 100);
        ids.push(...picked.ids);
        priorityIds.push(...picked.priorityIds);
      }
    }

    if (ids.length !== 300) return;
    markExamExposure(ids);
    markWrongReviewExposure(priorityIds);
    resetOptionOrders(ids);
    prepareOptionOrders(ids);
    state.exam = {
      kind: "balanced300",
      examKind: normalizedKind,
      title: EXAM_KIND_LABELS[normalizedKind] || "模拟考试",
      active: true,
      submitted: false,
      ids: spreadPriorityIds(priorityIds, ids),
      priorityIds,
      index: 0,
      answers: {},
      wrongIds: [],
      reviewWrongOnly: false,
      startedAt: Date.now(),
      durationMs: EXAM_DURATION_MS,
      timeUp: false
    };
    state.mode = "exam300";
    state.examStartMenuOpen = false;
    saveAndRender();
    resetViewportScroll();
  }

  function finishExam(timeUp = false) {
    const exam = state.exam;
    if (!exam || exam.submitted) return;
    const wrongIds = [];
    for (const id of exam.ids) {
      const question = questionById.get(id);
      if (!question) continue;
      const selected = exam.answers[id] || [];
      const correct = isCorrect(question, selected);
      recordAttempt(id, selected, correct);
      if (!correct) wrongIds.push(id);
    }
    exam.submitted = true;
    exam.wrongIds = wrongIds;
    exam.reviewWrongOnly = false;
    exam.index = 0;
    exam.finishedAt = Date.now();
    exam.timeUp = Boolean(timeUp);
    saveAndRender();
  }

  function updateExamAnswer(key) {
    const exam = state.exam;
    if (!exam || exam.submitted) return;
    const id = getVisibleExamIds(exam)[exam.index];
    const question = questionById.get(id);
    if (!question) return;
    const answer = exam.answers[id] || [];
    exam.answers[id] = updateSelection(question, answer, key);
    saveAndRender();
  }

  function moveExam(action) {
    const exam = state.exam;
    const ids = exam ? getVisibleExamIds(exam) : [];
    if (!exam || !ids.length) return;
    const delta = action === "next-exam" ? 1 : -1;
    exam.index = (exam.index + delta + ids.length) % ids.length;
    saveAndRender();
  }

  function getDraft(id) {
    return Array.isArray(state.drafts[id]) ? state.drafts[id] : [];
  }

  function updateDraft(id, key) {
    const question = questionById.get(id);
    if (!question) return;
    const current = getDraft(id);
    state.drafts[id] = updateSelection(question, current, key);
  }

  function updateSelection(question, current, key) {
    if (question.type === "多选") {
      const next = [...current];
      toggleArrayValue(next, key);
      return next.sort(sortByOption);
    }
    return [key];
  }

  function getBaseFilteredQuestions() {
    const selectedCategories = new Set(state.selectedCategories);
    const selectedTypes = new Set(state.selectedTypes);
    const query = state.query.trim().toLowerCase();
    return questions.filter((question) => {
      if (!selectedCategories.has(question.category)) return false;
      if (!selectedTypes.has(question.type)) return false;
      if (!query) return true;
      const haystack = [
        question.question,
        question.categoryName,
        question.type,
        question.explanation,
        ...question.options.map((option) => option.text)
      ].join("\n").toLowerCase();
      return haystack.includes(query);
    });
  }

  function examSourceQuestions() {
    const selectedCategories = new Set(state.selectedCategories);
    return uniqueQuestions(questions).filter((question) => selectedCategories.has(question.category));
  }

  function getModeQuestions(mode, baseQuestions) {
    if (TYPE_MODE_MAP[mode]) {
      return baseQuestions.filter((question) => question.type === TYPE_MODE_MAP[mode]);
    }
    if (mode === "wrong") return baseQuestions.filter((question) => isActiveWrong(question.id));
    if (mode === "favorite") return baseQuestions.filter((question) => state.favorites[question.id]);
    if (mode === "judgeCorrect") return questions.filter(isJudgeCorrectAnswer);
    if (mode === "allSelect") return questions.filter(isAllSelectAnswer);
    return baseQuestions;
  }

  function getVisibleExamIds(exam) {
    if (exam.submitted && exam.reviewWrongOnly) {
      return exam.wrongIds || [];
    }
    return exam.ids || [];
  }

  function typeCounts(source) {
    const uniqueSource = uniqueQuestions(source);
    return TYPES.reduce((counts, type) => {
      counts[type] = uniqueSource.filter((question) => question.type === type).length;
      return counts;
    }, {});
  }

  function examCoverageStats() {
    const uniqueBank = uniqueQuestions(questions);
    const stats = {};
    let totalSeen = 0;

    for (const type of TYPES) {
      const typedQuestions = uniqueBank.filter((question) => question.type === type);
      const seen = typedQuestions.filter((question) => state.examExposure[question.id]).length;
      totalSeen += seen;
      stats[type] = {
        count: typedQuestions.length,
        seen,
        rate: typedQuestions.length ? Math.round((seen / typedQuestions.length) * 100) : 0
      };
    }

    stats.total = {
      count: uniqueBank.length,
      seen: totalSeen,
      rate: uniqueBank.length ? Math.round((totalSeen / uniqueBank.length) * 100) : 0,
      rounds: Math.floor(Object.values(state.examExposure).reduce((sum, value) => sum + value, 0) / 300)
    };
    return stats;
  }

  function wrongEntry(id) {
    const raw = state.wrong ? state.wrong[id] : null;
    return normalizeWrongRecord(raw);
  }

  function normalizeWrongRecord(raw) {
    if (!raw) return null;
    if (raw === true) {
      return {
        correctStreak: 0,
        wrongCount: 1,
        reviewCount: 0,
        lastCorrect: false,
        lastAt: ""
      };
    }
    if (typeof raw === "object") {
      return {
        correctStreak: clamp(Number(raw.correctStreak) || 0, 0, 2),
        wrongCount: Number(raw.wrongCount) || 1,
        reviewCount: Number(raw.reviewCount) || 0,
        lastCorrect: Boolean(raw.lastCorrect),
        lastAt: raw.lastAt || "",
        lastReviewAt: raw.lastReviewAt || ""
      };
    }
    return null;
  }

  function isActiveWrong(id) {
    const entry = wrongEntry(id);
    return Boolean(entry && entry.correctStreak < 2 && questionById.has(id));
  }

  function activeWrongIds() {
    return Object.keys(state.wrong || {}).filter(isActiveWrong);
  }

  function activeWrongQuestions() {
    const ids = new Set(activeWrongIds());
    return questions.filter((question) => ids.has(question.id));
  }

  function pruneWrongRecords() {
    for (const id of Object.keys(state.wrong || {})) {
      if (!bank.isStarter && !questionById.has(id)) {
        delete state.wrong[id];
        continue;
      }
      const entry = wrongEntry(id);
      if (!entry) {
        delete state.wrong[id];
      }
    }
  }

  function wrongReviewStats() {
    const entries = activeWrongIds().map((id) => wrongEntry(id)).filter(Boolean);
    return {
      active: entries.length,
      onceCorrect: entries.filter((entry) => entry.correctStreak === 1).length,
      reviewed: entries.filter((entry) => entry.reviewCount > 0).length
    };
  }

  function pickExam300TypeQuestions(typedQuestions, count) {
    const activeWrongSet = new Set(activeWrongQuestions().map((question) => question.id));
    const wrongCandidates = typedQuestions.filter((question) => activeWrongSet.has(question.id));
    const priority = pickWrongReviewQuestions(wrongCandidates, Math.min(count, wrongCandidates.length));
    const used = new Set(priority.map((question) => question.id));
    const fill = pickLeastSeen(
      typedQuestions.filter((question) => !used.has(question.id)),
      count - priority.length
    );
    const picked = [...priority, ...fill];
    return {
      ids: picked.map((question) => question.id),
      priorityIds: priority.map((question) => question.id)
    };
  }

  function pickWrongReviewQuestions(source, count) {
    return shuffle(uniqueQuestions(source))
      .sort((left, right) => {
        const leftEntry = wrongEntry(left.id) || {};
        const rightEntry = wrongEntry(right.id) || {};
        const streakDelta = (leftEntry.correctStreak || 0) - (rightEntry.correctStreak || 0);
        if (streakDelta) return streakDelta;
        return (leftEntry.reviewCount || 0) - (rightEntry.reviewCount || 0);
      })
      .slice(0, count);
  }

  function markWrongReviewExposure(ids) {
    const now = new Date().toISOString();
    for (const id of ids) {
      const entry = wrongEntry(id);
      if (!entry) continue;
      state.wrong[id] = {
        ...entry,
        reviewCount: (entry.reviewCount || 0) + 1,
        lastReviewAt: now
      };
    }
  }

  function spreadPriorityIds(priorityIds, allIds) {
    const prioritySet = new Set(priorityIds);
    const priority = shuffle(priorityIds.filter((id) => prioritySet.has(id)));
    const normal = shuffle(allIds.filter((id) => !prioritySet.has(id)));
    if (!priority.length) return shuffle(allIds);

    const slots = new Map();
    priority.forEach((id, index) => {
      const slot = Math.floor(((index + 1) * allIds.length) / (priority.length + 1));
      const list = slots.get(slot) || [];
      list.push(id);
      slots.set(slot, list);
    });

    const result = [];
    let normalIndex = 0;
    for (let index = 0; index < allIds.length; index += 1) {
      if (slots.has(index)) result.push(...slots.get(index));
      if (normalIndex < normal.length) result.push(normal[normalIndex]);
      normalIndex += 1;
    }
    while (normalIndex < normal.length) {
      result.push(normal[normalIndex]);
      normalIndex += 1;
    }
    return result.slice(0, allIds.length);
  }

  function pickLeastSeen(source, count) {
    return shuffle(uniqueQuestions(source)).sort((left, right) => {
      const leftCount = state.examExposure[left.id] || 0;
      const rightCount = state.examExposure[right.id] || 0;
      return leftCount - rightCount;
    }).slice(0, count);
  }

  function uniqueQuestions(source) {
    const seen = new Set();
    const unique = [];
    for (const question of source) {
      if (seen.has(question.id)) continue;
      seen.add(question.id);
      unique.push(question);
    }
    return unique;
  }

  function markExamExposure(ids) {
    for (const id of ids) {
      state.examExposure[id] = (state.examExposure[id] || 0) + 1;
    }
  }

  function ensureCurrent(list) {
    if (!list.length) return;
    if (isSpecialReviewMode()) {
      setSpecialReviewIndex(getSpecialReviewIndex(list), list);
      saveState();
      return;
    }
    if (!list.some((question) => question.id === state.currentId)) {
      if (bank.isStarter && state.lastPracticeId && !questionById.has(state.lastPracticeId)) return;
      state.currentId = list[0].id;
      saveState();
    }
  }

  function isSpecialReviewMode(mode = state.mode) {
    return SPECIAL_REVIEW_MODES.includes(mode);
  }

  function getSpecialReviewIndex(list) {
    const saved = Number(state.specialIndexes?.[state.mode]);
    if (!Number.isFinite(saved)) return 0;
    return clamp(Math.trunc(saved), 0, Math.max(0, list.length - 1));
  }

  function setSpecialReviewIndex(index, list) {
    if (!state.specialIndexes || typeof state.specialIndexes !== "object") {
      state.specialIndexes = {};
    }
    const safeIndex = clamp(Math.trunc(Number(index) || 0), 0, Math.max(0, list.length - 1));
    state.specialIndexes[state.mode] = safeIndex;
    state.currentId = list[safeIndex]?.id || state.currentId;
  }

  function currentPracticeQuestion() {
    const list = getModeQuestions(state.mode, getBaseFilteredQuestions());
    if (!list.length) return null;
    if (isSpecialReviewMode()) return list[getSpecialReviewIndex(list)] || null;
    return questionById.get(state.currentId) || list[0] || null;
  }

  function modeCount(mode) {
    if (TYPE_MODE_MAP[mode]) {
      if (bank.isStarter && FULL_TYPE_COUNTS[mode]) return FULL_TYPE_COUNTS[mode];
      return questions.filter((question) => question.type === TYPE_MODE_MAP[mode]).length;
    }
    if (mode === "wrong") return activeWrongIds().length;
    if (mode === "favorite") {
      return Object.keys(state.favorites).filter((id) => questionById.has(id)).length;
    }
    if (mode === "judgeCorrect") return bank.isStarter ? FULL_JUDGE_CORRECT_COUNT : questions.filter(isJudgeCorrectAnswer).length;
    if (mode === "allSelect") return bank.isStarter ? FULL_ALL_SELECT_COUNT : questions.filter(isAllSelectAnswer).length;
    return 0;
  }

  function isCorrect(question, selected) {
    if (!question || !Array.isArray(selected)) return false;
    const expected = [...question.answer].sort(sortByOption);
    const actual = [...new Set(selected)].sort(sortByOption);
    return expected.length === actual.length && expected.every((value, index) => value === actual[index]);
  }

  function formatAnswer(question) {
    const presentedOptions = getPresentedOptions(question);
    return formatPresentedAnswer(question, presentedOptions);
  }

  function formatPresentedAnswer(question, presentedOptions) {
    const displayAnswers = presentedOptions
      .filter((option) => question.answer.includes(option.originalKey))
      .map((option) => option.key);
    if (question.type === "多选") return displayAnswers.join("");
    return displayAnswers.join("、");
  }

  function formatPresentedSelection(question, selected, presentedOptions) {
    if (!selected || !selected.length) return "未作答";
    const selectedSet = new Set(selected);
    const displayAnswers = presentedOptions
      .filter((option) => selectedSet.has(option.originalKey))
      .map((option) => option.key);
    if (question.type === "多选") return displayAnswers.join("") || "未作答";
    return displayAnswers.join("、") || "未作答";
  }

  function formatPracticeSelection(question, selected, presentedOptions) {
    const value = formatPresentedSelection(question, selected, presentedOptions);
    return value === "未作答" ? "无" : value;
  }

  function displayOptionKey(option) {
    if (option.key === "正确" && option.text === "正确") return "对";
    if (option.key === "错误" && option.text === "错误") return "错";
    return option.key;
  }

  function getPresentedOptions(question) {
    const originalOptions = question.options || [];
    if (originalOptions.length <= 1) {
      return originalOptions.map((option) => ({ ...option, originalKey: option.key }));
    }

    const currentOrder = state.optionOrders[question.id] || [];
    const originalKeys = originalOptions.map((option) => option.key);
    const validOrder =
      currentOrder.length === originalKeys.length &&
      originalKeys.every((key) => currentOrder.includes(key));
    const order = validOrder ? currentOrder : shuffle(originalKeys);
    if (!validOrder) state.optionOrders[question.id] = order;

    const optionByKey = new Map(originalOptions.map((option) => [option.key, option]));
    return order.map((originalKey, index) => {
      const option = optionByKey.get(originalKey);
      return {
        originalKey,
        key: question.type === "判断" ? originalKey : String.fromCharCode(65 + index),
        text: option ? option.text : ""
      };
    });
  }

  function resetOptionOrders(ids) {
    for (const id of ids) {
      delete state.optionOrders[id];
    }
  }

  function prepareOptionOrders(ids) {
    for (const id of ids) {
      const question = questionById.get(id);
      if (!question || !Array.isArray(question.options) || question.options.length <= 1) continue;
      state.optionOrders[id] = shuffle(question.options.map((option) => option.key));
    }
  }

  function answeredExamCount(exam) {
    return Object.values(exam.answers || {}).filter((answer) => answer && answer.length).length;
  }

  function examScore(exam) {
    const total = exam.ids.length;
    const correct = exam.ids.reduce((sum, id) => {
      const question = questionById.get(id);
      return sum + (isCorrect(question, exam.answers[id] || []) ? 1 : 0);
    }, 0);
    return {
      total,
      correct,
      rate: total ? Math.round((correct / total) * 100) : 0
    };
  }

  function examRemainingMs(exam) {
    if (!exam || exam.submitted) return 0;
    const startedAt = Number(exam.startedAt) || Date.now();
    const duration = Number(exam.durationMs) || EXAM_DURATION_MS;
    return Math.max(0, startedAt + duration - Date.now());
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function formatExamRemaining(exam) {
    return `剩余 ${formatDuration(examRemainingMs(exam))}`;
  }

  function scheduleExamTimer() {
    if (examTimer) {
      clearInterval(examTimer);
      examTimer = null;
    }
    const exam = state.exam;
    if (!isVerifiedStaffId(state.staffId) || !exam || !exam.active || exam.submitted) return;

    const tick = () => {
      const currentExam = state.exam;
      if (!currentExam || currentExam.submitted) {
        clearInterval(examTimer);
        examTimer = null;
        return;
      }
      const remaining = examRemainingMs(currentExam);
      const label = document.querySelector(".exam-timer");
      if (label) label.textContent = `剩余 ${formatDuration(remaining)}`;
      if (remaining <= 0) {
        clearInterval(examTimer);
        examTimer = null;
        finishExam(true);
      }
    };

    tick();
    examTimer = setInterval(tick, 1000);
  }

  function exportProgress() {
    const payload = {
      version: 1,
      app: "customer-manager-quiz",
      exportedAt: new Date().toISOString(),
      source: bank.source,
      progress: state.progress,
      wrong: state.wrong,
      favorites: state.favorites,
      notes: state.notes,
      examExposure: state.examExposure
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `刷题进度-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function importProgress(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(String(reader.result || "{}"));
        state.progress = mergeProgressRecords(state.progress, payload.progress || {});
        state.wrong = mergeWrongRecords(state.wrong, payload.wrong || {});
        state.favorites = { ...state.favorites, ...(payload.favorites || {}) };
        state.notes = { ...state.notes, ...(payload.notes || {}) };
        state.examExposure = mergeMaxNumberMap(state.examExposure, payload.examExposure || {});
        saveAndRender();
      } catch {
        alert("进度文件读取失败");
      }
    };
    reader.readAsText(file);
  }

  function mergeProgressRecords(current = {}, incoming = {}) {
    const merged = { ...current };
    for (const [id, incomingRecord] of Object.entries(incoming || {})) {
      const previous = merged[id] || {};
      const incomingAt = Date.parse(incomingRecord?.lastAt || "") || 0;
      const previousAt = Date.parse(previous?.lastAt || "") || 0;
      const latest = incomingAt >= previousAt ? incomingRecord : previous;
      const attempts = Math.max(Number(previous.attempts) || 0, Number(incomingRecord?.attempts) || 0);
      const correct = Math.max(Number(previous.correct) || 0, Number(incomingRecord?.correct) || 0);
      const wrong = Math.max(Number(previous.wrong) || 0, Number(incomingRecord?.wrong) || 0);
      merged[id] = {
        attempts: Math.max(attempts, correct + wrong),
        correct,
        wrong,
        lastCorrect: Boolean(latest?.lastCorrect),
        lastAnswer: Array.isArray(latest?.lastAnswer) ? latest.lastAnswer : [],
        lastAt: latest?.lastAt || previous?.lastAt || incomingRecord?.lastAt || ""
      };
    }
    return merged;
  }

  function mergeWrongRecords(current = {}, incoming = {}) {
    const merged = { ...current };
    for (const [id, incomingRaw] of Object.entries(incoming || {})) {
      const previous = normalizeWrongRecord(merged[id]);
      const incomingEntry = normalizeWrongRecord(incomingRaw);
      if (!incomingEntry && !previous) continue;
      if (!previous) {
        merged[id] = incomingEntry;
        continue;
      }
      if (!incomingEntry) {
        merged[id] = previous;
        continue;
      }
      const incomingAt = Date.parse(incomingEntry.lastAt || "") || 0;
      const previousAt = Date.parse(previous.lastAt || "") || 0;
      merged[id] = {
        correctStreak: Math.min(previous.correctStreak || 0, incomingEntry.correctStreak || 0),
        wrongCount: Math.max(previous.wrongCount || 0, incomingEntry.wrongCount || 0),
        reviewCount: Math.max(previous.reviewCount || 0, incomingEntry.reviewCount || 0),
        lastCorrect: incomingAt >= previousAt ? incomingEntry.lastCorrect : previous.lastCorrect,
        lastAt: incomingAt >= previousAt ? incomingEntry.lastAt : previous.lastAt,
        lastReviewAt: incomingEntry.lastReviewAt || previous.lastReviewAt || ""
      };
    }
    return merged;
  }

  function mergeMaxNumberMap(current = {}, incoming = {}) {
    const merged = { ...current };
    for (const [id, value] of Object.entries(incoming || {})) {
      merged[id] = Math.max(Number(merged[id]) || 0, Number(value) || 0);
    }
    return merged;
  }

  function saveAndRender() {
    sanitizeState();
    saveState();
    render();
  }

  function resetViewportScroll() {
    const reset = () => {
      window.scrollTo({ top: 0, left: 0 });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      const practiceLayout = document.querySelector(".layout.practice-layout");
      if (practiceLayout) practiceLayout.scrollTop = 0;
    };
    reset();
    requestAnimationFrame(reset);
    requestAnimationFrame(() => requestAnimationFrame(reset));
    setTimeout(reset, 60);
    setTimeout(reset, 180);
  }

  function rememberPracticeLocation() {
    if (!PRACTICE_MODES.includes(state.mode)) return;
    if (!questionById.has(state.currentId)) return;
    state.lastPracticeMode = state.mode;
    state.lastPracticeId = state.currentId;
  }

  function restorePracticeLocation() {
    const mode = PRACTICE_MODES.includes(state.lastPracticeMode)
      ? state.lastPracticeMode
      : "single";
    state.mode = mode;
    if (state.lastPracticeId) state.currentId = state.lastPracticeId;
    syncSelectedTypesForMode();
    state.exam = null;
  }

  function syncSelectedTypesForMode() {
    if (TYPE_MODE_MAP[state.mode]) {
      state.selectedTypes = [TYPE_MODE_MAP[state.mode]];
    }
  }

  function isVerifiedStaffId(value) {
    if (!/^\d{6}$/.test(String(value || ""))) return false;
    const number = Number(value);
    return number >= 704001 && number <= 704099;
  }

  function setupAutoHideTopbar() {
    let ticking = false;

    const update = () => {
      const currentY = Math.max(0, window.scrollY || 0);
      const isMobile = window.matchMedia("(max-width: 980px)").matches;

      if (!isMobile || currentY <= 8) {
        document.body.classList.remove("topbar-hidden");
      } else {
        document.body.classList.add("topbar-hidden");
      }

      ticking = false;
    };

    window.addEventListener(
      "scroll",
      () => {
        if (!ticking) {
          window.requestAnimationFrame(update);
          ticking = true;
        }
      },
      { passive: true }
    );
    window.addEventListener("resize", update);
  }

  function setupBottomBarSizing() {
    const update = () => {
      const topbar = document.querySelector(".topbar");
      if (!topbar) return;
      document.documentElement.style.setProperty(
        "--mobile-bottom-bar-height",
        `${Math.ceil(topbar.getBoundingClientRect().height)}px`
      );
    };

    const observer = new MutationObserver(() => window.requestAnimationFrame(update));
    observer.observe(app, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    window.requestAnimationFrame(update);
  }

  function loadFullQuestionBank(options = {}) {
    const forceStale = Boolean(options.forceStale);
    if (!isVerifiedStaffId(state.staffId)) return;
    if (!bank.isStarter) return;
    if (fullBankLoadStarted) {
      const stale = Date.now() - fullBankLoadStartedAt > 15000;
      if (!forceStale || !stale) return;
      fullBankLoadStarted = false;
    }
    if (fullBankRetryTimer) {
      clearTimeout(fullBankRetryTimer);
      fullBankRetryTimer = null;
    }
    fullBankLoadStarted = true;
    fullBankLoadStartedAt = Date.now();
    const script = document.createElement("script");
    script.src = `data/questions.js?v=${ASSET_VERSION}`;
    script.async = true;
    const timeout = setTimeout(() => {
      if (!bank.isStarter) return;
      fullBankLoadStarted = false;
      scheduleFullBankRetry();
    }, 20000);
    script.onload = () => {
      clearTimeout(timeout);
      const nextBank = window.QUIZ_BANK;
      if (!nextBank || !Array.isArray(nextBank.questions) || nextBank.questions.length <= questions.length) {
        fullBankLoadStarted = false;
        scheduleFullBankRetry();
        return;
      }
      const modeBeforeFullLoad = state.mode;
      bank = nextBank;
      questions = bank.questions || [];
      categories = bank.categories || [];
      questionById = new Map(questions.map((question) => [question.id, question]));
      categoryIds = new Set(categories.map((category) => category.id));
      if (SPECIAL_REVIEW_MODES.includes(modeBeforeFullLoad)) {
        state.mode = modeBeforeFullLoad;
      } else {
        restorePracticeLocation();
      }
      sanitizeState();
      saveState();
      render();
    };
    script.onerror = () => {
      clearTimeout(timeout);
      fullBankLoadStarted = false;
      const brand = document.querySelector(".brand p");
      if (brand) brand.textContent = `${questions.length} 题 · 完整题库稍后重试`;
      scheduleFullBankRetry();
    };
    document.head.appendChild(script);
  }

  function scheduleFullBankRetry() {
    if (!bank.isStarter || !isVerifiedStaffId(state.staffId) || fullBankRetryTimer) return;
    fullBankRetryTimer = setTimeout(() => {
      fullBankRetryTimer = null;
      loadFullQuestionBank({ forceStale: true });
    }, SPECIAL_REVIEW_MODES.includes(state.mode) ? 900 : 2500);
  }

  function toggleArrayValue(array, value) {
    const index = array.indexOf(value);
    if (index >= 0) {
      array.splice(index, 1);
    } else {
      array.push(value);
    }
  }

  function toggleObjectKey(object, key) {
    if (object[key]) {
      delete object[key];
    } else {
      object[key] = true;
    }
  }

  function shuffle(items) {
    const next = [...items];
    for (let index = next.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    }
    return next;
  }

  function sortByOption(left, right) {
    const order = "ABCDEFGHIJ正确错误";
    return order.indexOf(left) - order.indexOf(right);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatDate(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replaceAll("`", "&#096;");
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./service-worker.js").catch(() => {});
    });
  }
})();
