/**
 * Plan Reviewer 持续工作流面板逻辑。
 *
 * 模块职责：
 * - 轮询 `/api/sessions/{id}`，把 Codex 发布的新问题或新草案自动渲染到当前页面；
 * - 在同一工作台内处理需求澄清回答、计划草案批注和最终通过；
 * - 用户提交后立即进入等待状态，让用户无需回到 Codex 聊天页触发下一步；
 * - 对所有 Markdown 和用户输入做 HTML 转义，避免本地状态文件中的文本被当作脚本执行。
 *
 * 并发说明：
 * 提交按钮使用 busy 状态防重复点击；后端还会校验 itemId 必须等于 activeItemId，
 * 防止轮询刷新和用户点击同时发生时把旧步骤的回答写入新步骤。
 */

const state = {
  sessionId: "",
  session: null,
  activeItemId: "",
  renderSignature: "",
  selectedLabel: "",
  selectedBlockId: "",
  selectedText: "",
  blocks: [],
  annotations: [],
  generalNote: "",
  busy: false,
  message: "",
  pollTimerId: null,
  alertTimerId: null,
  lastFocusedElement: null,
};

const POLL_INTERVAL_MS = 1000;
const ALERT_AUTO_CLOSE_MS = 3000;
const FREEFORM_OPTION_LABEL = "D";
const ANNOTATION_HIGHLIGHT_MAX_LENGTH = 280;

const dom = {
  title: document.getElementById("sessionTitle"),
  status: document.getElementById("sessionStatus"),
  sessionIdLabel: document.getElementById("sessionIdLabel"),
  originalRequest: document.getElementById("originalRequest"),
  timelineCount: document.getElementById("timelineCount"),
  timelineList: document.getElementById("timelineList"),
  activeStepLabel: document.getElementById("activeStepLabel"),
  reloadButton: document.getElementById("reloadButton"),
  currentContent: document.getElementById("currentContent"),
  actionPane: document.getElementById("actionPane"),
  alertOverlay: document.getElementById("alertOverlay"),
  alertTitle: document.getElementById("alertTitle"),
  alertMessage: document.getElementById("alertMessage"),
  alertCloseButton: document.getElementById("alertCloseButton"),
};

/**
 * 页面入口。
 *
 * @returns {Promise<void>} 初始化完成后返回。
 * @throws {Error} URL 缺少 sessionId 或 API 加载失败时抛出。
 */
async function init() {
  state.sessionId = extractSessionId(window.location.pathname);
  bindEvents();
  await loadSession({ force: true });
  startPolling();
}

/**
 * 从路径中解析持续工作流 Session ID。
 *
 * @param {string} pathname 当前 location.pathname。
 * @returns {string} Session ID。
 * @throws {Error} 当路径中没有合法 ID 时抛出。
 */
