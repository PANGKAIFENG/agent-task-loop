# ATL Manual-First Task Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Obsidian task management human-first with configurable TaskNotes statuses, optional AI task clarification, and a lightweight Codex handoff while preserving the existing controlled research runner.

**Architecture:** Markdown remains authoritative. TaskNotes owns visual status configuration and drag interactions; ATL accepts safe custom status values and keeps automatic execution gated by explicit authorization plus readiness. The Obsidian modal performs optional one-turn structured enrichment through the existing Claude executor and can copy a deterministic task context for manual Codex work.

**Tech Stack:** TypeScript, Obsidian Plugin API, TaskNotes Bases, Zod, Claude Code structured executor, Vitest, Vite, pnpm 10, Node.js 24.

---

## File Map

- `src/domain/task.ts`: safe open status type plus existing known ATL statuses.
- `src/domain/transitions.ts`: transitions only for known controlled states.
- `src/storage/markdown-task-repository.ts`: parse and preserve safe custom statuses.
- `src/services/confirm-task.ts`: allow manual Ready promotion while preserving auto-execution admission.
- `src/obsidian-plugin/confirmation-form.ts`: optional project, objective, and criteria normalization.
- `src/obsidian-plugin/confirmation-controller.ts`: create a project only when requested and submit lightweight promotions.
- `src/obsidian-plugin/confirmation-modal.ts`: simple “move to todo” UI and optional AI enrichment interaction.
- `src/obsidian-plugin/task-enrichment.ts`: structured AI prompt, schema, and executor adapter.
- `src/obsidian-plugin/codex-handoff.ts`: deterministic clipboard context.
- `src/obsidian-plugin/task-eligibility.ts`: recognize ATL tasks in Inbox, Active, and Archive.
- `src/obsidian-plugin/main.ts`: file-menu entries, model executor reuse, clipboard and enrichment wiring.
- `src/obsidian-plugin/board-appearance-controller.ts`: raw-status four-column recommended Base preset.
- `src/ui/api.ts`, `src/ui/pages/ProjectBoardPage.tsx`: render unknown/custom statuses in the fallback web board.
- `README.md`, `docs/operations/obsidian-plugin.md`: user-facing manual-first workflow.

### Task 1: Accept Safe Custom Task Statuses

**Files:**
- Modify: `src/domain/task.ts`
- Modify: `src/domain/transitions.ts`
- Modify: `src/storage/markdown-task-repository.ts`
- Modify: `src/ui/api.ts`
- Modify: `src/ui/pages/ProjectBoardPage.tsx`
- Test: `tests/unit/domain/task.test.ts`
- Test: `tests/unit/domain/transitions.test.ts`
- Test: `tests/integration/storage/markdown-repositories.test.ts`
- Test: `tests/unit/ui/app.test.tsx`

- [ ] **Step 1: Write failing status contract tests**

Add tests proving `waiting_external` and `等待回复` parse and round-trip, while empty, control-character, and overlong values fail. Add a UI test proving a custom-status task appears in its own column.

```ts
expect(taskSchema.safeParse({ ...task, status: 'waiting_external' }).success).toBe(true);
expect(taskSchema.safeParse({ ...task, status: '等待回复' }).success).toBe(true);
expect(taskSchema.safeParse({ ...task, status: '' }).success).toBe(false);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm test tests/unit/domain/task.test.ts tests/unit/domain/transitions.test.ts tests/integration/storage/markdown-repositories.test.ts tests/unit/ui/app.test.tsx
```

Expected: failures show the current enum rejects custom values and the web board omits their column.

- [ ] **Step 3: Implement safe open statuses**

Keep the existing constants for controlled behavior, but validate persisted status as a bounded string:

```ts
export const TASK_STATUSES = [
  'inbox', 'ready', 'in_progress', 'review', 'done', 'blocked', 'cancelled',
] as const;
export type ControlledTaskStatus = (typeof TASK_STATUSES)[number];
export type TaskStatus = string;
export const taskStatusSchema = z.string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
```

Use `taskStatusSchema` in `taskSchema` and repository parsing. Unknown statuses remain in Active storage and cannot pass controlled transition or Runner checks. Build the fallback board columns from known columns plus distinct statuses found in loaded tasks.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain src/storage/markdown-task-repository.ts src/ui tests/unit/domain tests/integration/storage/markdown-repositories.test.ts tests/unit/ui/app.test.tsx
git commit -m "feat: support custom task statuses"
```

### Task 2: Make Inbox Promotion Human-First

**Files:**
- Modify: `src/services/confirm-task.ts`
- Modify: `src/obsidian-plugin/confirmation-form.ts`
- Modify: `src/obsidian-plugin/confirmation-controller.ts`
- Modify: `src/obsidian-plugin/confirmation-modal.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Test: `tests/integration/services/confirm-task.test.ts`
- Test: `tests/unit/obsidian-plugin/confirmation-form.test.ts`
- Test: `tests/integration/obsidian-plugin/confirmation-controller.test.ts`

