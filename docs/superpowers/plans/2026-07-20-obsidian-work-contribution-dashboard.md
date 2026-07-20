# Obsidian Personal Work Contribution Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 ATL Obsidian 插件中交付无需终端的“个人工作贡献”首页，以可审计任务完成事件和本机 OpenToken 汇总展示贡献热力图、趋势、项目与产出。

**Architecture:** 任务侧由 `AuditLog` 的范围查询和纯函数 `queryContribution` 生成快照；Token 侧由无 Shell 的 `OpenTokenAdapter` 读取并校验 `opentoken preview --json`，只缓存每日聚合。`ContributionDashboardController` 组合两个独立数据源，Obsidian `ItemView` 只负责渲染与交互。

**Tech Stack:** TypeScript 5.9、Obsidian Plugin API、Zod、execa、Vitest、JSDOM、原生 DOM/SVG/CSS。

---

## 文件结构

### 新增

- `src/services/query-contribution.ts`：完成事件识别、日期分桶、KPI、项目与产出聚合。
- `src/obsidian-plugin/opentoken-adapter.ts`：OpenToken 检测、受限调用、JSON 校验和每日汇总。
- `src/obsidian-plugin/contribution-dashboard-controller.ts`：范围、选中日期、缓存优先、异步刷新和部分失败状态。
- `src/obsidian-plugin/work-contribution-view.ts`：Obsidian `ItemView` 与页面 DOM/SVG 渲染。
- `tests/unit/services/query-contribution.test.ts`
- `tests/unit/obsidian-plugin/opentoken-adapter.test.ts`
- `tests/unit/obsidian-plugin/contribution-dashboard-controller.test.ts`
- `tests/unit/obsidian-plugin/work-contribution-view.test.ts`

### 修改

- `src/storage/contracts.ts`：为 `AuditLog` 增加范围读取契约。
- `src/storage/audit-log.ts`：实现安全的日期范围 Audit 查询。
- `src/obsidian-plugin/service-context.ts`：增加无写授权的只读 Context 工厂。
- `src/obsidian-plugin/settings.ts`：增加并归一化每日 Token 缓存。
- `src/obsidian-plugin/main.ts`：注册 View、Ribbon、命令和 Vault 刷新事件。
- `src/obsidian-plugin/styles.css`：首页布局、热力图、图表和响应式样式。
- `tests/helpers/obsidian-runtime.ts`：补充 ItemView/WorkspaceLeaf 测试替身。
- `tests/integration/storage/markdown-repositories.test.ts`：Audit 范围查询集成测试。
- `tests/unit/obsidian-plugin/settings.test.ts`：缓存兼容与裁剪测试。
- `README.md`、`docs/operations/obsidian-plugin.md`：用户入口、指标口径和故障状态。

---

### Task 1: Audit 范围查询

**Files:**
- Modify: `src/storage/contracts.ts`
- Modify: `src/storage/audit-log.ts`
- Test: `tests/integration/storage/markdown-repositories.test.ts`

- [ ] **Step 1: 写范围查询失败测试**

在临时 Vault 写入三个日期的 Audit，并断言只返回 `[fromInclusive, toExclusive)` 内的事件，且时间顺序稳定：

```ts
it('lists audit events inside a bounded timestamp range', async () => {
  const audit = new FileAuditLog(root, { timeZone: 'Asia/Shanghai' });
  await audit.append({ event: 'task.reviewed', at: '2026-07-18T23:59:59+08:00', taskId: 'old' });
  await audit.append({ event: 'task.reviewed', at: '2026-07-19T00:00:00+08:00', taskId: 'first' });
  await audit.append({ event: 'task.lifecycle_reconciled', at: '2026-07-19T18:00:00+08:00', taskId: 'second' });

  await expect(audit.listBetween({
    fromInclusive: '2026-07-19T00:00:00+08:00',
    toExclusive: '2026-07-20T00:00:00+08:00',
  })).resolves.toEqual([
    expect.objectContaining({ taskId: 'first' }),
    expect.objectContaining({ taskId: 'second' }),
  ]);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm test tests/integration/storage/markdown-repositories.test.ts`

Expected: FAIL，`listBetween` 尚不存在。

- [ ] **Step 3: 扩展契约并最小实现**

在 `AuditLog` 增加：