function extractSessionId(pathname) {
  const match = pathname.match(/\/session\/([a-zA-Z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error("URL 中缺少工作流会话 ID，请从 Codex 返回的链接打开面板。");
  }
  return match[1];
}

/**
 * 绑定页面级事件。
 *
 * @returns {void}
 */
function bindEvents() {
  dom.reloadButton.addEventListener("click", () => loadSession({ force: true }).catch(handleActionError));
  dom.alertCloseButton.addEventListener("click", () => hideAlert());
  dom.alertOverlay.addEventListener("click", handleAlertOverlayClick);
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("beforeunload", stopPolling);
}

/**
 * 启动轮询，持续接收 Codex 回写的新步骤。
 *
 * @returns {void}
 */
function startPolling() {
  stopPolling();
  state.pollTimerId = window.setInterval(() => {
    loadSession({ silent: true }).catch((error) => {
      setMessage(formatError(error, "刷新工作流状态失败。"));
    });
  }, POLL_INTERVAL_MS);
}

/**
 * 停止轮询，避免页面关闭后继续持有定时器。
 *
 * @returns {void}
 */
function stopPolling() {
  if (state.pollTimerId) {
    window.clearInterval(state.pollTimerId);
    state.pollTimerId = null;
  }
}

/**
 * 从本地 API 读取 Session。
 *
 * @param {{force?: boolean, silent?: boolean}} options 加载选项。
 * @returns {Promise<void>} 加载完成后返回。
 * @throws {Error} API 返回错误时抛出。
 */
async function loadSession(options = {}) {
  if (!options.silent) {
    setMessage("正在加载工作流...");
  }
  const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}`);
  const payload = await response.json();
  if (!response.ok) {
    renderMissingSession(payload.error ?? "加载工作流失败。");
    throw new Error(payload.error ?? "加载工作流失败。");
  }
  applySession(payload.session, options);
}

/**
 * 应用新的 Session 状态，并在内容变化时重新渲染。
 *
 * @param {Record<string, unknown>} session 后端返回的 session。
 * @param {{force?: boolean, silent?: boolean}} options 渲染选项。
 * @returns {void}
 */
function applySession(session, options = {}) {
  const nextSignature = buildRenderSignature(session);
  const shouldRender = options.force || nextSignature !== state.renderSignature;
  state.session = session;
  state.renderSignature = nextSignature;
  if (shouldRender && options.silent) {
    state.message = statusMessage(session);
  }
  if (shouldRender) {
    renderSession();
  }
  if (!options.silent) {
    setMessage(statusMessage(session));
  }
}

/**
 * 生成轻量签名，避免轮询时重复重绘并打断用户输入。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @returns {string} 渲染签名。
 */
function buildRenderSignature(session) {
  const activeItem = getActiveItem(session);
  return [
    session?.updatedAt ?? "",
    session?.status ?? "",
    session?.activeItemId ?? "",
    activeItem?.updatedAt ?? "",
    session?.actionSeq ?? 0,
    session?.codexSeq ?? 0,
  ].join("|");
}

/**
 * 渲染 session 缺失时的错误态。
 *
 * @param {string} message 错误消息。
 * @returns {void}
 */
function renderMissingSession(message) {
  dom.status.textContent = "未找到";
  dom.status.className = "status-badge";
  dom.currentContent.className = "session-main-card";
  dom.currentContent.innerHTML = `
    <section class="empty-error">
      <h2>没有找到这条工作流记录</h2>
      <p>${escapeHtml(message)}</p>
      <p>请回到 Codex 打开最新的 Plan Reviewer Session 链接。</p>
    </section>
  `;
  dom.actionPane.innerHTML = "";
}

/**
 * 根据当前 active item 渲染工作台。
 *
 * @returns {void}
 */
function renderSession() {
  const session = state.session;
  const activeItem = getActiveItem(session);

  dom.title.textContent = session?.title || "持续工作流";
  dom.sessionIdLabel.textContent = `会话 ID: ${shortSessionId(state.sessionId)}`;
  dom.originalRequest.textContent = session?.originalRequest || "未提供原始需求。";
  renderStatus(session?.status ?? "waiting_codex");
  renderTimeline(session?.items ?? []);

  if (!activeItem || session?.status === "waiting_codex") {
    renderWaiting(session, activeItem);
    return;
  }

  if (session?.status === "approved") {
    renderApproved(activeItem);
    return;
  }

  if (activeItem.type === "clarification") {
    renderClarification(activeItem);
    return;
  }

  if (activeItem.type === "plan_review") {
    renderPlanReview(activeItem);
    return;
  }

  renderWaiting(session, activeItem);
}

/**
 * 渲染 Session 状态徽标。
 *
 * @param {string} status Session 状态。
 * @returns {void}
 */
function renderStatus(status) {
  const labels = {
    waiting_codex: "等待 Codex",
    waiting_user_clarification: "待回答",
    waiting_user_review: "待审阅",
    approved: "已通过",
  };
  dom.status.textContent = labels[status] ?? status;
  dom.status.className = "status-badge";
  if (status === "approved") {
    dom.status.classList.add("approved");
  }
  if (status === "waiting_codex") {
    dom.status.classList.add("needs-revision");
  }
  if (status === "waiting_user_review") {
    dom.status.classList.add("reviewing");
  }
}

/**
 * 渲染左侧过程记录。
 *
 * @param {Array<Record<string, unknown>>} items Session 步骤列表。
 * @returns {void}
 */
function renderTimeline(items) {
  dom.timelineCount.textContent = String(items.length);
  dom.timelineList.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "selection-preview";
    empty.textContent = "Codex 正在准备第一步。";
    dom.timelineList.appendChild(empty);
    return;
  }

  items.forEach((item, index) => {
    const entry = document.createElement("div");
    entry.className = "timeline-item";
    if (item.id === state.session?.activeItemId) {
      entry.classList.add("is-active");
    }
    if (isFinishedTimelineItem(item)) {
      entry.classList.add("is-done");
    }
    entry.innerHTML = `
      <span class="timeline-node">${escapeHtml(timelineNodeLabel(item, index))}</span>
      <span class="timeline-body">
        <strong>${index + 1}. ${escapeHtml(itemLabel(item))}</strong>
        <small>${escapeHtml(timelineSubText(item))}</small>
      </span>
      <span class="timeline-status">${escapeHtml(itemStatusLabel(item.status ?? "pending"))}</span>
    `;
    dom.timelineList.appendChild(entry);
  });
}

/**
 * 渲染等待 Codex 回写下一步的状态。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @param {Record<string, unknown> | undefined} activeItem 当前步骤。
 * @returns {void}
 */
function renderWaiting(session, activeItem) {
  state.activeItemId = activeItem?.id ?? "";
  dom.currentContent.onmouseup = null;
  dom.currentContent.onclick = null;
  dom.activeStepLabel.textContent = "等待下一步";
  dom.currentContent.className = "session-main-card session-waiting-card";
  dom.currentContent.innerHTML = `
    <section class="session-waiting">
      <div class="waiting-spinner" aria-hidden="true"></div>
      <h2>正在等待 Codex 回写下一步</h2>
      <p>${escapeHtml(waitingDetail(session))}</p>
      ${renderRecentSubmissionCard(session)}
    </section>
  `;
  dom.actionPane.innerHTML = renderWaitingActionPane(session);
}

/**
 * 渲染最终通过状态。
 *
 * @param {Record<string, unknown>} activeItem 当前通过的计划步骤。
 * @returns {void}
 */
function renderApproved(activeItem) {
  dom.currentContent.onmouseup = null;
  dom.currentContent.onclick = null;
  dom.activeStepLabel.textContent = "计划已通过";
  dom.currentContent.className = "plan-document session-plan-document";
  dom.currentContent.innerHTML = "";
  const blocks = splitMarkdownBlocks(String(activeItem?.planMarkdown ?? ""));
  blocks.forEach((block) => {
    const article = document.createElement("section");
    article.className = "plan-block";
    article.innerHTML = renderMarkdownBlock(block.markdown);
    dom.currentContent.appendChild(article);
  });
  dom.actionPane.innerHTML = `
    <section class="session-card">
      <h2>计划已通过</h2>
      <p class="selection-preview">Codex 可以读取通过结果并输出正式 Plan。面板会按本地服务策略延迟关闭。</p>
    </section>
    <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
  `;
}

/**
 * 渲染需求澄清步骤。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {void}
 */
function renderClarification(item) {
  const itemChanged = state.activeItemId !== item.id;
  if (itemChanged) {
    state.activeItemId = String(item.id ?? "");
    state.selectedLabel = defaultClarificationLabel(item);
  }

  dom.currentContent.onmouseup = null;
  dom.currentContent.onclick = null;
  dom.activeStepLabel.textContent = `${Number(item.confidenceTarget ?? 95)}% 理解目标`;
  dom.currentContent.className = "session-main-card";
  dom.currentContent.innerHTML = "";
  dom.currentContent.appendChild(createClarificationContent(item));
  renderClarificationAction(item);
}

/**
 * 创建澄清问题主体内容。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {HTMLElement} 主体元素。
 */
function createClarificationContent(item) {
  const wrapper = document.createElement("div");
  wrapper.className = "session-clarify-content";

  if (item.knownContext) {
    const contextSection = document.createElement("section");
    contextSection.className = "clarify-section session-surface-section";
    contextSection.innerHTML = "<h2>当前上下文</h2>";
    const context = document.createElement("div");
    context.className = "context-block";
    context.textContent = String(item.knownContext ?? "");
    contextSection.appendChild(context);
    wrapper.appendChild(contextSection);
  }

  const questionSection = document.createElement("section");
  questionSection.className = "clarify-section session-surface-section";
  questionSection.innerHTML = "<h2>当前问题</h2>";
  const question = document.createElement("p");
  question.className = "question-text";
  question.textContent = String(item.question ?? "");
  questionSection.appendChild(question);
  wrapper.appendChild(questionSection);

  const optionList = document.createElement("div");
  optionList.className = "option-list";
  optionList.id = "sessionOptionList";
  const options = normalizedOptions(item);
  options.forEach((option) => optionList.appendChild(createOptionCard(option)));
  optionList.addEventListener("change", handleOptionChange);
  wrapper.appendChild(optionList);
  return wrapper;
}

/**
 * 渲染澄清提交区。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {void}
 */
function renderClarificationAction(item) {
  const recommendedOption = getRecommendedOption(item);
  dom.actionPane.innerHTML = `
    <section class="session-card session-answer-card">
      <h2>回答提交</h2>
      ${renderRecommendedPreview(recommendedOption)}
      <label class="freeform-group">
        <span>补充说明（可选）</span>
        <textarea id="sessionFreeformInput" rows="6" maxlength="300" placeholder="如有特殊需求或说明，请在此补充..."></textarea>
        <small id="freeformCounter" class="input-counter">0 / 300</small>
      </label>
      <div class="quick-reply-row">
        <button id="adoptRecommendedButton" class="success-outline" type="button">采用推荐方案</button>
        <button id="submitAnswerButton" class="primary session-full-button" type="button">提交回答</button>
      </div>
    </section>
    <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
  `;
  const button = document.getElementById("submitAnswerButton");
  const adoptButton = document.getElementById("adoptRecommendedButton");
  const textarea = document.getElementById("sessionFreeformInput");
  button?.addEventListener("click", () => submitClarificationAnswer(item).catch(handleActionError));
  adoptButton?.addEventListener("click", () => adoptRecommendedAnswer(item));
  textarea?.addEventListener("input", () => {
    if (state.selectedLabel === FREEFORM_OPTION_LABEL || normalizedOptions(item).length === 0) {
      state.selectedLabel = FREEFORM_OPTION_LABEL;
    }
    updateInputCounter("sessionFreeformInput", "freeformCounter", 300);
  });
  syncClarificationControls(item);
  updateInputCounter("sessionFreeformInput", "freeformCounter", 300);
}

/**
 * 创建澄清选项卡片。
 *
 * @param {Record<string, unknown>} option 选项数据。
 * @returns {HTMLElement} 选项卡片。
 */
function createOptionCard(option) {
  const label = String(option.label ?? "");
  const card = document.createElement("label");
  card.className = "clarify-option";
  if (option.recommended) {
    card.classList.add("is-recommended");
  }

  const radio = document.createElement("input");
  radio.type = "radio";
  radio.name = "sessionClarificationOption";
  radio.value = label;
  radio.checked = state.selectedLabel === label;

  const body = document.createElement("span");
  body.className = "clarify-option-body";

  const heading = document.createElement("span");
  heading.className = "clarify-option-heading";
  heading.textContent = `${label}: ${option.title ?? ""}`;
  if (option.recommended) {
    const badge = document.createElement("span");
    badge.className = "recommend-badge";
    badge.textContent = "推荐";
    heading.appendChild(badge);
  }

  const description = document.createElement("span");
  description.className = "clarify-option-description";
  description.textContent = String(option.description ?? "");

  body.appendChild(heading);
  body.appendChild(description);
  if (option.recommendationReason) {
    const reason = document.createElement("span");
    reason.className = "recommend-reason";
    reason.textContent = `推荐原因：${option.recommendationReason}`;
    body.appendChild(reason);
  }

  card.appendChild(radio);
  card.appendChild(body);
  return card;
}

/**
 * 处理澄清选项变更。
 *
 * @param {Event} event change 事件。
 * @returns {void}
 */
function handleOptionChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  state.selectedLabel = target.value;
  const textarea = document.getElementById("sessionFreeformInput");
  if (state.selectedLabel === FREEFORM_OPTION_LABEL) {
    textarea?.focus();
  }
}

/**
 * 提交澄清回答。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {Promise<void>} 提交完成后返回。
 */
async function submitClarificationAnswer(item) {
  const answer = buildClarificationAnswer(item);
  if (!answer.finalAnswer) {
    showAlert("还不能提交", "请先选择一个选项，或填写 D: 其他。");
    return;
  }

  setBusy(true);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/clarification-answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, answer }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "提交回答失败。");
    }
    applySession(payload.session, { force: true });
    const message = "回答已提交。请留在当前面板，Codex 回写下一步后这里会自动刷新。";
    setMessage(message);
    showAlert("回答已提交", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 组装澄清回答 payload。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {{selectedLabel: string, selectedTitle: string, selectedDescription: string, freeformAnswer: string, finalAnswer: string}} 答案对象。
 */
function buildClarificationAnswer(item) {
  const options = normalizedOptions(item).filter((option) => option.label !== FREEFORM_OPTION_LABEL);
  const selectedOption = options.find((option) => option.label === state.selectedLabel);
  const freeformAnswer = String(document.getElementById("sessionFreeformInput")?.value ?? "").trim();
  const usesFreeform = state.selectedLabel === FREEFORM_OPTION_LABEL || options.length === 0;
  const finalAnswer = usesFreeform
    ? freeformAnswer
    : [selectedOption?.title, selectedOption?.description].filter(Boolean).join("\n");

  return {
    selectedLabel: state.selectedLabel,
    selectedTitle: String(selectedOption?.title ?? (usesFreeform ? "其他" : "")),
    selectedDescription: String(selectedOption?.description ?? ""),
    freeformAnswer,
    finalAnswer: finalAnswer.trim(),
  };
}

/**
 * 渲染计划草案审阅步骤。
 *
 * @param {Record<string, unknown>} item 当前计划步骤。
 * @returns {void}
 */
function renderPlanReview(item) {
  const itemChanged = state.activeItemId !== item.id;
  if (itemChanged) {
    state.activeItemId = String(item.id ?? "");
    state.blocks = splitMarkdownBlocks(String(item.planMarkdown ?? ""));
    state.annotations = [...(Array.isArray(item.annotations) ? item.annotations : [])];
    state.generalNote = String(item.generalNote ?? "");
    state.selectedBlockId = "";
    state.selectedText = "";
  }

  dom.activeStepLabel.textContent = item.iteration ? `Draft ${item.iteration}` : "Draft";
  dom.currentContent.className = "plan-document session-plan-document";
  dom.currentContent.onmouseup = handleSelection;
  dom.currentContent.onclick = handleBlockClick;
  renderPlanBlocks();
  renderPlanAction(item);
}

/**
 * 渲染计划 Markdown 文档块。
 *
 * @returns {void}
 */
function renderPlanBlocks() {
  dom.currentContent.innerHTML = "";
  state.blocks.forEach((block, index) => {
    const article = document.createElement("section");
    article.className = "plan-block";
    article.dataset.blockId = block.id;
    article.dataset.blockLabel = `#${index + 1}`;
    article.innerHTML = renderMarkdownBlock(block.markdown);
    decorateAnnotatedBlock(article, getBlockAnnotationDecorations(block.id));
    dom.currentContent.appendChild(article);
  });
  syncSelectedBlockHighlight();
}

