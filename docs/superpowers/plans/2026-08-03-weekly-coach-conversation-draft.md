# Conversational Weekly Coach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the staged weekly-coach form with a native Obsidian two-column conversation that incrementally forms, protects, saves, and explicitly confirms 0-3 weekly priorities.

**Architecture:** Keep formal weekly Markdown ownership in `weekly-focus.ts`, introduce a pure session-draft domain module for item identity and merge protection, and persist only the minimal session draft in plugin `data.json`. The modal owns ephemeral chat messages and rendering, the AI adapter returns validated operations instead of replacing whole drafts, and the home view reads both formal weekly records and plugin drafts.

**Tech Stack:** TypeScript, Obsidian Plugin API, Zod, Vitest/jsdom, YAML, pnpm, Vite, Node.js 24.

---

## Scope And File Map

The work is one cohesive feature and ships as `v0.8.0`. It touches five existing boundaries and adds one domain module:

- Create `src/services/weekly-coach-draft.ts`: pure types, normalization, item identity, field locks, deletion protection, operation merge, confirmation validation, and plugin-draft collection transitions.
- Modify `src/services/weekly-focus.ts`: formal four-field priority model, Chinese serialization, legacy five-field read compatibility, optimistic concurrency, and manual-review preservation.
- Modify `src/obsidian-plugin/weekly-thinking-coach.ts`: structured conversation response and draft-operation contract; no Vault writes.
- Modify `src/obsidian-plugin/settings.ts`: normalized `weeklyCoachDrafts` state in plugin `data.json`; no raw source documents or full transcript.
- Modify `src/obsidian-plugin/main.ts`: dependency wiring for draft load/save/clear and formal confirmation through services.
- Modify `src/obsidian-plugin/work-contribution-view.ts`: distinguish no session, plugin draft, legacy Markdown draft, and confirmed record.
- Replace the interaction in `src/obsidian-plugin/weekly-thinking-coach-modal.ts`: fixed header/footer, left conversation, right live draft, focus mode, 800 ms autosave, cancel/timeout/retry, and explicit confirmation.
- Replace only the `.atl-weekly-coach-*` block in `src/obsidian-plugin/styles.css`: 960 x 700 desktop layout and narrow-window single-column fallback.
- Extend existing unit tests and create `tests/unit/services/weekly-coach-draft.test.ts`; all fixtures remain synthetic and temporary.
- Update `package.json`, `manifest.json`, `src/obsidian-plugin/manifest.json`, `src/version.ts`, `versions.json`, and `tests/unit/version.test.ts` for `v0.8.0`.

The following remain out of scope: task creation, task-state changes, calendar scheduling, Agent execution, token-level streaming, OKR editing, and automatic review generation.

## Shared Types Locked By This Plan

Use these identifiers consistently in every task:

```ts
export const WEEKLY_COACH_DRAFT_FIELDS = [
  'focus',
  'outcome',
  'whyThisWeek',
  'evidence',
] as const;

export type WeeklyCoachDraftField = typeof WEEKLY_COACH_DRAFT_FIELDS[number];
export type WeeklyCoachDraftFieldSource = 'ai' | 'user';
export type WeeklyCoachDraftReadiness = '仍需确认' | '可确认';

export interface WeeklyCoachDraftItem {
  id: string;
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
  fieldSources: Record<WeeklyCoachDraftField, WeeklyCoachDraftFieldSource>;
  suggestions: Partial<Record<WeeklyCoachDraftField, string>>;
  readiness: WeeklyCoachDraftReadiness;
}

export interface WeeklyCoachSessionDraft {
  draftVersion: 1;
  week: string;
  topic: string;
  selectedSources: WeeklyCoachSource[];
  pendingInput: string;
  keyAnswers: string[];
  sessionSummary: string;
  pendingQuestion: string;
  questionReason: string;
  background: WeeklyFocusBackground;
  items: WeeklyCoachDraftItem[];
  deletedItems: Array<{ id: string; focusKey: string }>;
  focusedItemId: string | null;
  noNewFocus: boolean;
  updatedAt: string;
}

export interface WeeklyCoachDraftValidationIssue {
  itemId: string | null;
  field: WeeklyCoachDraftField | 'noNewFocus';
  message: string;
}

export type WeeklyCoachDraftOperation =
  | {
    action: 'create';
    itemId: null;
    fields: Partial<Record<WeeklyCoachDraftField, string>>;
  }
  | {
    action: 'update' | 'suggest_replace';
    itemId: string;
    fields: Partial<Record<WeeklyCoachDraftField, string>>;
  };

export interface WeeklyCoachResult {
  assistantMessage: string;
  nextQuestion: string | null;
  questionReason: string | null;
  background: WeeklyFocusBackground;
  draftOperations: WeeklyCoachDraftOperation[];
  sessionSummary: string;
  readiness: '继续澄清' | '可确认';
}

export interface WeeklyThinkingCoachTurn {
  topic: string;
  selectedSources: WeeklyCoachSource[];
  latestAnswer: string;
  keyAnswers: string[];
  previousSummary: string | null;
  draftItems: WeeklyCoachDraftItem[];
  deletedFocuses: string[];
  focusedItemId: string | null;
}
```

`WeeklyFocusItem` is the formal record and intentionally omits IDs and merge metadata:

```ts
export interface WeeklyFocusItem {
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
}
```

### Task 1: Upgrade Formal Weekly Records Without Losing Legacy Notes

**Files:**
- Modify: `src/services/weekly-focus.ts:19-25,164-175,215-252,365-418`
- Modify: `src/obsidian-plugin/weekly-thinking-coach-modal.ts:100-102,506-551,719-731`
- Modify: `src/obsidian-plugin/work-contribution-view.ts:778-796`
- Modify: `tests/unit/services/weekly-focus.test.ts:17-303`
- Modify: `tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts:41-121,270-292`
- Modify: `tests/unit/obsidian-plugin/work-contribution-view.test.ts:16-45,299-317`

- [ ] **Step 1: Write failing serialization and compatibility tests**

Replace the fixture focus with the four public fields and add a legacy-note load case:

```ts
focuses: [{
  focus: '验证 StyleWork 产品边界是否能被团队复用。',
  outcome: '形成一页团队共同使用的边界图。',
  whyThisWeek: '本周有两个真实流程可用于验证，延后会继续重复讨论。',
  evidence: '两个流程的负责人都确认采用同一份说明。',
}],
```

Assert the serialized item and body use exactly four Chinese labels:

```ts
expect(frontmatter(document.raw)['本周判断']).toEqual([{
  重点事项: '验证 StyleWork 产品边界是否能被团队复用。',
  预期结果: '形成一页团队共同使用的边界图。',
  为什么是本周: '本周有两个真实流程可用于验证，延后会继续重复讨论。',
  完成证据: '两个流程的负责人都确认采用同一份说明。',
}]);
expect(document.raw).toContain('**为什么是本周**：本周有两个真实流程可用于验证');
expect(document.raw).not.toContain('用户最终判断');
expect(document.raw).not.toContain('本周承诺');
```

Create a legacy raw note by replacing the new item with the prior labels, then verify load normalization:

```ts
const legacy = saved.raw
  .replace('重点事项: 验证 StyleWork 产品边界是否能被团队复用。', '真正想解决的问题: 收敛产品边界。\n    用户最终判断: 先验证两个真实流程。')
  .replace('为什么是本周: 本周有两个真实流程可用于验证，延后会继续重复讨论。', '本周承诺: 周五前完成一页边界图。')
  .replace('预期结果:', '希望产生的结果:')
  .replace('完成证据:', '验证证据:');
gateway.files.set(saved.path, legacy);

const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');
expect(loaded?.record.input.focuses[0]).toEqual({
  focus: '先验证两个真实流程。',
  outcome: '形成一页团队共同使用的边界图。',
  whyThisWeek: '周五前完成一页边界图。',
  evidence: '两个流程的负责人都确认采用同一份说明。',
});
```

- [ ] **Step 2: Run the focused service test and observe the type/expectation failures**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/services/weekly-focus.test.ts
```

Expected: FAIL because `WeeklyFocusItem` still requires `problem`, `judgment`, and `commitment`, and the serializer still emits the five old labels.

- [ ] **Step 3: Implement the four-field formal model and legacy normalization**

Change the public item, normalization, visible serialization, and body rendering:

```ts
export interface WeeklyFocusItem {
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
}

function firstString(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') return raw[key];
  }
  return '';
}

function normalizeFocus(value: unknown, requireComplete: boolean): WeeklyFocusItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本周重点格式无效');
  }
  const raw = value as Record<string, unknown>;
  return {
    focus: boundedString(firstString(raw, [
      'focus', '重点事项', 'judgment', '用户最终判断', 'problem', '真正想解决的问题',
    ]), '重点事项', !requireComplete),
    outcome: boundedString(firstString(raw, [
      'outcome', '预期结果', '希望产生的结果',
    ]), '预期结果', !requireComplete),
    whyThisWeek: boundedString(firstString(raw, [
      'whyThisWeek', '为什么是本周', 'commitment', '本周承诺',
    ]), '为什么是本周', !requireComplete),
    evidence: boundedString(firstString(raw, [
      'evidence', '完成证据', '验证证据',
    ]), '完成证据', !requireComplete),
  };
}

function visibleFocus(focus: WeeklyFocusItem): Record<string, string> {
  return {
    重点事项: focus.focus,
    预期结果: focus.outcome,
    为什么是本周: focus.whyThisWeek,
    完成证据: focus.evidence,
  };
}
```

Render each body card as `重点事项`, `预期结果`, `为什么是本周`, and `完成证据`; retain the managed markers and `reviewBody()` unchanged.

Mechanically adapt the current modal and home renderer so the field migration is a green commit before the interaction rewrite:

```ts
function emptyFocus(focus = ''): WeeklyFocusItem {
  return { focus, outcome: '', whyThisWeek: '', evidence: '' };
}

const migratedOrganizedDraft: WeeklyFocusItem = {
  focus: draft.problem,
  outcome: draft.outcome,
  whyThisWeek: draft.commitment,
  evidence: draft.evidence,
};
```

In the current editor, replace the five old text areas with four labels: `重点事项`, `预期结果`, `为什么是本周`, and `完成证据`. In confirmed modal cards and home cards, use `focus.focus` as the title and `focus.outcome` plus `focus.whyThisWeek` as supporting text. Update only the affected synthetic fixtures and aria-label assertions; do not redesign the staged interaction until Task 6.

- [ ] **Step 4: Run the service suite and typecheck**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/services/weekly-focus.test.ts
fnm exec --using 24 pnpm typecheck
```

Expected: service, modal, and home tests PASS with no TypeScript errors. The interaction remains staged until Task 6, but the shared record type is already coherent.

- [ ] **Step 5: Commit the formal-record migration**

```bash
git add \
  src/services/weekly-focus.ts \
  src/obsidian-plugin/weekly-thinking-coach-modal.ts \
  src/obsidian-plugin/work-contribution-view.ts \
  tests/unit/services/weekly-focus.test.ts \
  tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts \
  tests/unit/obsidian-plugin/work-contribution-view.test.ts
git commit -m "feat: simplify weekly focus record fields"
```

### Task 2: Add The Pure Session Draft And Protected Merge Model

**Files:**
- Create: `src/services/weekly-coach-draft.ts`
- Create: `tests/unit/services/weekly-coach-draft.test.ts`

- [ ] **Step 1: Write failing tests for identity, locks, focus mode, deletion, and validation**

Use deterministic IDs and timestamps in every test:

```ts
const base = createWeeklyCoachSessionDraft('2026-W32', '2026-08-03T09:00:00.000Z');
const first = createManualWeeklyCoachDraftItem('focus-1');
let draft = { ...base, items: [{ ...first, focus: '发布插件', fieldSources: {
  focus: 'user', outcome: 'ai', whyThisWeek: 'ai', evidence: 'ai',
} }] };

draft = mergeWeeklyCoachDraftOperations(draft, [{
  action: 'update',
  itemId: 'focus-1',
  fields: { focus: '重写插件', outcome: '用户可完成安装' },
}], { nextId: () => 'focus-2', focusedItemId: null }).draft;

expect(draft.items[0]).toMatchObject({
  focus: '发布插件',
  outcome: '用户可完成安装',
  suggestions: { focus: '重写插件' },
});
```