- [ ] **Step 1: Write failing lightweight-promotion tests**

Cover an Inbox task moving to Ready with no project, objective, criteria, permission, or auto authorization. Also prove `autoExecutable: true` still fails without full readiness.

```ts
const promoted = await confirmTask(ctx, taskId, {
  priority: 'normal',
  autoExecutable: false,
});
expect(promoted).toMatchObject({
  status: 'ready', projectId: null, objective: null,
  acceptanceCriteria: [], autoExecutable: false,
});
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm test tests/integration/services/confirm-task.test.ts tests/unit/obsidian-plugin/confirmation-form.test.ts tests/integration/obsidian-plugin/confirmation-controller.test.ts
```

Expected: current required form and readiness gate reject the lightweight request.

- [ ] **Step 3: Implement optional fields and conditional admission**

Change `ConfirmTaskInput` so only priority is required. Normalize a `none` project choice and blank objective/criteria to null/empty. Enforce `readinessErrors()` only when automatic execution is requested:

```ts
if (candidate.autoExecutable) {
  const errors = readinessErrors(candidate);
  if (errors.length > 0) throw new Error(`Task is not ready: ${errors.join('; ')}`);
}
```

The modal primary action becomes “移到待办”; remove the visible automatic-execution toggle, add “暂不选择项目”, and make task details optional.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests pass, including existing complete research confirmation cases.

- [ ] **Step 5: Commit**

```bash
git add src/services/confirm-task.ts src/obsidian-plugin/confirmation-* src/obsidian-plugin/main.ts tests/integration/services/confirm-task.test.ts tests/unit/obsidian-plugin/confirmation-form.test.ts tests/integration/obsidian-plugin/confirmation-controller.test.ts
git commit -m "feat: allow lightweight manual task promotion"
```

### Task 3: Apply a Four-Column Configurable TaskNotes View

**Files:**
- Modify: `src/obsidian-plugin/board-appearance-controller.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Test: `tests/unit/obsidian-plugin/board-appearance-controller.test.ts`

- [ ] **Step 1: Write a failing Base preset test**

Expect the preset to group by raw `status`, pin four raw status values, hide unused extension columns, and remove the hardcoded formula dependency while preserving unrelated views and the original backup.

```ts
expect(parsed.views[0]).toMatchObject({
  groupBy: { property: 'status', direction: 'ASC' },
  pinnedColumns: 'inbox,ready,in_progress,done',
  hideEmptyColumns: true,
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm test tests/unit/obsidian-plugin/board-appearance-controller.test.ts
```

Expected: current preset retains `formula.atlStatus` and seven-state presentation.

- [ ] **Step 3: Implement and label the manual-first preset**

Set `groupBy.property` to `status`, `pinnedColumns` to the four raw values, `columnOrder` to raw status order, and `hideEmptyColumns` to true. Keep safe YAML parsing, one-time backup, and restore unchanged. Update settings text from “ATL 推荐布局” to “人工任务布局”.

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command. Expected: all board appearance tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/board-appearance-controller.ts src/obsidian-plugin/main.ts tests/unit/obsidian-plugin/board-appearance-controller.test.ts
git commit -m "feat: add configurable four-column board preset"
```

### Task 4: Add Optional AI Task Enrichment

**Files:**
- Create: `src/obsidian-plugin/task-enrichment.ts`
- Modify: `src/obsidian-plugin/confirmation-modal.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Test: `tests/unit/obsidian-plugin/task-enrichment.test.ts`

- [ ] **Step 1: Write failing enrichment contract tests**

Test prompt privacy boundaries, structured result normalization, the one-to-five criteria bound, and executor errors passing through without mutating input.

```ts
const result = await enrichTask(executor, {
  title: '评估 AnySearch', body: '判断是否接入 StyleWork',
  userIntent: '给出明确的接入建议', projectNames: ['StyleWork'],
});
expect(result.acceptanceCriteria).toHaveLength(2);
expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
  timeoutMs: 120_000,
}));
```

- [ ] **Step 2: Run the test and verify RED**

```bash
pnpm test tests/unit/obsidian-plugin/task-enrichment.test.ts
```

Expected: module does not exist.

- [ ] **Step 3: Implement the structured adapter**

Define a strict Zod result and use the existing `ClaudeStructuredExecutor`:

```ts
export const taskEnrichmentSchema = z.object({
  objective: z.string().trim().min(1).max(4_000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(2_000)).min(1).max(5),
}).strict();
```

The prompt must explicitly prohibit executing the task or reading files and request concise Chinese output. The modal adds a user-intent textarea, busy state, “AI 帮我整理” button, and editable回填. `main.ts` reuses the existing model configuration and Claude executable detection to create the executor.

- [ ] **Step 4: Run enrichment and existing plugin tests**

```bash
pnpm test tests/unit/obsidian-plugin/task-enrichment.test.ts tests/unit/obsidian-plugin/settings.test.ts tests/integration/obsidian-plugin/confirmation-controller.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/task-enrichment.ts src/obsidian-plugin/confirmation-modal.ts src/obsidian-plugin/main.ts tests/unit/obsidian-plugin/task-enrichment.test.ts
git commit -m "feat: add optional AI task enrichment"
```

### Task 5: Add Manual Codex Handoff

**Files:**
- Create: `src/obsidian-plugin/codex-handoff.ts`
- Modify: `src/obsidian-plugin/task-eligibility.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Test: `tests/unit/obsidian-plugin/codex-handoff.test.ts`
- Test: `tests/unit/obsidian-plugin/task-eligibility.test.ts`