/**
 * 渲染计划批注操作区。
 *
 * @param {Record<string, unknown>} item 当前计划步骤。
 * @returns {void}
 */
function renderPlanAction(item) {
  dom.actionPane.innerHTML = `
    <section class="selected-card session-selected-card">
      <h2>当前选中文本预览</h2>
      <p id="selectionPreview" class="selection-preview">在左侧选中文字或点击段落后添加批注。</p>
      <label class="field-label" for="commentInput">批注意见</label>
      <textarea id="commentInput" rows="4" maxlength="500" placeholder="请在此输入对选中文本的批注意见..."></textarea>
      <small id="commentCounter" class="input-counter">0 / 500</small>
      <button id="addAnnotationButton" type="button">添加批注</button>
    </section>
    <section class="annotation-card session-annotation-card">
      <div class="section-heading">
        <h2>待提交批注</h2>
        <span id="annotationCount">0</span>
      </div>
      <div id="annotationList" class="annotation-list"></div>
    </section>
    <section class="general-card">
      <h2>整体意见（可选）</h2>
      <textarea id="generalNoteInput" rows="5" maxlength="1000" placeholder="请输入对整体计划的意见或建议...">${escapeHtml(state.generalNote)}</textarea>
      <small id="generalCounter" class="input-counter">0 / 1000</small>
    </section>
    <div class="session-action-footer">
      <div class="actions session-actions">
        <button id="submitFeedbackButton" class="primary" type="button">提交批注</button>
        <button id="approveButton" class="success" type="button">通过计划</button>
      </div>
      <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
    </div>
  `;

  document.getElementById("commentInput")?.addEventListener("input", () => updateInputCounter("commentInput", "commentCounter", 500));
  document.getElementById("generalNoteInput")?.addEventListener("input", () => updateInputCounter("generalNoteInput", "generalCounter", 1000));
  document.getElementById("addAnnotationButton")?.addEventListener("click", addAnnotation);
  document.getElementById("submitFeedbackButton")?.addEventListener("click", () => submitPlanFeedback(item).catch(handleActionError));
  document.getElementById("approveButton")?.addEventListener("click", () => approvePlan(item).catch(handleActionError));
  updateInputCounter("commentInput", "commentCounter", 500);
  updateInputCounter("generalNoteInput", "generalCounter", 1000);
  renderAnnotations();
}

