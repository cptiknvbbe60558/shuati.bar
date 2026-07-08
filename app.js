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
  const STORAGE_BACKUP_KEY = `${STORAGE_KEY}-backup`;
  const STORAGE_LEGACY_KEYS = [
    STORAGE_KEY,
    STORAGE_BACKUP_KEY,
    "customer-manager-quiz-state",
    "quiz-pwa-state",
    "quiz-progress"
  ];
  const STATE_SCHEMA_VERSION = 4;
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
	    ["suite", "套题练习"],
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
	  const WRONG_MASTERY_TARGET = 5;
	  const SUITE_RULE = {
	    single: { type: "单选", count: 90, points: 0.5 },
	    multiple: { type: "多选", count: 45, points: 1 },
	    judge: { type: "判断", count: 20, points: 0.5 }
	  };
	  const SUITE_MIX = {
	    priority: 0.45
	  };
	  const SUITE_TYPES = Object.keys(SUITE_RULE);
	  const SUITE_TOTAL_QUESTIONS = SUITE_TYPES.reduce((sum, key) => sum + SUITE_RULE[key].count, 0);
	  const SUITE_TOTAL_POINTS = SUITE_TYPES.reduce((sum, key) => sum + SUITE_RULE[key].count * SUITE_RULE[key].points, 0);
	  const SPECIAL_REVIEW_MODES = [];
  const FULL_TYPE_COUNTS = {
    single: 1204,
    multiple: 965,
    judge: 974
  };
  const ASSET_VERSION = "20260708_2320_state_guard";
  const PROTECTED_CLOUD_SYNC_ENABLED = typeof fetch === "function";
  const PROTECTED_CLOUD_KEY_NAME = "shuati-bar-protected-v1";
  const PROTECTED_CLOUD_DATA_KEY = "protected-state-v2";
  const PROTECTED_CLOUD_SEED_SALT = [
    "shuati.bar",
    "customer-manager-quiz",
    "favorites-wrong-v1"
  ];

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
  let remoteSyncToken = "";
  let remoteSyncTokenStaffId = "";
  let remoteSyncTokenExpiresAt = 0;
  let protectedSyncDirty = false;
  let protectedSyncRevision = 0;
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
	    favoriteSync: {},
	    mastery: {},
	    notes: {},
	    examExposure: {},
	    suiteExposure: {},
	    optionOrders: {},
	    utilityPanel: "",
    categoryMenuOpen: false,
    examStartMenuOpen: false,
    studyMode: false,
    specialIndexes: {},
    examSize: 50,
	    lastPracticeMode: "single",
	    lastPracticeId: questions[0] ? questions[0].id : "",
	    exam: null,
	    suitePapers: [],
	    suite: null
	  };

  let state = loadState();
  sanitizeState();
	  if (state.mode === "suite" && state.suite?.submitted) {
	    state.suite = null;
	  }
	  if (isVerifiedStaffId(state.staffId) && !(state.mode === "suite" && state.suite?.active)) {
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
    const saved = readStoredState();
    if (!saved) return { ...defaultState };
    return normalizeLoadedState(saved);
  }

  function readStoredState() {
    const seen = new Set();
    const candidates = [];
    for (const key of STORAGE_LEGACY_KEYS) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          candidates.push(parsed);
        }
      } catch {
        // Ignore corrupt snapshots and keep looking for a usable backup.
      }
    }
    if (!candidates.length) return null;
    return candidates.sort((left, right) => storedStateStamp(right) - storedStateStamp(left))[0];
  }

  function storedStateStamp(payload = {}) {
    return Date.parse(payload._savedAt || payload.exportedAt || payload.updatedAt || "") || 0;
  }

  function normalizeLoadedState(saved = {}) {
    try {
      return {
        ...defaultState,
        ...saved,
        drafts: { ...defaultState.drafts, ...(saved.drafts || {}) },
        revealed: { ...defaultState.revealed, ...(saved.revealed || {}) },
	        progress: { ...defaultState.progress, ...(saved.progress || {}) },
	        wrong: { ...defaultState.wrong, ...(saved.wrong || {}) },
	        favorites: { ...defaultState.favorites, ...(saved.favorites || {}) },
	        favoriteSync: { ...defaultState.favoriteSync, ...(saved.favoriteSync || {}) },
	        mastery: { ...defaultState.mastery, ...(saved.mastery || {}) },
	        notes: { ...defaultState.notes, ...(saved.notes || {}) },
	        examExposure: { ...defaultState.examExposure, ...(saved.examExposure || {}) },
	        suiteExposure: { ...defaultState.suiteExposure, ...(saved.suiteExposure || {}) },
	        optionOrders: { ...defaultState.optionOrders, ...(saved.optionOrders || {}) },
	        specialIndexes: { ...defaultState.specialIndexes, ...(saved.specialIndexes || {}) },
	        utilityPanel: defaultState.utilityPanel,
	        categoryMenuOpen: false,
	        examStartMenuOpen: false,
	        studyMode: Boolean(saved.studyMode),
	        lastPracticeMode: saved.lastPracticeMode || defaultState.lastPracticeMode,
	        lastPracticeId: saved.lastPracticeId || defaultState.lastPracticeId,
	        suitePapers: Array.isArray(saved.suitePapers) ? saved.suitePapers : [],
	        suite: saved.suite || null
	      };
    } catch {
      return { ...defaultState };
    }
  }

  function saveState() {
    rememberPracticeLocation();
    persistLocalState(createStorageSnapshot());
    if (
      PROTECTED_CLOUD_SYNC_ENABLED
      && protectedSyncDirty
      && remoteSyncReady
      && remoteSyncStaffId === state.staffId
    ) {
      scheduleRemoteStateSave();
    }
  }

  function createStorageSnapshot() {
    const snapshot = {
      ...state,
      _schemaVersion: STATE_SCHEMA_VERSION,
      _savedAt: new Date().toISOString(),
      _assetVersion: ASSET_VERSION,
      utilityPanel: "",
      categoryMenuOpen: false,
      examStartMenuOpen: false
    };
    return snapshot;
  }

  function persistLocalState(snapshot) {
    const full = JSON.stringify(snapshot);
    try {
      localStorage.setItem(STORAGE_KEY, full);
      localStorage.setItem(STORAGE_BACKUP_KEY, full);
      return;
    } catch {
      // Quota or storage hiccups should never crash the quiz screen.
    }

    try {
      const compact = {
        ...snapshot,
        drafts: {},
        revealed: {},
        optionOrders: {},
        specialIndexes: {},
        exam: null,
        categoryMenuOpen: false,
        examStartMenuOpen: false,
        utilityPanel: ""
      };
      const compactJson = JSON.stringify(compact);
      localStorage.setItem(STORAGE_KEY, compactJson);
      localStorage.setItem(STORAGE_BACKUP_KEY, compactJson);
    } catch {
      // Keep the last good local snapshot instead of blocking the UI.
    }
  }

  async function initializeRemoteState() {
    if (!PROTECTED_CLOUD_SYNC_ENABLED) return;
    if (!isVerifiedStaffId(state.staffId)) return;
    const staffId = state.staffId;
    remoteSyncReady = false;
    remoteSyncStaffId = staffId;
    ensureFavoriteSyncRecords();
    try {
      const payload = await readProtectedCloudState(staffId);
      if (state.staffId !== staffId) return;
      mergeRemoteState(payload);
      sanitizeState();
      persistLocalState(createStorageSnapshot());
      render();
    } catch {
      // The local protected records stay available when cloud storage is unreachable.
    } finally {
      if (state.staffId === staffId) {
        remoteSyncReady = true;
        markProtectedSyncDirty();
        scheduleRemoteStateSave();
      }
    }
  }

	  function mergeRemoteState(payload = {}) {
	    state.wrong = mergeWrongRecords(state.wrong, payload.wrong || {});
	    state.mastery = mergeMasteryRecords(state.mastery, payload.mastery || {});
	    state.favoriteSync = mergeFavoriteSyncRecords(
	      state.favoriteSync,
	      payload.favoriteSync || {},
      payload.favorites || {}
    );
    state.notes = { ...(payload.notes || {}), ...(state.notes || {}) };
    state.suiteExposure = mergeMaxNumberMap(state.suiteExposure, payload.suiteExposure || {});
    state.suitePapers = mergeSuitePapers(state.suitePapers, payload.suitePapers || []);
    materializeFavoritesFromSync();
  }

  function scheduleRemoteStateSave() {
    if (!remoteSyncReady || !isVerifiedStaffId(state.staffId)) return;
    if (remoteSyncTimer) clearTimeout(remoteSyncTimer);
    remoteSyncTimer = setTimeout(saveRemoteState, 450);
  }

  async function saveRemoteState() {
    remoteSyncTimer = null;
    const staffId = state.staffId;
    if (
      !protectedSyncDirty
      || !remoteSyncReady
      || !isVerifiedStaffId(staffId)
      || remoteSyncStaffId !== staffId
    ) return;
    const revision = protectedSyncRevision;
    try {
      const beforeMerge = protectedStateSignature();
      const cloudPayload = await readProtectedCloudState(staffId);
      if (state.staffId !== staffId) return;
      mergeRemoteState(cloudPayload);
      const payload = buildProtectedCloudPayload();
      await writeProtectedCloudState(staffId, payload);
      if (state.staffId === staffId) {
        persistLocalState(createStorageSnapshot());
        if (revision === protectedSyncRevision) protectedSyncDirty = false;
        const afterMerge = protectedStateSignature();
        if (beforeMerge !== afterMerge) render();
        if (protectedSyncDirty) scheduleRemoteStateSave();
      }
    } catch {
      if (state.staffId === staffId && protectedSyncDirty && !remoteSyncTimer) {
        remoteSyncTimer = setTimeout(saveRemoteState, 10000);
      }
    }
  }

  function markProtectedSyncDirty() {
    protectedSyncDirty = true;
    protectedSyncRevision += 1;
  }

  function buildProtectedCloudPayload() {
    ensureFavoriteSyncRecords();
    return {
	      version: 3,
	      updatedAt: new Date().toISOString(),
	      favorites: state.favorites,
	      favoriteSync: state.favoriteSync,
	      wrong: state.wrong,
	      mastery: state.mastery,
	      notes: state.notes,
	      suiteExposure: state.suiteExposure,
	      suitePapers: state.suitePapers
	    };
	  }

  function protectedStateSignature() {
    return JSON.stringify({
      favorites: state.favorites,
      favoriteSync: state.favoriteSync,
      wrong: state.wrong,
      mastery: state.mastery,
      notes: state.notes,
      suiteExposure: state.suiteExposure,
      suitePapers: state.suitePapers
    });
  }

  async function readProtectedCloudState(staffId) {
    const token = await getProtectedCloudToken(staffId);
    const response = await fetch(`https://prefs.us/read/?${encodeURIComponent(PROTECTED_CLOUD_DATA_KEY)}`, {
      cache: "no-store",
      headers: protectedCloudHeaders(token)
    });
    if (!response.ok) return {};
    const envelope = await response.json();
    if (!envelope?.success || envelope.value === undefined || envelope.value === null) return {};
    if (typeof envelope.value === "object") return envelope.value;
    try {
      return JSON.parse(String(envelope.value || "{}"));
    } catch {
      return {};
    }
  }

  async function writeProtectedCloudState(staffId, payload) {
    const token = await getProtectedCloudToken(staffId, true);
    const response = await fetch(
      `https://prefs.us/write/?&${encodeURIComponent(PROTECTED_CLOUD_DATA_KEY)}=`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          ...protectedCloudHeaders(token),
          "Content-Type": "text/plain"
        },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) throw new Error("protected_cloud_write_failed");
    const result = await response.json();
    if (!result?.success) throw new Error("protected_cloud_write_rejected");
  }

  async function getProtectedCloudToken(staffId, forceRefresh = false) {
    const reusable = !forceRefresh
      && remoteSyncToken
      && remoteSyncTokenStaffId === staffId
      && Date.now() < remoteSyncTokenExpiresAt;
    if (reusable) return remoteSyncToken;

    const seedHash = hashProtectedCloudSeed([staffId, ...PROTECTED_CLOUD_SEED_SALT]);
    const response = await fetch(
      `https://prefs.us/getkey/?name=${encodeURIComponent(PROTECTED_CLOUD_KEY_NAME)}&seed=${seedHash}`,
      {
        cache: "no-store",
        headers: { "X-Prefs-Secure": window.location.protocol }
      }
    );
    if (!response.ok) throw new Error("protected_cloud_key_failed");
    const result = await response.json();
    if (!result?.success || !result.token) throw new Error("protected_cloud_key_rejected");
    remoteSyncToken = result.token;
    remoteSyncTokenStaffId = staffId;
    remoteSyncTokenExpiresAt = Date.now() + 45000;
    return remoteSyncToken;
  }

  function protectedCloudHeaders(token) {
    return {
      "X-Authorization": `Token ${token}`,
      "X-Prefs-Secure": window.location.protocol
    };
  }

  function hashProtectedCloudSeed(seed) {
    return seed.map((part) => {
      const source = String(part).padStart(8, "0");
      let hash = 5381;
      for (let index = 0; index < source.length; index += 1) {
        hash = (hash * 33) ^ source.charCodeAt(index);
      }
      return (hash >>> 0).toString(16);
    }).join("");
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
	    if (state.mode === "judgeCorrect") state.mode = "judge";
	    if (state.mode === "allSelect") state.mode = "multiple";
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
	    state.mastery = state.mastery && typeof state.mastery === "object"
	      ? state.mastery
	      : {};
	    state.suiteExposure = state.suiteExposure && typeof state.suiteExposure === "object"
	      ? state.suiteExposure
	      : {};
	    state.suitePapers = normalizeSuitePapers(state.suitePapers);
	    state.suite = normalizeSuiteSession(state.suite);
	    state.favoriteSync = state.favoriteSync && typeof state.favoriteSync === "object"
	      ? state.favoriteSync
	      : {};
    ensureFavoriteSyncRecords();
    materializeFavoritesFromSync();
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
	    if (!["exam300", "suite", "search"].includes(state.mode)) {
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
	    if (state.mode === "suite") return renderSuitePractice();
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
	      suite: "完整题库加载后再生成套题练习。",
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
          <div class="dock-step-group">
            <button class="soft-button nav-icon-button" data-action="previous-question" aria-label="上一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">◀</span></button>
            <button class="soft-button nav-icon-button" data-action="next-question" aria-label="下一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">▶</span></button>
          </div>
          <div class="dock-action-group">
            <button class="soft-button" data-action="reveal-answer" ${revealed || disabledNavigation || !allowReveal ? "disabled" : ""}>答案</button>
            <button class="soft-button memorize-button ${studyMode ? "active" : ""}" data-action="toggle-study-mode" aria-pressed="${studyMode ? "true" : "false"}">背题</button>
            <button class="soft-button" data-action="random-question" ${disabledNavigation ? "disabled" : ""}>随机</button>
            <button class="solid-button" data-action="submit-practice" ${canSubmit ? "" : "disabled"}>提交</button>
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
    const hasLastResult = lastCorrect !== null && lastCorrect !== undefined;
    const statusBadge = hasLastResult
      ? `<span class="badge question-status ${lastCorrect ? "green" : "coral"}">${lastCorrect ? "上次正确" : "上次错误"}</span>`
      : '<span class="badge question-status question-status-empty" aria-hidden="true">上次正确</span>';

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
          </div>
          <div class="question-progress-row">
            <div class="question-index">${index + 1}/${total}</div>
            ${statusBadge}
          </div>
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

	  function renderSuitePractice() {
	    const suite = state.suite && state.suite.active ? state.suite : null;
	    if (suite?.submitted) return renderSuiteReport(suite);
	    if (suite) return renderSuiteRun(suite);
	    return renderSuiteHome();
	  }

	  function renderSuiteHome() {
	    const counts = typeCounts(uniqueQuestions(questions));
	    const ready = SUITE_TYPES.every((key) => counts[SUITE_RULE[key].type] >= SUITE_RULE[key].count);
	    const papers = [...state.suitePapers].sort((left, right) => (right.number || 0) - (left.number || 0));
	    const stats = suiteStats();
    const latest = papers.slice(0, 3);
	    const latestPaper = latest[0] || null;

	    return `
	      <section class="practice-screen suite-screen">
	        <div class="practice-study-area suite-home-area">
	          <section class="suite-home-card">
	            <div class="suite-home-top">
	              <div>
	                <span class="badge blue">套题练习</span>
	                <h2>按真实考试题量刷一套</h2>
	                <p>单选 90 题、多选 45 题、判断 20 题，共 ${SUITE_TOTAL_POINTS} 分。优先抽错题和收藏，不够再补普通题。</p>
	              </div>
	              <button class="solid-button" data-action="start-suite-paper" ${ready ? "" : "disabled"}>生成新套</button>
	            </div>
	            <div class="suite-rule-grid">
	              <div><strong>90</strong><span>单选 · 45 分</span></div>
	              <div><strong>45</strong><span>多选 · 45 分</span></div>
	              <div><strong>20</strong><span>判断 · 10 分</span></div>
	            </div>
	            ${ready ? "" : `<p class="footer-note">当前完整题库数量不足，无法按考试题量生成套题。</p>`}
	          </section>
	          <section class="suite-home-card suite-stats-card">
	            <div class="suite-rule-grid">
	              <div><strong>${stats.paperCount}</strong><span>已存套题</span></div>
	              <div><strong>${stats.priorityCount}</strong><span>错题/收藏待复练</span></div>
	              <div><strong>${stats.covered}</strong><span>套题覆盖题数</span></div>
	            </div>
	          </section>
	          <section class="suite-paper-list">
	            ${latest.length ? latest.map(renderSuitePaperCard).join("") : renderEmpty("还没有套题", "点生成新套，会保存为套题（一），以后可以反复重做。")}
	          </section>
	        </div>
	        ${renderSuiteHomeDock({ ready, latestPaper })}
	      </section>
	    `;
	  }

	  function renderSuiteHomeDock({ ready, latestPaper }) {
	    const latestAttempt = latestPaper ? latestSuiteAttempt(latestPaper) : null;
	    const wrongCount = latestAttempt?.wrongIds?.length || 0;
	    return `
	      <div class="practice-dock suite-dock suite-home-dock">
	        <div class="toolbar practice-toolbar">
	          <div class="dock-action-group suite-home-actions">
	            <button class="solid-button" data-action="start-suite-paper" ${ready ? "" : "disabled"}>新套</button>
	            <button class="soft-button" data-action="retry-suite-full" data-paper-id="${escapeAttr(latestPaper?.id || "")}" ${latestPaper ? "" : "disabled"}>最近重做</button>
	            <button class="soft-button" data-action="retry-suite-wrong" data-paper-id="${escapeAttr(latestPaper?.id || "")}" ${wrongCount ? "" : "disabled"}>错题重做</button>
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

	  function renderSuitePaperCard(paper) {
	    const latest = latestSuiteAttempt(paper);
	    const score = latest?.score;
	    const wrongCount = latest?.wrongIds?.length || 0;
	    const scoreText = score ? `${formatPoints(score.points)}/${SUITE_TOTAL_POINTS} 分` : "未练习";
	    return `
	      <article class="suite-paper-card">
	        <div>
	          <strong>${escapeHtml(paper.title || suitePaperTitle(paper.number))}</strong>
	          <span>${formatSuitePaperMeta(paper, latest)}</span>
	        </div>
	        <div class="suite-paper-actions">
	          ${latest ? `<button class="soft-button" data-action="view-suite-report" data-paper-id="${escapeAttr(paper.id)}" data-run-id="${escapeAttr(latest.runId)}">${scoreText}</button>` : ""}
	          <button class="soft-button" data-action="retry-suite-full" data-paper-id="${escapeAttr(paper.id)}">整卷重做</button>
	          <button class="soft-button" data-action="retry-suite-wrong" data-paper-id="${escapeAttr(paper.id)}" ${wrongCount ? "" : "disabled"}>错题重做</button>
	        </div>
	      </article>
	    `;
	  }

	  function renderSuiteRun(suite) {
	    const paper = suitePaperById(suite.paperId);
	    const ids = getVisibleSuiteIds(suite);
	    if (!paper || !ids.length) {
	      return `
	        <section class="practice-screen suite-screen">
	          <div class="practice-study-area empty-practice-area">
	            ${renderEmpty("套题不存在", "回到套题首页重新生成一套。")}
	          </div>
	          ${renderSuiteDock({ revealed: true, canSubmit: false, disabledNavigation: true })}
	        </section>
	      `;
	    }

	    applyPaperOptionOrders(paper);
	    if (suite.index >= ids.length) suite.index = 0;
	    const currentId = ids[suite.index] || ids[0];
	    const question = questionById.get(currentId);
	    if (!question) {
	      return `
	        <section class="practice-screen suite-screen">
	          <div class="practice-study-area empty-practice-area">
	            ${renderEmpty("这道题不在题库里", "完整题库加载后再进入套题。")}
	          </div>
	          ${renderSuiteDock({ revealed: true, canSubmit: false, disabledNavigation: true })}
	        </section>
	      `;
	    }

	    const selected = suite.answers?.[question.id] || [];
	    const outcome = suite.outcomes?.[question.id];
	    const revealed = Boolean(suite.revealed?.[question.id] || outcome || state.studyMode);
	    const lastCorrect = outcome ? outcome.correct : state.progress[question.id]?.lastCorrect;
	    const canSubmit = selected.length && !revealed && !state.studyMode;

	    return `
	      <section class="practice-screen suite-screen">
	        <div class="practice-study-area">
	          ${renderSuiteQuestion(question, suite.index, ids.length, selected, revealed, lastCorrect)}
	        </div>
	        ${renderSuiteDock({ revealed, canSubmit, studyMode: state.studyMode })}
	      </section>
	    `;
	  }

	  function renderSuiteQuestion(question, index, total, selected, revealed, lastCorrect) {
	    const html = renderQuestionCard({
	      question,
	      index,
	      total,
	      selected,
	      revealed,
	      lastCorrect,
	      typeSwitcher: false
	    });
	    return html.replaceAll('data-action="option"', 'data-action="suite-option"');
	  }

	  function renderSuiteDock({ revealed, canSubmit, disabledNavigation = false, studyMode = false }) {
	    return `
	      <div class="practice-dock suite-dock">
	        <div class="toolbar practice-toolbar">
	          <div class="dock-step-group">
	            <button class="soft-button nav-icon-button" data-action="previous-suite" aria-label="上一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">◀</span></button>
	            <button class="soft-button nav-icon-button" data-action="next-suite" aria-label="下一题" ${disabledNavigation ? "disabled" : ""}><span aria-hidden="true">▶</span></button>
	          </div>
	          <div class="dock-action-group">
	            <button class="soft-button" data-action="suite-reveal-answer" ${revealed || disabledNavigation ? "disabled" : ""}>答案</button>
	            <button class="soft-button memorize-button ${studyMode ? "active" : ""}" data-action="toggle-study-mode" aria-pressed="${studyMode ? "true" : "false"}">背题</button>
	            <button class="solid-button" data-action="suite-submit-answer" ${canSubmit ? "" : "disabled"}>提交</button>
	            <button class="soft-button" data-action="finish-suite" ${disabledNavigation ? "disabled" : ""}>交卷</button>
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

	  function renderSuiteReport(suite) {
	    const paper = suitePaperById(suite.paperId);
	    const attempt = suiteAttemptById(suite.paperId, suite.runId);
	    if (!paper || !attempt) return renderSuiteHome();
	    const ids = suite.reviewWrongOnly ? attempt.wrongIds || [] : attempt.ids || paper.ids || [];
	    const visibleIds = ids.length ? ids : attempt.ids || paper.ids || [];
	    return `
	      <section class="practice-screen suite-screen suite-report-wrap">
	        <div class="practice-study-area suite-report-area">
	          <section class="suite-report-screen">
	            <section class="exam-header exam-review-header suite-report-header">
	              <div>
	                <h2>${escapeHtml(paper.title || "套题练习")}</h2>
	                <p>${escapeHtml(attempt.kind === "wrong" ? "错题重做" : "整卷练习")} · ${formatPoints(attempt.score.points)}/${SUITE_TOTAL_POINTS} 分 · 错 ${attempt.wrongIds.length} 题</p>
	              </div>
	              <div class="toolbar-group">
	                <button class="soft-button" type="button" data-action="suite-home">套题首页</button>
	                ${!suite.reviewWrongOnly && attempt.wrongIds.length ? `<button class="soft-button" type="button" data-action="suite-review-wrong" data-paper-id="${escapeAttr(paper.id)}" data-run-id="${escapeAttr(attempt.runId)}">只看错题</button>` : ""}
	                ${suite.reviewWrongOnly ? `<button class="soft-button" type="button" data-action="suite-review-all" data-paper-id="${escapeAttr(paper.id)}" data-run-id="${escapeAttr(attempt.runId)}">全部题目</button>` : ""}
	                <button class="soft-button" data-action="retry-suite-full" data-paper-id="${escapeAttr(paper.id)}">整卷重做</button>
	                <button class="soft-button" data-action="retry-suite-wrong" data-paper-id="${escapeAttr(paper.id)}" ${attempt.wrongIds.length ? "" : "disabled"}>错题重做</button>
	                <button class="solid-button" data-action="start-suite-paper">新套</button>
	              </div>
	            </section>
	            ${renderSuiteScore(attempt.score)}
	            <section class="exam-review-list">
	              ${visibleIds.map((id) => renderSuiteReviewItem(paper, attempt, id)).join("")}
	            </section>
	          </section>
	        </div>
	        ${renderSuiteReportDock(paper, attempt)}
	      </section>
	    `;
	  }

	  function renderSuiteReportDock(paper, attempt) {
	    const hasWrong = Boolean(attempt?.wrongIds?.length);
	    return `
	      <div class="practice-dock suite-dock suite-report-dock">
	        <div class="toolbar practice-toolbar">
	          <div class="dock-action-group suite-report-actions">
	            <button class="soft-button" data-action="suite-home">套题首页</button>
	            <button class="soft-button" data-action="retry-suite-full" data-paper-id="${escapeAttr(paper.id)}">整卷重做</button>
	            <button class="soft-button" data-action="retry-suite-wrong" data-paper-id="${escapeAttr(paper.id)}" ${hasWrong ? "" : "disabled"}>错题重做</button>
	            <button class="solid-button" data-action="start-suite-paper">新套</button>
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

	  function renderSuiteScore(score) {
	    return `
	      <section class="result-card suite-score-card">
	        <div class="result-score">
	          <div class="score-ring" style="--value: ${score.rate}%">${score.rate}%</div>
	          <div>
	            <h2>${formatPoints(score.points)} 分</h2>
	            <p class="footer-note">单选 ${suiteTypeCorrect(score, "单选")}/90，多选 ${suiteTypeCorrect(score, "多选")}/45，判断 ${suiteTypeCorrect(score, "判断")}/20。</p>
	          </div>
	        </div>
	      </section>
	    `;
	  }

	  function renderSuiteReviewItem(paper, attempt, id) {
	    const question = questionById.get(id);
	    if (!question) return "";
	    applyPaperOptionOrders(paper);
	    const selected = attempt.answers[id] || [];
	    const correct = isCorrect(question, selected);
	    const orderIndex = Math.max(0, (attempt.ids || paper.ids || []).indexOf(id));
	    const presentedOptions = getPresentedOptions(question);
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
	          <span class="question-index">${orderIndex + 1}/${attempt.ids.length}</span>
	        </div>
	        <h3>${escapeHtml(question.question)}</h3>
	        <div class="review-answer-row">
	          <span class="answer-pill correct">正确答案：${escapeHtml(correctAnswer)}</span>
	          <span class="answer-pill ${correct ? "correct" : "wrong"}">我的答案：${escapeHtml(selectedAnswer)}</span>
	        </div>
	      </article>
	    `;
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
    let clickTarget = event.target;
    if (clickTarget && clickTarget.nodeType === 3) clickTarget = clickTarget.parentElement;
    const target = clickTarget?.closest?.("[data-action]");
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
      if (nextMode === state.mode) {
        if (nextMode === "suite") {
          if (state.suite?.submitted || !state.suite?.active) state.suite = null;
        } else if (nextMode === "exam300") {
          state.exam = null;
        }
        state.utilityPanel = "";
        state.categoryMenuOpen = false;
        state.examStartMenuOpen = false;
        saveAndRender();
        resetViewportScroll();
        return;
      }
      state.mode = nextMode;
      if (nextMode === "suite" && state.suite?.submitted) {
        state.suite = null;
      }
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
      toggleFavorite(target.dataset.id || state.currentId);
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

	    if (action === "start-suite-paper") {
	      startSuitePaper();
	      return;
	    }

	    if (action === "retry-suite-full") {
	      startSuiteRun(target.dataset.paperId, "full");
	      return;
	    }

	    if (action === "retry-suite-wrong") {
	      startSuiteRun(target.dataset.paperId, "wrong");
	      return;
	    }

	    if (action === "view-suite-report") {
	      state.mode = "suite";
	      state.suite = {
	        active: true,
	        paperId: target.dataset.paperId,
	        runId: target.dataset.runId,
	        submitted: true,
	        reviewWrongOnly: false
	      };
	      state.examStartMenuOpen = false;
	      state.utilityPanel = "";
	      saveAndRender();
	      resetViewportScroll();
	      return;
	    }

	    if (action === "suite-home") {
	      state.suite = null;
	      saveAndRender();
	      resetViewportScroll();
	      return;
	    }

	    if (action === "suite-option") {
	      updateSuiteAnswer(target.dataset.key);
	      return;
	    }

	    if (action === "suite-submit-answer") {
	      submitSuiteCurrent();
	      return;
	    }

	    if (action === "suite-reveal-answer") {
	      revealSuiteCurrent();
	      return;
	    }

	    if (action === "finish-suite") {
	      finishSuite();
	      return;
	    }

	    if (action === "next-suite" || action === "previous-suite" || action === "random-suite") {
	      moveSuite(action);
	      resetViewportScroll();
	      return;
	    }

	    if (action === "suite-review-wrong") {
	      startSuiteRun(target.dataset.paperId, "wrong");
	      return;
	    }

	    if (action === "suite-review-all") {
	      setSuiteReviewMode(target, false);
	      saveAndRender();
	      resetViewportScroll();
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
      if (confirm("清空练习进度和模拟记录？收藏、错题、笔记和工号会永久保留。")) {
        state.progress = {};
        state.drafts = {};
        state.revealed = {};
        state.examExposure = {};
        state.optionOrders = {};
        state.specialIndexes = {};
        state.exam = null;
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
    remoteSyncToken = "";
    remoteSyncTokenStaffId = "";
    remoteSyncTokenExpiresAt = 0;
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
	    recordMastery(id, correct);
	  }

  function recordWrongMastery(id, correct) {
    const previous = wrongEntry(id);
    if (correct) {
      if (!previous) return;
	      const nextStreak = (previous.correctStreak || 0) + 1;
	      state.wrong[id] = {
	        ...previous,
	        correctStreak: Math.min(nextStreak, WRONG_MASTERY_TARGET),
	        lastCorrect: true,
	        lastAt: new Date().toISOString()
	      };
      markProtectedSyncDirty();
      return;
    }

    state.wrong[id] = {
      ...(previous || {}),
      correctStreak: 0,
      wrongCount: (previous?.wrongCount || 0) + 1,
      lastCorrect: false,
      lastAt: new Date().toISOString()
    };
    markProtectedSyncDirty();
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

	  function startSuitePaper() {
	    const picked = buildSuiteQuestionIds();
	    if (!picked) {
	      alert("完整题库数量不足，暂时无法按真实考试题量生成套题。");
	      return;
	    }
	    const number = nextSuiteNumber();
	    const id = `suite-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	    const paper = {
	      id,
	      number,
	      title: suitePaperTitle(number),
	      createdAt: new Date().toISOString(),
	      ids: picked.ids,
	      priorityIds: picked.priorityIds,
	      typeCounts: {
	        "单选": SUITE_RULE.single.count,
	        "多选": SUITE_RULE.multiple.count,
	        "判断": SUITE_RULE.judge.count
	      },
	      optionOrders: buildOptionOrdersForIds(picked.ids),
	      attempts: []
	    };
	    state.suitePapers.push(paper);
	    markSuiteExposure(picked.ids);
	    markWrongReviewExposure(picked.priorityIds);
	    startSuiteRun(paper.id, "full", { skipSave: true });
	    saveAndRender();
	    resetViewportScroll();
	  }

	  function startSuiteRun(paperId, kind = "full", options = {}) {
	    const paper = suitePaperById(paperId);
	    if (!paper) return;
	    const normalizedKind = kind === "wrong" ? "wrong" : "full";
	    const latest = latestSuiteAttempt(paper);
	    const ids = normalizedKind === "wrong"
	      ? (latest?.wrongIds || []).filter((id) => questionById.has(id))
	      : (paper.ids || []).filter((id) => questionById.has(id));
	    if (!ids.length) return;
	    applyPaperOptionOrders(paper);
	    state.mode = "suite";
	    state.exam = null;
	    state.examStartMenuOpen = false;
	    state.utilityPanel = "";
	    state.suite = {
	      active: true,
	      paperId: paper.id,
	      runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	      kind: normalizedKind,
	      ids,
	      index: 0,
	      answers: {},
	      revealed: {},
	      outcomes: {},
	      submitted: false,
	      startedAt: Date.now(),
	      reviewWrongOnly: false
	    };
	    if (!options.skipSave) {
	      saveAndRender();
	      resetViewportScroll();
	    }
	  }

	  function buildSuiteQuestionIds() {
	    const ids = [];
	    const priorityIds = [];
	    for (const key of SUITE_TYPES) {
	      const rule = SUITE_RULE[key];
	      const typedQuestions = uniqueQuestions(questions).filter((question) => question.type === rule.type);
	      if (typedQuestions.length < rule.count) return null;
	      const picked = pickSuiteTypeQuestions(typedQuestions, rule.count);
	      if (picked.ids.length !== rule.count) return null;
	      ids.push(...picked.ids);
	      priorityIds.push(...picked.priorityIds);
	    }
	    return { ids, priorityIds };
	  }

	  function pickSuiteTypeQuestions(typedQuestions, count) {
	    const unique = uniqueQuestions(typedQuestions);
	    const priorityQuota = Math.round(count * SUITE_MIX.priority);
	    const used = new Set();
	    const priority = unique.filter((question) => isSuitePriority(question.id));
	    const pickedPriority = takeSuiteCandidates(priority, priorityQuota, used, true);
	    const pickedHistoryWrong = takeSuiteCandidates(
	      unique.filter((question) => isHistoricalWrong(question.id)),
	      priorityQuota - pickedPriority.length,
	      used,
	      false
	    );
	    const remainingCount = count - pickedPriority.length - pickedHistoryWrong.length;
	    const coverageFill = takeSuiteCoverageCandidates(unique, remainingCount, used);
	    const picked = [...pickedPriority, ...pickedHistoryWrong, ...coverageFill];
	    return {
	      ids: picked.map((question) => question.id),
	      priorityIds: [...pickedPriority, ...pickedHistoryWrong].map((question) => question.id)
	    };
	  }

	  function takeSuiteCandidates(source, count, used, priorityOnly) {
	    const limit = Math.max(0, count);
	    if (!limit) return [];
	    const picked = sortSuiteCandidates(
	      source.filter((question) => !used.has(question.id)),
	      priorityOnly
	    ).slice(0, limit);
	    picked.forEach((question) => used.add(question.id));
	    return picked;
	  }

	  function takeSuiteCoverageCandidates(source, count, used) {
	    const limit = Math.max(0, count);
	    if (!limit) return [];
	    const picked = sortSuiteCoverageCandidates(
	      source.filter((question) => !used.has(question.id))
	    ).slice(0, limit);
	    picked.forEach((question) => used.add(question.id));
	    return picked;
	  }

	  function sortSuiteCoverageCandidates(source) {
	    return shuffle(source).sort((left, right) => {
	      const exposureDelta = (state.suiteExposure[left.id] || 0) - (state.suiteExposure[right.id] || 0);
	      if (exposureDelta) return exposureDelta;
	      const leftMastered = isMastered(left.id) ? 1 : 0;
	      const rightMastered = isMastered(right.id) ? 1 : 0;
	      if (leftMastered !== rightMastered) return leftMastered - rightMastered;
	      return 0;
	    });
	  }

	  function sortSuiteCandidates(source, priorityOnly) {
	    return shuffle(source).sort((left, right) => {
	      const exposureDelta = (state.suiteExposure[left.id] || 0) - (state.suiteExposure[right.id] || 0);
	      if (exposureDelta) return exposureDelta;
	      if (priorityOnly) {
	        const leftWrong = isActiveWrong(left.id) ? 0 : 1;
	        const rightWrong = isActiveWrong(right.id) ? 0 : 1;
	        if (leftWrong !== rightWrong) return leftWrong - rightWrong;
	        const leftEntry = wrongEntry(left.id) || {};
	        const rightEntry = wrongEntry(right.id) || {};
	        const streakDelta = (leftEntry.correctStreak || 0) - (rightEntry.correctStreak || 0);
	        if (streakDelta) return streakDelta;
	        const reviewDelta = (leftEntry.reviewCount || 0) - (rightEntry.reviewCount || 0);
	        if (reviewDelta) return reviewDelta;
	      }
	      return 0;
	    });
	  }

	  function isSuitePriority(id) {
	    return isActiveWrong(id) || Boolean(state.favorites[id]);
	  }

	  function isHistoricalWrong(id) {
	    return Boolean(wrongEntry(id) && !isSuitePriority(id));
	  }

	  function updateSuiteAnswer(key) {
	    const suite = state.suite;
	    if (!suite || suite.submitted) return;
	    ensureSuiteRunMaps(suite);
	    const question = currentSuiteQuestion();
	    if (!question || suite.outcomes?.[question.id]) return;
	    const answer = suite.answers?.[question.id] || [];
	    suite.answers[question.id] = updateSelection(question, answer, key);
	    if (question.type !== "多选") submitSuiteCurrent();
	    else saveAndRender();
	  }

	  function submitSuiteCurrent() {
	    const suite = state.suite;
	    const question = currentSuiteQuestion();
	    if (!suite || suite.submitted || !question) return;
	    ensureSuiteRunMaps(suite);
	    const selected = suite.answers?.[question.id] || [];
	    if (!selected.length || suite.outcomes?.[question.id]) return;
	    const correct = isCorrect(question, selected);
	    suite.revealed[question.id] = true;
	    suite.outcomes[question.id] = {
	      selected,
	      correct,
	      effective: true,
	      at: new Date().toISOString()
	    };
	    recordAttempt(question.id, selected, correct);
	    saveAndRender();
	  }

	  function revealSuiteCurrent() {
	    const suite = state.suite;
	    const question = currentSuiteQuestion();
	    if (!suite || suite.submitted || !question || suite.outcomes?.[question.id]) return;
	    ensureSuiteRunMaps(suite);
	    const selected = suite.answers?.[question.id] || [];
	    suite.revealed[question.id] = true;
	    suite.outcomes[question.id] = {
	      selected,
	      correct: false,
	      effective: false,
	      revealed: true,
	      at: new Date().toISOString()
	    };
	    recordAttempt(question.id, selected, false);
	    saveAndRender();
	  }

	  function finishSuite() {
	    const suite = state.suite;
	    const paper = suite ? suitePaperById(suite.paperId) : null;
	    if (!suite || suite.submitted || !paper) return;
	    ensureSuiteRunMaps(suite);
	    const ids = getVisibleSuiteIds(suite);
	    const wrongIds = [];
	    for (const id of ids) {
	      const question = questionById.get(id);
	      if (!question) continue;
	      const selected = suite.answers?.[id] || [];
	      const outcome = suite.outcomes?.[id];
	      if (!outcome) {
	        suite.outcomes[id] = {
	          selected,
	          correct: false,
	          effective: false,
	          skipped: true,
	          at: new Date().toISOString()
	        };
	        recordAttempt(id, selected, false);
	      }
	      if (!suite.outcomes[id].correct) wrongIds.push(id);
	    }
	    const score = suiteScore(ids, suite.answers || {}, suite.outcomes || {});
	    const attempt = {
	      runId: suite.runId,
	      kind: suite.kind || "full",
	      ids,
	      answers: suite.answers || {},
	      revealedIds: Object.keys(suite.revealed || {}),
	      wrongIds,
	      score,
	      startedAt: suite.startedAt || Date.now(),
	      finishedAt: Date.now()
	    };
	    paper.attempts = Array.isArray(paper.attempts) ? paper.attempts : [];
	    paper.attempts.push(attempt);
	    state.suite = {
	      active: true,
	      paperId: paper.id,
	      runId: attempt.runId,
	      submitted: true,
	      reviewWrongOnly: false
	    };
	    saveAndRender();
	    resetViewportScroll();
	  }

	  function moveSuite(action) {
	    const suite = state.suite;
	    const ids = suite ? getVisibleSuiteIds(suite) : [];
	    if (!suite || suite.submitted || !ids.length) return;
	    if (action === "random-suite") {
	      const candidates = ids.map((_, index) => index).filter((index) => index !== suite.index);
	      suite.index = candidates[Math.floor(Math.random() * candidates.length)] || 0;
	    } else {
	      const delta = action === "previous-suite" ? -1 : 1;
	      suite.index = (suite.index + delta + ids.length) % ids.length;
	    }
	    saveAndRender();
	  }

	  function currentSuiteQuestion() {
	    const suite = state.suite;
	    const ids = suite ? getVisibleSuiteIds(suite) : [];
	    if (!suite || !ids.length) return null;
	    return questionById.get(ids[suite.index] || ids[0]) || null;
	  }

	  function getVisibleSuiteIds(suite) {
	    if (!suite) return [];
	    return (suite.ids || []).filter((id) => questionById.has(id));
	  }

	  function ensureSuiteRunMaps(suite) {
	    suite.answers = suite.answers && typeof suite.answers === "object" ? suite.answers : {};
	    suite.revealed = suite.revealed && typeof suite.revealed === "object" ? suite.revealed : {};
	    suite.outcomes = suite.outcomes && typeof suite.outcomes === "object" ? suite.outcomes : {};
	  }

	  function suitePaperById(id) {
	    return (state.suitePapers || []).find((paper) => paper.id === id) || null;
	  }

	  function suiteAttemptById(paperId, runId) {
	    const paper = suitePaperById(paperId);
	    return (paper?.attempts || []).find((attempt) => attempt.runId === runId) || null;
	  }

	  function setSuiteReviewMode(target, reviewWrongOnly) {
	    const currentPaper = state.suite ? suitePaperById(state.suite.paperId) : null;
	    const fallbackPaperId = target?.dataset?.paperId || currentPaper?.id || "";
	    const fallbackPaper = suitePaperById(fallbackPaperId);
	    const fallbackRunId = target?.dataset?.runId || state.suite?.runId || latestSuiteAttempt(fallbackPaper)?.runId || "";
	    if (!fallbackPaper || !fallbackRunId) return;
	    state.mode = "suite";
	    state.examStartMenuOpen = false;
	    state.utilityPanel = "";
	    state.categoryMenuOpen = false;
	    state.suite = {
	      active: true,
	      paperId: fallbackPaper.id,
	      runId: fallbackRunId,
	      submitted: true,
	      reviewWrongOnly
	    };
	  }

	  function latestSuiteAttempt(paper) {
	    const attempts = Array.isArray(paper?.attempts) ? paper.attempts : [];
	    return attempts[attempts.length - 1] || null;
	  }

	  function nextSuiteNumber() {
	    const numbers = (state.suitePapers || []).map((paper) => Number(paper.number) || 0);
	    return Math.max(0, ...numbers) + 1;
	  }

	  function suitePaperTitle(number) {
	    return `套题（${toChineseNumber(number)}）`;
	  }

	  function toChineseNumber(value) {
	    const number = Math.max(1, Math.trunc(Number(value) || 1));
	    const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
	    if (number <= 10) return number === 10 ? "十" : digits[number];
	    if (number < 20) return `十${digits[number % 10]}`;
	    if (number < 100) {
	      const tens = Math.floor(number / 10);
	      const ones = number % 10;
	      return `${digits[tens]}十${ones ? digits[ones] : ""}`;
	    }
	    return String(number);
	  }

	  function suiteStats() {
	    const priorityIds = uniqueQuestions(questions)
	      .filter((question) => isSuitePriority(question.id))
	      .map((question) => question.id);
	    const covered = Object.values(state.suiteExposure || {}).filter((value) => Number(value) > 0).length;
	    return {
	      paperCount: (state.suitePapers || []).length,
	      priorityCount: priorityIds.length,
	      covered
	    };
	  }

	  function formatSuitePaperMeta(paper, latest) {
	    const created = paper.createdAt ? new Date(paper.createdAt) : null;
	    const date = created && !Number.isNaN(created.getTime())
	      ? `${created.getMonth() + 1}月${created.getDate()}日`
	      : "已保存";
	    if (!latest) return `${date} · ${paper.ids?.length || SUITE_TOTAL_QUESTIONS} 题`;
	    return `${date} · 已练 ${paper.attempts.length} 次 · 错 ${latest.wrongIds?.length || 0} 题`;
	  }

	  function buildOptionOrdersForIds(ids) {
	    const orders = {};
	    for (const id of ids) {
	      const question = questionById.get(id);
	      if (!question || !Array.isArray(question.options) || question.options.length <= 1) continue;
	      orders[id] = question.options.map((option) => option.key);
	    }
	    return orders;
	  }

	  function applyPaperOptionOrders(paper) {
	    const ids = Array.isArray(paper?.ids) ? paper.ids : [];
	    for (const id of ids) {
	      const question = questionById.get(id);
	      if (!question || !Array.isArray(question.options) || question.options.length <= 1) continue;
	      state.optionOrders[id] = question.options.map((option) => option.key);
	    }
	  }

	  function markSuiteExposure(ids) {
	    for (const id of ids) {
	      state.suiteExposure[id] = (state.suiteExposure[id] || 0) + 1;
	    }
	  }

	  function suiteScore(ids, answers = {}, outcomes = {}) {
	    const byType = TYPES.reduce((result, type) => {
	      result[type] = { total: 0, correct: 0, points: 0 };
	      return result;
	    }, {});
	    let correct = 0;
	    let points = 0;
	    for (const id of ids) {
	      const question = questionById.get(id);
	      if (!question) continue;
	      const selected = answers[id] || [];
	      const outcome = outcomes[id];
	      const isEffectiveCorrect = outcome ? Boolean(outcome.correct && outcome.effective !== false) : isCorrect(question, selected);
	      const rule = Object.values(SUITE_RULE).find((item) => item.type === question.type);
	      byType[question.type].total += 1;
	      if (isEffectiveCorrect) {
	        correct += 1;
	        byType[question.type].correct += 1;
	        byType[question.type].points += rule?.points || 0;
	        points += rule?.points || 0;
	      }
	    }
	    return {
	      total: ids.length,
	      correct,
	      points,
	      rate: SUITE_TOTAL_POINTS ? Math.round((points / SUITE_TOTAL_POINTS) * 100) : 0,
	      byType
	    };
	  }

	  function formatPoints(value) {
	    const number = Number(value) || 0;
	    return Number.isInteger(number) ? String(number) : number.toFixed(1);
	  }

	  function suiteTypeCorrect(score, type) {
	    return Number(score?.byType?.[type]?.correct) || 0;
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
	        correctStreak: clamp(Number(raw.correctStreak) || 0, 0, WRONG_MASTERY_TARGET),
	        wrongCount: Number(raw.wrongCount) || 1,
        reviewCount: Number(raw.reviewCount) || 0,
        lastCorrect: Boolean(raw.lastCorrect),
        lastAt: raw.lastAt || "",
        lastReviewAt: raw.lastReviewAt || ""
      };
    }
    return null;
  }

	  function normalizeFavoriteSyncRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    return {
      active: Boolean(raw.active),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : ""
    };
	  }

	  function normalizeMasteryRecord(raw) {
	    if (!raw || typeof raw !== "object") return null;
	    return {
	      correctStreak: clamp(Number(raw.correctStreak) || 0, 0, WRONG_MASTERY_TARGET),
	      lastCorrect: Boolean(raw.lastCorrect),
	      lastAt: raw.lastAt || ""
	    };
	  }

	  function recordMastery(id, correct) {
	    if (!id) return;
	    const previous = normalizeMasteryRecord(state.mastery?.[id]) || {
	      correctStreak: 0,
	      lastCorrect: false,
	      lastAt: ""
	    };
	    state.mastery[id] = {
	      correctStreak: correct ? Math.min((previous.correctStreak || 0) + 1, WRONG_MASTERY_TARGET) : 0,
	      lastCorrect: Boolean(correct),
	      lastAt: new Date().toISOString()
	    };
	    markProtectedSyncDirty();
	  }

	  function isMastered(id) {
	    const mastery = normalizeMasteryRecord(state.mastery?.[id]);
	    const wrong = wrongEntry(id);
	    return Boolean(
	      (mastery && mastery.correctStreak >= WRONG_MASTERY_TARGET) ||
	      (wrong && wrong.correctStreak >= WRONG_MASTERY_TARGET)
	    );
	  }

  function ensureFavoriteSyncRecords() {
    state.favoriteSync = state.favoriteSync && typeof state.favoriteSync === "object"
      ? state.favoriteSync
      : {};
    for (const [id, active] of Object.entries(state.favorites || {})) {
      if (!active || normalizeFavoriteSyncRecord(state.favoriteSync[id])) continue;
      state.favoriteSync[id] = {
        active: true,
        updatedAt: ""
      };
    }
  }

  function materializeFavoritesFromSync() {
    const favorites = {};
    for (const [id, raw] of Object.entries(state.favoriteSync || {})) {
      const record = normalizeFavoriteSyncRecord(raw);
      if (record?.active) favorites[id] = true;
    }
    state.favorites = favorites;
  }

  function mergeFavoriteSyncRecords(current = {}, incoming = {}, legacyIncoming = {}) {
    const left = {};
    const right = {};
    for (const [id, raw] of Object.entries(current || {})) {
      const record = normalizeFavoriteSyncRecord(raw);
      if (record) left[id] = record;
    }
    for (const [id, raw] of Object.entries(incoming || {})) {
      const record = normalizeFavoriteSyncRecord(raw);
      if (record) right[id] = record;
    }
    for (const [id, active] of Object.entries(legacyIncoming || {})) {
      if (active && !right[id]) right[id] = { active: true, updatedAt: "" };
    }

    const merged = {};
    const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const id of ids) {
      const local = left[id];
      const remote = right[id];
      if (!local) {
        merged[id] = remote;
        continue;
      }
      if (!remote) {
        merged[id] = local;
        continue;
      }

      const localAt = Date.parse(local.updatedAt || "") || 0;
      const remoteAt = Date.parse(remote.updatedAt || "") || 0;
      if (localAt !== remoteAt) {
        merged[id] = localAt > remoteAt ? local : remote;
      } else if (!localAt) {
        merged[id] = {
          active: local.active || remote.active,
          updatedAt: ""
        };
      } else {
        merged[id] = local.active === remote.active
          ? local
          : { active: false, updatedAt: local.updatedAt || remote.updatedAt };
      }
    }
    return merged;
  }

	  function isActiveWrong(id) {
	    const entry = wrongEntry(id);
	    return Boolean(entry && entry.correctStreak < WRONG_MASTERY_TARGET && questionById.has(id));
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
    let changed = false;
    for (const id of ids) {
      const entry = wrongEntry(id);
      if (!entry) continue;
      state.wrong[id] = {
        ...entry,
        reviewCount: (entry.reviewCount || 0) + 1,
        lastReviewAt: now
      };
      changed = true;
    }
    if (changed) markProtectedSyncDirty();
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
	    if (mode === "suite") return (state.suitePapers || []).length;
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
    return originalOptions.map((option) => {
      return {
        originalKey: option.key,
        key: option.key,
        text: option.text || ""
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
      state.optionOrders[id] = question.options.map((option) => option.key);
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
	      mastery: state.mastery,
	      notes: state.notes,
	      examExposure: state.examExposure,
	      suiteExposure: state.suiteExposure,
	      suitePapers: state.suitePapers
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
	        state.mastery = mergeMasteryRecords(state.mastery, payload.mastery || {});
        const importedAt = new Date().toISOString();
        for (const [id, active] of Object.entries(payload.favorites || {})) {
          if (!active) continue;
          state.favoriteSync[id] = { active: true, updatedAt: importedAt };
        }
        materializeFavoritesFromSync();
	        state.notes = { ...state.notes, ...(payload.notes || {}) };
	        state.examExposure = mergeMaxNumberMap(state.examExposure, payload.examExposure || {});
	        state.suiteExposure = mergeMaxNumberMap(state.suiteExposure, payload.suiteExposure || {});
	        state.suitePapers = mergeSuitePapers(state.suitePapers, payload.suitePapers || []);
	        markProtectedSyncDirty();
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
      let latest = previous;
      if (incomingAt > previousAt) {
        latest = incomingEntry;
      } else if (incomingAt === previousAt && incomingAt > 0) {
        latest = incomingEntry.wrongCount >= previous.wrongCount ? incomingEntry : previous;
      }
      const latestReviewAt = [previous.lastReviewAt, incomingEntry.lastReviewAt]
        .filter(Boolean)
        .sort((left, right) => (Date.parse(right) || 0) - (Date.parse(left) || 0))[0] || "";
      merged[id] = {
        correctStreak: incomingAt || previousAt
          ? latest.correctStreak || 0
          : Math.min(previous.correctStreak || 0, incomingEntry.correctStreak || 0),
        wrongCount: Math.max(previous.wrongCount || 0, incomingEntry.wrongCount || 0),
        reviewCount: Math.max(previous.reviewCount || 0, incomingEntry.reviewCount || 0),
        lastCorrect: Boolean(latest.lastCorrect),
        lastAt: latest.lastAt || "",
        lastReviewAt: latestReviewAt
      };
    }
	    return merged;
	  }

	  function mergeMasteryRecords(current = {}, incoming = {}) {
	    const merged = { ...current };
	    for (const [id, incomingRaw] of Object.entries(incoming || {})) {
	      const previous = normalizeMasteryRecord(merged[id]);
	      const incomingRecord = normalizeMasteryRecord(incomingRaw);
	      if (!incomingRecord && !previous) continue;
	      if (!previous) {
	        merged[id] = incomingRecord;
	        continue;
	      }
	      if (!incomingRecord) {
	        merged[id] = previous;
	        continue;
	      }
	      const incomingAt = Date.parse(incomingRecord.lastAt || "") || 0;
	      const previousAt = Date.parse(previous.lastAt || "") || 0;
	      merged[id] = incomingAt >= previousAt ? incomingRecord : previous;
	    }
	    return merged;
	  }

	  function normalizeSuitePapers(raw) {
	    if (!Array.isArray(raw)) return [];
	    return raw
	      .filter((paper) => paper && typeof paper === "object" && Array.isArray(paper.ids))
	      .map((paper, index) => {
	        const ids = paper.ids.filter((id) => typeof id === "string");
	        const attempts = Array.isArray(paper.attempts)
	          ? paper.attempts
	              .filter((attempt) => attempt && typeof attempt === "object" && Array.isArray(attempt.ids))
	              .map((attempt) => ({
	                runId: String(attempt.runId || `run-${index}-${Date.now()}`),
	                kind: attempt.kind === "wrong" ? "wrong" : "full",
	                ids: attempt.ids.filter((id) => typeof id === "string"),
	                answers: normalizeAnswerMap(attempt.answers),
	                revealedIds: Array.isArray(attempt.revealedIds) ? attempt.revealedIds.filter((id) => typeof id === "string") : [],
	                wrongIds: Array.isArray(attempt.wrongIds) ? attempt.wrongIds.filter((id) => typeof id === "string") : [],
	                score: attempt.score || { total: 0, correct: 0, points: 0, rate: 0, byType: {} },
	                startedAt: Number(attempt.startedAt) || Date.now(),
	                finishedAt: Number(attempt.finishedAt) || Date.now()
	              }))
	          : [];
	        return {
	          id: String(paper.id || `suite-${index + 1}`),
	          number: Number(paper.number) || index + 1,
	          title: paper.title || suitePaperTitle(Number(paper.number) || index + 1),
	          createdAt: paper.createdAt || "",
	          ids,
	          priorityIds: Array.isArray(paper.priorityIds) ? paper.priorityIds.filter((id) => typeof id === "string") : [],
	          typeCounts: paper.typeCounts || {},
	          optionOrders: normalizeOptionOrderMap(paper.optionOrders),
	          attempts
	        };
	      });
	  }

	  function mergeSuitePapers(current = [], incoming = []) {
	    const merged = new Map();
	    for (const paper of normalizeSuitePapers(current)) merged.set(paper.id, paper);
	    for (const paper of normalizeSuitePapers(incoming)) {
	      const previous = merged.get(paper.id);
	      if (!previous) {
	        merged.set(paper.id, paper);
	        continue;
	      }
	      const attempts = new Map();
	      for (const attempt of previous.attempts || []) attempts.set(attempt.runId, attempt);
	      for (const attempt of paper.attempts || []) attempts.set(attempt.runId, attempt);
	      merged.set(paper.id, {
	        ...previous,
	        ...paper,
	        ids: paper.ids.length ? paper.ids : previous.ids,
	        optionOrders: Object.keys(paper.optionOrders || {}).length ? paper.optionOrders : previous.optionOrders,
	        attempts: [...attempts.values()].sort((left, right) => (left.startedAt || 0) - (right.startedAt || 0))
	      });
	    }
	    return [...merged.values()].sort((left, right) => (left.number || 0) - (right.number || 0));
	  }

	  function normalizeSuiteSession(raw) {
	    if (!raw || typeof raw !== "object" || !raw.active) return null;
	    const paperId = String(raw.paperId || "");
	    if (!paperId) return null;
	    if (raw.submitted) {
	      return {
	        active: true,
	        paperId,
	        runId: String(raw.runId || ""),
	        submitted: true,
	        reviewWrongOnly: Boolean(raw.reviewWrongOnly)
	      };
	    }
	    return {
	      active: true,
	      paperId,
	      runId: String(raw.runId || `run-${Date.now()}`),
	      kind: raw.kind === "wrong" ? "wrong" : "full",
	      ids: Array.isArray(raw.ids) ? raw.ids.filter((id) => typeof id === "string") : [],
	      index: Number(raw.index) || 0,
	      answers: normalizeAnswerMap(raw.answers),
	      revealed: normalizeBooleanMap(raw.revealed),
	      outcomes: normalizeSuiteOutcomes(raw.outcomes),
	      submitted: false,
	      startedAt: Number(raw.startedAt) || Date.now(),
	      reviewWrongOnly: false
	    };
	  }

	  function normalizeAnswerMap(raw) {
	    const result = {};
	    for (const [id, values] of Object.entries(raw || {})) {
	      if (!Array.isArray(values)) continue;
	      result[id] = values.map((value) => String(value)).filter(Boolean).sort(sortByOption);
	    }
	    return result;
	  }

	  function normalizeBooleanMap(raw) {
	    const result = {};
	    for (const [id, value] of Object.entries(raw || {})) {
	      if (value) result[id] = true;
	    }
	    return result;
	  }

	  function normalizeOptionOrderMap(raw) {
	    const result = {};
	    for (const [id, values] of Object.entries(raw || {})) {
	      if (!Array.isArray(values)) continue;
	      result[id] = values.map((value) => String(value)).filter(Boolean);
	    }
	    return result;
	  }

	  function normalizeSuiteOutcomes(raw) {
	    const result = {};
	    for (const [id, value] of Object.entries(raw || {})) {
	      if (!value || typeof value !== "object") continue;
	      result[id] = {
	        selected: Array.isArray(value.selected) ? value.selected.map((item) => String(item)).filter(Boolean).sort(sortByOption) : [],
	        correct: Boolean(value.correct),
	        effective: value.effective !== false,
	        revealed: Boolean(value.revealed),
	        skipped: Boolean(value.skipped),
	        at: value.at || ""
	      };
	    }
	    return result;
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
	      if (SPECIAL_REVIEW_MODES.includes(modeBeforeFullLoad) || modeBeforeFullLoad === "suite") {
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
	    }, (SPECIAL_REVIEW_MODES.includes(state.mode) || state.mode === "suite") ? 900 : 2500);
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

  function toggleFavorite(id) {
    if (!id) return;
    const active = !Boolean(state.favorites[id]);
    state.favoriteSync[id] = {
      active,
      updatedAt: new Date().toISOString()
    };
    materializeFavoritesFromSync();
    markProtectedSyncDirty();
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
      const controlled = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .then(async () => {
          if ("caches" in window) {
            const keys = await caches.keys();
            await Promise.all(
              keys
                .filter((key) => key.startsWith("quiz-pwa-") || key.startsWith("shuati-bar-"))
                .map((key) => caches.delete(key))
            );
          }
          if (controlled && !sessionStorage.getItem("shuati-sw-cleaned")) {
            sessionStorage.setItem("shuati-sw-cleaned", "1");
            window.location.reload();
          }
        })
        .catch(() => {});
    });
  }
})();
