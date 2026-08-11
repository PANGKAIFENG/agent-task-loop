# Weekly Coach Scope Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the weekly coach focused on weekly investment decisions while preserving task-level questions for later work without continuing to ask them in the weekly conversation.

**Architecture:** Extend the structured model contract with an allow-listed weekly question dimension and deferred task-question output. Merge deferred questions through the draft service, persist them in backward-compatible plugin drafts and Chinese weekly-focus records, then render them as compact editable disclosures in the Obsidian modal. Existing task execution, capture, calendar, and model configuration boundaries remain unchanged.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 3, Obsidian API 1.13, YAML, Vite 8, pnpm 10, Node 24.

---

## File Map

- Modify `src/obsidian-plugin/weekly-thinking-coach.ts`: define weekly question dimensions, structured deferred-question output, scope Prompt, and duplicate-question validation.
- Modify `src/services/weekly-coach-draft.ts`: own deferred-question state, merge/edit/remove services, backward-compatible normalization, redaction, and conversion to formal input.
- Modify `src/services/weekly-focus.ts`: validate, serialize, render, and parse deferred questions with Chinese labels.
- Modify `src/obsidian-plugin/weekly-thinking-coach-modal.ts`: pass existing deferred questions to the coach, apply model results through services, and render editable disclosures.
- Modify `src/obsidian-plugin/styles.css`: add compact disclosure and inline-edit styles using the existing weekly-coach visual system.
- Modify `tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts`: cover the structured boundary contract and Prompt.
- Modify `tests/unit/services/weekly-coach-draft.test.ts`: cover merge, association, deduplication, limits, editing, deletion, migration, and redaction.
- Modify `tests/unit/services/weekly-focus.test.ts`: cover Chinese YAML/body round trips and old-record compatibility.
- Modify `tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts`: cover boundary text, disclosure rendering, edits, deletion, restoration, and confirmation.
- Modify `docs/operations/obsidian-plugin.md`: explain the weekly-versus-task boundary in user-facing Chinese.
- Modify `package.json`, `manifest.json`, `src/obsidian-plugin/manifest.json`, and `versions.json`: prepare `v0.8.3`.

## Task 1: Enforce the model-level weekly decision boundary

**Files:**
- Modify: `tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts`
- Modify: `src/obsidian-plugin/weekly-thinking-coach.ts`
- Modify: `src/services/weekly-coach-draft.ts`

- [ ] **Step 1: Extend synthetic fixtures with deferred questions**

Add these exact properties to the `input` fixture and the object returned by `validOutput`:

```ts
deferredTaskQuestions: [],

nextQuestionDimension: '周级结果',
deferredTaskQuestions: [],
```

- [ ] **Step 2: Write failing contract and Prompt tests**

Add tests that require the six allowed dimensions, reject a missing or task-level dimension, and assert the Prompt boundary:

```ts
it('restricts follow-up questions to weekly decision dimensions', async () => {
  const fake = executor(validOutput({
    nextQuestion: '如果本周投入它，需要延后什么？',
    questionReason: '需要确认机会成本。',
    nextQuestionDimension: '机会成本',
  }));

  const result = await runWeeklyThinkingCoach(fake, input);
  expect(result.nextQuestionDimension).toBe('机会成本');

  const execution = fake.execute.mock.calls[0]?.[0] as ClaudeStructuredInput<unknown>;
  expect(execution.prompt).toContain('目标关联、本周时机、周级结果、结果价值、机会成本、投入容量');
  expect(execution.prompt).toContain('什么叫可用的 Skill');
  expect(execution.prompt).toContain('进入任务后待思考的问题');
  expect(execution.prompt).toContain('不得再次追问');
});

it('rejects a question without an allowed weekly dimension', async () => {
  await expect(runWeeklyThinkingCoach(executor(validOutput({
    nextQuestion: '什么叫可用的 Skill？',
    questionReason: '需要定义任务标准。',
    nextQuestionDimension: '任务执行',
  })), input)).rejects.toThrow();
});

it('requires the question fields and dimension to be null together', async () => {
  await expect(runWeeklyThinkingCoach(executor(validOutput({
    nextQuestion: null,
    questionReason: null,
    nextQuestionDimension: '周级结果',
  })), input)).rejects.toThrow();
});
```

