# 收件箱日期排序与每日待办不限量 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让四个 ATL 管理看板显示来源日期、入箱时间和有效计划时间，保留人工拖动优先并按入箱时间自动排序，同时移除每日复盘 3–5 条候选上限并统一任务分类口径。

**Architecture:** `BoardAppearanceController` 继续作为唯一的 Base 预设写入边界，通过原子写入和一次性备份更新四个已知 Kanban 视图，不触碰用户自建视图或任务文件。实时扫描只增强候选提取提示词和不限量回归，后台每日复盘的数量与分类规则通过现有 `obsidian` automation 原地更新，真实 Vault 仅在全部自动化测试通过后应用预设并验证。

**Tech Stack:** TypeScript、YAML、Obsidian Bases / TaskNotes、Vitest、pnpm 10、Node.js 24、Codex Automations、GitHub Actions

---

### Task 1: 用失败测试锁定四看板日期字段和排序契约

**Files:**
- Modify: `tests/unit/obsidian-plugin/board-appearance-controller.test.ts`
- Test: `tests/unit/obsidian-plugin/board-appearance-controller.test.ts`

- [x] **Step 1: 扩充 Base 合成 fixture**

在 `original` 中保留“任务总看板”，再增加“工作任务”“个人实践”“待归类”三个 ATL 管理视图和一个“我的自建视图”。三个分类视图分别保留不同 `filters`，自建视图使用独特 `order`、`sort` 和 `columnWidth`，用于证明预设不会覆盖其配置。

```yaml
  - type: tasknotesKanban
    name: 工作任务
    filters:
      and:
        - task_scope == "work"
  - type: tasknotesKanban
    name: 个人实践
    filters:
      and:
        - task_scope == "personal"
  - type: tasknotesKanban
    name: 待归类
    filters:
      and:
        - formula.atlScope == "待归类"
  - type: tasknotesKanban
    name: 我的自建视图
    order:
      - review_state
    sort:
      - property: file.name
        direction: ASC
    columnWidth: 444
```

- [x] **Step 2: 把主预设测试改成新契约**

对四个已管理视图逐一断言：

```ts
expect(view).toMatchObject({
  order: [
    'project_id',
    'source_date',
    'formula.atlCollectedAt',
    'formula.atlPlannedAt',
    'priority',
  ],
  sort: [
    { column: 'tasknotes_manual_order', direction: 'DESC' },
    { column: 'formula.atlCollectedAt', direction: 'DESC' },
    { column: 'source_date', direction: 'DESC' },
    { column: 'formula.atlPriorityRank', direction: 'ASC' },
  ],
});
```

同时断言：

```ts
expect(parsed.formulas).toMatchObject({
  atlCollectedAt: expect.stringContaining('created_at'),
  atlPlannedAt: expect.stringContaining('scheduled'),
});
expect(parsed.properties).toMatchObject({
  source_date: { displayName: '来源日期' },
  'formula.atlCollectedAt': { displayName: '入箱时间' },
  'formula.atlPlannedAt': { displayName: '计划时间' },
});
expect(parsed.views.find((view) => view.name === '我的自建视图')).toMatchObject({
  order: ['review_state'],
  sort: [{ property: 'file.name', direction: 'ASC' }],
  columnWidth: 444,
});
```

- [x] **Step 3: 增加异常和兼容性测试**

增加以下用例：

```ts
it('updates every present managed view while preserving each filter');
it('leaves user-created Kanban and calendar fields unchanged');
it('treats a missing optional managed view as compatible');
it('rejects duplicate managed view names before creating a backup');
it('reports the preset as stale when one managed view still exposes scheduled');
```

“缺少可选管理视图”fixture 必须仍包含唯一“任务总看板”；“重复管理视图”必须完整比较写入前后的原文并断言 `.atl-backup` 不存在。

