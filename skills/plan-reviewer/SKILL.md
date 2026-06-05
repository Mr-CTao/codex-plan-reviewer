---
name: plan-reviewer
description: Use when the user wants Codex to clarify requirements, draft, review, annotate, wait for panel actions, and iterate on a plan before producing the final Plan-mode proposal.
---

# Plan Reviewer

## 工作流职责

当用户要求在正式 Plan 之前先审阅草案，或明确提到 `Plan Reviewer` / `plan-reviewer`
时，使用本技能。目标是让 Codex 先通过同一个本地 Session 面板完成至少一轮需求澄清，
再生成可批注的计划草案，通过本地审阅面板收集用户意见，并根据批注重写草案，直到用户通过为止。

用户不需要重复粘贴“正式 Plan 前先澄清、一次只问一个问题、95% 信心后再生成草案”等
插件规则。只要用户选择本插件默认 Prompt、提到 Plan Reviewer，或表达“先审阅计划再开发”
这类意图，就自动套用下面的内置协议，并把用户后续输入当作真实任务内容处理。

## 内置提示词协议

以下规则等同于插件内置提示词，Codex 必须自动执行，不要要求用户手动补写：

- 在正式 Plan 前先做需求澄清和草案审阅；不要直接写代码。
- 使用 Plan Reviewer 的持续工作流 Session，让用户只打开一次面板。
- 每个全新 Session 必须至少发布一轮需求澄清确认；即使需求看似清楚，也要询问最关键的边界、风险或继续方式。
- 需求澄清一次只问一个问题；多选问题给 A/B/C 方案，推荐一个最合适方案并说明原因，D: 其他由面板提供。
- 持续追问直到约 95% 信心理解用户真实需求和目标。
- 达到理解信心后，再把 Markdown 开发计划草案发布到同一个 Session 审阅面板。
- 发布澄清问题或计划草案后，Codex 必须立刻调用 `wait_for_session_user_action`，主动等待并读取 Session 结果，继续回写下一步。
- 用户通过计划之前，不要开始修改代码、运行写操作或进入实现。

## 使用规则

1. 不要在第一轮直接输出正式 Plan。
2. **优先使用持续工作流 Session**：先调用 `create_plan_workflow_session` 创建一个统一面板，并把 URL 明确给用户。后续澄清、草案审阅、等待状态都发布到这个 session，不要反复让用户打开新页面。
3. **创建新 Session 后必须先调用 `publish_requirement_clarification_to_session` 发布第一轮澄清问题**。每次只问一个问题，多选问题最多给 A/B/C 三个方案，并设置一个 `recommended: true` 的推荐项和 `recommendationReason`；面板会提供 D: 其他输入。如果需求已经很清楚，第一轮问题就用来确认最关键边界或询问“是否按当前理解继续生成草案”。
4. **关键要求：发布澄清问题后不要结束回合，也不要要求用户“提交后告诉我一声”。必须立刻调用 `wait_for_session_user_action`，建议参数为 `timeout_seconds: 900` 和当前 `session.actionSeq`。**
5. 根据 `lastUserAction.type === "clarification_answered"` 的回答继续追问；直到你有约 95% 信心理解用户真实需求和目标，才生成 Markdown 计划草案。
6. 计划草案内容应包含目标、范围、实施步骤、验证方式、风险点。
7. 调用 `publish_plan_review_to_session`，把草案发布到同一个统一面板。
8. **关键要求：发布计划草案后不要结束回合，也不要要求用户“提交后告诉我一声”。必须立刻调用 `wait_for_session_user_action`，建议参数为 `timeout_seconds: 900` 和当前 `session.actionSeq`。**
9. 如果返回 `review_feedback_submitted`，必须逐条吸收 `payload.annotations` 和 `payload.generalNote`，重新生成草案并再次调用 `publish_plan_review_to_session`。
10. 如果返回 `plan_approved` 或 session 状态是 `approved`，再输出正式 Plan，让用户走 Codex 原生确认流程。
11. 如果等待超时且没有新动作，只能简短说明“我还在等你在面板提交/通过”，然后继续等待；不要输出正式 Plan。
12. 在用户通过之前，不要开始改代码、运行写操作或提交变更。