- [ ] **Step 3: Run the focused test and observe Red**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts
```

Expected: FAIL because `nextQuestionDimension`, `deferredTaskQuestions`, and the scope Prompt rules do not exist.

- [ ] **Step 4: Add the question dimension and deferred output schemas**

In `weekly-thinking-coach.ts`, add:

```ts
export const WEEKLY_COACH_QUESTION_DIMENSIONS = [
  '目标关联',
  '本周时机',
  '周级结果',
  '结果价值',
  '机会成本',
  '投入容量',
] as const;

export type WeeklyCoachQuestionDimension =
  typeof WEEKLY_COACH_QUESTION_DIMENSIONS[number];

const deferredTaskQuestionSchema = z.object({
  relatedItemId: text.nullable(),
  relatedFocus: text,
  question: text,
}).strict();
```

Extend `weeklyCoachResultSchema`, `weeklyCoachJsonSchema`, and `WeeklyCoachResult` with:

```ts
nextQuestionDimension: z.enum(WEEKLY_COACH_QUESTION_DIMENSIONS).nullable(),
deferredTaskQuestions: z.array(deferredTaskQuestionSchema).max(3),
```

Update the existing `superRefine` so `nextQuestion`, `questionReason`, and `nextQuestionDimension` are either all present or all null.

- [ ] **Step 5: Pass existing deferred questions into each turn**

In `weekly-coach-draft.ts`, add the shared types and turn property:

```ts
export interface WeeklyCoachDeferredTaskQuestion {
  id: string;
  relatedItemId: string | null;
  relatedFocus: string;
  question: string;
}