/**
 * 处理鼠标选择文本事件。
 *
 * @returns {void}
 */
function handleSelection() {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() ?? "";
  if (!selectedText) {
    return;
  }

  const anchorNode = selection.anchorNode;
  const element = anchorNode?.nodeType === Node.TEXT_NODE ? anchorNode.parentElement : anchorNode;
  const block = element?.closest?.(".plan-block");
  if (!block) {
    return;
  }
  setSelectedBlock(block.dataset.blockId, selectedText);
}

/**
 * 处理点击文档块事件。
 *
 * @param {MouseEvent} event 点击事件。
 * @returns {void}
 */
function handleBlockClick(event) {
  const block = event.target.closest?.(".plan-block");
  if (!block) {
    return;
  }
  const selectedText = window.getSelection()?.toString().trim();
  if (selectedText) {
    return;
  }
  const blockRecord = findBlock(block.dataset.blockId);
  setSelectedBlock(block.dataset.blockId, blockRecord?.markdown ?? "");
}

/**
 * 设置当前批注目标。
 *
 * @param {string} blockId 文档块 ID。
 * @param {string} selectedText 选中文本。
 * @returns {void}
 */
function setSelectedBlock(blockId, selectedText) {
  state.selectedBlockId = blockId;
  state.selectedText = selectedText;
  syncSelectedBlockHighlight();
  const preview = document.getElementById("selectionPreview");
  if (preview) {
    preview.textContent = selectedText.length > 240 ? `${selectedText.slice(0, 240)}...` : selectedText;
  }
}

/**
 * 新增一条待提交批注。
 *
 * @returns {void}
 */
function addAnnotation() {
  const commentInput = document.getElementById("commentInput");
  const comment = String(commentInput?.value ?? "").trim();
  if (!state.selectedBlockId || !state.selectedText) {
    setMessage("请先在左侧选择一段文本或点击一个段落。");
    return;
  }
  if (!comment) {
    setMessage("请先填写批注意见。");
    return;
  }

  const block = findBlock(state.selectedBlockId);
  state.annotations.push({
    id: createLocalId(),
    blockId: state.selectedBlockId,
    blockMarkdown: block?.markdown ?? "",
    selectedText: state.selectedText,
    comment,
    createdAt: new Date().toISOString(),
  });
  if (commentInput) {
    commentInput.value = "";
  }
  renderPlanBlocks();
  updateInputCounter("commentInput", "commentCounter", 500);
  renderAnnotations();
  setMessage("批注已加入待提交列表。");
}

/**
 * 渲染待提交批注列表。
 *
 * @returns {void}
 */
function renderAnnotations() {
  const count = document.getElementById("annotationCount");
  const list = document.getElementById("annotationList");
  if (!count || !list) {
    return;
  }

  count.textContent = String(state.annotations.length);
  list.innerHTML = "";
  if (state.annotations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "selection-preview";
    empty.textContent = "还没有待提交批注。";
    list.appendChild(empty);
    return;
  }

  state.annotations.forEach((annotation, index) => {
    const annotationNumber = index + 1;
    const tone = index % 5;
    const item = document.createElement("div");
    item.className = `annotation-item annotation-tone-${tone}`;
    item.innerHTML = `
      <strong><span class="annotation-item-badge">${annotationNumber}</span>${escapeHtml(annotation.blockId || "未绑定段落")}</strong>
      <p>${escapeHtml(shorten(annotation.selectedText, 140))}</p>
      <p>${escapeHtml(annotation.comment)}</p>
    `;
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.textContent = "移除";
    removeButton.addEventListener("click", () => removeAnnotation(annotation.id));
    item.appendChild(removeButton);
    list.appendChild(item);
  });
}