## 持续 Session 协议

推荐调用顺序：

1. `create_plan_workflow_session({ title, original_request, open_browser: true })`
2. 把返回的 `url` 发给用户，并说明“请留在这个面板，提交后下一步会自动刷新”。
3. 必须先调用 `publish_requirement_clarification_to_session({ session_id, question, known_context, options, allow_freeform: true, confidence_target: 95 })` 发布第一轮澄清；即使需求看似充分，也要确认关键边界或风险。
4. 记录工具返回的 `session.actionSeq`，立即调用 `wait_for_session_user_action({ session_id, since_action_seq: session.actionSeq, timeout_seconds: 900 })`。
5. 如果 `lastUserAction.type` 是 `clarification_answered`，读取 `lastUserAction.payload.answer.finalAnswer`，继续判断是否达到 95% 理解信心。
6. 足够清楚时，调用 `publish_plan_review_to_session({ session_id, plan_markdown, title, iteration, known_context })`。
7. 再次用返回的 `session.actionSeq` 调用 `wait_for_session_user_action`。
8. 如果 `lastUserAction.type` 是 `review_feedback_submitted`，吸收 `payload.annotations` 和 `payload.generalNote`，发布下一版草案。
9. 如果 `lastUserAction.type` 是 `plan_approved`，输出正式 Plan。

Session 面板会在用户提交回答或批注后自动进入“等待 Codex 回写”状态。Codex 发布下一轮内容后，
同一个 `/session/{id}` 页面会轮询到新状态并自动渲染，用户不需要在 Codex 页面和面板之间来回切换。

## 需求澄清协议

以下是旧版单轮澄清工具的兜底协议。只有在 Session 工具不可用时才使用；Session 工具可用时禁止优先使用本流程。

推荐调用顺序：

1. 判断当前信息是否足以达到约 95% 理解信心；不足时不要生成计划草案。
2. 生成一个最关键的澄清问题。一次只问一个问题。
3. 调用 `create_requirement_clarification({ question, original_request, known_context, options, allow_freeform: true, confidence_target: 95, open_browser: true })`。
4. 向用户展示 URL，并说明“我会在这里等待你提交回答”。
5. 立即调用 `wait_for_requirement_clarification({ clarification_id, timeout_seconds: 900 })`。
6. 如果状态是 `answered`，吸收 `answer.finalAnswer`，继续判断是否达到 95% 理解信心。
7. 仍不足时继续创建下一条澄清问题；足够时再进入计划草案审阅。

多选问题格式要求：

- A/B/C 是 Codex 提供的方案。
- 必须推荐一个最合适方案，并写清推荐理由。
- D: 其他由面板提供，用户可以输入自己的意见。
- 如果不是多选问题，可以只提供问题正文和自由输入框。

## 等待协议

以下是旧版单轮计划审阅工具的兜底协议。Session 工具可用时，必须优先使用
`publish_plan_review_to_session` 和 `wait_for_session_user_action`。

推荐调用顺序：

1. `create_plan_review({ plan_markdown, title, iteration, open_browser: true })`
2. 向用户展示 URL，并说明“我会在这里等待你提交批注或通过计划”。
3. 立即调用 `wait_for_plan_review({ review_id, timeout_seconds: 900 })`。
4. 根据返回状态处理：
   - `pending`：继续等待，或在超时后让用户发送“我已提交批注，请读取结果”作为兜底。
   - `needs_revision`：重写草案，进入下一轮审阅。
   - `approved`：输出正式 Plan。

本插件不会在用户通过后关闭 MCP 工具进程，因为同一线程可能还需要继续读取结果或创建下一轮审阅。
提交批注后本地 HTTP 面板会保持打开，方便等待下一版草案；用户通过计划后，面板会延迟自动关闭。
`get_plan_review_result` / `wait_for_plan_review` 只读取状态，不会重新启动已关闭的面板。若确实需要
立即关闭面板，可调用 `shutdown_plan_review_panel`，这只关闭 localhost 面板，不会停止 MCP server。