export interface WeeklyCoachDeferredTaskQuestionInput {
  relatedItemId: string | null;
  relatedFocus: string;
  question: string;
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
  deferredTaskQuestions: WeeklyCoachDeferredTaskQuestion[];
}
```

Add `deferredTaskQuestions` to `WeeklyCoachTurnInput`, normalized model output, and the JSON Schema required list.

- [ ] **Step 6: Add the explicit two-level Prompt contract**

Add these instructions before user context in `promptFor`:

```ts
'你的对话目标只限于本周投入判断：本周是否值得做、为什么现在做、期望形成什么周级结果、与其他承诺如何取舍、是否有足够时间和资源。',
'下一问题只能属于：目标关联、本周时机、周级结果、结果价值、机会成本、投入容量。',
'领域定义、具体方案、详细验收标准、执行步骤、任务拆解，以及需要任务内调研后才能得出的结论，都是任务级问题。',
'发现任务级问题时，把它写入 deferredTaskQuestions，说明已留到任务阶段处理，不得在 assistantMessage 或 nextQuestion 中继续追问。',
'assistantMessage 只能复述、解释或提示已记录内容；所有需要用户回答的问题只能放在唯一的 nextQuestion 中。',
'已在“进入任务后待思考的问题”中的内容不得再次追问。',
'例如“什么叫可用的 Skill”“应该用哪些维度筛选 Skill”必须延后；“为什么必须本周完成”“本周投入它要延后什么”可以追问。',
```

Render existing deferred questions below the current draft:

```ts
function deferredQuestionsForPrompt(input: WeeklyCoachTurnInput): string {
  if (input.deferredTaskQuestions.length === 0) return '当前没有已延后的任务级问题。';
  return input.deferredTaskQuestions.map((item) => (
    `- ${item.relatedFocus || '待关联'}：${item.question}`
  )).join('\n');
}
```

- [ ] **Step 7: Reject an exact re-ask of a deferred question**

Add a punctuation-insensitive normalizer and throw a `ZodError` when `nextQuestion` equals a current-turn or existing deferred question:

```ts
function normalizedQuestion(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function assertQuestionWasNotDeferred(
  result: WeeklyCoachRawResult,
  existing: WeeklyCoachDeferredTaskQuestion[],
): void {
  if (result.nextQuestion === null) return;
  const blocked = [...existing, ...result.deferredTaskQuestions]
    .some((item) => normalizedQuestion(item.question) === normalizedQuestion(result.nextQuestion!));
  if (!blocked) return;
  throw new z.ZodError([{
    code: 'custom',
    path: ['nextQuestion'],
    message: '已延后的任务级问题不得再次追问',
  }]);
}
```

Call it after schema parsing and before normalization.

- [ ] **Step 8: Run the focused test and observe Green**

Run the same focused Vitest command.

Expected: all tests in `weekly-thinking-coach.test.ts` PASS.

- [ ] **Step 9: Commit the model contract**

```bash
git add src/obsidian-plugin/weekly-thinking-coach.ts src/services/weekly-coach-draft.ts tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts
git commit -m "fix: keep weekly coach questions at weekly scope"
```

## Task 2: Persist and manage deferred task questions in session drafts

**Files:**
- Modify: `tests/unit/services/weekly-coach-draft.test.ts`
- Modify: `src/services/weekly-coach-draft.ts`

- [ ] **Step 1: Write failing service tests**

Import the new service functions and add tests for association, deduplication, limits, editing, removal, deletion, migration, and readiness:

```ts
it('merges, associates, and deduplicates deferred task questions', () => {
  const original = draftWith(completeItem('focus-1', '筛选本周要交付的 Skill'));
  let sequence = 0;
  const merged = mergeWeeklyCoachDeferredTaskQuestions(original, [
    { relatedItemId: 'focus-1', relatedFocus: '筛选本周要交付的 Skill', question: '定义 Skill 的可用标准' },
    { relatedItemId: null, relatedFocus: '筛选本周要交付的 Skill', question: '定义 Skill 的可用标准。' },
    { relatedItemId: null, relatedFocus: '其他方向', question: '确认执行工具' },
  ], { nextId: () => `question-${++sequence}` });

  expect(merged.deferredTaskQuestions).toEqual([
    {
      id: 'question-1',
      relatedItemId: 'focus-1',
      relatedFocus: '筛选本周要交付的 Skill',
      question: '定义 Skill 的可用标准',
    },
    {
      id: 'question-2',
      relatedItemId: null,
      relatedFocus: '其他方向',
      question: '确认执行工具',
    },
  ]);
});

it('edits and removes deferred questions without changing focus readiness', () => {
  const withQuestion = mergeWeeklyCoachDeferredTaskQuestions(
    draftWith(completeItem('focus-1')),
    [{ relatedItemId: 'focus-1', relatedFocus: '发布插件', question: '定义兼容范围' }],
    { nextId: () => 'question-1' },
  );
  const edited = editWeeklyCoachDeferredTaskQuestion(withQuestion, 'question-1', '确认兼容范围');
  expect(edited.items[0]?.readiness).toBe('可确认');
  expect(edited.deferredTaskQuestions[0]?.question).toBe('确认兼容范围');
  expect(removeWeeklyCoachDeferredTaskQuestion(edited, 'question-1').deferredTaskQuestions).toEqual([]);
});
```

Add migration and safety assertions:

```ts
it('restores legacy version-one drafts with an empty deferred list', () => {
  const legacy = structuredClone(persistedDraft()) as Record<string, unknown>;
  delete legacy.deferredTaskQuestions;
  const normalized = normalizeWeeklyCoachDraftCollection({
    collectionVersion: 1,
    byWeek: { '2026-W32': legacy },
  });
  expect(normalized.byWeek['2026-W32']?.deferredTaskQuestions).toEqual([]);
});

it('removes questions explicitly linked to a deleted focus', () => {
  const draft = {
    ...draftWith(completeItem('focus-1')),
    deferredTaskQuestions: [{
      id: 'question-1',
      relatedItemId: 'focus-1',
      relatedFocus: '发布插件',
      question: '定义兼容范围',
    }],
  };
  expect(removeWeeklyCoachDraftItem(draft, 'focus-1').deferredTaskQuestions).toEqual([]);
});
```

- [ ] **Step 2: Run the draft-service test and observe Red**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/services/weekly-coach-draft.test.ts
```

Expected: FAIL because deferred-question state and service functions are absent.

- [ ] **Step 3: Add backward-compatible draft state**

Add `deferredTaskQuestions: WeeklyCoachDeferredTaskQuestion[]` to `WeeklyCoachSessionDraft` and initialize it in `createWeeklyCoachSessionDraft`:

```ts
deferredTaskQuestions: [],
```

In `normalizePersistedDraft`, treat a missing property as an empty array and validate present entries with the same string, count, timestamp-independent, and redaction limits used by the rest of the draft.

Update `cloneDraft` and `redactSessionDraft`:

```ts
deferredTaskQuestions: draft.deferredTaskQuestions.map((item) => ({ ...item })),
```

Redact `id`, `relatedFocus`, and `question`; convert an empty redacted label to `待关联重点` and reject an empty redacted question.

- [ ] **Step 4: Implement merge, edit, and remove services**

Export these functions:

```ts
export function mergeWeeklyCoachDeferredTaskQuestions(
  draft: WeeklyCoachSessionDraft,
  questions: WeeklyCoachDeferredTaskQuestionInput[],
  options: { nextId: () => string },
): WeeklyCoachSessionDraft;

export function editWeeklyCoachDeferredTaskQuestion(
  draft: WeeklyCoachSessionDraft,
  questionId: string,
  value: string,
): WeeklyCoachSessionDraft;

export function removeWeeklyCoachDeferredTaskQuestion(
  draft: WeeklyCoachSessionDraft,
  questionId: string,
): WeeklyCoachSessionDraft;
```

Implementation rules:

```ts
const MAX_DEFERRED_PER_FOCUS = 5;
const MAX_UNASSIGNED_DEFERRED = 10;

function normalizedQuestion(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}
```

Resolve a valid `relatedItemId` first, otherwise match one draft item by `normalizedFocus(relatedFocus)`. Deduplicate within the resolved item or unassigned bucket. Keep the first retained wording, enforce the two caps, and never mutate the input draft.

`editWeeklyCoachDeferredTaskQuestion` trims, redacts, rejects an empty value by returning the original draft, and deduplicates the edited item against its bucket. `removeWeeklyCoachDeferredTaskQuestion` removes only the requested ID.

- [ ] **Step 5: Remove linked questions with a deleted focus**

In `removeWeeklyCoachDraftItem`, filter the cloned list:

```ts
next.deferredTaskQuestions = next.deferredTaskQuestions.filter(
  (question) => question.relatedItemId !== itemId,
);
```

Do not remove unassigned questions that only happen to share the same text.

- [ ] **Step 6: Keep deferred questions outside readiness validation**

Do not add deferred questions to `WEEKLY_COACH_DRAFT_FIELDS`, `itemReadiness`, or `validateWeeklyCoachSessionDraft`. Add an assertion that an otherwise complete item remains `可确认` with five deferred questions.

- [ ] **Step 7: Run the draft-service test and observe Green**

Run the same focused Vitest command.

Expected: all tests in `weekly-coach-draft.test.ts` PASS.

- [ ] **Step 8: Commit the draft service**

```bash
git add src/services/weekly-coach-draft.ts tests/unit/services/weekly-coach-draft.test.ts
git commit -m "feat: preserve task questions for later work"
```

## Task 3: Round-trip deferred questions in Chinese weekly records

**Files:**
- Modify: `tests/unit/services/weekly-focus.test.ts`
- Modify: `src/services/weekly-focus.ts`
- Modify: `src/services/weekly-coach-draft.ts`

- [ ] **Step 1: Write failing Chinese serialization and compatibility tests**

Extend the test input:

```ts
focuses: [{
  focus: '验证 StyleWork 产品边界是否能被团队复用。',
  outcome: '形成一页团队共同使用的边界图。',
  whyThisWeek: '本周有两个真实流程可用于验证，延后会继续重复讨论。',
  evidence: '两个流程的负责人都确认采用同一份说明。',
  deferredTaskQuestions: ['定义边界图的内部模板'],
}],
unassignedDeferredTaskQuestions: ['确认后续任务承载位置'],
```

Add assertions:

```ts
expect(data['本周判断']).toEqual([expect.objectContaining({
  进入任务后待思考的问题: ['定义边界图的内部模板'],
})]);
expect(data['其他进入任务后待思考的问题']).toEqual(['确认后续任务承载位置']);
expect(document.raw).toContain('#### 进入任务后待思考的问题');
expect(document.raw).toContain('## 其他进入任务后待思考的问题');

const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');
expect(loaded?.record.input.focuses[0]?.deferredTaskQuestions)
  .toEqual(['定义边界图的内部模板']);
expect(loaded?.record.input.unassignedDeferredTaskQuestions)
  .toEqual(['确认后续任务承载位置']);
```

Add an old-record test that removes both Chinese fields before loading and expects empty arrays.

- [ ] **Step 2: Run the weekly-focus test and observe Red**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/services/weekly-focus.test.ts
```

Expected: FAIL because the formal input and serializer do not know the new fields.

- [ ] **Step 3: Extend and validate formal input types**

Add:

```ts
export interface WeeklyFocusItem {
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
  deferredTaskQuestions: string[];
}

export interface WeeklyFocusInput {
  conversationTopic: string;
  selectedSources: WeeklyCoachSource[];
  currentQuestion: string;
  coachSummary: string;
  focuses: WeeklyFocusItem[];
  noNewFocus: boolean;
  notDoing: string[];
  background: WeeklyFocusBackground;
  coachInsights: string[];
  consideredDirections: string[];
  keyAnswers: string[];
  linkedGoals: string[];
  linkedTasks: string[];
  adjustmentNote: string;
  unassignedDeferredTaskQuestions: string[];
}
```

Update input normalization so each new list uses `stringList`, is capped by existing list limits, and defaults to `[]` only when parsing an older persisted record. Direct API input must provide both fields, allowing TypeScript to expose missed call sites.

- [ ] **Step 4: Render Chinese YAML and managed Markdown**

Extend `visibleFocus`:

```ts
进入任务后待思考的问题: focus.deferredTaskQuestions,
```

Extend `renderFocuses` after completion evidence:

```ts
const deferred = focus.deferredTaskQuestions.length === 0
  ? ''
  : [
      '',
      '#### 进入任务后待思考的问题',
      '',
      bulletList(focus.deferredTaskQuestions),
    ].join('\n');
```

Add the top-level YAML key and managed-body section:

```ts
其他进入任务后待思考的问题: input.unassignedDeferredTaskQuestions,
```

Render the separate Markdown section only when the list is non-empty.

- [ ] **Step 5: Parse old and new records**

In `recordFromRaw`, read nested `进入任务后待思考的问题` and top-level `其他进入任务后待思考的问题`; when either property is absent use `[]`, but reject a present non-array or oversized value.

- [ ] **Step 6: Convert session questions to formal input**

Update `weeklyCoachDraftToFocusInput`:

```ts
focuses: safeDraft.items.map((item) => ({
  focus: item.focus,
  outcome: item.outcome,
  whyThisWeek: item.whyThisWeek,
  evidence: item.evidence,
  deferredTaskQuestions: safeDraft.deferredTaskQuestions
    .filter((question) => question.relatedItemId === item.id)
    .map((question) => question.question),
})),
unassignedDeferredTaskQuestions: safeDraft.deferredTaskQuestions
  .filter((question) => question.relatedItemId === null)
  .map((question) => question.question),
```

Preserve existing values from `baseInput` only through the restored session draft; do not silently re-add a question the user deleted.

- [ ] **Step 7: Run service tests and observe Green**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/services/weekly-focus.test.ts tests/unit/services/weekly-coach-draft.test.ts
```

Expected: both files PASS.

- [ ] **Step 8: Commit the formal-record support**

```bash
git add src/services/weekly-focus.ts src/services/weekly-coach-draft.ts tests/unit/services/weekly-focus.test.ts tests/unit/services/weekly-coach-draft.test.ts
git commit -m "feat: write deferred questions to weekly records"
```

## Task 4: Render and edit deferred questions in the Obsidian modal

**Files:**
- Modify: `tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts`
- Modify: `src/obsidian-plugin/weekly-thinking-coach-modal.ts`
- Modify: `src/obsidian-plugin/styles.css`

- [ ] **Step 1: Update modal fixtures for the additive data contract**

Add `deferredTaskQuestions: []` and `nextQuestionDimension: '周级结果'` to the session and coach result fixtures. Add `deferredTaskQuestions: []` to each `WeeklyFocusItem` and `unassignedDeferredTaskQuestions: []` to every `WeeklyFocusInput` fixture in this test file.

- [ ] **Step 2: Write failing render and interaction tests**

Add a coach result containing one linked and one unassigned question, send a turn, and assert:

```ts
expect(modal.contentEl.textContent).toContain(
  '这里只讨论本周是否值得投入和如何取舍；具体方案会记录下来，留到任务中处理。',
);
expect(modal.contentEl.textContent).toContain('进入任务后待思考（1）');
expect(modal.contentEl.textContent).toContain('待关联的任务问题（1）');
expect(modal.contentEl.textContent).not.toContain('创建任务');
expect(modal.contentEl.textContent).not.toContain('交给 AI');
```

Add an edit/delete test:

```ts
const questionInput = modal.contentEl.querySelector<HTMLInputElement>(
  'input[aria-label="编辑进入任务后待思考的问题"]',
)!;
questionInput.value = '确认 Skill 可用标准';
questionInput.dispatchEvent(new Event('input', { bubbles: true }));
modal.contentEl.querySelector<HTMLButtonElement>(
  'button[aria-label="删除进入任务后待思考的问题"]',
)!.click();
expect(savedDrafts.at(-1)?.deferredTaskQuestions).toEqual([]);
```

Assert that five deferred questions do not disable or invalidate confirmation for a complete focus.

- [ ] **Step 3: Run the modal test and observe Red**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts
```

Expected: FAIL because the modal does not pass, merge, or render deferred questions.

- [ ] **Step 4: Thread deferred questions through each coach turn**

Import the three draft service functions. Add cloned deferred state in `cloneSession`. When restoring a formal record in `sessionFromRecord`, create the draft items first, preserve each generated item ID, attach each focus's `deferredTaskQuestions` to that ID, and restore `input.unassignedDeferredTaskQuestions` with `relatedItemId: null`.

Use this shape for the restored data:

```ts
const restoredItems = input.focuses.map((focus) => ({
  item: {
    ...createManualWeeklyCoachDraftItem(createId()),
    ...focus,
    readiness: '可确认' as const,
  },
  questions: focus.deferredTaskQuestions,
}));

items: restoredItems.map(({ item }) => item),
deferredTaskQuestions: [
  ...restoredItems.flatMap(({ item, questions }) => questions.map((question) => ({
    id: createId(),
    relatedItemId: item.id,
    relatedFocus: item.focus,
    question,
  }))),
  ...input.unassignedDeferredTaskQuestions.map((question) => ({
    id: createId(),
    relatedItemId: null,
    relatedFocus: '待关联重点',
    question,
  })),
],
```

In `runCoach`, include:

```ts
deferredTaskQuestions: this.session.deferredTaskQuestions.map((item) => ({ ...item })),
```

After `mergeWeeklyCoachDraftOperations`, apply the model list:

```ts
const withDeferred = mergeWeeklyCoachDeferredTaskQuestions(
  merged.draft,
  result.deferredTaskQuestions,
  { nextId: this.dependencies.createId },
);
this.session = {
  ...withDeferred,
  sessionSummary: result.sessionSummary,
  pendingQuestion: result.nextQuestion ?? '',
  questionReason: result.questionReason ?? '',
  background: {
    facts: [...result.background.facts],
    assumptions: [...result.background.assumptions],
    gaps: [...result.background.gaps],
    sources: [...result.background.sources],
  },
};
```

- [ ] **Step 5: Replace the composer helper with the approved boundary sentence**

Change the helper text to exactly:

```ts
'这里只讨论本周是否值得投入和如何取舍；具体方案会记录下来，留到任务中处理。'
```

- [ ] **Step 6: Render compact editable disclosures**

Add a method that uses native `details` and `summary`, not nested cards:

```ts
private renderDeferredQuestions(
  container: HTMLElement,
  relatedItemId: string | null,
  label: string,
): void {
  const questions = this.session.deferredTaskQuestions.filter(
    (question) => question.relatedItemId === relatedItemId,
  );
  if (questions.length === 0) return;
  const details = container.createEl('details', { cls: 'atl-weekly-coach-deferred' });
  details.createEl('summary', { text: `${label}（${questions.length}）` });
  const list = details.createDiv({ cls: 'atl-weekly-coach-deferred-list' });
  for (const question of questions) {
    const row = list.createDiv({ cls: 'atl-weekly-coach-deferred-row' });
    const input = row.createEl('input', {
      type: 'text',
      attr: { 'aria-label': '编辑进入任务后待思考的问题' },
    });
    input.value = question.question;
    input.addEventListener('input', () => {
      this.session = editWeeklyCoachDeferredTaskQuestion(
        this.session,
        question.id,
        input.value,
      );
      this.changed();
    });
    this.appendIconButton(row, '删除进入任务后待思考的问题', 'trash-2', () => {
      this.session = removeWeeklyCoachDeferredTaskQuestion(this.session, question.id);
      this.changed();
      this.render();
    });
  }
}
```

Call it after the four fields in each draft card with `item.id` and label `进入任务后待思考`. Call it once at the bottom of the draft list with `null` and label `待关联的任务问题`. Render read-only lists for confirmed records.

- [ ] **Step 7: Add restrained styles**

Add selectors that preserve stable layout and Obsidian colors:

```css
.atl-weekly-coach-deferred {
  border-top: 1px solid var(--background-modifier-border);
  margin-top: 8px;
  padding-top: 8px;
}

.atl-weekly-coach-deferred > summary {
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--font-ui-smaller);
  font-weight: 600;
}