- [x] **Step 4: 运行目标测试并确认 RED**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/board-appearance-controller.test.ts
```

Expected: FAIL，差异明确显示旧预设仍使用 `scheduled` / `due`、只更新一个视图且缺少双日期公式。

### Task 2: 实现四看板双日期呈现、可空计划时间和人工优先排序

**Files:**
- Modify: `src/obsidian-plugin/board-appearance-controller.ts`
- Test: `tests/unit/obsidian-plugin/board-appearance-controller.test.ts`

- [x] **Step 1: 定义受管视图、公式、字段和排序常量**

用以下契约替换单视图常量：

```ts
const MANAGED_KANBAN_NAMES = new Set([
  '任务总看板',
  '工作任务',
  '个人实践',
  '待归类',
]);
const COLLECTED_AT_FORMULA = 'if(created_at.isEmpty(), file.ctime, if(date(created_at).isEmpty(), file.ctime, date(created_at)))';
const PLANNED_AT_FORMULA = 'if(scheduled.isEmpty(), null, date(scheduled))';
const MANUAL_CARD_FIELDS = [
  'project_id',
  'source_date',
  'formula.atlCollectedAt',
  'formula.atlPlannedAt',
  'priority',
];
const MANUAL_CARD_SORT = [
  { column: 'tasknotes_manual_order', direction: 'DESC' },
  { column: 'formula.atlCollectedAt', direction: 'DESC' },
  { column: 'source_date', direction: 'DESC' },
  { column: 'formula.atlPriorityRank', direction: 'ASC' },
];
```

- [x] **Step 2: 让解析结果返回全部受管视图**

将 `ParsedBoard.view` 改成 `managedViews: BaseView[]`。解析时要求“任务总看板”恰好一个；其他受管名称允许缺失，但任一名称出现两次必须以“任务总看板配置无效”失败关闭。日历识别和安全检查保持不变。

```ts
type ParsedBoard = {
  document: BaseDocument;
  managedViews: BaseView[];
  calendar: BaseView | undefined;
};
```

- [x] **Step 3: 增加只补充目标键的公式和属性帮助函数**

读取 `document.formulas` / `document.properties` 时：未定义则创建普通对象；已定义但不是对象则抛出配置无效。只写入以下键并保留其他键：

```ts
formulas.atlCollectedAt = COLLECTED_AT_FORMULA;
formulas.atlPlannedAt = PLANNED_AT_FORMULA;
properties.source_date = {
  ...(isRecord(properties.source_date) ? properties.source_date : {}),
  displayName: '来源日期',
};
properties['formula.atlCollectedAt'] = {
  ...(isRecord(properties['formula.atlCollectedAt'])
    ? properties['formula.atlCollectedAt']
    : {}),
  displayName: '入箱时间',
};
properties['formula.atlPlannedAt'] = {
  ...(isRecord(properties['formula.atlPlannedAt'])
    ? properties['formula.atlPlannedAt']
    : {}),
  displayName: '计划时间',
};
```

- [x] **Step 4: 统一应用并检测全部受管视图**

`applyRecommendedPreset()` 对 `managedViews` 循环应用字段、排序、列宽、紧凑布局和四列状态配置，但不重建对象，因此每个视图的 `filters` 与其他未知键保持原样。`status()` 只有在公式、属性、所有当前存在的受管视图及日历选项均满足契约时才返回 `applied: true`。

- [x] **Step 5: 运行目标测试并确认 GREEN**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/board-appearance-controller.test.ts
```

Expected: 全部 PASS；输出中没有真实 Vault 路径，也没有写入个人数据。

- [x] **Step 6: 提交看板实现**

```bash
git add src/obsidian-plugin/board-appearance-controller.ts tests/unit/obsidian-plugin/board-appearance-controller.test.ts
git commit -m "feat: show inbox source and collection dates"
```

### Task 3: 统一同步助手分类口径并证明候选不限量

**Files:**
- Modify: `tests/unit/obsidian-plugin/candidate-extractor.test.ts`
- Modify: `src/obsidian-plugin/candidate-extractor.ts`

- [x] **Step 1: 写入分类提示词和不限量失败测试**

在受限提示词测试中增加以下断言：

```ts
expect(input.prompt).toContain('explicit_task');
expect(input.prompt).toContain('inferred_task');
expect(input.prompt).toContain('supporting_action_candidate');
expect(input.prompt).toContain('thought_or_context');
expect(input.prompt).toContain('information');
expect(input.prompt).toContain('completed_action');
expect(input.prompt).toContain('周期性');
expect(input.prompt).toContain('关联调研');
```

新增一个 executor 在同一批次返回 8 个合格候选，断言结果长度仍为 8、顺序不变且没有 `.slice(0, 5)` 语义：

```ts
it('returns every validated candidate when a batch contains more than five', async () => {
  const sources = Array.from({ length: 8 }, (_, index) => record(index));
  const candidates = sources.map((source, index) => ({
    title: `调研工具 ${index}`,
    summary: `比较工具 ${index} 的能力。`,
    priority: 'normal' as const,
    topicKey: `工具-${index}`,
    sourceRecordFingerprint: source.fingerprint,
    sourceQuote: `#待办 调研工具 ${index}`,
  }));
  await expect(extractTaskCandidates({
    records: sources,
    executor: fakeExecutor([{ candidates }]),
  })).resolves.toEqual(candidates);
});
```

- [x] **Step 2: 运行目标测试并确认 RED**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/candidate-extractor.test.ts
```

Expected: 新的六类口径提示词断言 FAIL；原有 40 条 / 60,000 字符分批测试继续 PASS。

