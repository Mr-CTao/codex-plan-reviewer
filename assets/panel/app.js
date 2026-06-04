/**
 * Plan Reviewer 浏览器端逻辑。
 *
 * 模块职责：
 * - 从本地 MCP 服务配套的 HTTP API 读取计划草案；
 * - 将 Markdown 安全地拆分为可 hover、可选择的文档块；
 * - 收集用户对段落/选中文本的批注和整体意见；
 * - 将“需要重写”或“通过计划”的决策提交给 Codex 可读取的状态文件。
 *
 * 安全说明：
 * 计划草案虽然通常由 Codex 生成，但仍按不可信文本处理。Markdown 渲染只做最小
 * 标签转换，并在插入 DOM 前转义 HTML，避免脚本注入。
 */

const state = {
  reviewId: "",
  review: null,
  blocks: [],
  selectedBlockId: "",
  selectedText: "",
  annotations: [],
  clientId: "",
  heartbeatTimerId: null,
  releasedClient: false,
  lastFocusedElement: null,
  alertTimerId: null,
};

const CLIENT_HEARTBEAT_INTERVAL_MS = 10000;
const ANNOTATION_HIGHLIGHT_MAX_LENGTH = 280;
const ALERT_AUTO_CLOSE_MS = 3000;

const dom = {
  title: document.getElementById("reviewTitle"),
  status: document.getElementById("reviewStatus"),
  iteration: document.getElementById("iterationLabel"),
  planDocument: document.getElementById("planDocument"),
  selectionPreview: document.getElementById("selectionPreview"),
  commentInput: document.getElementById("commentInput"),
  addAnnotationButton: document.getElementById("addAnnotationButton"),
  annotationList: document.getElementById("annotationList"),
  annotationCount: document.getElementById("annotationCount"),
  generalNoteInput: document.getElementById("generalNoteInput"),
  submitFeedbackButton: document.getElementById("submitFeedbackButton"),
  approveButton: document.getElementById("approveButton"),
  reloadButton: document.getElementById("reloadButton"),
  messageBox: document.getElementById("messageBox"),
  alertOverlay: document.getElementById("alertOverlay"),
  alertTitle: document.getElementById("alertTitle"),
  alertMessage: document.getElementById("alertMessage"),
  alertCloseButton: document.getElementById("alertCloseButton"),
};

/**
 * 页面入口。
 *
 * @returns {Promise<void>} 页面初始化完成后返回。
 * @throws {Error} 当 URL 中缺少 reviewId 或 API 加载失败时抛出。
 */
async function init() {
  state.reviewId = extractReviewId(window.location.pathname);
  state.clientId = createReviewClientId();
  bindEvents();
  await loadReview();
  startReviewHeartbeat();
}

/**
 * 从路径中解析审阅 ID。
 *
 * @param {string} pathname 当前 location.pathname。
 * @returns {string} 审阅 ID。
 * @throws {Error} 当路径中没有合法审阅 ID 时抛出。
 */
function extractReviewId(pathname) {
  const match = pathname.match(/\/review\/([a-zA-Z0-9_-]+)/);
  if (!match?.[1]) {
    throw new Error("URL 中缺少审阅 ID，请从 Codex 返回的链接打开面板。");
  }
  return match[1];
}

/**
 * 绑定浏览器事件。
 *
 * @returns {void}
 */
function bindEvents() {
  dom.reloadButton.addEventListener("click", () => loadReview().catch(handleActionError));
  dom.addAnnotationButton.addEventListener("click", addAnnotation);
  dom.submitFeedbackButton.addEventListener("click", submitFeedback);
  dom.approveButton.addEventListener("click", approveReview);
  dom.alertCloseButton.addEventListener("click", () => hideAlert());
  dom.alertOverlay.addEventListener("click", handleAlertOverlayClick);
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("pagehide", handlePageClose);
  window.addEventListener("beforeunload", handlePageClose);

  dom.planDocument.addEventListener("mouseup", handleSelection);
  dom.planDocument.addEventListener("click", handleBlockClick);
}