如果用户在后续消息中说已经提交批注、已经通过、面板没反应、继续读取结果等，直接调用
`get_plan_review_result` 或 `wait_for_plan_review` 读取最近的审阅状态，不要重新创建草案。
如果用户说已经提交澄清回答、澄清面板没反应、继续读取回答等，直接调用
`get_requirement_clarification_result` 或 `wait_for_requirement_clarification` 读取当前澄清状态。

## MCP 工具缺失时的兜底

如果当前线程能使用本 Skill，但工具列表里没有 `create_requirement_clarification`、`create_plan_review`、`wait_for_plan_review`
或其他 `plan_reviewer` MCP 工具，不要继续泛化搜索其他插件。按以下顺序处理：

1. 运行 `codex mcp list`，确认 `plan_reviewer` 是否 enabled。
2. 如果 `plan_reviewer` 不存在或 disabled，说明当前线程没有加载插件 MCP；提示用户新开线程或重启 Codex 后再试。
3. 如果 `plan_reviewer` enabled 但工具仍不可见，使用 shell 兜底模式。不要临时编写 Python `importlib` 代码导入插件模块，也不要硬编码 `.codex/plugins/cache/.../<version>` 目录；优先使用用户本地插件源码目录调用脚本入口。

macOS / Linux:

```bash
cd "$HOME/plugins/plan-reviewer"
python3 scripts/plan_reviewer_mcp.py \
  --review-from-stdin \
  --title "Codex Plan Draft" \
  --iteration 1 \
  --open-browser \
  --wait-seconds 900 <<'PLAN_REVIEWER_DRAFT'
在这里放入 Markdown 计划草案
PLAN_REVIEWER_DRAFT
```

Windows PowerShell:

```powershell
Set-Location "$env:USERPROFILE\plugins\plan-reviewer"
@'
在这里放入 Markdown 计划草案
'@ | py -3 .\scripts\plan_reviewer_mcp.py `
  --review-from-stdin `
  --title "Codex Plan Draft" `
  --iteration 1 `
  --open-browser `
  --wait-seconds 900
```

如果 Windows 机器没有 Python Launcher，但 `python --version` 可用，则把 `py -3` 替换为
`python`。

兜底命令会把本地面板 URL 打印为 `PANEL_URL=...`，并在用户提交批注或通过后输出 JSON。
如果返回 `needs_revision`，按批注重写草案；如果返回 `approved`，再输出正式 Plan。
不要在 `--open-browser` 时把 `--wait-seconds` 设为 0；脚本退出后本地 HTTP 面板也会结束。

## 草案格式

草案建议使用以下结构：

```md
## 目标

## 我会先确认的上下文

## 实施步骤

## 验证方式

## 风险与取舍
```

## 批注吸收要求

- 对段落级批注，优先调整对应步骤或顺序。
- 对整体意见，优先调整计划范围、验收标准和风险边界。
- 如果批注之间互相冲突，先用简短问题向用户确认，不要擅自合并。
- 每轮重写草案时，用新的 `iteration` 数字标明轮次。

## 并发与安全说明

本插件的本地面板只绑定 `127.0.0.1`，用于当前机器上的人工审阅。计划草案和批注会保存到
Codex 本地状态目录下的 `plan-reviewer/reviews.json`。不要把包含密钥、Token 或生产密码的
内容写进计划草案；如果用户需求涉及敏感信息，先要求脱敏。

状态文件使用 `reviews.lock` 做跨进程写保护，macOS/Linux 通过 `fcntl.flock` 实现，Windows
通过 `msvcrt.locking` 实现，避免 MCP、CLI 兜底和旧面板进程同时写入时互相覆盖。
当用户要求清理历史记录时，优先使用 `prune_plan_reviews` 保留每类近期记录；该工具会处理审阅、
澄清和 Session，默认只删除已完成记录，不会误删 pending/未完成 Session。只有用户明确要求清空时，
才调用 `clear_plan_reviews({ confirm: true })`；若用户要求连同未完成记录一起清理，再加
`include_pending: true`。