Add separate tests proving:

```ts
expect(mergeWeeklyCoachDraftOperations(twoItems, [{
  action: 'update', itemId: 'focus-2', fields: { outcome: '不应变化' },
}], { nextId: () => 'focus-3', focusedItemId: 'focus-1' }).draft).toEqual(twoItems);

const removed = removeWeeklyCoachDraftItem(draft, 'focus-1');
const recreated = mergeWeeklyCoachDraftOperations(removed, [{
  action: 'create', itemId: null, fields: { focus: '发布插件' },
}], { nextId: () => 'focus-2', focusedItemId: null }).draft;
expect(recreated.items).toHaveLength(0);

expect(validateWeeklyCoachSessionDraft({ ...base, items: [] })).toEqual([
  { itemId: null, field: 'noNewFocus', message: '请至少保留一项重点，或明确选择本周暂不新增重点' },
]);
expect(validateWeeklyCoachSessionDraft({ ...base, noNewFocus: true })).toEqual([]);
```

Also test `acceptWeeklyCoachSuggestion`, `editWeeklyCoachDraftField`, a three-item cap, restored non-empty fields becoming `user`, and conversion to `WeeklyFocusInput`.

- [ ] **Step 2: Run the new unit test and observe the missing-module failure**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/services/weekly-coach-draft.test.ts
```

Expected: FAIL with a module-resolution error for `src/services/weekly-coach-draft.ts`.

- [ ] **Step 3: Implement immutable draft transitions and merge protection**

Create the shared types from this plan and these exported functions:

```ts
export function createWeeklyCoachSessionDraft(
  week: string,
  updatedAt: string,
): WeeklyCoachSessionDraft;

export function createManualWeeklyCoachDraftItem(id: string): WeeklyCoachDraftItem;

export function editWeeklyCoachDraftField(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
  field: WeeklyCoachDraftField,
  value: string,
): WeeklyCoachSessionDraft;

export function acceptWeeklyCoachSuggestion(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
  field: WeeklyCoachDraftField,
): WeeklyCoachSessionDraft;

export function removeWeeklyCoachDraftItem(
  draft: WeeklyCoachSessionDraft,
  itemId: string,
): WeeklyCoachSessionDraft;