/**
 * 启动当前审阅页标签的 heartbeat。
 *
 * @returns {void}
 */
function startReviewHeartbeat() {
  stopReviewHeartbeat();
  state.releasedClient = false;
  sendReviewHeartbeat().catch(() => {});
  state.heartbeatTimerId = window.setInterval(() => {
    sendReviewHeartbeat().catch(() => {});
  }, CLIENT_HEARTBEAT_INTERVAL_MS);
}

/**
 * 停止当前审阅页标签的 heartbeat 定时器。
 *
 * @returns {void}
 */
function stopReviewHeartbeat() {
  if (state.heartbeatTimerId) {
    window.clearInterval(state.heartbeatTimerId);
    state.heartbeatTimerId = null;
  }
}

/**
 * 页面关闭或跳转时释放当前标签页租约。
 *
 * @returns {void}
 */
function handlePageClose() {
  stopReviewHeartbeat();
  releaseReviewClient();
}

/**
 * 通知当前 HTTP 面板进程本审阅页仍处于打开状态。
 *
 * @returns {Promise<void>} heartbeat 请求完成后返回。
 */
async function sendReviewHeartbeat() {
  await fetch(`/api/reviews/${encodeURIComponent(state.reviewId)}/client-heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: state.clientId }),
    keepalive: true,
  });
}

/**
 * 通知当前 HTTP 面板进程本审阅页已经关闭。
 *
 * @returns {void}
 */
function releaseReviewClient() {
  if (state.releasedClient || !state.reviewId || !state.clientId) {
    return;
  }
  state.releasedClient = true;
  const payload = JSON.stringify({ clientId: state.clientId });
  const url = `/api/reviews/${encodeURIComponent(state.reviewId)}/client-release`;
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

/**
 * 从本地 API 读取审阅记录并刷新界面。
 *
 * @returns {Promise<void>} 加载完成后返回。
 * @throws {Error} 当 API 返回错误时抛出。
 */
async function loadReview() {
  setMessage("正在加载计划草案...");
  const response = await fetch(`/api/reviews/${encodeURIComponent(state.reviewId)}`);
  const payload = await response.json();
  if (!response.ok) {
    renderMissingReview(payload.error ?? "加载审阅记录失败。");
    throw new Error(payload.error ?? "加载审阅记录失败。");
  }

  state.review = payload.review;
  state.annotations = [...(state.review.annotations ?? [])];
  state.blocks = splitMarkdownBlocks(state.review.planMarkdown ?? "");
  renderReview();
  setMessage("已加载。选中左侧文字或点击段落即可添加批注。");
}

/**
 * 渲染审阅记录缺失时的错误态。
 *
 * @param {string} message API 返回的错误消息。
 * @returns {void}
 */
function renderMissingReview(message) {
  dom.status.textContent = "未找到";
  dom.status.className = "status-badge";
  dom.planDocument.innerHTML = `
    <section class="empty-error">
      <h2>没有找到这条审阅记录</h2>
      <p>${escapeHtml(message)}</p>
      <p>请点击刷新重试；如果仍然失败，请回到 Codex 重新打开最新审阅链接。</p>
    </section>
  `;
}

/**
 * 渲染完整审阅界面。
 *
 * @returns {void}
 */
function renderReview() {
  dom.title.textContent = state.review.title || "计划草案审阅";
  dom.iteration.textContent = state.review.iteration ? `Draft ${state.review.iteration}` : "Draft";
  dom.generalNoteInput.value = state.review.generalNote ?? "";
  renderStatus(state.review.status);
  renderPlanBlocks();
  renderAnnotations();
}

/**
 * 渲染审阅状态徽标。
 *
 * @param {string} status 审阅状态。
 * @returns {void}
 */
function renderStatus(status) {
  const labels = {
    pending: "待审阅",
    needs_revision: "需要重写",
    approved: "已通过",
  };
  dom.status.textContent = labels[status] ?? status;
  dom.status.className = "status-badge";
  if (status === "approved") {
    dom.status.classList.add("approved");
  }
  if (status === "needs_revision") {
    dom.status.classList.add("needs-revision");
  }
}

/**
 * 将 Markdown 拆分后的文档块渲染到左侧。
 *
 * @returns {void}
 */
function renderPlanBlocks() {
  dom.planDocument.innerHTML = "";
  state.blocks.forEach((block, index) => {
    const article = document.createElement("section");
    article.className = "plan-block";
    article.dataset.blockId = block.id;
    article.dataset.blockLabel = `#${index + 1}`;
    article.innerHTML = renderMarkdownBlock(block.markdown);
    decorateAnnotatedBlock(article, getBlockAnnotationDecorations(block.id));
    dom.planDocument.appendChild(article);
  });
  syncSelectedBlockHighlight();
}