- [x] **Step 3: 用六类判定规则替换宽泛提取描述**

在 `extractionPrompt()` 中明确：

```text
- 先逐条分类：explicit_task、inferred_task、supporting_action_candidate、thought_or_context、information、completed_action。
- 只有 explicit_task、inferred_task、supporting_action_candidate 可以返回候选。
- inferred_task 必须在 summary 写明推断理由；supporting_action_candidate 必须与来源中的当前目标直接相关，例如关联调研。
- thought_or_context、information、completed_action 不返回候选；#Ai使用 等主题标签不能单独作为行动证据。
- 保留一次性或周期性意图、动作对象、预期成果和时间表达，不把周期性任务改写成一次性任务。
- 同一来源动作不同则分别返回；不要因为标题相似或为了减少数量强行合并。
- 不设置候选数量上限；返回本批次全部合格候选。
```

保留结构化输出、来源 fingerprint、逐字引文校验、40 条 / 60,000 字符技术分批和显式 `#待办` 确定性回退。

- [x] **Step 4: 运行目标测试并确认 GREEN**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/candidate-extractor.test.ts
```

Expected: 全部 PASS，8 个候选完整返回，分批限制保持不变。

- [x] **Step 5: 提交分类实现**

```bash
git add src/obsidian-plugin/candidate-extractor.ts tests/unit/obsidian-plugin/candidate-extractor.test.ts
git commit -m "fix: align sync task candidate classification"
```

### Task 4: 更新用户文案和每日复盘自动化

**Files:**
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `docs/operations/obsidian-plugin.md`
- Update in place: Codex automation `id = "obsidian"`

- [ ] **Step 1: 更新插件设置文案**

把“ATL 紧凑卡片”说明改为：

```ts
.setDesc('在 TaskNotes 看板中优先显示项目、来源日期、入箱时间、有效计划时间和优先级，并在日历中单行省略过长标题。')
```

把“人工任务看板布局”已找到时的说明改为：

```text
按任务状态显示四列，并保留人工拖动优先；首次应用会保留原始备份。
```

- [ ] **Step 2: 从用户视角补充三种日期和不限量说明**

在 `docs/operations/obsidian-plugin.md` 的“应用人工任务看板”后补充：

```markdown
卡片上的三个时间不要混用：

| 字段 | 回答的问题 | 是否决定日历位置 |
| --- | --- | --- |
| 来源日期 | 这件事来自哪天的同步助手记录 | 否 |
| 入箱时间 | ATL 什么时候把它整理进 Inbox | 否 |
| 计划时间 | 我准备哪天、几点处理 | 是 |

