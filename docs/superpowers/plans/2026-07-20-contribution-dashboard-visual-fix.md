# Contribution Dashboard Visual Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复个人工作贡献热力图的周列排布，并用更直接的用户文案说明首页价值。

**Architecture:** 保留现有贡献查询和 Dashboard Controller；仅在 `WorkContributionView` 渲染日期按钮时，根据首日星期与日期下标计算明确的 Grid 行列。CSS 继续负责固定尺寸和横向滚动，不承载日期语义。

**Tech Stack:** TypeScript、Obsidian DOM API、CSS Grid、Vitest、JSDOM。

---

### Task 1: 锁定文案与周列布局契约

**Files:**
- Modify: `tests/unit/obsidian-plugin/work-contribution-view.test.ts`

- [ ] **Step 1: 写失败测试**

扩充日期夹具，断言副文案，以及同周、跨周日期的 `gridRow` / `gridColumn`：

```ts
expect(view.contentEl.querySelector('.atl-contribution-subtitle')?.textContent)
  .toBe('看见每天完成了什么，也看见时间花在了哪里。');
expect(day('2026-07-19')?.style.gridRow).toBe('7');
expect(day('2026-07-19')?.style.gridColumn).toBe('1');
expect(day('2026-07-20')?.style.gridRow).toBe('1');
expect(day('2026-07-20')?.style.gridColumn).toBe('2');
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm exec vitest run tests/unit/obsidian-plugin/work-contribution-view.test.ts`

Expected: FAIL，旧副文案仍存在且 `gridColumn` 为空。

### Task 2: 最小实现并验证

**Files:**
- Modify: `src/obsidian-plugin/work-contribution-view.ts`
- Verify: `src/obsidian-plugin/styles.css`

- [ ] **Step 1: 实现明确周列**

在 `renderHeatmap` 中取得第一天的 Monday-based weekday，并按日期下标计算列：

```ts
const firstRow = mondayBasedWeekday(snapshot.days[0]?.date);
snapshot.days.forEach((day, index) => {
  const row = mondayBasedWeekday(day.date);
  button.style.gridRow = String(row);
  button.style.gridColumn = String(Math.floor((firstRow - 1 + index) / 7) + 1);
});
```

同时替换副文案，不改变其他页面内容。

- [ ] **Step 2: 运行目标测试并确认 GREEN**

Run: `pnpm exec vitest run tests/unit/obsidian-plugin/work-contribution-view.test.ts`

Expected: PASS。

- [ ] **Step 3: 运行完整质量门禁**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && git diff --check`

Expected: 全部 exit 0。

- [ ] **Step 4: 真实 Obsidian 只读验收**

把构建产物安装到 `ClawVault/.obsidian/plugins/agent-task-loop/`，重载插件后依次查看 `7 天`、`12 周`、`1 年`。确认日期按周横向排列，任务目录与 Audit 没有被修改。

- [ ] **Step 5: CR 与发布**

提交 scoped commit，独立审查 `origin/main...HEAD`，修复 Critical / Important 后 push、创建 PR、合并并发布 `v0.4.1`。
