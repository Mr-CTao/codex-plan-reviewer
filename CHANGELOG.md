# Changelog

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
