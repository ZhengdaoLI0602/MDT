(() => {
  const STORAGE_KEY = "ledgerPilot.v1";
  const OCR_SCRIPT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
  const SHARE_DB_NAME = "ledgerPilot.shareTarget.v1";
  const SHARE_STORE = "incomingScreenshots";
  const DEFAULT_CATEGORIES = ["餐饮", "交通", "购物", "生活缴费", "住房", "医疗", "学习", "娱乐", "旅行", "人情", "还款", "收入", "其他"];
  const QUICK_CATEGORIES = ["餐饮", "交通", "购物", "生活缴费", "医疗", "学习", "娱乐", "旅行", "人情", "还款", "其他"];
  const DEFAULT_RULES = [
    { pattern: "美团|淘宝闪购|麦当劳|肯德基|星巴克|瑞幸|餐厅|饭|咖啡|奶茶", category: "餐饮" },
    { pattern: "滴滴|高德|地铁|公交|铁路|航空|机票|停车|加油", category: "交通" },
    { pattern: "淘宝|天猫|京东|拼多多|亚马逊|Apple Store|商店|超市", category: "购物" },
    { pattern: "水费|电费|燃气|移动|联通|电信|宽带|物业", category: "生活缴费" },
    { pattern: "医院|药房|诊所|体检|医保", category: "医疗" },
    { pattern: "学费|课程|Udemy|Coursera|书店|论文|学校", category: "学习" },
    { pattern: "信用卡|还款|花呗|借呗|贷款|房贷|车贷", category: "还款" },
  ];

  const state = loadState();
  let currentTab = "pending";
  let importPreview = [];
  let selectedImportFile = null;
  let selectedScreenshotFile = null;
  let selectedScreenshotUrl = "";
  let screenshotBusy = false;
  let ocrEnginePromise = null;

  const qs = (selector, root = document) => root.querySelector(selector);
  const qsa = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    seedDemoDateFields();
    bindEvents();
    refreshCategoryList();
    renderQuickCategoryChips();
    handleUrlIntent();
    handleShareTargetIntent();
    render();
    checkReminders();
    registerServiceWorker();
    setInterval(checkReminders, 60_000);
  }

  function loadState() {
    const fallback = {
      transactions: [],
      pending: [],
      reminders: [],
      categoryRules: DEFAULT_RULES,
      settings: {},
    };

    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return {
        transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        reminders: Array.isArray(parsed.reminders) ? parsed.reminders : [],
        categoryRules: Array.isArray(parsed.categoryRules) ? parsed.categoryRules : DEFAULT_RULES,
        settings: parsed.settings || {},
      };
    } catch {
      return fallback;
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function bindEvents() {
    qsa(".tab-button").forEach((button) => {
      button.addEventListener("click", () => {
        currentTab = button.dataset.tab;
        render();
      });
    });

    qs("#manualForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const record = formToRecord(new FormData(event.currentTarget), "manual");
      if (event.currentTarget.elements.pendingFirst.checked) {
        addPending(record);
        toast("已加入待确认箱。");
      } else {
        record.status = "confirmed";
        state.transactions.unshift(record);
        saveState();
        toast("已入账。");
      }
      event.currentTarget.reset();
      seedDemoDateFields();
      render();
    });

    qs("#textCaptureForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const source = data.get("source");
      const text = String(data.get("text") || "");
      if (!text.trim()) {
        toast("请先粘贴短信、邮件或 OCR 文本。");
        return;
      }
      const record = parseFreeText(text, source);
      addPending(record);
      event.currentTarget.reset();
      currentTab = "pending";
      toast("已解析到待确认箱。");
      render();
    });

    qs("#screenshotInput").addEventListener("change", (event) => {
      const file = event.target.files?.[0] || null;
      if (file) setScreenshotFile(file);
      event.target.value = "";
    });
    qs("#screenshotPasteButton").addEventListener("click", readClipboardScreenshot);
    qs("#screenshotOcrForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!selectedScreenshotFile) {
        toast("请先选择或粘贴一张截图。");
        return;
      }
      const source = new FormData(event.currentTarget).get("source") || "ocr";
      await recognizeScreenshotFile(selectedScreenshotFile, source);
    });
    document.addEventListener("paste", handleScreenshotPaste);

    qs("#billInput").addEventListener("change", (event) => {
      selectedImportFile = event.target.files?.[0] || null;
      qs("#importSummary").textContent = selectedImportFile ? `已选择：${selectedImportFile.name}` : "尚未选择文件。";
    });

    qs("#importPreviewButton").addEventListener("click", previewBillImport);
    qs("#commitImportButton").addEventListener("click", commitBillImport);
    qs("#clearIgnoredButton").addEventListener("click", clearIgnoredPending);
    qs("#closeEditorButton").addEventListener("click", closeEditor);
    qs("#editForm").addEventListener("submit", saveEditedPending);
    qs("#ledgerSearch").addEventListener("input", renderLedger);
    qs("#quickExpenseButton").addEventListener("click", () => openQuickExpense());
    qs("#closeQuickExpenseButton").addEventListener("click", closeQuickExpense);
    qs("#quickExpenseForm").addEventListener("submit", saveQuickExpense);

    qs("#reminderForm").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const reminder = {
        id: uid("reminder"),
        title: String(form.get("title") || "").trim(),
        dayOfMonth: clampNumber(Number(form.get("dayOfMonth")), 1, 31, 10),
        advanceDays: clampNumber(Number(form.get("advanceDays")), 0, 15, 3),
        amount: parseAmount(form.get("amount")),
        note: String(form.get("note") || "").trim(),
        active: true,
        createdAt: new Date().toISOString(),
      };
      state.reminders.push(reminder);
      saveState();
      event.currentTarget.reset();
      qs("#reminderForm [name='dayOfMonth']").value = 10;
      qs("#reminderForm [name='advanceDays']").value = 3;
      toast("已添加还款提醒。");
      render();
    });

    qs("#notificationButton").addEventListener("click", requestNotificationPermission);
    qs("#exportJsonButton").addEventListener("click", exportBackup);
    qs("#backupInput").addEventListener("change", importBackup);
  }

  function seedDemoDateFields() {
    const input = qs("#manualForm [name='occurredAt']");
    if (input && !input.value) input.value = toDateTimeLocal(new Date());
  }

  function render() {
    renderTabs();
    renderSummary();
    renderShortcutExample();
    renderScreenshotCapture();
    renderQuickCategoryChips();
    renderPending();
    renderLedger();
    renderReminders();
    renderImportPreview();
  }

  function renderTabs() {
    qsa(".tab-button").forEach((button) => button.classList.toggle("active", button.dataset.tab === currentTab));
    qsa(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === currentTab));
  }

  function renderSummary() {
    const now = new Date();
    const monthExpense = state.transactions
      .filter((item) => item.direction === "expense")
      .filter((item) => {
        const date = new Date(item.occurredAt);
        return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
      })
      .reduce((sum, item) => sum + Number(item.amount || 0), 0);

    qs("#monthExpense").textContent = money(monthExpense);
    qs("#pendingCount").textContent = String(state.pending.filter((item) => item.status !== "ignored").length);
    qs("#duplicateCount").textContent = String(state.pending.filter((item) => item.status === "duplicate_review").length);
    qs("#nextReminder").textContent = nextReminderLabel();
  }

  function renderPending() {
    const list = qs("#pendingList");
    const visible = state.pending.filter((item) => item.status !== "ignored");
    qs("#pendingEmpty").classList.toggle("hidden", visible.length > 0);

    list.innerHTML = visible.map((item) => pendingCard(item)).join("");
    qsa("[data-action]", list).forEach((button) => button.addEventListener("click", handlePendingAction));
  }

  function pendingCard(item) {
    const duplicate = item.status === "duplicate_review";
    const duplicateHtml = duplicate ? duplicateBox(item) : "";
    return `
      <article class="record-card ${duplicate ? "duplicate" : ""}" data-id="${item.id}">
        <div class="record-top">
          <div class="record-main">
            <div class="merchant">${escapeHtml(item.merchant || "未识别商户")}</div>
            <div class="meta">
              <span class="pill ${duplicate ? "warn" : "ok"}">${duplicate ? "疑似重复" : "待确认"}</span>
              <span class="pill">${escapeHtml(sourceLabel(item.source))}</span>
              <span class="pill">${escapeHtml(item.channel || "未知渠道")}</span>
              <span class="pill">${escapeHtml(item.category || "待分类")}</span>
              <span>${formatDate(item.occurredAt)}</span>
            </div>
          </div>
          <div class="amount ${item.direction === "income" ? "income" : "expense"}">${item.direction === "income" ? "+" : "-"}${money(item.amount)}</div>
        </div>
        ${item.note ? `<p class="meta">${escapeHtml(item.note)}</p>` : ""}
        ${duplicateHtml}
        <div class="actions">
          <button class="primary" data-action="confirm" data-id="${item.id}" type="button">确认入账</button>
          <button class="secondary" data-action="edit" data-id="${item.id}" type="button">修改</button>
          ${duplicate ? `<button class="secondary" data-action="keep-both" data-id="${item.id}" type="button">两条都保留</button>` : ""}
          <button class="danger" data-action="ignore" data-id="${item.id}" type="button">忽略</button>
        </div>
      </article>
    `;
  }

  function duplicateBox(item) {
    const candidates = (item.duplicateCandidates || []).map((candidate) => {
      const existing = findRecordByRef(candidate);
      if (!existing) return "";
      return `
        <li>
          ${escapeHtml(existing.merchant || "未识别商户")} · ${money(existing.amount)} · ${formatDate(existing.occurredAt)}
          <div class="actions">
            <button class="secondary" data-action="keep-existing" data-id="${item.id}" data-ref="${candidate.collection}:${candidate.id}" type="button">保留已有</button>
            <button class="secondary" data-action="merge" data-id="${item.id}" data-ref="${candidate.collection}:${candidate.id}" type="button">合并</button>
            <button class="danger" data-action="replace" data-id="${item.id}" data-ref="${candidate.collection}:${candidate.id}" type="button">用新记录替换</button>
          </div>
        </li>
      `;
    }).join("");

    return `
      <div class="duplicate-box">
        <strong>发现疑似重复消费</strong>
        <p class="meta">请确认保留哪一条，App 不会自动删除或覆盖。</p>
        <ul>${candidates}</ul>
      </div>
    `;
  }

  function renderLedger() {
    const list = qs("#ledgerList");
    const keyword = (qs("#ledgerSearch").value || "").trim().toLowerCase();
    const records = [...state.transactions]
      .filter((item) => {
        if (!keyword) return true;
        return [item.merchant, item.category, item.note, item.channel, sourceLabel(item.source)]
          .join(" ")
          .toLowerCase()
          .includes(keyword);
      })
      .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));

    if (!records.length) {
      list.innerHTML = `<div class="empty-state">暂无正式账单。</div>`;
      return;
    }

    list.innerHTML = records.map((item) => `
      <article class="record-card">
        <div class="record-top">
          <div class="record-main">
            <div class="merchant">${escapeHtml(item.merchant || "未识别商户")}</div>
            <div class="meta">
              <span class="pill">${escapeHtml(item.category || "待分类")}</span>
              <span class="pill">${escapeHtml(item.channel || "未知渠道")}</span>
              <span class="pill">${escapeHtml(sourceLabel(item.source))}</span>
              <span>${formatDate(item.occurredAt)}</span>
            </div>
          </div>
          <div class="amount ${item.direction === "income" ? "income" : "expense"}">${item.direction === "income" ? "+" : "-"}${money(item.amount)}</div>
        </div>
        ${item.note ? `<p class="meta">${escapeHtml(item.note)}</p>` : ""}
      </article>
    `).join("");
  }

  function renderReminders() {
    const list = qs("#reminderList");
    if (!state.reminders.length) {
      list.innerHTML = `<div class="empty-state">暂无还款提醒。</div>`;
      return;
    }

    list.innerHTML = state.reminders.map((item) => `
      <article class="record-card">
        <div class="record-top">
          <div>
            <div class="merchant">${escapeHtml(item.title)}</div>
            <div class="meta">
              <span class="pill">每月 ${item.dayOfMonth} 号</span>
              <span class="pill">提前 ${item.advanceDays} 天</span>
              ${item.amount ? `<span class="pill">${money(item.amount)}</span>` : ""}
              <span>${escapeHtml(reminderDueLabel(item))}</span>
            </div>
          </div>
          <div class="actions">
            <button class="secondary" data-reminder-action="ics" data-id="${item.id}" type="button">导出日历</button>
            <button class="danger" data-reminder-action="delete" data-id="${item.id}" type="button">删除</button>
          </div>
        </div>
        ${item.note ? `<p class="meta">${escapeHtml(item.note)}</p>` : ""}
      </article>
    `).join("");

    qsa("[data-reminder-action]", list).forEach((button) => {
      button.addEventListener("click", () => {
        const reminder = state.reminders.find((item) => item.id === button.dataset.id);
        if (!reminder) return;
        if (button.dataset.reminderAction === "delete") {
          state.reminders = state.reminders.filter((item) => item.id !== reminder.id);
          saveState();
          render();
          return;
        }
        exportReminderIcs(reminder);
      });
    });
  }

  function renderImportPreview() {
    const tbody = qs("#importTable tbody");
    if (!importPreview.length) {
      tbody.innerHTML = "";
      qs("#commitImportButton").disabled = true;
      return;
    }

    qs("#commitImportButton").disabled = false;
    tbody.innerHTML = importPreview.map((item) => `
      <tr>
        <td>${item.duplicateCandidates?.length ? `<span class="pill warn">疑似重复</span>` : `<span class="pill ok">可导入</span>`}</td>
        <td>${formatDate(item.occurredAt)}</td>
        <td>${item.direction === "income" ? "+" : "-"}${money(item.amount)}</td>
        <td>${escapeHtml(item.merchant || "未识别商户")}</td>
        <td>${escapeHtml(item.category || "待分类")}</td>
        <td>${escapeHtml(sourceLabel(item.source))}</td>
      </tr>
    `).join("");
  }

  function renderShortcutExample() {
    const base = location.href.split("?")[0].split("#")[0];
    qs("#shortcutUrlExample").textContent = [
      `${base}?intent=quickExpense`,
      `${base}?intent=wechatOcr&text=${encodeURIComponent("微信支付成功 ￥35.80 收款方 瑞幸咖啡")}`,
      `${base}?intent=alipayOcr&text=${encodeURIComponent("支付宝 支付成功 ￥35.80 商户 瑞幸咖啡")}`,
      `${base}?intent=bankMessage&text=${encodeURIComponent("招商银行 快捷支付支出 35.80 元 商户 瑞幸咖啡 支付宝")}`,
    ].join("\n");
  }

  function renderQuickCategoryChips() {
    const form = qs("#quickExpenseForm");
    const chips = qs("#quickCategoryChips");
    if (!form || !chips) return;

    const selected = form.elements.category.value || QUICK_CATEGORIES[0];
    chips.innerHTML = QUICK_CATEGORIES.map((category) => `
      <button class="category-chip ${category === selected ? "active" : ""}" data-category="${escapeHtml(category)}" type="button">
        ${escapeHtml(category)}
      </button>
    `).join("");

    qsa("[data-category]", chips).forEach((button) => {
      button.addEventListener("click", () => {
        form.elements.category.value = button.dataset.category;
        renderQuickCategoryChips();
      });
    });
  }

  function openQuickExpense(preset = {}) {
    const form = qs("#quickExpenseForm");
    form.reset();
    form.elements.amount.value = preset.amount ? String(preset.amount) : "";
    form.elements.channel.value = preset.channel || "微信";
    form.elements.category.value = preset.category || QUICK_CATEGORIES[0];
    form.elements.merchant.value = preset.merchant || "";
    form.elements.occurredAt.value = toDateTimeLocalInput(preset.occurredAt || localDateTimeString(new Date()));
    form.elements.note.value = preset.note || "";
    renderQuickCategoryChips();
    qs("#quickExpensePanel").classList.remove("hidden");
    setTimeout(() => form.elements.amount.focus(), 0);
  }

  function closeQuickExpense() {
    qs("#quickExpensePanel").classList.add("hidden");
  }

  function saveQuickExpense(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const amount = Math.abs(parseAmount(form.elements.amount.value));
    if (amount <= 0) {
      toast("请先填写金额。");
      return;
    }

    const category = form.elements.category.value || QUICK_CATEGORIES[0];
    const merchant = form.elements.merchant.value.trim() || category;
    const record = normalizeRecord({
      amount,
      direction: "expense",
      occurredAt: parseDate(form.elements.occurredAt.value) || localDateTimeString(new Date()),
      channel: form.elements.channel.value || "其他",
      merchant,
      category,
      note: form.elements.note.value.trim(),
      source: "quick_expense",
      rawText: "背部轻点快速记账",
      status: "confirmed",
      confidence: 1,
    });

    state.transactions.unshift({
      ...record,
      status: "confirmed",
      confirmedAt: new Date().toISOString(),
    });
    saveState();
    closeQuickExpense();
    currentTab = "ledger";
    render();
    toast("已记录到本地账本。");
  }

  function renderScreenshotCapture() {
    const preview = qs("#screenshotPreview");
    const button = qs("#screenshotOcrButton");
    if (!preview || !button) return;

    if (selectedScreenshotFile && selectedScreenshotUrl) {
      preview.innerHTML = `
        <img alt="待识别截图预览" src="${selectedScreenshotUrl}" />
        <span>${escapeHtml(selectedScreenshotFile.name || "截图")} · ${Math.round(selectedScreenshotFile.size / 1024)} KB</span>
      `;
    } else {
      preview.textContent = "尚未选择截图。";
    }

    button.disabled = !selectedScreenshotFile || screenshotBusy;
  }

  function setScreenshotFile(file) {
    if (!file || !String(file.type || "").startsWith("image/")) {
      toast("请选择图片格式的截图。");
      return false;
    }

    if (selectedScreenshotUrl) URL.revokeObjectURL(selectedScreenshotUrl);
    selectedScreenshotFile = file;
    selectedScreenshotUrl = URL.createObjectURL(file);
    setOcrStatus("已读取截图。iPhone/iPad 上更推荐用快捷指令调用系统 OCR；这里的浏览器 OCR 作为备用。");
    renderScreenshotCapture();
    return true;
  }

  function setOcrStatus(message) {
    const node = qs("#screenshotOcrStatus");
    if (node) node.textContent = message;
  }

  function handleScreenshotPaste(event) {
    const files = Array.from(event.clipboardData?.files || []);
    const image = files.find((file) => String(file.type || "").startsWith("image/"));
    if (!image) return;

    event.preventDefault();
    if (setScreenshotFile(image)) {
      currentTab = "capture";
      render();
      toast("已粘贴截图，可以开始识别。");
    }
  }

  async function readClipboardScreenshot() {
    if (!navigator.clipboard?.read) {
      toast("当前浏览器不能直接读取剪贴板图片，请用“选择截图”或 iOS 快捷指令。");
      return;
    }

    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((value) => value.startsWith("image/"));
        if (!type) continue;
        const blob = await item.getType(type);
        const file = new File([blob], `clipboard-screenshot.${imageExtension(type)}`, { type });
        if (setScreenshotFile(file)) toast("已读取剪贴板截图，可以开始识别。");
        return;
      }
      toast("剪贴板里没有图片。");
    } catch {
      toast("没有获得剪贴板图片权限，请改用“选择截图”。");
    }
  }

  async function recognizeScreenshotFile(file, source = "ocr") {
    if (screenshotBusy) return;
    screenshotBusy = true;
    renderScreenshotCapture();

    try {
      setOcrStatus("正在加载浏览器 OCR 引擎。若在 iPhone/iPad 上频繁使用，建议改用快捷指令的系统 OCR 路线。");
      const tesseract = await loadOcrEngine();
      setOcrStatus("正在识别截图文字...");
      const result = await tesseract.recognize(file, "chi_sim+eng", {
        logger(message) {
          if (message.status === "recognizing text" && Number.isFinite(message.progress)) {
            setOcrStatus(`正在识别截图文字... ${Math.round(message.progress * 100)}%`);
          }
        },
      });
      const text = String(result?.data?.text || "").trim();
      if (!text) {
        setOcrStatus("没有从截图中识别到文字。");
        toast("截图 OCR 没有识别到文字。");
        return;
      }

      const record = parseFreeText(text, source);
      addPending(record);
      const textarea = qs("#textCaptureForm textarea[name='text']");
      if (textarea) textarea.value = text;
      currentTab = "pending";
      setOcrStatus("已识别并加入待确认箱。");
      toast("截图已识别，请在待确认箱确认入账。");
      render();
    } catch {
      setOcrStatus("浏览器 OCR 失败。iPhone/iPad 上请使用快捷指令“从图像中提取文本”后打开本 app。");
      toast("截图识别失败，请改用 iOS 快捷指令原生 OCR。");
    } finally {
      screenshotBusy = false;
      renderScreenshotCapture();
    }
  }

  function loadOcrEngine() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (ocrEnginePromise) return ocrEnginePromise;

    ocrEnginePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = OCR_SCRIPT_URL;
      script.async = true;
      script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("Tesseract unavailable"));
      script.onerror = () => reject(new Error("Failed to load OCR engine"));
      document.head.appendChild(script);
    });

    return ocrEnginePromise;
  }

  function imageExtension(type) {
    if (/png/i.test(type)) return "png";
    if (/webp/i.test(type)) return "webp";
    if (/gif/i.test(type)) return "gif";
    return "jpg";
  }

  function handleShareTargetIntent() {
    const params = new URLSearchParams(location.search);
    if (!params.has("shared")) return;

    history.replaceState({}, document.title, location.pathname + location.hash);
    currentTab = "capture";
    readSharedScreenshots()
      .then(async (items) => {
        if (!items.length) {
          toast("没有读取到分享的截图。");
          render();
          return;
        }

        render();
        toast(`收到 ${items.length} 张分享截图，开始识别。`);
        for (const item of items) {
          const type = item.type || item.file?.type || "image/png";
          const file = new File([item.file], item.name || `shared-screenshot.${imageExtension(type)}`, { type });
          setScreenshotFile(file);
          await recognizeScreenshotFile(file, item.source || "ocr");
        }
      })
      .catch(() => {
        toast("读取分享截图失败。");
        render();
      });
  }

  async function readSharedScreenshots() {
    if (!("indexedDB" in window)) return [];
    const db = await openShareDb();
    const tx = db.transaction(SHARE_STORE, "readwrite");
    const store = tx.objectStore(SHARE_STORE);
    const items = await idbRequest(store.getAll());
    store.clear();
    await idbTransactionDone(tx);
    db.close();
    return items || [];
  }

  function openShareDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SHARE_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SHARE_STORE)) db.createObjectStore(SHARE_STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbTransactionDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function handlePendingAction(event) {
    const button = event.currentTarget;
    const action = button.dataset.action;
    const id = button.dataset.id;
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;

    if (action === "confirm" || action === "keep-both") confirmPending(id);
    if (action === "edit") openEditor(id);
    if (action === "ignore") ignorePending(id);
    if (action === "keep-existing") keepExisting(id);
    if (action === "merge") mergeRecords(id, parseRef(button.dataset.ref));
    if (action === "replace") replaceExisting(id, parseRef(button.dataset.ref));

    saveState();
    render();
  }

  function confirmPending(id) {
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;
    state.pending = state.pending.filter((record) => record.id !== id);
    state.transactions.unshift({
      ...item,
      status: "confirmed",
      duplicateCandidates: [],
      confirmedAt: new Date().toISOString(),
    });
    toast("已确认入账。");
  }

  function ignorePending(id) {
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;
    item.status = "ignored";
    item.ignoredAt = new Date().toISOString();
    toast("已忽略。");
  }

  function keepExisting(id) {
    ignorePending(id);
    toast("已保留已有记录，新记录已忽略。");
  }

  function mergeRecords(id, ref) {
    const item = state.pending.find((record) => record.id === id);
    const existing = findRecordByRef(ref);
    if (!item || !existing) return;

    existing.merchant = preferBetter(existing.merchant, item.merchant);
    existing.category = preferBetter(existing.category, item.category);
    existing.channel = preferBetter(existing.channel, item.channel);
    existing.note = [existing.note, item.note].filter(Boolean).join("；");
    existing.rawText = [existing.rawText, item.rawText].filter(Boolean).join("\n\n--- merged raw text ---\n\n");
    existing.sources = Array.from(new Set([...(existing.sources || [existing.source]), item.source].filter(Boolean)));
    existing.updatedAt = new Date().toISOString();
    state.pending = state.pending.filter((record) => record.id !== id);
    toast("已合并到已有记录。");
  }

  function replaceExisting(id, ref) {
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;

    if (ref.collection === "transactions") {
      state.transactions = state.transactions.filter((record) => record.id !== ref.id);
    } else {
      state.pending = state.pending.filter((record) => record.id !== ref.id);
    }

    confirmPending(id);
    toast("已用新记录替换已有记录。");
  }

  function openEditor(id) {
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;
    const form = qs("#editForm");
    form.elements.id.value = item.id;
    form.elements.amount.value = item.amount ?? "";
    form.elements.direction.value = item.direction || "expense";
    form.elements.occurredAt.value = toDateTimeLocalInput(item.occurredAt || localDateTimeString(new Date()));
    form.elements.channel.value = item.channel || "";
    form.elements.merchant.value = item.merchant || "";
    form.elements.category.value = item.category || "";
    form.elements.note.value = item.note || "";
    form.elements.rawText.value = item.rawText || "";
    qs("#editorPanel").classList.remove("hidden");
  }

  function closeEditor() {
    qs("#editorPanel").classList.add("hidden");
  }

  function saveEditedPending(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const id = form.elements.id.value;
    const item = state.pending.find((record) => record.id === id);
    if (!item) return;

    item.amount = Math.abs(parseAmount(form.elements.amount.value));
    item.direction = form.elements.direction.value;
    item.occurredAt = parseDate(form.elements.occurredAt.value) || localDateTimeString(new Date());
    item.channel = form.elements.channel.value.trim();
    item.merchant = form.elements.merchant.value.trim();
    item.category = form.elements.category.value.trim() || categorize(item.merchant);
    item.note = form.elements.note.value.trim();
    item.rawText = form.elements.rawText.value.trim();
    item.updatedAt = new Date().toISOString();
    item.duplicateCandidates = findDuplicates(item, { excludePendingId: item.id });
    item.status = item.duplicateCandidates.length ? "duplicate_review" : "pending";

    closeEditor();
    saveState();
    render();
    toast("修改已保存。");
  }

  function clearIgnoredPending() {
    state.pending = state.pending.filter((item) => item.status !== "ignored");
    saveState();
    render();
    toast("已清理忽略记录。");
  }

  async function previewBillImport() {
    if (!selectedImportFile) {
      toast("请先选择账单文件。");
      return;
    }

    const source = qs("#importSource").value;
    const text = await selectedImportFile.text();
    importPreview = parseBillFile(text, source).map((item) => {
      const duplicateCandidates = findDuplicates(item);
      return {
        ...item,
        status: duplicateCandidates.length ? "duplicate_review" : "pending",
        duplicateCandidates,
      };
    });

    const dupes = importPreview.filter((item) => item.duplicateCandidates.length).length;
    qs("#importSummary").textContent = `预览 ${importPreview.length} 条，其中 ${dupes} 条疑似重复。确认后会先进入待确认箱。`;
    renderImportPreview();
  }

  function commitBillImport() {
    if (!importPreview.length) return;
    importPreview.forEach((item) => addPending(item, { rerunDuplicateCheck: false }));
    const count = importPreview.length;
    importPreview = [];
    selectedImportFile = null;
    qs("#billInput").value = "";
    qs("#importSummary").textContent = `已加入待确认箱：${count} 条。`;
    currentTab = "pending";
    saveState();
    render();
    toast("账单导入已进入待确认箱。");
  }

  function parseBillFile(text, source) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) return [];

    const headerIndex = lines.findIndex((line) => /交易时间|创建时间|付款时间|交易对方|商品|金额|收\/支|收支/.test(line));
    if (headerIndex === -1) {
      return parseLooseBillLines(lines, source);
    }

    const header = splitDelimited(lines[headerIndex]).map(cleanCell);
    const rows = lines.slice(headerIndex + 1).map(splitDelimited).filter((row) => row.some((cell) => String(cell).trim()));
    const index = {
      time: findHeader(header, ["交易时间", "创建时间", "付款时间", "时间"]),
      merchant: findHeader(header, ["交易对方", "商户", "商品", "商品名称", "交易对象", "对方", "交易说明", "说明"]),
      amount: findHeader(header, ["金额", "交易金额", "支出", "收入", "金额(元)", "金额（元）"]),
      direction: findHeader(header, ["收/支", "收支", "类型", "交易类型", "资金状态"]),
      status: findHeader(header, ["交易状态", "状态"]),
      note: findHeader(header, ["备注", "交易说明", "商品说明", "订单号", "商户订单号"]),
    };

    return rows.map((row) => {
      const rawCells = Object.fromEntries(header.map((name, idx) => [name || `列${idx + 1}`, cleanCell(row[idx] || "")]));
      const merchant = cleanMerchant(row[index.merchant] || row[index.note] || "");
      const amount = parseAmount(row[index.amount]);
      const direction = detectDirection(row[index.direction] || row[index.amount] || "");
      const occurredAt = parseDate(row[index.time]) || localDateTimeString(new Date());
      const channel = source === "wechat_import" ? "微信" : "支付宝";
      const rawText = JSON.stringify(rawCells, null, 2);

      return normalizeRecord({
        amount,
        direction,
        occurredAt,
        merchant,
        channel,
        category: categorize(merchant),
        note: cleanCell(row[index.status] || ""),
        source,
        rawText,
      });
    }).filter((item) => item.amount > 0);
  }

  function parseLooseBillLines(lines, source) {
    return lines.map((line) => parseFreeText(line, source)).filter((item) => item.amount > 0);
  }

  function splitDelimited(line) {
    const delimiter = line.includes("\t") ? "\t" : ",";
    const result = [];
    let current = "";
    let quoted = false;

    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      const next = line[i + 1];
      if (char === '"' && quoted && next === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === delimiter && !quoted) {
        result.push(current);
        current = "";
      } else {
        current += char;
      }
    }

    result.push(current);
    return result;
  }

  function parseFreeText(text, source = "free_text") {
    const channel = detectChannel(text, source);
    const merchant = extractMerchant(text);
    const amount = extractAmount(text);
    const occurredAt = extractDate(text) || localDateTimeString(new Date());
    const direction = detectDirection(text);

    return normalizeRecord({
      amount,
      direction,
      occurredAt,
      merchant,
      channel,
      category: categorize(merchant || text),
      note: "",
      source,
      rawText: text,
      confidence: amount > 0 ? 0.72 : 0.35,
    });
  }

  function handleUrlIntent() {
    const params = new URLSearchParams(location.search);
    if (!params.has("intent")) return;

    const intent = params.get("intent");
    if (intent === "quickExpense" || intent === "quickAdd") {
      openQuickExpense({
        amount: parseAmount(params.get("amount")),
        category: params.get("category") || "",
        merchant: params.get("merchant") || "",
        channel: params.get("channel") || "",
        occurredAt: parseDate(params.get("time") || params.get("occurredAt")) || localDateTimeString(new Date()),
        note: params.get("note") || "",
      });
      history.replaceState({}, document.title, location.pathname + location.hash);
      toast("快速记账已打开。");
      return;
    }

    const sourceMap = {
      bankMessage: "bank_message",
      bankEmail: "bank_email",
      applePay: "apple_pay",
      wechatOcr: "wechat_ocr",
      alipayOcr: "alipay_ocr",
      ocr: "ocr",
    };
    const source = sourceMap[intent] || intent || "url";
    const structuredAmount = parseAmount(params.get("amount"));
    const structuredMerchant = params.get("merchant");
    const structuredTime = params.get("time");

    let record;
    if (structuredAmount > 0 || structuredMerchant) {
      const text = params.get("text") || "";
      record = normalizeRecord({
        amount: structuredAmount,
        direction: detectDirection(params.get("direction") || text),
        occurredAt: parseDate(structuredTime) || extractDate(text) || localDateTimeString(new Date()),
        merchant: structuredMerchant || extractMerchant(text),
        channel: params.get("channel") || detectChannel(text, source),
        category: categorize(structuredMerchant || text),
        note: params.get("note") || "",
        source,
        rawText: text,
      });
    } else {
      record = parseFreeText(params.get("text") || params.toString(), source);
    }

    addPending(record);
    history.replaceState({}, document.title, location.pathname + location.hash);
    currentTab = "pending";
    toast("快捷指令记录已进入待确认箱。");
  }

  function addPending(record, options = {}) {
    const normalized = normalizeRecord(record);
    const duplicateCandidates = options.rerunDuplicateCheck === false
      ? normalized.duplicateCandidates || []
      : findDuplicates(normalized);

    normalized.status = duplicateCandidates.length ? "duplicate_review" : "pending";
    normalized.duplicateCandidates = duplicateCandidates;
    normalized.createdAt = normalized.createdAt || new Date().toISOString();
    state.pending.unshift(normalized);
    saveState();
    return normalized;
  }

  function formToRecord(form, source) {
    const merchant = String(form.get("merchant") || "").trim();
    return normalizeRecord({
      amount: Math.abs(parseAmount(form.get("amount"))),
      direction: String(form.get("direction") || "expense"),
      occurredAt: parseDate(form.get("occurredAt")) || localDateTimeString(new Date()),
      channel: String(form.get("channel") || "其他"),
      merchant,
      category: String(form.get("category") || "").trim() || categorize(merchant),
      note: String(form.get("note") || "").trim(),
      source,
      rawText: "",
    });
  }

  function normalizeRecord(record) {
    const amount = Math.abs(Number(record.amount || 0));
    const merchant = cleanMerchant(record.merchant || "");
    return {
      id: record.id || uid("tx"),
      amount,
      direction: record.direction === "income" ? "income" : "expense",
      occurredAt: parseDate(record.occurredAt) || localDateTimeString(new Date()),
      merchant,
      channel: record.channel || "其他",
      category: record.category || categorize(merchant),
      note: record.note || "",
      source: record.source || "unknown",
      rawText: record.rawText || "",
      status: record.status || "pending",
      confidence: record.confidence || 0.8,
      duplicateCandidates: record.duplicateCandidates || [],
      createdAt: record.createdAt || new Date().toISOString(),
    };
  }

  function findDuplicates(record, options = {}) {
    const candidates = [];
    const pools = [
      ...state.transactions.map((item) => ({ collection: "transactions", item })),
      ...state.pending
        .filter((item) => item.id !== options.excludePendingId && item.status !== "ignored")
        .map((item) => ({ collection: "pending", item })),
    ];

    pools.forEach(({ collection, item }) => {
      const score = duplicateScore(record, item);
      if (score >= 65) {
        candidates.push({
          collection,
          id: item.id,
          score,
        });
      }
    });

    return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  function duplicateScore(a, b) {
    let score = 0;
    const amountDiff = Math.abs(Number(a.amount || 0) - Number(b.amount || 0));
    if (amountDiff < 0.005) score += 42;
    if (a.direction === b.direction) score += 8;
    if ((a.channel || "") && a.channel === b.channel) score += 12;

    const timeDiff = Math.abs(new Date(a.occurredAt) - new Date(b.occurredAt));
    if (timeDiff <= 5 * 60 * 1000) score += 28;
    else if (timeDiff <= 30 * 60 * 1000) score += 22;
    else if (timeDiff <= 24 * 60 * 60 * 1000) score += 12;

    const similarity = stringSimilarity(a.merchant || "", b.merchant || "");
    score += Math.round(similarity * 18);
    if (a.source !== b.source) score += 4;
    return score;
  }

  function findRecordByRef(ref) {
    if (!ref) return null;
    const collection = ref.collection || "transactions";
    const list = collection === "pending" ? state.pending : state.transactions;
    return list.find((item) => item.id === ref.id) || null;
  }

  function parseRef(value) {
    const [collection, id] = String(value || "").split(":");
    return { collection, id };
  }

  function extractAmount(text) {
    const cleaned = String(text || "").replace(/,/g, "");
    const patterns = [
      /(?:付款金额|实付款|实付|订单金额|消费金额|收款金额|交易金额)[:：\s]*[¥￥]?\s*([0-9]+(?:\.[0-9]{1,2})?)\s*元?/i,
      /(?:支出|消费|扣款|付款|支付|交易|人民币|金额|CNY|RMB|¥|￥)\s*([0-9]+(?:\.[0-9]{1,2})?)\s*元?/i,
      /[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/,
      /([0-9]+(?:\.[0-9]{1,2})?)\s*元/,
    ];

    for (const pattern of patterns) {
      const match = cleaned.match(pattern);
      if (match) return Math.abs(Number(match[1]));
    }

    return 0;
  }

  function extractMerchant(text) {
    const raw = String(text || "");
    const labeled = extractLabeledValue(raw, ["商户", "收款方", "交易对方", "对方", "商家", "店铺", "付款给", "收款账户"]);
    if (labeled) return cleanMerchant(labeled);

    const patterns = [
      /(?:商户|收款方|交易对方|对方|商家|店铺)[:：\s]*([^\n，,。；;]+)/,
      /(?:向|给|在)\s*([^\n，,。；;]{2,24}?)(?:\s*支付|\s*付款|\s*消费|\s*支出)/,
      /(?:支付宝|财付通|微信支付|Apple Pay).{0,8}(?:商户)?[:：\s]*([^\n，,。；;]{2,24})/,
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) return cleanMerchant(match[1]);
    }

    const lines = raw.split(/\r?\n/).map(cleanCell).filter(Boolean);
    const candidate = lines.find((line) => {
      if (looksLikeMerchantNoise(line)) return false;
      return line.length >= 2 && line.length <= 28;
    });

    return cleanMerchant(candidate || "未识别商户");
  }

  function extractLabeledValue(raw, labels) {
    const lines = String(raw || "").split(/\r?\n/).map(cleanCell).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const compact = lines[i].replace(/\s/g, "");
      for (const label of labels) {
        const sameLine = lines[i].match(new RegExp(`${label}\\s*[:：]?\\s*(.+)$`));
        if (sameLine && sameLine[1] && !looksLikeMerchantNoise(sameLine[1])) return sameLine[1];
        if (compact === label || compact.endsWith(label)) {
          const next = lines.slice(i + 1).find((line) => !looksLikeMerchantNoise(line));
          if (next) return next;
        }
      }
    }
    return "";
  }

  function looksLikeMerchantNoise(line) {
    const value = cleanCell(line);
    if (!value) return true;
    if (/^[¥￥]\s*[0-9]+(?:\.[0-9]{1,2})?/.test(value)) return true;
    if (/[0-9]{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|[0-9]{1,2}:\d{2}/.test(value)) return true;
    return /支出|收入|支付成功|付款成功|交易成功|余额|银行卡|订单|单号|交易|时间|金额|人民币|合计|优惠|收款方|付款方|商户|商家|店铺|支付方式|付款方式|完成|详情|账单|¥|￥|元/.test(value);
  }

  function extractDate(text) {
    const value = String(text || "");
    const patterns = [
      /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?\s+\d{1,2}:\d{2}(?::\d{2})?)/,
      /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}[日]?)/,
      /(\d{1,2}[-/.月]\d{1,2}[日]?\s+\d{1,2}:\d{2}(?::\d{2})?)/,
    ];

    for (const pattern of patterns) {
      const match = value.match(pattern);
      if (match) return parseDate(match[1]);
    }

    return null;
  }

  function detectDirection(value) {
    const text = String(value || "");
    if (/收入|入账|收款|退款|退回|转入|\+/.test(text) && !/支出|付款|消费|扣款/.test(text)) return "income";
    return "expense";
  }

  function detectChannel(text, source) {
    const value = `${source || ""} ${text || ""}`;
    if (/wechat|微信|财付通/i.test(value)) return "微信";
    if (/alipay|支付宝/i.test(value)) return "支付宝";
    if (/apple\s*pay|Apple Pay/i.test(value)) return "Apple Pay";
    if (/银行|银行卡|快捷支付|信用卡|储蓄卡/.test(value)) return "银行卡";
    return "其他";
  }

  function categorize(text) {
    const value = String(text || "");
    for (const rule of state.categoryRules || DEFAULT_RULES) {
      try {
        if (new RegExp(rule.pattern, "i").test(value)) return rule.category;
      } catch {
        continue;
      }
    }
    return "其他";
  }

  function parseAmount(value) {
    if (value === null || value === undefined) return 0;
    const match = String(value).replace(/,/g, "").match(/-?[0-9]+(?:\.[0-9]{1,2})?/);
    return match ? Math.abs(Number(match[0])) : 0;
  }

  function parseDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : localDateTimeString(value);

    let text = String(value).trim();
    if (!text) return null;
    text = text
      .replace(/年/g, "-")
      .replace(/月/g, "-")
      .replace(/日/g, "")
      .replace(/\./g, "-")
      .replace(/\//g, "-");

    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(text)) {
      const date = new Date(text);
      return Number.isNaN(date.getTime()) ? null : localDateTimeString(date);
    }

    if (/^\d{1,2}-\d{1,2}/.test(text)) {
      text = `${new Date().getFullYear()}-${text}`;
    }

    const manual = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (manual) {
      const [, year, month, day, hour = "0", minute = "0", second = "0"] = manual;
      return localDateTimeFromParts(year, month, day, hour, minute, second);
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : localDateTimeString(date);
  }

  function findHeader(header, candidates) {
    const idx = header.findIndex((item) => candidates.some((candidate) => item.includes(candidate)));
    return idx >= 0 ? idx : 0;
  }

  function cleanCell(value) {
    return String(value || "").replace(/^"|"$/g, "").trim();
  }

  function cleanMerchant(value) {
    return cleanCell(value)
      .replace(/^(商户|收款方|交易对方|对方|商家|店铺)[:：\s]*/, "")
      .replace(/\s*(微信支付|支付宝|财付通|Apple Pay|银行卡|快捷支付).*$/i, "")
      .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}.*$/, "")
      .replace(/[¥￥]?\s*[0-9]+(?:\.[0-9]{1,2})?\s*元?.*$/, "")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 80);
  }

  function preferBetter(a, b) {
    if (!a || a === "其他" || a === "未识别商户" || a === "待分类") return b || a;
    return a;
  }

  function stringSimilarity(a, b) {
    const left = String(a || "").toLowerCase();
    const right = String(b || "").toLowerCase();
    if (!left || !right) return 0;
    if (left === right) return 1;
    if (left.includes(right) || right.includes(left)) return 0.82;

    const leftSet = new Set(left.replace(/\s/g, "").split(""));
    const rightSet = new Set(right.replace(/\s/g, "").split(""));
    const intersection = Array.from(leftSet).filter((char) => rightSet.has(char)).length;
    const union = new Set([...leftSet, ...rightSet]).size;
    return union ? intersection / union : 0;
  }

  function nextReminderLabel() {
    if (!state.reminders.length) return "暂无";
    const next = [...state.reminders].sort((a, b) => nextDueDate(a) - nextDueDate(b))[0];
    return `${next.title} ${formatMonthDay(nextDueDate(next))}`;
  }

  function reminderDueLabel(reminder) {
    const due = nextDueDate(reminder);
    const today = startOfDay(new Date());
    const diff = Math.round((startOfDay(due) - today) / 86_400_000);
    if (diff === 0) return "今天到期";
    if (diff > 0) return `${diff} 天后到期`;
    return "本月已过";
  }

  function nextDueDate(reminder) {
    const now = new Date();
    const makeDate = (year, month) => {
      const last = new Date(year, month + 1, 0).getDate();
      return new Date(year, month, Math.min(reminder.dayOfMonth, last), 9, 0, 0);
    };
    const current = makeDate(now.getFullYear(), now.getMonth());
    if (current >= startOfDay(now)) return current;
    return makeDate(now.getFullYear(), now.getMonth() + 1);
  }

  function checkReminders() {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const todayKey = new Date().toISOString().slice(0, 10);

    state.reminders.forEach((reminder) => {
      if (!reminder.active) return;
      const due = nextDueDate(reminder);
      const remindOn = new Date(due);
      remindOn.setDate(remindOn.getDate() - Number(reminder.advanceDays || 0));
      const shouldNotify = startOfDay(new Date()) >= startOfDay(remindOn) && startOfDay(new Date()) <= startOfDay(due);
      const notifyKey = `${reminder.id}:${todayKey}`;

      if (shouldNotify && reminder.lastNotified !== notifyKey) {
        new Notification("还款提醒", {
          body: `${reminder.title}：${reminderDueLabel(reminder)}${reminder.amount ? `，预计 ${money(reminder.amount)}` : ""}`,
        });
        reminder.lastNotified = notifyKey;
        saveState();
      }
    });
  }

  async function requestNotificationPermission() {
    if (typeof Notification === "undefined") {
      toast("当前浏览器不支持网页通知。");
      return;
    }
    const permission = await Notification.requestPermission();
    toast(permission === "granted" ? "网页通知已启用。" : "未获得通知权限。");
    checkReminders();
  }

  function exportReminderIcs(reminder) {
    const due = nextDueDate(reminder);
    const ymd = toIcsDate(due);
    const uidValue = `${reminder.id}@ledgerpilot.local`;
    const alarmDays = Number(reminder.advanceDays || 0);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//LedgerPilot//Local Reminder//ZH",
      "BEGIN:VEVENT",
      `UID:${uidValue}`,
      `DTSTAMP:${toIcsDateTime(new Date())}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `SUMMARY:${escapeIcs(reminder.title)}`,
      `DESCRIPTION:${escapeIcs(reminder.note || "LedgerPilot 还款提醒")}`,
      `RRULE:FREQ=MONTHLY;BYMONTHDAY=${reminder.dayOfMonth}`,
      "BEGIN:VALARM",
      `TRIGGER:-P${alarmDays}D`,
      "ACTION:DISPLAY",
      `DESCRIPTION:${escapeIcs(reminder.title)}`,
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    downloadText(`${reminder.title}.ics`, ics, "text/calendar");
  }

  function exportBackup() {
    downloadText(`ledgerpilot-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), "application/json");
  }

  async function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      state.transactions = Array.isArray(parsed.transactions) ? parsed.transactions : state.transactions;
      state.pending = Array.isArray(parsed.pending) ? parsed.pending : state.pending;
      state.reminders = Array.isArray(parsed.reminders) ? parsed.reminders : state.reminders;
      state.categoryRules = Array.isArray(parsed.categoryRules) ? parsed.categoryRules : state.categoryRules;
      state.settings = parsed.settings || state.settings;
      saveState();
      render();
      toast("备份已导入。");
    } catch {
      toast("备份文件无法解析。");
    } finally {
      event.target.value = "";
    }
  }

  function refreshCategoryList() {
    const categories = new Set(DEFAULT_CATEGORIES);
    state.categoryRules.forEach((rule) => categories.add(rule.category));
    state.transactions.forEach((item) => item.category && categories.add(item.category));
    qs("#categoryList").innerHTML = Array.from(categories).sort().map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
  }

  function registerServiceWorker() {
    const isLocalDev = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    if ("serviceWorker" in navigator && location.protocol === "https:" && !isLocalDev) {
      navigator.serviceWorker.register("./sw.js").catch(() => undefined);
    }
  }

  function downloadText(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function toast(message) {
    const existing = qs(".toast");
    if (existing) existing.remove();
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = message;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 2600);
  }

  function uid(prefix) {
    if (crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  function money(value) {
    return `￥${Number(value || 0).toFixed(2)}`;
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知时间";
    return new Intl.DateTimeFormat("zh-Hans", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }

  function formatMonthDay(value) {
    return new Intl.DateTimeFormat("zh-Hans", { month: "2-digit", day: "2-digit" }).format(value);
  }

  function toDateTimeLocal(date) {
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
  }

  function toDateTimeLocalInput(value) {
    const parsed = parseDate(value);
    if (parsed) return parsed.slice(0, 16);
    return toDateTimeLocal(new Date());
  }

  function localDateTimeFromParts(year, month, day, hour = "0", minute = "0", second = "0") {
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (Number.isNaN(date.getTime())) return null;

    return [
      String(date.getFullYear()).padStart(4, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-") + "T" + [
      String(date.getHours()).padStart(2, "0"),
      String(date.getMinutes()).padStart(2, "0"),
      String(date.getSeconds()).padStart(2, "0"),
    ].join(":");
  }

  function localDateTimeString(date) {
    return localDateTimeFromParts(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    );
  }

  function toIcsDate(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    return `${yyyy}${mm}${dd}`;
  }

  function toIcsDateTime(date) {
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  }

  function escapeIcs(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }

  function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function clampNumber(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  }

  function sourceLabel(source) {
    const labels = {
      manual: "手动",
      wechat_ocr: "微信截图 OCR",
      alipay_ocr: "支付宝截图 OCR",
      bank_message: "银行短信",
      bank_email: "银行邮件",
      apple_pay: "Apple Pay",
      wechat_import: "微信账单导入",
      alipay_import: "支付宝账单导入",
      ocr: "截图 OCR",
      url: "快捷指令",
      quick_expense: "快速记账",
    };
    return labels[source] || source || "未知来源";
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
