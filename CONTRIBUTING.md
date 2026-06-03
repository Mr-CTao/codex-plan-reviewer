# Contributing

感谢你愿意改进 Plan Reviewer。这个项目的目标是让 Codex 在正式 Plan 前更容易完成需求澄清、草案批注和多轮迭代。

## 开发准备

1. 克隆仓库到本地插件目录：

```bash
mkdir -p ~/plugins
git clone https://github.com/Mr-CTao/codex-plan-reviewer.git ~/plugins/plan-reviewer
```

2. 安装到 Codex：

```bash
codex plugin add plan-reviewer@personal
```

3. 修改插件后，建议新开 Codex 线程或重启 Codex，确保加载最新版本。

## 本地检查

提交 PR 前请至少运行：

```bash
node --check assets/panel/app.js
node --check assets/panel/clarify.js
node --check assets/panel/session.js
python3 -m py_compile scripts/plan_reviewer_mcp.py
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py ~/plugins/plan-reviewer
```

如果修改了页面交互，也请运行：

```bash
python3 scripts/plan_reviewer_mcp.py --serve-only --session-demo
```

然后在浏览器中确认澄清态、审阅态、等待态都能正常显示。

## 代码约定

- 面板页面不引用外部脚本、字体或远程资源。
- 用户可见内容必须经过转义或通过 `textContent` 写入 DOM。
- 提交类按钮需要 loading 状态，避免重复提交。
- 定时器、轮询和未完成请求需要在页面卸载时清理。
- MCP 与 HTTP 面板共享状态时需要考虑并发写入。

## Issue 与 PR

提交 issue 时建议包含：

- Codex 版本或插件版本。
- 复现步骤。
- 当前结果与期望结果。
- 如涉及 UI，附截图会更容易定位。

提交 PR 时建议包含：

- 变更目的。
- 影响范围。
- 已运行的检查命令。
- 仍然存在的风险或待验证项。
