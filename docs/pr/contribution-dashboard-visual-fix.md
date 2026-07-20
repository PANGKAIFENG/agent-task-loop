# fix: align contribution heatmap by week

## Summary

- 修复 Obsidian“个人工作贡献”首页热力图日期纵向堆叠的问题，明确按周一到周日为行、自然周为列布局。
- 将页头说明更新为“看见每天完成了什么，也看见时间花在了哪里。”
- 发布补丁版本 `0.4.1`；不改变任务贡献、OpenToken、KPI 或任务状态口径。

## Verification

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- 真实 Obsidian 只读烟测：重载插件后检查 `7 天`、`12 周`、`1 年`，副文案和周历布局生效。
- 真实 Vault 指纹复核：`10_Tasks/Inbox`、`Active`、`Archive`、`Audit` 前后无变化。

## Scope and risk

- 日期数组仍由既有贡献查询提供，本次只补充 DOM 的 `grid-column` 位置，不调整日期范围和统计结果。
- 星期计算固定使用 UTC 中午解析 `YYYY-MM-DD`，避免本机时区将纯日期移到前一天。
- 空日期数组保持原有空态；日期点击、键盘焦点、Tooltip、选中态和强度等级保持不变。

## Release checklist

- [x] 目标回归测试通过
- [x] 真实 Obsidian 三种范围只读烟测通过
- [x] 真实任务和 Audit 目录指纹无变化
- [x] 独立 CR 无 Critical / Important
- [ ] CI 通过后合并并发布 `v0.4.1`