```ts
listBetween(query: {
  fromInclusive: string;
  toExclusive: string;
}): Promise<AuditEvent[]>;
```

`FileAuditLog.listBetween` 校验两个 RFC3339 时间、确保起点早于终点，复用安全文件读取边界，按 `at` 升序返回命中事件；非法范围抛 `InvalidAuditEventError`。

- [ ] **Step 4: 验证 GREEN 与存储回归**

Run: `pnpm test tests/integration/storage/markdown-repositories.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/storage/contracts.ts src/storage/audit-log.ts tests/integration/storage/markdown-repositories.test.ts
git commit -m "feat: query bounded audit events"
```

---

### Task 2: 贡献指标纯函数

**Files:**
- Create: `src/services/query-contribution.ts`
- Create: `tests/unit/services/query-contribution.test.ts`

- [ ] **Step 1: 写完成事件与同日去重测试**

构造 `task.reviewed/approve`、`task.lifecycle_reconciled/done`、非完成事件和同任务同日重复事件，期望同任务同日只计一次：

```ts
const snapshot = queryContribution({
  tasks: [doneTaskA, doneTaskB],
  projects: [{ projectId: 'atl', name: 'Agent Task Loop', context: '', createdAt: NOW, updatedAt: NOW }],
  auditEvents,
  now: new Date('2026-07-20T10:00:00+08:00'),
  timeZone: 'Asia/Shanghai',
  range: '12w',
  selectedDate: '2026-07-20',
});

expect(snapshot.kpis.completedToday).toBe(2);
expect(snapshot.days.find((day) => day.date === '2026-07-20')?.completed).toBe(2);
```

- [ ] **Step 2: 写周窗口、连续天数和历史覆盖测试**

覆盖周一起始、今天无完成时允许从昨天计算、跨时区边界、缺少 Audit 的 `done` 任务只进入 `historicalCompletionDateUnavailable` 警告。

- [ ] **Step 3: 写项目分组和产出链接测试**

断言按唯一完成任务分组、无项目回退为 `未归类`、Artifact 取最后一个引用、输出按完成时间倒序。

- [ ] **Step 4: 运行测试并确认 RED**

Run: `pnpm test tests/unit/services/query-contribution.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 5: 实现明确数据类型与纯函数**

最小导出：

```ts
export type ContributionRange = '7d' | '12w' | '1y';

export interface ContributionSnapshot {
  range: ContributionRange;
  selectedDate: string;
  kpis: {
    completedToday: number;
    completedThisWeek: number;
    currentStreak: number;
  };
  days: Array<{ date: string; completed: number; projectCount: number; level: 0 | 1 | 2 | 3 | 4 }>;
  projectSummaries: Array<{
    projectId: string | null;
    projectName: string;
    completed: number;
    artifactCount: number;
    evidenceTitles: string[];
  }>;
  outputs: Array<{
    taskId: string;
    title: string;
    projectName: string;
    completedAt: string;
    artifactRef: string | null;
  }>;
  coverage: { historicalCompletionDateUnavailable: number };
}
```

用 `Intl.DateTimeFormat` 生成本地日期，不使用 `updatedAt` 推断完成日期。

- [ ] **Step 6: 验证 GREEN**

Run: `pnpm test tests/unit/services/query-contribution.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/services/query-contribution.ts tests/unit/services/query-contribution.test.ts
git commit -m "feat: aggregate auditable task contributions"
```

---

### Task 3: OpenToken 只读适配器

**Files:**
- Create: `src/obsidian-plugin/opentoken-adapter.ts`
- Create: `tests/unit/obsidian-plugin/opentoken-adapter.test.ts`

- [ ] **Step 1: 写 JSON 校验与跨工具汇总测试**

注入假执行器，返回 Claude Code、Codex 两行同日数据：

```ts
const adapter = new OpenTokenAdapter({
  homeDirectory: '/Users/test',
  pathExists: async () => true,
  resolveOnPath: async () => null,
  execute: async () => ({
    stdout: JSON.stringify({
      rows: [
        { date: '2026-07-20', tool: 'codex', model: 'gpt', input: 100, output: 20, cache_read: 40, cache_write: 0, normalized: 120 },
        { date: '2026-07-20', tool: 'claude-code', model: 'claude', input: 50, output: 10, cache_read: 5, cache_write: 2, normalized: 60 },
      ],
      sessions: [],
    }),
    stderr: '',
  }),
  now: () => new Date('2026-07-20T12:00:00Z'),
});