export function protectRestoredWeeklyCoachDraft(
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachSessionDraft;

export function mergeWeeklyCoachDraftOperations(
  draft: WeeklyCoachSessionDraft,
  operations: WeeklyCoachDraftOperation[],
  options: { nextId: () => string; focusedItemId: string | null },
): { draft: WeeklyCoachSessionDraft; conflicts: Array<{
  itemId: string;
  field: WeeklyCoachDraftField;
  suggestion: string;
}> };

export function validateWeeklyCoachSessionDraft(
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachDraftValidationIssue[];

export function weeklyCoachDraftToFocusInput(
  draft: WeeklyCoachSessionDraft,
): WeeklyFocusInput;
```

Implement field updates by cloning the session and target item. `editWeeklyCoachDraftField` sets the target field source to `user` and clears only that field's suggestion. During AI merge, write only `ai` fields; for a different non-empty value in a `user` field, retain the value and record a suggestion. `suggest_replace` always records suggestions until the user explicitly accepts one.

Normalize deletion keys with:

```ts
function focusKey(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}
```

Reject AI `create` operations when there are already three items or when the normalized proposed focus matches a tombstone. In focus mode, ignore every operation that is not an update or suggestion for `focusedItemId`.

- [ ] **Step 4: Run the draft-domain tests**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/services/weekly-coach-draft.test.ts
```

Expected: PASS with tests covering partial drafts, 0-item confirmation, item caps, field locks, explicit suggestion adoption, focus isolation, and deletion protection.

- [ ] **Step 5: Commit the pure draft domain**

```bash
git add src/services/weekly-coach-draft.ts tests/unit/services/weekly-coach-draft.test.ts
git commit -m "feat: add protected weekly coach drafts"
```

### Task 3: Replace The AI Response With Conversation And Draft Operations

**Files:**
- Modify: `src/obsidian-plugin/weekly-thinking-coach.ts:9-232`
- Modify: `tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts:13-155`

- [ ] **Step 1: Write failing contract tests**

Change the valid fake result to:

```ts
const output = {
  assistantMessage: '先不要急着列任务。你真正要验证的是边界图是否会被团队使用。',
  nextQuestion: '如果周五只看到一个变化，什么变化最能证明这件事值得做？',
  questionReason: '这个答案会决定预期结果和完成证据。',
  background: {
    facts: ['产品边界讨论反复出现。'],
    assumptions: ['边界图可能减少重复讨论。'],
    gaps: ['尚未确定验收人。'],
    sources: ['02_Projects/StyleWork.md', '07_System/不存在.md'],
  },
  draftOperations: [{
    action: 'create',
    itemId: null,
    fields: {
      focus: '验证 StyleWork 产品边界是否可复用',
      outcome: '团队使用同一份边界说明',
      whyThisWeek: '本周有两个真实流程可验证',
    },
  }],
  sessionSummary: '用户希望用团队是否采用同一说明判断投入价值。',
  readiness: '继续澄清',
};
```

Verify unknown source paths are filtered, `nextQuestion: null` is accepted, a second question or fourth operation is rejected, and prompt text contains current draft IDs, locked fields, deleted focus keys, and focused-item restrictions.

- [ ] **Step 2: Run the adapter test and observe schema failures**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts
```

Expected: FAIL because the current schema requires `currentQuestion`, `directions`, `organizedDraft`, and `summary`.

- [ ] **Step 3: Implement the new Zod and JSON Schema contract**

Change `WeeklyCoachTurnInput` to carry the current draft state used by the prompt:

```ts
export interface WeeklyCoachTurnInput {
  topic: string;
  latestAnswer: string;
  keyAnswers: string[];
  previousSummary: string | null;
  draftItems: WeeklyCoachDraftItem[];
  deletedFocuses: string[];
  focusedItemId: string | null;
  context: WeeklyCoachContext;
}
```

Use strict schemas. Model field objects have all four properties present as nullable strings in JSON Schema; normalization removes nulls before returning `WeeklyCoachDraftOperation`. This avoids ambiguous omitted fields while still permitting partial drafts.

The prompt must state:

```ts
'每轮最多提出一个当前最有价值的问题；信息充分时 nextQuestion 可以为 null。',
'不得为了凑满三项创造方向。只有至少三个可见字段已有依据时，才能 create 新草稿项。',
'只能补充未锁定字段。锁定字段如有不同建议，使用 suggest_replace，不能 update 覆盖。',
'聚焦讨论时只能操作指定 itemId；不得删除草稿项、创建任务、修改任务或触发 Agent。',
```

Keep the existing 180-second timeout, abort signal, progress callback, prompt-injection warning, partial-read notice, truncation notice, and actual-source filtering.

- [ ] **Step 4: Run the focused adapter test**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts
```

Expected: PASS; invalid output is rejected atomically before any operation reaches the modal.

- [ ] **Step 5: Commit the AI contract**

```bash
git add src/obsidian-plugin/weekly-thinking-coach.ts tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts
git commit -m "feat: return conversational weekly coach drafts"
```

### Task 4: Persist Minimal Session Drafts In Plugin Settings

**Files:**
- Modify: `src/services/weekly-coach-draft.ts`
- Modify: `src/obsidian-plugin/settings.ts:15-23,59-91,476-550`
- Modify: `src/obsidian-plugin/main.ts:209-224,524-584`
- Modify: `tests/unit/services/weekly-coach-draft.test.ts`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts:28-331`

- [ ] **Step 1: Write failing normalization and collection-transition tests**

Add this collection type and fixture expectation:

```ts
export interface WeeklyCoachDraftCollection {
  collectionVersion: 1;
  byWeek: Record<string, WeeklyCoachSessionDraft>;
}

function persistedDraft(): WeeklyCoachSessionDraft {
  return {
    draftVersion: 1,
    week: '2026-W32',
    topic: '判断本周是否应该发布插件',
    selectedSources: ['目标', '项目', '任务'],
    pendingInput: '',
    keyAnswers: ['希望用户不使用终端也能完成安装。'],
    sessionSummary: '已确认一个候选方向。',
    pendingQuestion: '什么证据能证明安装体验已经成立？',
    questionReason: '需要补齐完成证据。',
    background: { facts: [], assumptions: [], gaps: [], sources: [] },
    items: [{
      id: 'focus-1',
      focus: '发布插件',
      outcome: '用户可完成安装',
      whyThisWeek: '本周已经完成核心交互',
      evidence: '',
      fieldSources: {
        focus: 'user', outcome: 'ai', whyThisWeek: 'ai', evidence: 'ai',
      },
      suggestions: {},
      readiness: '仍需确认',
    }],
    deletedItems: [],
    focusedItemId: null,
    noNewFocus: false,
    updatedAt: '2026-08-03T09:00:00.000Z',
  };
}

expect(normalizeSettings({
  weeklyCoachDrafts: {
    collectionVersion: 1,
    byWeek: { '2026-W32': persistedDraft() },
  },
}).weeklyCoachDrafts.byWeek['2026-W32']).toMatchObject({
  week: '2026-W32',
  sessionSummary: '已确认一个候选方向。',
  items: [expect.objectContaining({ id: 'focus-1' })],
});
```

Assert malformed weeks, more than three items, invalid sources, unknown keys, overlong strings, full `messages` arrays, and `sourceDocuments` are not retained. Test immutable transitions:

```ts
const stored = putWeeklyCoachSessionDraft(emptyWeeklyCoachDraftCollection(), persistedDraft());
expect(getWeeklyCoachSessionDraft(stored, '2026-W32')).toEqual(persistedDraft());
expect(removeWeeklyCoachSessionDraft(stored, '2026-W32').byWeek).toEqual({});
```

- [ ] **Step 2: Run settings and draft tests and observe missing state**

Run:

```bash
fnm exec --using 24 pnpm vitest run \
  tests/unit/services/weekly-coach-draft.test.ts \
  tests/unit/obsidian-plugin/settings.test.ts
```

Expected: FAIL because `AtlPluginSettings` and `DEFAULT_SETTINGS` do not have `weeklyCoachDrafts`.

- [ ] **Step 3: Add bounded draft collection normalization**

Export these pure collection functions from `weekly-coach-draft.ts`:

```ts
export function emptyWeeklyCoachDraftCollection(): WeeklyCoachDraftCollection;
export function normalizeWeeklyCoachDraftCollection(value: unknown): WeeklyCoachDraftCollection;
export function getWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  week: string,
): WeeklyCoachSessionDraft | null;
export function putWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  draft: WeeklyCoachSessionDraft,
): WeeklyCoachDraftCollection;
export function removeWeeklyCoachSessionDraft(
  collection: WeeklyCoachDraftCollection,
  week: string,
): WeeklyCoachDraftCollection;
```

Retain at most 12 valid ISO weeks, at most 8 key answers of 4,000 characters each, at most three items, and no raw source content or message history. `normalizeWeeklyCoachDraftCollection` must return only the declared properties.

Add the state to settings:

```ts
export interface AtlPluginSettings {
  allowVaultManagement: boolean;
  taskCardThemeEnabled: boolean;
  taskNotesFieldLayoutBackup?: unknown;
  capture: CaptureState;
  background: BackgroundSettings;
  dashboard: DashboardTokenCache;
  dingtalkCalendar: DingTalkCalendarSettings;
  weeklyCoachDrafts: WeeklyCoachDraftCollection;
}
```

Normalize it in `normalizeSettings()` and include an empty collection in `DEFAULT_SETTINGS`.

- [ ] **Step 4: Wire main.ts through immutable service transitions**

Add methods that update settings only with the service functions and the existing serialized writer:

```ts
private loadWeeklyCoachSessionDraft(week: string): WeeklyCoachSessionDraft | null {
  return getWeeklyCoachSessionDraft(this.settings.weeklyCoachDrafts, week);
}