.atl-weekly-coach-deferred-list {
  display: grid;
  gap: 6px;
  margin-top: 8px;
}

.atl-weekly-coach-deferred-row {
  align-items: center;
  display: grid;
  gap: 6px;
  grid-template-columns: minmax(0, 1fr) 28px;
}

.atl-weekly-coach-deferred-row input {
  min-width: 0;
  width: 100%;
}
```

Use the existing icon-button dimensions for the delete button; do not add a rounded text button.

- [ ] **Step 8: Run modal and related service tests and observe Green**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts tests/unit/services/weekly-coach-draft.test.ts tests/unit/services/weekly-focus.test.ts
```

Expected: all four files PASS.

- [ ] **Step 9: Commit the modal UI**

```bash
git add src/obsidian-plugin/weekly-thinking-coach-modal.ts src/obsidian-plugin/styles.css tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts
git commit -m "feat: show deferred task questions in weekly coach"
```

## Task 5: Document, verify, review, and release v0.8.3

**Files:**
- Modify: `docs/operations/obsidian-plugin.md`
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `versions.json`

- [ ] **Step 1: Update the Chinese operation guide**

Add a short subsection under the weekly coach instructions:

```markdown
### 本周思考与任务执行的边界

本周思考教练只帮助判断本周是否值得投入、为什么现在做、预期形成什么结果，以及需要放弃或延后什么。具体方案、详细验收标准、执行步骤和任务内部需要调研的问题不会在这里继续追问。

AI 识别到这类问题后，会把它放到对应重点的“进入任务后待思考的问题”。这些问题会随草稿和正式周记录保存，但不会阻止你确认本周重点，也不会自动创建或执行任务。
```