await expect(adapter.preview('2026-07-20')).resolves.toMatchObject({
  days: [{ date: '2026-07-20', normalized: 180, input: 150, output: 30, tools: ['claude-code', 'codex'] }],
});
```

- [ ] **Step 2: 写边界与脱敏失败测试**

覆盖固定候选路径顺序、缺少程序、非法日期、负数/NaN/未知字段、超时、超大输出和错误消息不回显 stderr。

- [ ] **Step 3: 运行测试并确认 RED**

Run: `pnpm test tests/unit/obsidian-plugin/opentoken-adapter.test.ts`

Expected: FAIL，模块尚不存在。

- [ ] **Step 4: 实现适配器**

导出：

```ts
export interface DailyTokenUsage {
  date: string;
  normalized: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tools: string[];
}

export interface OpenTokenSnapshot {
  version: string;
  updatedAt: string;
  since: string;
  days: DailyTokenUsage[];
}
```

使用 Zod 严格校验；生产依赖用 `execa(executable, ['preview', '--since', since, '--json'], { shell: false, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 })`。版本通过固定的 `--version` 调用读取。错误映射为 `missing`、`timeout`、`invalid_output`、`process_failed`，不携带原始输出。

- [ ] **Step 5: 验证 GREEN**

Run: `pnpm test tests/unit/obsidian-plugin/opentoken-adapter.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/obsidian-plugin/opentoken-adapter.ts tests/unit/obsidian-plugin/opentoken-adapter.test.ts
git commit -m "feat: read local OpenToken usage"
```

---

### Task 4: Token 缓存与设置兼容

**Files:**
- Modify: `src/obsidian-plugin/settings.ts`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts`

- [ ] **Step 1: 写旧设置兼容与非法缓存清理测试**

```ts
expect(normalizeSettings({ allowVaultManagement: true })).toMatchObject({
  dashboard: { tokenCacheVersion: 1, updatedAt: null, version: null, since: null, days: [] },
});

expect(normalizeSettings({
  dashboard: {
    tokenCacheVersion: 1,
    updatedAt: '2026-07-20T01:00:00Z',
    version: '0.3.11',
    since: '2026-07-01',
    days: [validDay, invalidDay],
  },
}).dashboard.days).toEqual([validDay]);
```

- [ ] **Step 2: 写最多保留 370 天、日期升序和 Tool 去重测试**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts`

Expected: FAIL，`dashboard` 尚不存在。

- [ ] **Step 3: 实现 `DashboardTokenCache` 与归一化**

```ts
export interface DashboardTokenCache {
  tokenCacheVersion: 1;
  updatedAt: string | null;
  version: string | null;
  since: string | null;
  days: DailyTokenUsage[];
}
```

只接受非负安全数值、`YYYY-MM-DD`、受限 Tool id；按日期去重并保留最新 370 天。`DEFAULT_SETTINGS` 和 `normalizeSettings` 必须兼容 v0.3.2 的 `data.json`。

- [ ] **Step 4: 验证 GREEN**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/obsidian-plugin/settings.ts tests/unit/obsidian-plugin/settings.test.ts
git commit -m "feat: cache daily dashboard token usage"
```

---

### Task 5: Dashboard Controller

**Files:**
- Create: `src/obsidian-plugin/contribution-dashboard-controller.ts`
- Create: `tests/unit/obsidian-plugin/contribution-dashboard-controller.test.ts`
- Modify: `src/obsidian-plugin/service-context.ts`

- [ ] **Step 1: 写缓存优先与异步更新测试**

Controller 初始状态先包含缓存 Token；`initialize()` 立即完成任务查询，后台 Token Promise 完成后再发布一次状态。

```ts
const controller = new ContributionDashboardController(dependencies);
const states: ContributionDashboardState[] = [];
controller.subscribe((state) => states.push(state));
await controller.initialize();

expect(states.some((state) => state.token.status === 'cached')).toBe(true);
await controller.waitForTokenRefresh();
expect(states.at(-1)?.token.status).toBe('ready');
```

- [ ] **Step 2: 写部分失败、并发刷新和范围覆盖测试**