没有计划时间时卡片不会再显示 `scheduled: false`。人工拖动顺序优先；未拖动任务默认按入箱时间从新到旧排列。每日复盘不限制合格候选数量，但所有自动整理任务仍留在 Inbox，必须由你确认后才会进入待办。
```

- [ ] **Step 3: 原地更新 `obsidian` 自动化**

使用 Codex automation 更新工具读取现有 `id = "obsidian"` 并只修改原有任务，不创建第二个自动化。保持 schedule、model、reasoning effort、cwd 和状态不变；将任务候选规则第 16–18 条调整为六类口径，删除：

```text
每日最多向 ATL 提交 3-5 条候选
若候选超过 5 条，只保留最明确、最接近执行、来源证据最强的 3-5 条
```

增加：所有批次中通过质量门槛的候选都提交 ATL，不限数量；报告候选总数、新增数、已有数、失败数，不截断列表。保留逐条 ATL capture、去重、人工确认、失败不直写 Markdown 等边界。

- [ ] **Step 4: 验证自动化没有重复且配置已持久化**

读取 automation 列表和 `obsidian` 详情，断言：

```text
id = obsidian 的自动化恰好 1 个
rrule = FREQ=DAILY;INTERVAL=1;BYHOUR=20;BYMINUTE=0
prompt 不含“最多向 ATL 提交 3-5 条”或“超过 5 条”
prompt 包含六类标识和“不设置候选数量上限”
```

- [ ] **Step 5: 运行文档与源码检查并提交**

Run:

```bash
rg -n "来源日期|入箱时间|计划时间|不限制合格候选数量" docs/operations/obsidian-plugin.md
rg -n "来源日期、入箱时间、有效计划时间|保留人工拖动优先" src/obsidian-plugin/main.ts
git diff --check
```

Expected: 两个 `rg` 均命中目标文案，`git diff --check` 退出 0。

```bash
git add src/obsidian-plugin/main.ts docs/operations/obsidian-plugin.md
git commit -m "docs: explain inbox dates and candidate flow"
```

### Task 5: 完整验证、代码审查和真实 Vault 冒烟

**Files:**
- Modify only when an Important or Critical review finding requires a focused fix
- Verify: `/Users/linctex/Documents/ClawVault/10_Tasks/Views/任务总看板.base`
- Verify unchanged: `/Users/linctex/Documents/ClawVault/笔记同步助手`

- [ ] **Step 1: 执行完整自动化验证**

Run:

```bash
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm build
git diff --check
```

Expected: 所有命令退出 0。

- [ ] **Step 2: 以 `origin/main...HEAD` 执行代码审查**

逐项审查：公式对缺失/损坏日期的处理、四个视图的筛选保留、用户自建视图所有权、重复名称 fail-closed、备份幂等、人工排序优先、候选数量无截断、周期性意图、来源引文校验、自动化人工确认边界。Critical / Important 必须先补失败测试再修复；不影响 MVP 的 Minor 创建 GitHub issue 后继续。

- [ ] **Step 3: 重跑完整验证**

Run:

```bash
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm build
```

Expected: 全部退出 0，工作树只包含已审查的计划/功能提交。

- [ ] **Step 4: 在显式真实写入授权下应用推荐预设**

使用与插件相同的公开控制器入口，并显式设置：

```bash
ATL_VAULT_ROOT=/Users/linctex/Documents/ClawVault \
ATL_ALLOW_REAL_WRITES=1 \
fnm exec --using 24 pnpm atl --help
```

实际应用前记录 `任务总看板.base` 和既有 `.atl-backup` 的 hash。通过已构建插件的“设置 → Agent Task Loop → 任务看板 → 应用人工任务布局”执行一次；禁止直接改任务 Markdown。

- [ ] **Step 5: 验证真实 Base 和 Obsidian UI**

读取 Base 并确认：四个受管视图均包含双日期、可空计划时间和四级排序；工作/个人/待归类筛选不变；日历配置不变；原始 `scheduled` 不在卡片 `order`；同步助手目录 hash/mtime 未变化。完全重启 Obsidian 后确认 Inbox 卡片显示“来源日期”“入箱时间”，未排期卡片不显示 `scheduled: false`，已有人工顺序仍优先。

### Task 6: 发布 v0.7.5 并安装最终产物

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `src/version.ts`
- Modify: `versions.json`
- Modify: `tests/unit/version.test.ts`
- Modify: `tests/integration/runner/packaged-runner.test.ts`

- [ ] **Step 1: 将所有版本元数据同步到 `0.7.5`**

把 package、两个 manifest、`ATL_VERSION`、版本测试和 packaged runner 断言统一改为 `0.7.5`，并在 `versions.json` 增加：

```json
"0.7.5": "1.11.4"
```

- [ ] **Step 2: 运行版本和完整验证**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/version.test.ts tests/integration/runner/packaged-runner.test.ts
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm build
cmp manifest.json src/obsidian-plugin/manifest.json
```

Expected: 全部退出 0，两个 manifest 字节一致，构建产物包含 `main.js`、`manifest.json`、`styles.css`、`atl-runner.mjs`。

- [ ] **Step 3: 提交版本元数据**

```bash
git add package.json manifest.json src/obsidian-plugin/manifest.json src/version.ts versions.json tests/unit/version.test.ts tests/integration/runner/packaged-runner.test.ts
git commit -m "chore: release v0.7.5"
```

- [ ] **Step 4: 推送分支并创建 PR**

```bash
git push -u origin codex/inbox-date-ordering
gh pr create \
  --base main \
  --head codex/inbox-date-ordering \
  --title "feat: clarify inbox dates and remove candidate cap" \
  --body-file /tmp/agent-task-loop-inbox-date-ordering-pr.md
```

PR 正文必须列出用户可见变化、分类边界、自动化本机更新、测试证据和真实 Vault 冒烟结果，不包含私人笔记原文。

- [ ] **Step 5: 合并、打 tag 并等待 GitHub Release**

确认 PR checks 通过后 squash/merge 到 `main`，在合并提交上创建并推送 annotated tag：

```bash
git tag -a v0.7.5 -m "Agent Task Loop v0.7.5"
git push origin v0.7.5
gh run watch --repo PANGKAIFENG/agent-task-loop --exit-status
gh release view v0.7.5 --repo PANGKAIFENG/agent-task-loop
```

Expected: Release workflow 成功，Release 附件包含四个单文件和 `agent-task-loop-v0.7.5.zip`。

- [ ] **Step 6: 安装 Release 产物并最终复验**

下载 `v0.7.5` Release zip，核对 tag/manifest 版本后覆盖 `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/` 的四个 ATL 文件。安装前后记录 TaskNotes 插件目录 hash 并确认完全不变；重启 Obsidian，再次验证双日期、隐藏 `scheduled: false`、人工顺序和每日自动化唯一性。