/**
 * 移除一条待提交批注。
 *
 * @param {string} annotationId 批注 ID。
 * @returns {void}
 */
function removeAnnotation(annotationId) {
  state.annotations = state.annotations.filter((item) => item.id !== annotationId);
  renderPlanBlocks();
  renderAnnotations();
}

/**
 * 提交计划批注。
 *
 * @param {Record<string, unknown>} item 当前计划步骤。
 * @returns {Promise<void>} 提交完成后返回。
 */
async function submitPlanFeedback(item) {
  const generalNote = String(document.getElementById("generalNoteInput")?.value ?? "").trim();
  if (state.annotations.length === 0 && !generalNote) {
    showAlert("还不能提交", "请至少添加一条批注，或填写整体意见后再提交。");
    return;
  }

  setBusy(true);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/review-feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id, annotations: state.annotations, generalNote }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "提交批注失败。");
    }
    applySession(payload.session, { force: true });
    const message = "批注已提交。请留在当前面板，Codex 回写下一版草案后这里会自动刷新。";
    setMessage(message);
    showAlert("批注已提交", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 通过当前计划。
 *
 * @param {Record<string, unknown>} item 当前计划步骤。
 * @returns {Promise<void>} 提交完成后返回。
 */
async function approvePlan(item) {
  setBusy(true);
  try {
    const response = await fetch(`/api/sessions/${encodeURIComponent(state.sessionId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: item.id }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "通过计划失败。");
    }
    applySession(payload.session, { force: true });
    const shutdownSeconds = Number(payload.panelShutdownSeconds ?? 0);
    const shutdownHint = shutdownSeconds > 0 ? `本地面板会在约 ${Math.round(shutdownSeconds)} 秒后自动关闭。` : "";
    const message = ["计划已通过。", shutdownHint, "Codex 会读取通过结果并继续原生 Plan 流程。"].filter(Boolean).join(" ");
    setMessage(message);
    showAlert("计划已通过", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 获取某个 Markdown 块关联的批注装饰信息。
 *
 * @param {string} blockId 文档块 ID。
 * @returns {Array<{annotation: Record<string, string>, number: number, tone: number}>} 装饰信息。
 */
function getBlockAnnotationDecorations(blockId) {
  return state.annotations
    .map((annotation, index) => ({
      annotation,
      number: index + 1,
      tone: index % 5,
    }))
    .filter((item) => item.annotation.blockId === blockId);
}

/**
 * 给已批注文档块添加背景和编号。
 *
 * @param {HTMLElement} article 文档块元素。
 * @param {Array<{annotation: Record<string, string>, number: number, tone: number}>} decorations 装饰信息。
 * @returns {void}
 */
function decorateAnnotatedBlock(article, decorations) {
  if (decorations.length === 0) {
    return;
  }
  article.classList.add("has-annotations", `annotation-tone-${decorations[0].tone}`);
  decorations.forEach((decoration) => applyInlineAnnotationHighlight(article, decoration));
  appendAnnotationMarkers(article, decorations);
}

/**
 * 添加右上角批注编号徽标。
 *
 * @param {HTMLElement} article 文档块元素。
 * @param {Array<{annotation: Record<string, string>, number: number, tone: number}>} decorations 装饰信息。
 * @returns {void}
 */
function appendAnnotationMarkers(article, decorations) {
  const markerGroup = document.createElement("div");
  markerGroup.className = "annotation-markers";
  markerGroup.setAttribute("aria-label", decorations.map((item) => `批注 ${item.number}`).join("，"));

  decorations.slice(0, 4).forEach((decoration) => {
    const marker = document.createElement("span");
    marker.className = `annotation-marker annotation-tone-${decoration.tone}`;
    marker.textContent = String(decoration.number);
    marker.title = `批注 ${decoration.number}`;
    markerGroup.appendChild(marker);
  });
  if (decorations.length > 4) {
    const moreMarker = document.createElement("span");
    moreMarker.className = "annotation-marker is-more";
    moreMarker.textContent = `+${decorations.length - 4}`;
    markerGroup.appendChild(moreMarker);
  }
  article.appendChild(markerGroup);
}

/**
 * 尽量把用户选中的短文本标为内联高亮。
 *
 * @param {HTMLElement} root 文档块根元素。
 * @param {{annotation: Record<string, string>, number: number, tone: number}} decoration 装饰信息。
 * @returns {boolean} 成功时返回 true。
 */
function applyInlineAnnotationHighlight(root, decoration) {
  const selectedText = String(decoration.annotation.selectedText ?? "").trim();
  if (selectedText.length < 2 || selectedText.length > ANNOTATION_HIGHLIGHT_MAX_LENGTH) {
    return false;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("mark, .annotation-markers")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue?.includes(selectedText) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const textNode = walker.nextNode();
  if (!textNode) {
    return false;
  }
  return wrapTextNodeWithAnnotation(textNode, selectedText, decoration);
}

/**
 * 将文本节点中的目标片段替换为带编号的 mark。
 *
 * @param {Node} textNode 命中的文本节点。
 * @param {string} selectedText 需要高亮的文本。
 * @param {{number: number, tone: number}} decoration 装饰信息。
 * @returns {boolean} 替换成功时返回 true。
 */
function wrapTextNodeWithAnnotation(textNode, selectedText, decoration) {
  const source = textNode.nodeValue ?? "";
  const start = source.indexOf(selectedText);
  if (start < 0 || !textNode.parentNode) {
    return false;
  }

  const fragment = document.createDocumentFragment();
  const prefix = source.slice(0, start);
  const suffix = source.slice(start + selectedText.length);
  if (prefix) {
    fragment.appendChild(document.createTextNode(prefix));
  }

  const mark = document.createElement("mark");
  mark.className = `annotation-highlight annotation-tone-${decoration.tone}`;
  mark.textContent = selectedText;

  const badge = document.createElement("span");
  badge.className = `inline-annotation-badge annotation-tone-${decoration.tone}`;
  badge.textContent = String(decoration.number);
  mark.appendChild(badge);
  fragment.appendChild(mark);

  if (suffix) {
    fragment.appendChild(document.createTextNode(suffix));
  }
  textNode.parentNode.replaceChild(fragment, textNode);
  return true;
}

/**
 * 同步当前选中文档块样式。
 *
 * @returns {void}
 */
function syncSelectedBlockHighlight() {
  document.querySelectorAll(".plan-block").forEach((item) => item.classList.remove("is-selected"));
  if (state.selectedBlockId) {
    document.querySelector(`[data-block-id="${CSS.escape(state.selectedBlockId)}"]`)?.classList.add("is-selected");
  }
}

/**
 * 按 ID 查找 Markdown 文档块。
 *
 * @param {string} blockId 文档块 ID。
 * @returns {{id: string, markdown: string} | undefined} 匹配块。
 */
function findBlock(blockId) {
  return state.blocks.find((item) => item.id === blockId);
}

/**
 * 拆分 Markdown 为稳定文档块。
 *
 * @param {string} markdown 原始 Markdown。
 * @returns {Array<{id: string, markdown: string}>} 文档块数组。
 */
function splitMarkdownBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let current = [];
  let inFence = false;

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      current.push(line);
      return;
    }
    if (!inFence && line.trim() === "") {
      flushCurrentBlock(blocks, current);
      current = [];
      return;
    }
    current.push(line);
  });
  flushCurrentBlock(blocks, current);
  return blocks.map((markdownBlock, index) => ({ id: `block-${index + 1}`, markdown: markdownBlock }));
}

/**
 * 将当前行缓冲写入 Markdown 块数组。
 *
 * @param {string[]} blocks 已收集块。
 * @param {string[]} current 当前行缓冲。
 * @returns {void}
 */
function flushCurrentBlock(blocks, current) {
  const value = current.join("\n").trim();
  if (value) {
    blocks.push(value);
  }
}

/**
 * 安全渲染单个 Markdown 块。
 *
 * @param {string} markdownBlock 单个 Markdown 块。
 * @returns {string} HTML 片段。
 */
function renderMarkdownBlock(markdownBlock) {
  if (markdownBlock.startsWith("```")) {
    return `<pre><code>${escapeHtml(markdownBlock.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/```$/, ""))}</code></pre>`;
  }
  const escaped = escapeHtml(markdownBlock);
  if (/^###\s+/.test(markdownBlock)) {
    return `<h3>${escaped.replace(/^###\s+/, "")}</h3>`;
  }
  if (/^##\s+/.test(markdownBlock)) {
    return `<h2>${escaped.replace(/^##\s+/, "")}</h2>`;
  }
  if (/^#\s+/.test(markdownBlock)) {
    return `<h2>${escaped.replace(/^#\s+/, "")}</h2>`;
  }
  if (/^[-*]\s+/m.test(markdownBlock) || /^\d+\.\s+/m.test(markdownBlock)) {
    const items = markdownBlock
      .split(/\n/)
      .filter((line) => line.trim())
      .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, ""))
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }
  return `<p>${escaped.replace(/\n/g, "<br />")}</p>`;
}