- [ ] **Step 1: Write failing handoff and path tests**

Recognize safe task paths under Inbox, Active, and Archive. Verify copied context contains the absolute task path and structured fields, omits null source paths, and never changes task data.

```ts
expect(isAtlTaskPath('10_Tasks/Active/unassigned/task-example.md')).toBe(true);
expect(formatCodexHandoff(task, '/vault/10_Tasks/Active/unassigned/task-example.md'))
  .toContain('任务文件：/vault/10_Tasks/Active/unassigned/task-example.md');
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm test tests/unit/obsidian-plugin/codex-handoff.test.ts tests/unit/obsidian-plugin/task-eligibility.test.ts
```

Expected: new helpers do not exist and current path helper rejects Active/Archive.

- [ ] **Step 3: Implement deterministic copy action**

Add `isAtlTaskPath()` and make `taskIdFromPath()` accept every safe lifecycle folder. Format a concise Chinese handoff with title, file path, description, project, objective, criteria, status, and source excerpt. Add “复制给 Codex” to the native file menu and use `navigator.clipboard.writeText`; report success/failure through `Notice`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/codex-handoff.ts src/obsidian-plugin/task-eligibility.ts src/obsidian-plugin/main.ts tests/unit/obsidian-plugin/codex-handoff.test.ts tests/unit/obsidian-plugin/task-eligibility.test.ts
git commit -m "feat: copy task context for Codex"
```

### Task 6: User Documentation, Full Verification, and Local Install

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`
- Modify: `package.json` only if the release version is intentionally advanced
- Generated and install: `build/obsidian/*`, current Vault `.obsidian/plugins/agent-task-loop/*`

- [ ] **Step 1: Rewrite the user flow**

Document installation without Terminal, the default four-column workflow, TaskNotes status customization, calendar scheduling, direct manual promotion, optional AI enrichment, Codex copy, and the distinction between “待办” and “可自动执行”. Remove instructions that say project/objective/criteria are mandatory for ordinary tasks.

- [ ] **Step 2: Run static verification**

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

Expected: zero lint/type errors, all tests pass, build exits 0, and no whitespace errors.

- [ ] **Step 3: Install the verified plugin build into the current Vault**

Copy only the built plugin artifacts (`main.js`, `manifest.json`, `styles.css`, `atl-runner.mjs`, and maps when generated) into `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/`, preserving user `data.json`. Reload Obsidian and confirm commands load without console errors.

- [ ] **Step 4: Apply the recommended Base preset through the plugin-safe controller**

Use the verified controller/Obsidian setting action so the existing Base receives the raw-status four-column preset with its `.atl-backup`. Do not directly rewrite TaskNotes plugin settings.

- [ ] **Step 5: Complete independent code review**

Request a reviewer against `origin/main...HEAD`. Fix all Critical and Important findings, rerun the full verification command, and document any deferred non-MVP issue as a GitHub issue only when it has user-visible impact.

- [ ] **Step 6: Commit release documentation and fixes**

```bash
git add README.md docs/operations/obsidian-plugin.md src tests package.json
git commit -m "docs: explain the manual-first Obsidian workflow"
```

- [ ] **Step 7: Push the branch and create a ready Pull Request**

```bash
git push -u origin codex/manual-first-task-management
gh pr create --base main --head codex/manual-first-task-management \
  --title "feat: make Obsidian task management human-first" \
  --body-file /tmp/atl-manual-first-pr.md
```

Expected: GitHub returns a Pull Request URL. Keep the worktree for review follow-up.