private async saveWeeklyCoachSessionDraft(draft: WeeklyCoachSessionDraft): Promise<void> {
  this.settings.weeklyCoachDrafts = putWeeklyCoachSessionDraft(
    this.settings.weeklyCoachDrafts,
    draft,
  );
  await this.saveSettings();
}

private async clearWeeklyCoachSessionDraft(week: string): Promise<void> {
  this.settings.weeklyCoachDrafts = removeWeeklyCoachSessionDraft(
    this.settings.weeklyCoachDrafts,
    week,
  );
  await this.saveSettings();
}
```

Pass `loadSessionDraft`, `saveSessionDraft`, and `clearSessionDraft` to the modal. Do not call `saveWeeklyFocusDraft` for new plugin drafts. Keep `confirmWeeklyFocus` as the only formal writer. Loading a legacy `状态: 草稿` Markdown remains supported through `loadCurrentWeeklyFocus`.

- [ ] **Step 5: Run settings tests and typecheck**

Run:

```bash
fnm exec --using 24 pnpm vitest run \
  tests/unit/services/weekly-coach-draft.test.ts \
  tests/unit/obsidian-plugin/settings.test.ts
fnm exec --using 24 pnpm typecheck
```

Expected: tests PASS; remaining type errors should be limited to modal/home callers still using the old dependency interfaces.

- [ ] **Step 6: Commit plugin draft persistence**

```bash
git add \
  src/services/weekly-coach-draft.ts \
  src/obsidian-plugin/settings.ts \
  src/obsidian-plugin/main.ts \
  tests/unit/services/weekly-coach-draft.test.ts \
  tests/unit/obsidian-plugin/settings.test.ts
git commit -m "feat: persist weekly coach session drafts"
```

### Task 5: Make The Home Entry Reflect Plugin Draft State

**Files:**
- Modify: `src/obsidian-plugin/work-contribution-view.ts:14-27,300-330,699-718`
- Modify: `src/obsidian-plugin/main.ts:446-456,532-584`
- Modify: `tests/unit/obsidian-plugin/work-contribution-view.test.ts:167-317`

- [ ] **Step 1: Write failing home-entry state tests**

Extend dependencies with:

```ts
loadWeeklyCoachDraft: () => Promise<WeeklyCoachSessionDraft | null>;
openWeeklyCoach: (onChanged: () => void) => Promise<void> | void;

function weeklyDraft(): WeeklyCoachSessionDraft {
  return createWeeklyCoachSessionDraft('2026-W32', '2026-08-03T09:00:00.000Z');
}

async function entryText(
  formal: WeeklyFocusDocument | null,
  session: WeeklyCoachSessionDraft | null,
): Promise<string> {
  const { view } = setup(state(), formal, session);
  await view.onOpen();
  return view.contentEl.querySelector('.atl-home-focus .atl-home-section-link')?.textContent ?? '';
}
```

Add assertions for all four states:

```ts
await expect(entryText(null, null)).resolves.toContain('梳理本周重点');
await expect(entryText(null, weeklyDraft())).resolves.toContain('继续本周思考');
await expect(entryText(weeklyFocus('草稿'), null)).resolves.toContain('继续本周思考');
await expect(entryText(weeklyFocus('已确认'), weeklyDraft())).resolves.toContain('查看本周判断');
```

Click the entry, invoke the captured `onChanged`, and assert the view reloads both sources rather than trusting an optimistic document argument.

- [ ] **Step 2: Run the home-view test and observe dependency failures**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/work-contribution-view.test.ts
```

Expected: FAIL because the view does not load plugin session drafts and `openWeeklyCoach` expects a document callback.

- [ ] **Step 3: Load both sources and derive the entry label**

Store `weeklyCoachDraft: WeeklyCoachSessionDraft | null` beside `weeklyFocus`. Replace `refreshWeeklyFocus()` with one method that loads both in parallel:

```ts
async refreshWeeklyCoachState(): Promise<void> {
  const [weeklyFocus, weeklyCoachDraft] = await Promise.all([
    this.dependencies.loadWeeklyFocus().catch(() => null),
    this.dependencies.loadWeeklyCoachDraft().catch(() => null),
  ]);
  this.weeklyFocus = weeklyFocus;
  this.weeklyCoachDraft = weeklyCoachDraft;
  this.rerender();
}
```

Use this precedence:

```ts
const actionLabel = this.weeklyFocus?.record.status === '已确认'
  ? '查看本周判断'
  : this.weeklyCoachDraft !== null || this.weeklyFocus?.record.status === '草稿'
    ? '继续本周思考'
    : '梳理本周重点';
```

Formal confirmed cards retain priority over any stale plugin draft. Pass `() => { void this.refreshWeeklyCoachState(); }` to `openWeeklyCoach`.

- [ ] **Step 4: Run the home-view test**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/work-contribution-view.test.ts
```

Expected: PASS for no session, resumable plugin draft, legacy Markdown draft, and confirmed record.

- [ ] **Step 5: Commit the home-entry state**

```bash
git add \
  src/obsidian-plugin/work-contribution-view.ts \
  src/obsidian-plugin/main.ts \
  tests/unit/obsidian-plugin/work-contribution-view.test.ts
git commit -m "feat: resume weekly coach drafts from home"
```

### Task 6: Build The Two-Column Conversational Modal

**Files:**
- Replace: `src/obsidian-plugin/weekly-thinking-coach-modal.ts`
- Replace: `tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts`

- [ ] **Step 1: Replace tests with the confirmed interaction contract**

Keep the jsdom Obsidian element helpers, then cover these behaviors with synthetic dependencies:

```ts
function sendMessage(modal: WeeklyThinkingCoachModal, value: string): void {
  const input = modal.contentEl.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="给本周思考教练发消息"]',
  );
  if (input === null) throw new Error('Missing weekly coach composer');
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  button(modal, '发送').click();
}