/**
 * 获取某个 Markdown 块关联的批注装饰信息。
 *
 * @param {string} blockId 文档块 ID。
 * @returns {Array<{annotation: Record<string, string>, number: number, tone: number}>} 批注装饰信息。
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
 * 给已批注的文档块添加背景、编号徽标，并尽量标出真实选中文本。
 *
 * @param {HTMLElement} article 文档块元素。
 * @param {Array<{annotation: Record<string, string>, number: number, tone: number}>} decorations 批注装饰信息。
 * @returns {void}
 */
function decorateAnnotatedBlock(article, decorations) {
  if (decorations.length === 0) {
    return;
  }

  article.classList.add("has-annotations", `annotation-tone-${decorations[0].tone}`);
  article.dataset.annotationLabels = decorations.map((item) => `批注 ${item.number}`).join("，");
  decorations.forEach((decoration) => applyInlineAnnotationHighlight(article, decoration));
  appendAnnotationMarkers(article, decorations);
}

/**
 * 在文档块右上角添加批注编号徽标。
 *
 * @param {HTMLElement} article 文档块元素。
 * @param {Array<{annotation: Record<string, string>, number: number, tone: number}>} decorations 批注装饰信息。
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
    moreMarker.title = `还有 ${decorations.length - 4} 条批注`;
    markerGroup.appendChild(moreMarker);
  }

  article.appendChild(markerGroup);
}

/**
 * 尽量把用户选中的短文本标成内联高亮。
 *
 * @param {HTMLElement} root 文档块根元素。
 * @param {{annotation: Record<string, string>, number: number, tone: number}} decoration 批注装饰信息。
 * @returns {boolean} 成功标出文本时返回 true。
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
 * @param {{number: number, tone: number}} decoration 批注装饰信息。
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
  mark.dataset.annotationNumber = String(decoration.number);
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
 * 拆分 Markdown 为稳定块，方便批注绑定到具体段落。
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

  return blocks.map((markdownBlock, index) => ({
    id: `block-${index + 1}`,
    markdown: markdownBlock,
  }));
}

/**
 * 将当前行缓冲区写入块数组。
 *
 * @param {string[]} blocks 已收集的 Markdown 块。
 * @param {string[]} current 当前行缓冲区。
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
 * @returns {string} 已转义的 HTML 片段。
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
 * HTML 转义。
 *
 * @param {string} value 待插入 DOM 的文本。
 * @returns {string} 转义后的文本。
 */
function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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
 * 处理点击段落事件；未选中文字时以整段作为批注目标。
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
  dom.selectionPreview.textContent = selectedText.length > 240 ? `${selectedText.slice(0, 240)}...` : selectedText;
}

/**
 * 同步左侧当前选区块样式。
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
 * 新增一条待提交批注。
 *
 * @returns {void}
 */
function addAnnotation() {
  const comment = dom.commentInput.value.trim();
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
    id: crypto.randomUUID(),
    blockId: state.selectedBlockId,
    blockMarkdown: block?.markdown ?? "",
    selectedText: state.selectedText,
    comment,
    createdAt: new Date().toISOString(),
  });

  dom.commentInput.value = "";
  renderPlanBlocks();
  renderAnnotations();
  setMessage("批注已加入待提交列表。");
}

/**
 * 渲染批注列表。
 *
 * @returns {void}
 */
