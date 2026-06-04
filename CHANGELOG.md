# Changelog

## Unreleased

### Added

- 新增 `.mcp.windows.json`，提供 Windows Codex App 的 MCP 启动配置示例。
- README 和贡献说明补充 Windows 安装、PowerShell 验证和状态文件路径说明。
- Skill 兜底流程补充 Windows PowerShell 命令。
- Session、Review 与 Clarify 面板新增标签页 heartbeat/release，关闭网页后只清理当前 MCP 进程启动的 HTTP 面板服务。

### Changed

- 强化 Session 工作流规则：每个新 Session 至少先发布一轮澄清问题，发布澄清或草案后必须立即等待用户动作。
- 静态面板资源加载增加本地源码目录和最新插件缓存目录兜底，避免旧面板进程在缓存升级后报 `Missing static asset`。
- Windows 下状态文件锁从进程内 fallback 升级为基于 `msvcrt.locking` 的跨进程文件锁。

## 0.1.0

### Added

- 新增 Plan Reviewer 本地 Codex 插件。
- 支持持续工作流 Session，把需求澄清、计划草案审阅和等待 Codex 回写放在同一个面板中。
- 支持一次一个问题的需求澄清、A/B/C 推荐选项和 D: 其他输入。
- 支持 Markdown 计划草案段落级批注、整体意见和通过计划。
- 支持提交回答或批注后的等待态，方便用户留在面板中等待下一版内容。
- 支持本地状态文件锁，降低多进程同时写入导致审阅记录丢失的风险。
- 新增开源基础文件：`README.md`、`.gitignore`、`LICENSE`、`CONTRIBUTING.md`。

### Notes

- 插件面板只绑定 `127.0.0.1`，状态文件默认保存在 `~/.codex/plan-reviewer/reviews.json`。
- 已打开的旧 Codex 线程可能仍使用旧插件工具列表，升级后建议新开线程或重启 Codex。