/**
 * 返回当前 active item。
 *
 * @param {Record<string, unknown> | null} session 指定 session；缺省使用当前状态。
 * @returns {Record<string, unknown> | undefined} 当前步骤。
 */
function getActiveItem(session = state.session) {
  const activeItemId = String(session?.activeItemId ?? "");
  const items = Array.isArray(session?.items) ? session.items : [];
  return items.find((item) => item.id === activeItemId);
}

/**
 * 规范化澄清选项，并按需补 D: 其他。
 *
 * @param {Record<string, unknown>} item 澄清步骤。
 * @returns {Array<Record<string, unknown>>} 可渲染选项。
 */
function normalizedOptions(item) {
  const options = Array.isArray(item.options) ? [...item.options] : [];
  if (item.allowFreeform && !options.some((option) => option.label === FREEFORM_OPTION_LABEL)) {
    options.push({
      label: FREEFORM_OPTION_LABEL,
      title: "其他",
      description: "输入你自己的意见。",
    });
  }
  return options;
}

/**
 * 选择澄清问题的默认选项。
 *
 * @param {Record<string, unknown>} item 澄清步骤。
 * @returns {string} 默认选项 label。
 */
function defaultClarificationLabel(item) {
  const options = normalizedOptions(item);
  const recommended = options.find((option) => option.recommended);
  return String(recommended?.label ?? options[0]?.label ?? FREEFORM_OPTION_LABEL);
}

/**
 * 同步澄清输入控件状态。
 *
 * @param {Record<string, unknown>} item 澄清步骤。
 * @returns {void}
 */
function syncClarificationControls(item) {
  const textarea = document.getElementById("sessionFreeformInput");
  const options = normalizedOptions(item);
  if (options.length === 1 && options[0]?.label === FREEFORM_OPTION_LABEL) {
    state.selectedLabel = FREEFORM_OPTION_LABEL;
    document.querySelector(`input[value="${FREEFORM_OPTION_LABEL}"]`)?.setAttribute("checked", "checked");
    textarea?.focus();
  }
}

/**
 * 返回推荐选项；没有显式推荐时使用默认选项兜底。
 *
 * @param {Record<string, unknown>} item 澄清步骤。
 * @returns {Record<string, unknown> | undefined} 推荐选项。
 */
function getRecommendedOption(item) {
  const options = normalizedOptions(item).filter((option) => option.label !== FREEFORM_OPTION_LABEL);
  return options.find((option) => option.recommended) ?? options[0];
}

/**
 * 渲染右侧推荐方案预览。
 *
 * @param {Record<string, unknown> | undefined} option 推荐选项。
 * @returns {string} HTML 片段。
 */
function renderRecommendedPreview(option) {
  if (!option) {
    return `
      <div class="recommended-preview is-empty">
        <strong>推荐方案预览</strong>
        <p>当前问题没有预设推荐方案，可直接填写补充说明后提交。</p>
      </div>
    `;
  }
  return `
    <div class="recommended-preview">
      <strong>推荐方案预览</strong>
      <div class="recommended-option-line">
        <span>${escapeHtml(String(option.label ?? ""))}. ${escapeHtml(String(option.title ?? ""))}</span>
        <em>推荐</em>
      </div>
      <p>${escapeHtml(String(option.description ?? ""))}</p>
    </div>
  `;
}