expect(modal.contentEl.querySelector('.atl-weekly-coach-conversation')).not.toBeNull();
expect(modal.contentEl.querySelector('.atl-weekly-coach-draft-panel')).not.toBeNull();
expect(modal.contentEl.textContent).toContain('本周重点草稿');
expect(modal.contentEl.textContent).toContain('0 / 3');
```

After one model response, assert conversation and draft update together:

```ts
sendMessage(modal, '我希望减少团队重复讨论');
await vi.waitFor(() => expect(modal.contentEl.textContent).toContain(
  '先不要急着列任务。你真正要验证的是边界图是否会被使用。',
));
expect(modal.contentEl.querySelector<HTMLInputElement>(
  'input[aria-label="重点事项"]',
)?.value).toBe('验证产品边界是否可复用');
expect(modal.contentEl.textContent).toContain('1 / 3');
```

Add independent tests for:

- one next question and no fixed round count;
- partial card `待补充` rendering;
- icon button `aria-label` and `title` values for send, add, and delete;
- direct edit locking a field and surfacing an AI replacement as `采用建议`;
- focus mode adding `接下来只讨论：<重点事项>` and preventing changes to other items;
- deletion tombstones blocking AI recreation;
- 800 ms debounced session save with fake timers;
- `保存并离开` cancelling a running request, flushing draft save, and closing;
- close flushing a pending save without writing formal Markdown;
- restore showing `上次进展` rather than full prior chat and reauthorizing sensitive sources;
- explicit 0-item confirmation;
- inline validation for each missing visible field;
- confirm calling formal service, clearing plugin draft only after success, and refreshing home;
- write conflict retaining the plugin draft;
- unavailable model, invalid response, partial context, cancellation, 45-second slow notice, and 180-second timeout;
- manual editing and confirmation while AI is unavailable;
- confirmed formal record rendering read-only with `打开 Markdown`.

- [ ] **Step 2: Run the modal test and observe old-flow failures**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts
```

Expected: FAIL because the current modal renders one staged body and writes Markdown for draft saves.

- [ ] **Step 3: Implement modal state and the fixed shell**

Use this dependency boundary:

```ts
export interface WeeklyThinkingCoachModalDependencies {
  week: string;
  modelLabel: string;
  loadRecord(): Promise<WeeklyFocusDocument | null>;
  loadSessionDraft(): WeeklyCoachSessionDraft | null;
  runCoach(
    input: WeeklyThinkingCoachTurn,
    control: WeeklyThinkingCoachRunControl,
  ): Promise<WeeklyCoachResult>;
  saveSessionDraft(draft: WeeklyCoachSessionDraft): Promise<void>;
  clearSessionDraft(): Promise<void>;
  confirm(input: WeeklyFocusInput, expectedContent: string | null): Promise<WeeklyFocusDocument>;
  canManageVault(): boolean;
  onChanged(): void;
  openRecord(path: string): Promise<void>;
  notify(message: string): void;
  now(): Date;
  createId(): string;
}
```

Keep full message history only in a private in-memory array:

```ts
type CoachMessage = {
  id: string;
  role: 'assistant' | 'user' | 'system';
  text: string;
  question?: string;
  questionReason?: string;
};
```

The render root must always be:

```ts
this.renderHeader();
const main = this.contentEl.createDiv({ cls: 'atl-weekly-coach-main' });
this.renderConversation(main.createDiv({ cls: 'atl-weekly-coach-conversation' }));
this.renderDraftPanel(main.createDiv({ cls: 'atl-weekly-coach-draft-panel' }));
this.renderFooter();
```

On first open, create a session draft if none exists and show one assistant introduction. On restore, call `protectRestoredWeeklyCoachDraft`, remove sensitive sources from current authorization, and show only a synthetic `上次进展` message built from `sessionSummary`, `pendingQuestion`, and current item count.

- [ ] **Step 4: Implement conversation, model progress, and atomic merge**

On send:

```ts
const answer = this.session.pendingInput.trim();
if (answer !== '') {
  this.messages.push({ id: this.dependencies.createId(), role: 'user', text: answer });
  this.session = {
    ...this.session,
    pendingInput: '',
    keyAnswers: [...this.session.keyAnswers, answer].slice(-8),
  };
  this.scheduleAutosave();
}
```

Call `runCoach` with current items, tombstones, focus ID, and allowed context. Only after the whole result validates, merge operations with `mergeWeeklyCoachDraftOperations`; then append one assistant message, update summary/background/question/readiness, and schedule autosave. Never render raw JSON or partially apply a rejected response.

Retain the existing progress stages, elapsed timer, 45-second slow notice, `AbortSignal`, and 180-second cancellation. The progress block is inline below the latest user message; the rest of the conversation and draft panel remain visible.

- [ ] **Step 5: Implement card actions and field ownership**

Render every card with four controlled inputs. Empty fields show `待补充`; user input must call:

```ts
this.session = editWeeklyCoachDraftField(
  this.session,
  item.id,
  field,
  input.value,
);
this.scheduleAutosave();
```

Display `已由你修改` for `user` fields. Show `采用建议` only when `suggestions[field]` exists and call `acceptWeeklyCoachSuggestion` on click. `聚焦讨论` sets `focusedItemId` and inserts a system message; `结束聚焦` resets it. `删除` calls the pure service and does not expose an AI restore action.

The plus icon calls `createManualWeeklyCoachDraftItem(createId())` until there are three cards. Send/add/delete icon buttons use Obsidian `setIcon`, visible or tooltip labels, `aria-label`, and `title`.

- [ ] **Step 6: Implement autosave, leave, and formal confirmation**

Use one 800 ms debounce timer. Autosave and `保存并离开` call only `saveSessionDraft`. Save status values are `未保存`, `正在暂存`, `刚刚暂存`, and `暂存失败`.

`保存并离开` aborts an active model request, awaits an immediate draft save, calls `onChanged`, and closes. Late results must compare the active controller identity and never merge after abort.

For confirmation:

