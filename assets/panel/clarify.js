/**
 * Plan Reviewer 需求澄清面板逻辑。
 *
 * 模块职责：
 * - 从本地 HTTP API 读取单轮需求澄清问题；
 * - 渲染 A/B/C 方案、推荐方案说明和 D: 其他输入框；
 * - 提交用户回答，让 Codex 可以继续追问或进入计划草案审阅；
 * - 保持所有用户可见内容用 textContent 写入 DOM，避免草案或回答内容造成 XSS。
 *
 * 并发说明：
 * 提交按钮使用 busy 状态锁定，避免重复提交；后端仍会用文件锁保护最终状态文件。
 */

const state = {
  clarificationId: "",
  clarification: null,
  selectedLabel: "",
  alertTimerId: null,
  lastFocusedElement: null,
};

const ALERT_AUTO_CLOSE_MS = 3000;
const FREEFORM_OPTION_LABEL = "D";

const dom = {
  title: document.getElementById("clarificationTitle"),
  status: document.getElementById("clarificationStatus"),
  confidenceTarget: document.getElementById("confidenceTarget"),
  reloadButton: document.getElementById("reloadButton"),
  contextSection: document.getElementById("contextSection"),
  contextText: document.getElementById("contextText"),
  questionText: document.getElementById("questionText"),
  answerForm: document.getElementById("answerForm"),
  optionList: document.getElementById("optionList"),
  freeformGroup: document.getElementById("freeformGroup"),
  freeformLabel: document.getElementById("freeformLabel"),
  freeformInput: document.getElementById("freeformInput"),
  answerSummary: document.getElementById("answerSummary"),
  submitAnswerButton: document.getElementById("submitAnswerButton"),
  messageBox: document.getElementById("messageBox"),
  alertOverlay: document.getElementById("alertOverlay"),
  alertTitle: document.getElementById("alertTitle"),
  alertMessage: document.getElementById("alertMessage"),
  alertCloseButton: document.getElementById("alertCloseButton"),
};

/**
 * 页面入口。
 *
 * @returns {Promise<void>} 初始化完成后返回。
 * @throws {Error} URL 缺少 clarificationId 或 API 加载失败时抛出。
 */
async function init() {
  state.clarificationId = extractClarificationId(window.location.pathname);
  bindEvents();
  await loadClarification();
}

/**
 * 从路径中解析需求澄清 ID。
 *
 * @param {string} pathname 当前 location.pathname。
 * @returns {string} 需求澄清 ID。
 * @throws {Error} 当路径中没有合法 ID 时抛出。
 */
function extractClarificationId(pathname) {
  const match = pathname.match(/\/clarify\/([a-zA-Z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error("URL 中缺少需求澄清 ID，请从 Codex 返回的链接打开面板。");
  }
  return match[1];
}

/**
 * 绑定页面事件。
 *
 * @returns {void}
 */
function bindEvents() {
  dom.reloadButton.addEventListener("click", () => loadClarification().catch(handleActionError));
  dom.answerForm.addEventListener("submit", submitAnswer);
  dom.optionList.addEventListener("change", handleOptionChange);
  dom.alertCloseButton.addEventListener("click", () => hideAlert());
  dom.alertOverlay.addEventListener("click", handleAlertOverlayClick);
  document.addEventListener("keydown", handleGlobalKeydown);
}

/**
 * 加载需求澄清记录。
 *
 * @returns {Promise<void>} 加载完成后返回。
 * @throws {Error} API 返回错误时抛出。
 */
async function loadClarification() {
  setMessage("正在加载需求澄清问题...");
  const response = await fetch(`/api/clarifications/${encodeURIComponent(state.clarificationId)}`);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error ?? "加载需求澄清记录失败。");
  }
  state.clarification = payload.clarification;
  state.selectedLabel = state.clarification.answer?.selectedLabel ?? "";
  renderClarification();
  setMessage(state.clarification.status === "answered" ? "已提交回答。" : "请选择一个方案，或填写 D: 其他。");
}

/**
 * 渲染当前需求澄清记录。
 *
 * @returns {void}
 */
function renderClarification() {
  const clarification = state.clarification;
  dom.title.textContent = clarification.title || "需求澄清";
  dom.confidenceTarget.textContent = `${clarification.confidenceTarget ?? 95}% 理解目标`;
  dom.questionText.textContent = clarification.question || "暂无问题。";
  renderStatus(clarification.status);
  renderContext(clarification);
  renderOptions(clarification);
  renderAnsweredState(clarification);
}

/**
 * 渲染澄清状态徽标。
 *
 * @param {string} status 澄清状态。
 * @returns {void}
 */
function renderStatus(status) {
  const labels = {
    pending: "待回答",
    answered: "已回答",
  };
  dom.status.textContent = labels[status] ?? status;
  dom.status.className = "status-badge";
  if (status === "answered") {
    dom.status.classList.add("approved");
  }
}

