# feat: add Obsidian work contribution dashboard

## Summary

- 在 ATL Obsidian 插件中增加原生 `ItemView`“个人工作贡献”，提供 GitHub 风格完成热力图、任务/Token 趋势、项目和产出回顾。
- 任务指标只使用 ATL Audit 完成事件，按任务与本地日期去重；Token 通过本机 OpenToken 只读汇总并缓存，失败时任务统计继续可用。
- 增加 Ribbon/命令入口、任务和 Artifact 跳转、范围切换、刷新和 Vault 变更后的任务统计防抖刷新。

## User behavior

- 打开 Obsidian 后点击“ATL：个人工作贡献”，无需终端。
- 7 天、12 周、1 年切换只改变统计窗口；点击热力图日期查看当天主要做了什么。
- OpenToken 缺失不会阻断任务完成统计；Token 区显示恢复状态。

## Verification

- `pnpm test`：全量通过，47 个测试文件、523 个测试
- `pnpm typecheck`：通过
- `pnpm lint`：通过
- `pnpm build`：通过，产物包含服务端、UI、Obsidian 插件和 Runner
- `git diff --check`：通过
- 真实 Obsidian 只读烟测：贡献首页、7 天/12 周/1 年、日期选择、刷新禁用态和真实 OpenToken 数据均通过；安装后重载确认 `manifest.json` 为 `0.4.0`
- 真实 Vault 未创建、修改或删除 `10_Tasks/Inbox`、`Active`、`Archive`、`Audit` 文件；仅插件 `data.json` 更新 Token 缓存

## Scope and risks

- 首页是只读回顾页，不替代 TaskNotes 看板，不提供完整 Review 验收按钮。
- OpenToken 的真实数据源依赖用户本机安装；OpenToken 错误只降级 Token 区，不影响 ATL 任务贡献。
- 真实 Vault 烟测必须保持只读：只打开首页、切换范围和打开文件，不创建、修改或删除任务及 Audit。
- 统计使用本机系统时区；任务 Audit 历史读取从 Unix epoch 开始，确保长连续记录和历史覆盖提示不被 1 年窗口截断。
- 本次 CR 的非阻塞项已登记为 GitHub Issues [#39](https://github.com/PANGKAIFENG/agent-task-loop/issues/39)、[#40](https://github.com/PANGKAIFENG/agent-task-loop/issues/40)、[#41](https://github.com/PANGKAIFENG/agent-task-loop/issues/41)，不阻塞 MVP 发布。

## Release checklist

- [x] 完成全量测试、构建和真实 OpenToken 契约检查
- [x] 备份并安装构建产物到本机 Obsidian 插件目录
- [x] 完成 Obsidian 只读烟测与截图检查
- [ ] CI 通过后合并并按既有 workflow 发布版本