/**
 * 快速采用推荐方案并提交当前回答。
 *
 * @param {Record<string, unknown>} item 当前澄清步骤。
 * @returns {void}
 */
function adoptRecommendedAnswer(item) {
  const recommended = getRecommendedOption(item);
  if (!recommended) {
    const textarea = document.getElementById("sessionFreeformInput");
    textarea?.focus();
    return;
  }
  state.selectedLabel = String(recommended.label ?? "");
  document
    .querySelectorAll('input[name="sessionClarificationOption"]')
    .forEach((input) => {
      input.checked = input.value === state.selectedLabel;
    });
  submitClarificationAnswer(item).catch(handleActionError);
}

/**
 * 更新 textarea 字数计数。
 *
 * @param {string} inputId textarea 元素 ID。
 * @param {string} counterId 计数元素 ID。
 * @param {number} maxLength 最大字符数。
 * @returns {void}
 */
function updateInputCounter(inputId, counterId, maxLength) {
  const input = document.getElementById(inputId);
  const counter = document.getElementById(counterId);
  if (!(input instanceof HTMLTextAreaElement) || !counter) {
    return;
  }
  counter.textContent = `${input.value.length} / ${maxLength}`;
}

/**
 * 设置 loading 状态，防止重复提交。
 *
 * @param {boolean} busy 是否提交中。
 * @returns {void}
 */
function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("button").forEach((button) => {
    if (button.id !== "reloadButton" && button.id !== "alertCloseButton" && !button.classList.contains("hamburger-button")) {
      button.disabled = busy;
    }
  });
}

/**
 * 生成等待态主卡片里的最近提交摘要。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @returns {string} HTML 片段。
 */
function renderRecentSubmissionCard(session) {
  const action = session?.lastUserAction ?? {};
  if (!action.type) {
    return "";
  }
  const payload = action.payload ?? {};
  if (action.type === "clarification_answered") {
    const answer = payload.answer ?? {};
    return `
      <div class="recent-submission-card">
        <button class="recent-submission-toggle" type="button" disabled>最近一次提交</button>
        <dl>
          <div><dt>提交类型</dt><dd>需求澄清回答</dd></div>
          <div><dt>提交时间</dt><dd>${escapeHtml(formatDateTime(action.createdAt))}</dd></div>
          <div><dt>你的回答</dt><dd>${escapeHtml(shorten(answer.finalAnswer ?? "", 220))}</dd></div>
        </dl>
      </div>
    `;
  }
  if (action.type === "review_feedback_submitted") {
    const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
    return `
      <div class="recent-submission-card">
        <button class="recent-submission-toggle" type="button" disabled>最近一次提交</button>
        <dl>
          <div><dt>提交类型</dt><dd>计划批注</dd></div>
          <div><dt>提交时间</dt><dd>${escapeHtml(formatDateTime(action.createdAt))}</dd></div>
          <div><dt>批注摘要</dt><dd>${escapeHtml(annotations.length ? `${annotations.length} 条批注已提交` : "仅提交整体意见")}</dd></div>
        </dl>
        ${renderSubmittedAnnotationSummary(annotations)}
      </div>
    `;
  }
  return "";
}

/**
 * 渲染等待态右侧锁定操作面板。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @returns {string} HTML 片段。
 */
function renderWaitingActionPane(session) {
  const action = session?.lastUserAction ?? {};
  const payload = action.payload ?? {};
  if (action.type === "review_feedback_submitted") {
    const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
    const generalNote = String(payload.generalNote ?? "");
    return `
      <section class="annotation-card session-annotation-card">
        <div class="section-heading">
          <h2>已提交批注</h2>
          <span>${annotations.length}</span>
        </div>
        <div class="annotation-list is-readonly">${renderSubmittedAnnotationItems(annotations)}</div>
      </section>
      <section class="general-card locked-card">
        <h2>整体意见（总结）</h2>
        <p>${escapeHtml(generalNote || "未填写整体意见。")}</p>
      </section>
      <div class="session-action-footer">
        <div class="waiting-action-button">等待回写中</div>
        <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
      </div>
    `;
  }
  if (action.type === "clarification_answered") {
    const answer = payload.answer ?? {};
    return `
      <section class="session-card locked-card">
        <h2>已提交回答</h2>
        <p>${escapeHtml(answer.finalAnswer || "回答已提交。")}</p>
      </section>
      <div class="session-action-footer">
        <div class="waiting-action-button">等待下一步</div>
        <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
      </div>
    `;
  }
  return `
    <section class="session-card">
      <h2>当前状态</h2>
      <p class="selection-preview">${escapeHtml(statusMessage(session))}</p>
    </section>
    <p id="sessionMessage" class="message-box" role="status">${escapeHtml(state.message)}</p>
  `;
}

/**
 * 渲染等待态中间卡片的批注摘要。
 *
 * @param {Array<Record<string, unknown>>} annotations 已提交批注。
 * @returns {string} HTML 片段。
 */
function renderSubmittedAnnotationSummary(annotations) {
  if (annotations.length === 0) {
    return "";
  }
  const items = annotations
    .slice(0, 3)
    .map((annotation) => `<li>${escapeHtml(shorten(annotation.comment ?? "", 120))}</li>`)
    .join("");
  return `<ul class="submitted-summary-list">${items}</ul>`;
}

/**
 * 渲染等待态右侧的已提交批注列表。
 *
 * @param {Array<Record<string, unknown>>} annotations 已提交批注。
 * @returns {string} HTML 片段。
 */
function renderSubmittedAnnotationItems(annotations) {
  if (annotations.length === 0) {
    return `<p class="selection-preview">没有段落级批注。</p>`;
  }
  return annotations
    .map(
      (annotation, index) => `
        <div class="submitted-annotation-item">
          <span>${index + 1}</span>
          <strong>${escapeHtml(annotation.blockId || "整体")}</strong>
          <p>${escapeHtml(shorten(annotation.comment ?? "", 140))}</p>
        </div>
      `,
    )
    .join("");
}

/**
 * 生成当前 session 的用户提示。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @returns {string} 用户可读提示。
 */