function renderAnnotations() {
  dom.annotationCount.textContent = String(state.annotations.length);
  dom.annotationList.innerHTML = "";

  if (state.annotations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "selection-preview";
    empty.textContent = "还没有待提交批注。";
    dom.annotationList.appendChild(empty);
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
    dom.annotationList.appendChild(item);
  });
}

/**
 * 移除待提交批注。
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
 * 提交批注，通知 Codex 该草案需要重写。
 *
 * @returns {Promise<void>} 提交完成后返回。
 */
async function submitFeedback() {
  const generalNote = dom.generalNoteInput.value.trim();
  if (state.annotations.length === 0 && !generalNote) {
    setMessage("请至少添加一条批注或填写整体意见。");
    showAlert("还不能提交", "请至少添加一条批注，或填写整体意见后再提交。");
    return;
  }

  setBusy(true);
  try {
    const response = await fetch(`/api/reviews/${encodeURIComponent(state.reviewId)}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ annotations: state.annotations, generalNote }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "提交批注失败。");
    }
    state.review = payload.review;
    renderStatus(state.review.status);
    const message = "已提交批注。面板会保持打开，等待 Codex 创建下一版草案；如果 Codex 没有反应，请在聊天框发送：我已提交批注，请读取结果。";
    setMessage(message);
    showAlert("批注已提交", message);
  } catch (error) {
    const message = formatError(error, "提交批注失败。");
    setMessage(message);
    showAlert("提交失败", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 通过当前计划，通知 Codex 可以输出正式 Plan。
 *
 * @returns {Promise<void>} 提交完成后返回。
 */
async function approveReview() {
  setBusy(true);
  try {
    const response = await fetch(`/api/reviews/${encodeURIComponent(state.reviewId)}/approve`, {
      method: "POST",
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error ?? "通过计划失败。");
    }
    state.review = payload.review;
    renderStatus(state.review.status);
    const shutdownSeconds = Number(payload.panelShutdownSeconds ?? 0);
    const shutdownHint = shutdownSeconds > 0 ? `本地面板会在约 ${Math.round(shutdownSeconds)} 秒后自动关闭。` : "";
    const messageParts = [
      "计划已通过。",
      shutdownHint,
      "如果 Codex 正在等待，它会自动继续；如果没有反应，请在聊天框发送：我已通过计划，请读取结果。",
    ];
    const message = messageParts.filter(Boolean).join(" ");
    setMessage(message);
    showAlert("计划已通过", message);
  } catch (error) {
    const message = formatError(error, "通过计划失败。");
    setMessage(message);
    showAlert("通过失败", message);
  } finally {
    setBusy(false);
  }
}

/**
 * 按 ID 查找文档块。
 *
 * @param {string} blockId 文档块 ID。
 * @returns {{id: string, markdown: string} | undefined} 匹配的文档块。
 */
function findBlock(blockId) {
  return state.blocks.find((item) => item.id === blockId);
}

/**
 * 截断长文本，避免批注卡片撑破布局。
 *
 * @param {string} value 原始文本。
 * @param {number} maxLength 最大长度。
 * @returns {string} 截断后的文本。
 */
function shorten(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value ?? "";
  }
  return `${value.slice(0, maxLength)}...`;
}

/**
 * 为当前浏览器审阅标签页生成临时客户端 ID。
 *
 * @returns {string} 当前页面生命周期内稳定的客户端 ID。
 */
function createReviewClientId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * 设置按钮 loading 状态，防止重复提交。
 *
 * @param {boolean} busy 是否处于提交中。
 * @returns {void}
 */
function setBusy(busy) {
  dom.submitFeedbackButton.disabled = busy;
  dom.approveButton.disabled = busy;
  dom.addAnnotationButton.disabled = busy;
}

/**
 * 统一处理按钮动作异常，避免未处理 Promise 让用户看不到失败原因。
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
 * @param {string} fallback 兜底提示。
 * @returns {string} 用户可读错误消息。
 */
function formatError(error, fallback) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

/**
 * 点击弹窗遮罩时关闭弹窗。
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
 * 处理全局键盘事件。
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
 * 显示顶部 toast 提示框。
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
 * 关闭顶部 toast 提示框。
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