覆盖任务失败但 Token 可用、Token 失败保留缓存、重复刷新只调用一次、选择日期不触发 OpenToken、范围超出缓存才重新扫描。

- [ ] **Step 3: 运行测试并确认 RED**

Run: `pnpm test tests/unit/obsidian-plugin/contribution-dashboard-controller.test.ts`

Expected: FAIL，Controller 尚不存在。

- [ ] **Step 4: 增加只读 ServiceContext 工厂**

```ts
export function createObsidianReadServiceContext(
  root: string,
  options: ObsidianServiceContextOptions = {},
): ServiceContext {
  return createContext(root, undefined, options);
}
```

重用 Repository，但不传 `VaultWriteAuthorization`，确保意外写入会被现有存储层拒绝。

- [ ] **Step 5: 实现 Controller 状态机**

状态至少包含：

```ts
interface ContributionDashboardState {
  range: ContributionRange;
  selectedDate: string;
  contribution: { status: 'loading' | 'ready' | 'error'; snapshot: ContributionSnapshot | null };
  token: { status: 'loading' | 'cached' | 'ready' | 'missing' | 'stale' | 'error'; snapshot: OpenTokenSnapshot | null };
  refreshing: boolean;
}
```

所有异步完成先检查 Controller 是否已 `dispose()`；刷新 Promise 去重；错误只保留稳定 code。

- [ ] **Step 6: 验证 GREEN**

Run: `pnpm test tests/unit/obsidian-plugin/contribution-dashboard-controller.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/obsidian-plugin/contribution-dashboard-controller.ts src/obsidian-plugin/service-context.ts tests/unit/obsidian-plugin/contribution-dashboard-controller.test.ts
git commit -m "feat: coordinate contribution dashboard data"
```

---

### Task 6: Obsidian 首页 View 与入口

**Files:**
- Create: `src/obsidian-plugin/work-contribution-view.ts`
- Create: `tests/unit/obsidian-plugin/work-contribution-view.test.ts`
- Modify: `tests/helpers/obsidian-runtime.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `src/obsidian-plugin/styles.css`

- [ ] **Step 1: 扩展 Obsidian 测试替身并写 View 结构测试**

增加最小 `WorkspaceLeaf`、`ItemView`、`setIcon` 替身。断言 View 包含标题、四个 KPI、三个范围按钮、刷新按钮、热力图、两张趋势图、项目区和产出区。

- [ ] **Step 2: 写交互与可访问性测试**

断言：

- 范围按钮设置 `aria-pressed` 并调用 `setRange`。
- 热力单元格为 `button`，带日期与完成数 `aria-label`。
- 点击任务调用注入的 `openTask(taskId)`，由统一任务索引解析路径。
- OpenToken missing 时任务区仍渲染，Token 区显示恢复入口。
- 刷新时固定图表容器不被移除。

- [ ] **Step 3: 运行测试并确认 RED**

Run: `pnpm test tests/unit/obsidian-plugin/work-contribution-view.test.ts`

Expected: FAIL，View 尚不存在。

- [ ] **Step 4: 实现 `WorkContributionView`**

```ts
export const WORK_CONTRIBUTION_VIEW_TYPE = 'atl-work-contribution';