function statusMessage(session) {
  const status = session?.status;
  if (status === "waiting_user_clarification") {
    return "请回答当前问题，提交后页面会等待 Codex 回写下一步。";
  }
  if (status === "waiting_user_review") {
    return "请批注当前草案或直接通过计划，提交后页面会等待 Codex 回写下一步。";
  }
  if (status === "approved") {
    return "计划已通过，Codex 可以继续输出正式 Plan。";
  }
  return "Codex 正在处理你的提交。保持此页面打开即可，下一步会自动刷新。";
}

/**
 * 生成等待页细节。
 *
 * @param {Record<string, unknown>} session 当前 session。
 * @returns {string} 等待说明。
 */
function waitingDetail(session) {
  const actionType = session?.lastUserAction?.type;
  if (actionType === "clarification_answered") {
    return "你的回答已经提交，Codex 会据此判断是否继续追问或生成计划草案。";
  }
  if (actionType === "review_feedback_submitted") {
    return "你的批注已经提交，Codex 会吸收意见并发布下一版计划草案。";
  }
  return "Codex 正在准备要展示给你的问题或计划草案。";
}

/**
 * 缩短 Session ID，便于顶部工具栏展示。
 *
 * @param {string} sessionId 完整 Session ID。
 * @returns {string} 短 ID。
 */
function shortSessionId(sessionId) {
  return sessionId ? sessionId.slice(0, 8) : "-";
}

/**
 * 返回过程记录名称。
 *
 * @param {Record<string, unknown>} item 步骤。
 * @returns {string} 名称。
 */
function itemLabel(item) {
  if (item.type === "clarification") {
    return item.title || "需求澄清";
  }
  if (item.type === "plan_review") {
    return item.title || "计划草案";
  }
  return item.title || "步骤";
}

/**
 * 判断流程节点是否已经完成。
 *
 * @param {Record<string, unknown>} item 步骤。
 * @returns {boolean} 完成时返回 true。
 */
function isFinishedTimelineItem(item) {
  return ["answered", "needs_revision", "approved"].includes(String(item.status ?? ""));
}

/**
 * 返回流程节点圆点中的文本。
 *
 * @param {Record<string, unknown>} item 步骤。
 * @param {number} index 步骤序号。
 * @returns {string} 节点文本。
 */
function timelineNodeLabel(item, index) {
  return isFinishedTimelineItem(item) ? "✓" : String(index + 1);
}

/**
 * 返回流程节点副文本。
 *
 * @param {Record<string, unknown>} item 步骤。
 * @returns {string} 副文本。
 */
function timelineSubText(item) {
  if (item.type === "clarification") {
    return shorten(item.question ?? "需求澄清", 36);
  }
  if (item.type === "plan_review") {
    return item.iteration ? `计划草案 Draft ${item.iteration}` : "计划草案";
  }
  return formatDateTime(item.updatedAt ?? item.createdAt);
}

/**
 * 返回步骤状态名称。
 *
 * @param {string} status 步骤状态。
 * @returns {string} 状态名称。
 */
function itemStatusLabel(status) {
  const labels = {
    pending: "进行中",
    answered: "已回答",
    needs_revision: "需重写",
    approved: "已通过",
  };
  return labels[status] ?? status;
}

/**
 * 把 ISO 时间格式化为短日期时间；解析失败时返回原文本或占位符。
 *
 * @param {unknown} value ISO 时间。
 * @returns {string} 本地化短时间。
 */
function formatDateTime(value) {
  const rawValue = String(value ?? "");
  if (!rawValue) {
    return "-";
  }
  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return rawValue;
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * 截断长文本，避免卡片撑破布局。
 *
 * @param {string} value 原始文本。
 * @param {number} maxLength 最大长度。
 * @returns {string} 截断文本。
 */
function shorten(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value ?? "";
  }
  return `${value.slice(0, maxLength)}...`;
}

/**
 * 创建本地临时 ID。
 *
 * @returns {string} ID。
 */
function createLocalId() {
  return crypto?.randomUUID?.() ?? `annotation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * HTML 转义。
 *
 * @param {string} value 待插入 DOM 的文本。
 * @returns {string} 转义文本。
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * 统一处理异步动作异常。
 *
 * @param {unknown} error 异常对象。
 * @returns {void}
 */
function handleActionError(error) {
  const message = formatError(error, "操作失败。");
  setMessage(message);
  showAlert("操作失败", message);
}

/**
 * 将任意异常转换为用户可读文本。
 *
 * @param {unknown} error 异常对象。
 * @param {string} fallback 兜底文本。
 * @returns {string} 用户可读错误。
 */
function formatError(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * 显示页面底部状态信息。
 *
 * @param {string} message 用户可读消息。
 * @returns {void}
 */
function setMessage(message) {
  state.message = message;
  const box = document.getElementById("sessionMessage");
  if (box) {
    box.textContent = message;
  }
}

/**
 * 点击 toast 外层时关闭提示。
 *
 * @param {MouseEvent} event 点击事件。
 * @returns {void}
 */
function handleAlertOverlayClick(event) {
  if (event.target === dom.alertOverlay) {
    hideAlert();
  }
}

/**
 * 处理 Esc 关闭 toast。
 *
 * @param {KeyboardEvent} event 键盘事件。
 * @returns {void}
 */
function handleGlobalKeydown(event) {
  if (event.key === "Escape" && !dom.alertOverlay.hidden) {
    hideAlert();
  }
}

/**
 * 显示顶部 toast。
 *
 * @param {string} title 提示标题。
 * @param {string} message 提示正文。
 * @returns {void}
 */
function showAlert(title, message) {
  if (state.alertTimerId) {
    window.clearTimeout(state.alertTimerId);
  }
  state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dom.alertTitle.textContent = title;
  dom.alertMessage.textContent = message;
  dom.alertOverlay.hidden = false;
  state.alertTimerId = window.setTimeout(() => hideAlert({ restoreFocus: false }), ALERT_AUTO_CLOSE_MS);
}

/**
 * 关闭顶部 toast。
 *
 * @param {{restoreFocus?: boolean}} options 关闭选项。
 * @returns {void}
 */
function hideAlert(options = {}) {
  if (state.alertTimerId) {
    window.clearTimeout(state.alertTimerId);
    state.alertTimerId = null;
  }
  dom.alertOverlay.hidden = true;
  if (options.restoreFocus !== false && state.lastFocusedElement instanceof HTMLElement) {
    state.lastFocusedElement.focus();
  }
  state.lastFocusedElement = null;
}

init().catch((error) => {
  setMessage(error.message ?? "面板初始化失败。");
});