- [ ] **Step 2: Run formatting and static verification**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm lint
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm typecheck
```

Expected: both commands exit 0 with no errors.

- [ ] **Step 3: Run focused and full tests**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test -- tests/unit/obsidian-plugin/weekly-thinking-coach-modal.test.ts tests/unit/obsidian-plugin/weekly-thinking-coach.test.ts tests/unit/services/weekly-coach-draft.test.ts tests/unit/services/weekly-focus.test.ts
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test
```

Expected: focused tests and the complete suite exit 0 with zero failures.

- [ ] **Step 4: Build all deliverables**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm build
```

Expected: server, UI, Obsidian plugin, and runner builds exit 0; `build/obsidian/main.js`, `build/obsidian/manifest.json`, `build/obsidian/styles.css`, and `build/obsidian/atl-runner.mjs` exist.

- [ ] **Step 5: Perform code review**

Review the diff against `docs/superpowers/specs/2026-08-04-weekly-coach-scope-boundary-design.md` and check:

- every state mutation goes through `weekly-coach-draft.ts`;
- existing draft and formal-record migrations default missing lists safely;
- question scope does not rely on a brittle keyword blacklist;
- deferred questions cannot affect readiness;
- no real Vault or personal data appears in tests;
- no task creation or Agent execution path was added;
- UI uses native disclosure and icon actions without nested cards.

Fix all blocking and high-severity findings, rerun affected tests, and commit fixes separately.

- [ ] **Step 6: Prepare v0.8.3 metadata**

Set `0.8.3` in `package.json`, `manifest.json`, and `src/obsidian-plugin/manifest.json`. Add:

```json
"0.8.3": "1.11.4"
```

to `versions.json`, keeping valid JSON and existing history.

- [ ] **Step 7: Commit documentation and release metadata**

```bash
git add docs/operations/obsidian-plugin.md package.json manifest.json src/obsidian-plugin/manifest.json versions.json
git commit -m "chore: prepare v0.8.3 release"
```

- [ ] **Step 8: Re-run release verification after the version commit**

Run:

```bash
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm lint
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm typecheck
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm test
PATH=/Users/linctex/.nvm/versions/node/v24.15.0/bin:$PATH pnpm build
git diff --check origin/main...HEAD
git status --short --branch
```

Expected: every command exits 0 and the worktree is clean.

- [ ] **Step 9: Push and open the governed GitHub change**

Create an Issue describing the boundary bug and acceptance criteria, push `codex/refine-weekly-coach-boundary`, and open a PR linked to the Issue. The PR must include test counts, build evidence, migration behavior, and the explicit statement that no real AI message or user weekly focus was modified during verification.

- [ ] **Step 10: Merge and publish v0.8.3**

After required checks and review pass, merge the PR into `main`, create tag `v0.8.3`, and publish a GitHub Release with `main.js`, `manifest.json`, `styles.css`, and `atl-runner.mjs` from the verified build.

- [ ] **Step 11: Install without overwriting plugin settings**

Back up the installed plugin directory metadata, then replace only:

```text
/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/main.js
/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/manifest.json
/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/styles.css
/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/atl-runner.mjs
```

Do not delete, replace, or rewrite `data.json`.

- [ ] **Step 12: Verify the real Obsidian installation without changing user data**

Confirm installed hashes match the release assets, verify the plugin manifest reports `0.8.3`, and reload Obsidian. Open the existing weekly coach only to verify plugin load, boundary helper text, restored session visibility, and disclosure layout. Do not send a model message, edit deferred questions, confirm a record, or modify the real weekly focus.