```ts
const issues = validateWeeklyCoachSessionDraft(this.session);
if (issues.length > 0) {
  this.validationIssues = issues;
  this.render();
  return;
}
const result = await this.dependencies.confirm(
  weeklyCoachDraftToFocusInput(this.session),
  this.currentRecord?.raw ?? null,
);
await this.dependencies.clearSessionDraft();
this.currentRecord = result;
this.dependencies.onChanged();
```

Disable confirmation only while AI or formal persistence is running. If the formal write fails, retain the plugin draft and show a retryable error. If the formal write succeeds but draft cleanup fails, switch to the confirmed read-only state, refresh the home, show `正式记录已确认，临时草稿清理失败` through `notify`, and retry cleanup the next time the confirmed record is opened; never invite the user to confirm the same record twice. `canManageVault()` gates formal confirmation, not plugin autosave.

- [ ] **Step 7: Run modal tests and typecheck**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts
fnm exec --using 24 pnpm typecheck
```

Expected: PASS with no TypeScript errors. No test writes a real Vault.

- [ ] **Step 8: Commit the conversational modal**

```bash
git add \
  src/obsidian-plugin/weekly-thinking-coach-modal.ts \
  tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts
git commit -m "feat: build conversational weekly coach modal"
```

### Task 7: Apply The Confirmed Visual System And Responsive Layout

**Files:**
- Modify: `src/obsidian-plugin/styles.css:2434-2880`
- Modify: `tests/unit/obsidian-plugin/personal-home-styles.test.ts:148-172`

- [ ] **Step 1: Write failing CSS contract tests**

Replace old staged-flow selectors with checks for the approved shell:

```ts
expect(declarationsFor(css, '.atl-weekly-coach-modal'))
  .toMatch(/max-width\s*:\s*960px/);
expect(declarationsFor(css, '.atl-weekly-coach-modal'))
  .toMatch(/height\s*:\s*min\(700px,\s*calc\(100vh\s*-\s*48px\)\)/);
expect(declarationsFor(css, '.atl-weekly-coach-main'))
  .toMatch(/grid-template-columns\s*:\s*minmax\(0,\s*1\.35fr\)\s+minmax\(300px,\s*0\.85fr\)/);
expect(declarationsFor(css, '.atl-weekly-coach-conversation'))
  .toMatch(/overflow-y\s*:\s*auto/);
expect(declarationsFor(css, '.atl-weekly-coach-draft-panel'))
  .toMatch(/overflow-y\s*:\s*auto/);
expect(css).toMatch(/@media\s*\(max-width:\s*760px\)[\s\S]*\.atl-weekly-coach-main[\s\S]*grid-template-columns\s*:\s*1fr/);
```

Check cards have at most `8px` radius, AI status uses cyan, pending state uses orange, and the primary action uses `#6a00ff`.

- [ ] **Step 2: Run style tests and observe missing selectors**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/obsidian-plugin/personal-home-styles.test.ts
```

Expected: FAIL because `.atl-weekly-coach-main`, `.atl-weekly-coach-conversation`, and `.atl-weekly-coach-draft-panel` do not yet have the confirmed declarations.

- [ ] **Step 3: Replace the weekly-coach CSS block**

Implement these stable layout constraints:

```css
.atl-weekly-coach-modal {
  width: min(960px, calc(100vw - 48px));
  max-width: 960px;
  height: min(700px, calc(100vh - 48px));
}

.atl-weekly-coach-content {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100%;
  overflow: hidden;
}

.atl-weekly-coach-main {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(300px, 0.85fr);
  min-height: 0;
}

.atl-weekly-coach-conversation,
.atl-weekly-coach-draft-panel {
  min-width: 0;
  overflow-y: auto;
}

@media (max-width: 760px) {
  .atl-weekly-coach-modal {
    width: calc(100vw - 24px);
    height: calc(100vh - 24px);
  }

  .atl-weekly-coach-main {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(300px, 1fr) auto;
  }
}
```

Use Obsidian theme variables for surfaces and borders, `#6a00ff` only for primary emphasis, cyan for AI state, orange for incomplete/confirmation state, and no decorative gradients or nested cards. Keep all card radii at `8px` or less and preserve keyboard focus rings.

- [ ] **Step 4: Run style, modal, and home tests**

Run:

```bash
fnm exec --using 24 pnpm vitest run \
  tests/unit/obsidian-plugin/personal-home-styles.test.ts \
  tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts \
  tests/unit/obsidian-plugin/work-contribution-view.test.ts
```

Expected: PASS; no staged-flow selector is required by the modal tests.

- [ ] **Step 5: Commit the visual system**

```bash
git add src/obsidian-plugin/styles.css tests/unit/obsidian-plugin/personal-home-styles.test.ts
git commit -m "style: add weekly coach conversation layout"
```

### Task 8: Complete Regression, Version, Review, Installation, And Release

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `src/version.ts`
- Modify: `versions.json`
- Modify: `tests/unit/version.test.ts`
- Create: `docs/pr/weekly-coach-conversation-draft.md`

- [ ] **Step 1: Run the full pre-version regression**

Run:

```bash
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm build
git diff --check
```

Expected: all commands exit 0. The test summary includes the new draft-domain suite; build produces `build/obsidian-plugin/main.js`, `manifest.json`, `styles.css`, and `atl-runner.mjs`.

- [ ] **Step 2: Add a version test that fails on v0.7.6**

Update the expected version in `tests/unit/version.test.ts`:

```ts
expect(VERSION).toBe('0.8.0');
expect(rootManifest.version).toBe('0.8.0');
expect(pluginManifest.version).toBe('0.8.0');
expect(versions['0.8.0']).toBe('1.11.4');
```

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/version.test.ts
```

Expected: FAIL because release metadata still says `0.7.6`.

- [ ] **Step 3: Bump all release metadata to v0.8.0**

Set `0.8.0` in `package.json`, both manifests, and `src/version.ts`; append:

```json
"0.8.0": "1.11.4"
```

to `versions.json`, preserving valid JSON and existing entries.

- [ ] **Step 4: Write the review brief**

Create `docs/pr/weekly-coach-conversation-draft.md` with these exact sections and evidence categories:

```markdown
# 本周思考教练：对话共创与动态草稿