export class WorkContributionView extends ItemView {
  getViewType(): string { return WORK_CONTRIBUTION_VIEW_TYPE; }
  getDisplayText(): string { return '个人工作贡献'; }
  getIcon(): string { return 'chart-no-axes-combined'; }
  async onOpen(): Promise<void> { /* subscribe, render, initialize */ }
  async onClose(): Promise<void> { /* unsubscribe, dispose */ }
}
```

图表使用原生 SVG，热力图使用固定网格按钮。只使用 Obsidian CSS 变量，不引入图表库。

任务跳转只传递 `taskId`，由插件现有任务 Repository/文件索引统一解析真实路径；View 不复制 Inbox、Active、Archive 的生命周期路径规则。

- [ ] **Step 5: 注册入口与激活逻辑**

`main.ts` 中：

```ts
this.registerView(WORK_CONTRIBUTION_VIEW_TYPE, (leaf) => this.createContributionView(leaf));
this.addRibbonIcon('chart-no-axes-combined', 'ATL：个人工作贡献', () => void this.activateContributionView());
this.addCommand({ id: 'open-work-contribution', name: '打开个人工作贡献', callback: () => void this.activateContributionView() });
```

激活时复用已有 Leaf，否则在主工作区新建；插件卸载时由 Obsidian 清理 View。Vault 中 ATL 任务或 Audit 文件变化后，250ms 防抖刷新任务统计，不触发 Token 扫描。

- [ ] **Step 6: 实现响应式样式**

新增 `.atl-contribution-*` 命名空间。宽屏 KPI 四列、趋势两列；中屏两列；窄屏单列。热力图可横向滚动但不压缩到不可点击。明暗主题完全使用变量。

- [ ] **Step 7: 验证 GREEN 与插件回归**

Run:

```bash
pnpm test tests/unit/obsidian-plugin/work-contribution-view.test.ts
pnpm test tests/unit/obsidian-plugin
pnpm typecheck
pnpm lint
pnpm build:obsidian
```

Expected: 全部 PASS，生成 `build/obsidian-plugin/main.js`、`styles.css`、`manifest.json`。

- [ ] **Step 8: 提交**

```bash
git add src/obsidian-plugin/work-contribution-view.ts src/obsidian-plugin/main.ts src/obsidian-plugin/styles.css tests/helpers/obsidian-runtime.ts tests/unit/obsidian-plugin/work-contribution-view.test.ts
git commit -m "feat: add Obsidian contribution dashboard"
```

---

### Task 7: 文档、全量验证、实机安装与发布准备

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`
- Create: `docs/pr/obsidian-contribution-dashboard.md`
- Modify if release is approved: `package.json`, `manifest.json`, `src/obsidian-plugin/manifest.json`, `versions.json`, `src/version.ts`

- [ ] **Step 1: 更新用户文档**

README 和操作指南说明：如何打开首页、四个指标口径、贡献图只统计完成任务、Token 来自 Tokenrank/OpenToken、部分数据失败时如何理解。日常操作不得要求终端。

- [ ] **Step 2: 执行全量质量门禁**

Run:

```bash
export PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: 0 failures，构建产物完整。

- [ ] **Step 3: 本机 OpenToken 只读契约验证**

使用真实 `/Users/linctex/.local/bin/opentoken` 执行只读预览，断言版本可读、JSON 符合适配器契约、所选日期范围存在 Claude Code/Codex 等实际非零 Tool。不得输出配置、接入链接或凭据。

- [ ] **Step 4: 安装到真实 Obsidian 插件目录**

仅复制构建产物到：

```text
/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/
```

安装前备份现有 `main.js`、`styles.css`、`manifest.json`、`atl-runner.mjs`。不得修改真实任务或 Audit。

- [ ] **Step 5: Obsidian 实机烟测**

验证：Ribbon 入口、首次打开、缓存优先、真实 Token、7 天/12 周/1 年、热力日期选择、任务/Artifact 跳转、刷新、OpenToken 错误降级、明暗主题和窄面板。烟测只允许读取和打开文件，不得创建、修改或删除真实任务与 Audit；截图检查无空白、遮挡或布局跳动。

- [ ] **Step 6: 代码审查并修复问题**

按严重度检查：统计口径、时区、重复完成去重、进程边界、缓存隐私、真实 Vault 只读、事件泄漏、UI 状态和回归测试。每个缺陷先补失败测试再修复。

- [ ] **Step 7: 更新版本并提交发布准备**

只有实机烟测和 CR 通过后，按仓库现有版本规则更新版本文件与变更说明：

```bash
git add README.md docs/operations/obsidian-plugin.md package.json manifest.json src/obsidian-plugin/manifest.json versions.json src/version.ts
git commit -m "chore: prepare contribution dashboard release"
```

- [ ] **Step 8: 推送、PR 与 Release**

先将范围、统计口径、验证证据、风险与回滚说明写入 `docs/pr/obsidian-contribution-dashboard.md`，再执行：

```bash
git push -u origin codex/obsidian-contribution-dashboard
gh pr create --title "feat: add Obsidian work contribution dashboard" --body-file docs/pr/obsidian-contribution-dashboard.md
```

等待 CI 通过、合并 PR，再通过仓库既有 Release 流程发布插件包。不得在 CI 未通过前合并或打 Release。