/**
 * 渲染原始需求和已理解上下文。
 *
 * @param {Record<string, unknown>} clarification 澄清记录。
 * @returns {void}
 */
function renderContext(clarification) {
  const parts = [];
  if (clarification.originalRequest) {
    parts.push(`原始需求：\n${clarification.originalRequest}`);
  }
  if (clarification.knownContext) {
    parts.push(`我目前理解的是：\n${clarification.knownContext}`);
  }
  dom.contextSection.hidden = parts.length === 0;
  dom.contextText.textContent = parts.join("\n\n");
}

/**
 * 渲染选项列表和 D: 其他输入框。
 *
 * @param {Record<string, unknown>} clarification 澄清记录。
 * @returns {void}
 */
function renderOptions(clarification) {
  const options = Array.isArray(clarification.options) ? clarification.options : [];
  dom.optionList.innerHTML = "";
  options.forEach((option) => {
    dom.optionList.appendChild(createOptionCard(option));
  });

  const shouldShowFreeform = Boolean(clarification.allowFreeform);
  dom.freeformGroup.hidden = !shouldShowFreeform;
  dom.freeformLabel.textContent = options.length > 0 ? "D: 其他" : "你的回答";
  dom.freeformInput.placeholder = options.length > 0 ? "选择 D 后输入你自己的意见" : "输入你的回答";
  if (!state.selectedLabel && options.length === 0 && shouldShowFreeform) {
    state.selectedLabel = FREEFORM_OPTION_LABEL;
  }
}

/**
 * 创建单个选项卡片。
 *
 * @param {Record<string, unknown>} option 选项数据。
 * @returns {HTMLElement} 选项卡片元素。
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
  radio.name = "clarificationOption";
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
 * 渲染已回答状态，避免重复编辑已提交答案。
 *
 * @param {Record<string, unknown>} clarification 澄清记录。
 * @returns {void}
 */
function renderAnsweredState(clarification) {
  const isAnswered = clarification.status === "answered";
  dom.submitAnswerButton.disabled = isAnswered;
  dom.freeformInput.disabled = isAnswered;
  dom.optionList.querySelectorAll("input").forEach((input) => {
    input.disabled = isAnswered;
  });

  dom.answerSummary.hidden = !isAnswered;
  if (isAnswered) {
    dom.answerSummary.textContent = `你的回答：${clarification.answer?.finalAnswer ?? ""}`;
  }
}

/**
 * 处理选项变化。
 *
 * @param {Event} event 表单 change 事件。
 * @returns {void}
 */
function handleOptionChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) {
    return;
  }
  state.selectedLabel = target.value;
}

/**
 * 提交需求澄清回答。
 *
 * @param {SubmitEvent} event 表单提交事件。
 * @returns {Promise<void>} 提交完成后返回。
 */
async function submitAnswer(event) {
  event.preventDefault();
  if (state.clarification?.status === "answered") {
    showAlert("已经提交", "这条需求澄清已经提交过回答。");
    return;
  }

  const answer = buildAnswerPayload();
  if (!answer.finalAnswer) {
    setMessage("请先选择一个选项，或填写你的意见。");
    showAlert("还不能提交", "请先选择一个选项，或填写 D: 其他。");
    return;
  }

  setBusy(true);
  try {
    const response = await fetch(`/api/clarifications/${encodeURIComponent(state.clarificationId)}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "提交回答失败。");
    }
    state.clarification = payload.clarification;
    renderClarification();
    const message = "回答已提交。Codex 会读取你的回答，并决定继续追问还是生成计划草案。";
    setMessage(message);
    showAlert("回答已提交", message);
  } catch (error) {
    const message = formatError(error, "提交回答失败。");
    setMessage(message);
    showAlert("提交失败", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 组装提交给后端的答案。
 *
 * @returns {{selectedLabel: string, selectedTitle: string, selectedDescription: string, freeformAnswer: string, finalAnswer: string}} 答案对象。
 */
function buildAnswerPayload() {
  const options = Array.isArray(state.clarification?.options) ? state.clarification.options : [];
  const selectedOption = options.find((option) => option.label === state.selectedLabel);
  const freeformAnswer = dom.freeformInput.value.trim();
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
 * 设置提交 loading 状态，防止重复提交。
 *
 * @param {boolean} busy 是否处于提交中。
 * @returns {void}
 */
function setBusy(busy) {
  dom.submitAnswerButton.disabled = busy || state.clarification?.status === "answered";
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
 * 将任意异常转换成用户可读文本。
 *
 * @param {unknown} error 异常对象。
 * @param {string} fallback 兜底文本。
 * @returns {string} 用户可读错误消息。
 */
function formatError(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
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

/**
 * 显示底部状态信息。
 *
 * @param {string} message 用户可读消息。
 * @returns {void}
 */
function setMessage(message) {
  dom.messageBox.textContent = message;
}

init().catch((error) => {
  setMessage(error.message ?? "面板初始化失败。");
});