## 用户变化
- 在 Obsidian 原生双栏弹窗中边对话、边形成 0-3 项本周重点。
- 人工编辑字段受保护，AI 只能提出待采用建议。
- 自动暂存只保存插件草稿，确认后才生成正式周度 Markdown。

## 明确不做
- 不自动创建任务、修改状态、安排日历或触发 Agent。
- 不保存完整对话逐字稿，不实现 token 级流式输出。

## 验证证据
- Node 24：typecheck、lint、test、build 全部通过。
- 临时数据：字段锁定、删除保护、聚焦讨论、超时、冲突与兼容读取通过。
- Obsidian：桌面双栏、窄窗口单栏、保存离开、确认写入完成冒烟验证。
```

- [ ] **Step 5: Re-run release verification and commit**

Run:

```bash
fnm exec --using 24 pnpm vitest run tests/unit/version.test.ts
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm build
cmp manifest.json src/obsidian-plugin/manifest.json
test "$(node -p "require('./manifest.json').version")" = "0.8.0"
test -f build/obsidian-plugin/main.js
test -f build/obsidian-plugin/styles.css
test -f build/obsidian-plugin/atl-runner.mjs
git diff --check
```

Expected: every command exits 0.

Commit:

```bash
git add \
  package.json \
  manifest.json \
  src/obsidian-plugin/manifest.json \
  src/version.ts \
  versions.json \
  tests/unit/version.test.ts \
  docs/pr/weekly-coach-conversation-draft.md
git commit -m "chore: prepare weekly coach v0.8.0"
```

- [ ] **Step 6: Perform code review against the confirmed spec**

Inspect the complete branch diff:

```bash
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
git diff origin/main...HEAD -- \
  src/services/weekly-focus.ts \
  src/services/weekly-coach-draft.ts \
  src/obsidian-plugin/weekly-thinking-coach.ts \
  src/obsidian-plugin/weekly-thinking-coach-modal.ts \
  src/obsidian-plugin/settings.ts \
  src/obsidian-plugin/main.ts \
  src/obsidian-plugin/work-contribution-view.ts \
  src/obsidian-plugin/styles.css
```

Review specifically for: a direct Vault write outside `weekly-focus.ts` gateway use; saving full chat or raw source content; AI overwriting `user` fields; AI recreation after delete; focus-mode cross-item operations; formal write before explicit confirmation; confirmation clearing draft before successful write; English user-visible Markdown keys; and any task/Agent side effect.

Expected: no unresolved P0/P1/P2 finding. Record minor non-blocking issues separately rather than expanding the MVP.

- [ ] **Step 7: Install the verified build into the real Obsidian plugin directory**

Only after all temporary-fixture tests pass, write the build with both real-Vault guards explicitly set:

```bash
ATL_VAULT_ROOT=/Users/linctex/Documents/ClawVault \
ATL_ALLOW_REAL_WRITES=1 \
zsh -c 'install -m 0644 build/obsidian-plugin/main.js "$ATL_VAULT_ROOT/.obsidian/plugins/agent-task-loop/main.js" && \
install -m 0644 build/obsidian-plugin/manifest.json "$ATL_VAULT_ROOT/.obsidian/plugins/agent-task-loop/manifest.json" && \
install -m 0644 build/obsidian-plugin/styles.css "$ATL_VAULT_ROOT/.obsidian/plugins/agent-task-loop/styles.css" && \
install -m 0644 build/obsidian-plugin/atl-runner.mjs "$ATL_VAULT_ROOT/.obsidian/plugins/agent-task-loop/atl-runner.mjs"'
```

Reload the plugin in Obsidian, then verify:

1. 首页入口 opens a centered native modal.
2. Desktop shows conversation left and draft right; narrow width stacks without horizontal overflow.
3. One AI response appears atomically and updates at most three draft cards.
4. Manual edit survives another AI round; focus mode does not alter other cards.
5. `保存并离开` changes the home entry to `继续本周思考` without creating a new weekly Markdown file.
6. Explicit confirmation creates or updates only the current weekly record and preserves the manual review area.
7. No task is created, moved, scheduled, or executed.

- [ ] **Step 8: Push, open the PR, merge after checks, and publish v0.8.0**

Run:

```bash
git push -u origin codex/weekly-coach-conversation-draft
gh pr create \
  --base main \
  --head codex/weekly-coach-conversation-draft \
  --title "feat: conversational weekly thinking coach" \
  --body-file docs/pr/weekly-coach-conversation-draft.md
gh pr checks --watch
gh pr merge --squash --delete-branch
git fetch origin main --tags
git tag v0.8.0 origin/main
git push origin v0.8.0
gh run list --workflow "Release Obsidian plugin" --limit 1
gh run watch "$(gh run list --workflow "Release Obsidian plugin" --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release view v0.8.0 --json tagName,name,assets,url
```

Expected: PR checks pass, `main` contains the squash merge, the release workflow succeeds, and the GitHub release contains `main.js`, `manifest.json`, `styles.css`, `atl-runner.mjs`, and `agent-task-loop-v0.8.0.zip`.

## Final Acceptance Checklist

- [ ] The native modal is approximately 960 x 700 and remains usable in a narrow Obsidian window.
- [ ] Conversation and live 0-3 item draft are visible together.
- [ ] AI asks at most one question per round and never invents items to reach three.
- [ ] Every formal item has `重点事项`, `预期结果`, `为什么是本周`, and `完成证据`.
- [ ] User edits, deletion tombstones, and focus isolation survive later AI rounds.
- [ ] Cancellation, failure, invalid output, and timeout preserve input and the previous draft.
- [ ] Autosave and save-and-leave write only plugin draft state.
- [ ] Explicit confirmation is the only path to formal weekly Markdown.
- [ ] User-visible Markdown uses only Chinese keys and enum values.
- [ ] Legacy weekly draft Markdown still loads and external/manual content remains intact.
- [ ] No task, calendar, Agent execution, raw source document, model credential, or full transcript is written by this feature.
- [ ] Node 24 typecheck, lint, unit tests, build, diff checks, Obsidian smoke validation, PR checks, and release workflow all pass.
