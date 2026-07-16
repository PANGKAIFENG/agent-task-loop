# ATL Obsidian Instant Sync Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add terminal-free Obsidian task capture and immediate AI extraction from 笔记同步助手 while routing daily-review tasks through the same deduplicating ATL capture service.

**Architecture:** Keep TaskNotes optional and add two ATL-owned Obsidian ribbon commands. A read-only source reader produces stable source records, a restricted Claude extractor returns validated candidates, and a capture controller writes selected candidates only through `captureTask`. Cross-channel matching lives in a pure core module and is used by `captureTask`, so real-time capture and the daily-review CLI bridge converge on one task.

**Tech Stack:** TypeScript 5.9, Obsidian Plugin API, Node.js 24 filesystem/crypto/child_process, Zod 4, Vitest 3, Vite 8.

---

## File Structure

**Create:**

- `src/services/task-deduplication.ts` - pure exact, evidence, and soft duplicate classification.
- `src/obsidian-plugin/sync-source-reader.ts` - read-only dated-folder scan, aggregate-note splitting, and stable record fingerprints.
- `src/obsidian-plugin/candidate-extractor.ts` - candidate schema, prompt construction, restricted Claude CLI execution, and response parsing.
- `src/obsidian-plugin/capture-controller.ts` - orchestration for scan, extraction, selection, idempotent capture, and scan-state commits.
- `src/obsidian-plugin/quick-capture-modal.ts` - centered manual task capture form.
- `src/obsidian-plugin/capture-candidates-modal.ts` - centered checkbox review for extracted candidates.
- `tests/unit/services/task-deduplication.test.ts`
- `tests/unit/obsidian-plugin/sync-source-reader.test.ts`
- `tests/unit/obsidian-plugin/candidate-extractor.test.ts`
- `tests/integration/obsidian-plugin/capture-controller.test.ts`
- `tests/unit/obsidian-plugin/capture-state.test.ts`
- `tests/unit/obsidian-plugin/quick-capture-modal.test.ts`
- `tests/unit/obsidian-plugin/capture-candidates-modal.test.ts`

**Modify:**

- `src/services/capture-task.ts` - call shared hard/soft duplicate classifier before task creation.
- `src/obsidian-plugin/settings.ts` - persist normalized capture state without secrets.
- `src/obsidian-plugin/main.ts` - register ribbon icons and command-palette actions, build controllers, guard concurrent scans.
- `src/obsidian-plugin/styles.css` - stable modal dimensions, candidate rows, source excerpt truncation, and responsive behavior.
- `tests/integration/services/capture-task.test.ts` - prove cross-channel order independence and legacy compatibility.
- `tests/unit/obsidian-plugin/settings.test.ts` - prove state migration and fingerprint trimming.
- `tests/integration/cli/core-loop.test.ts` - prove packaged `task capture` uses shared dedupe.
- `src/cli.ts` - accept bounded task-capture JSON from stdin for safe automation bridging.
- `README.md` - user-facing capture and daily-review behavior.
- `docs/operations/obsidian-plugin.md` - installation, ribbon actions, scan behavior, troubleshooting.
- `/Users/linctex/.codex/automations/obsidian/automation.toml` - deploy prompt-only integration after code verification; never commit this machine-specific file.

## Task 1: Cross-Channel Capture Deduplication

**Files:**
- Create: `src/services/task-deduplication.ts`
- Create: `tests/unit/services/task-deduplication.test.ts`
- Modify: `src/services/capture-task.ts`
- Modify: `tests/integration/services/capture-task.test.ts`

- [ ] **Step 1: Write failing pure duplicate-classification tests**

Cover exact `sourceKey`, legacy same-note evidence, same-note but distinct actions, and unrelated same-title tasks:

```ts
expect(classifyTaskDuplicate(input, [existing])).toEqual({
  existingTaskId: existing.taskId,
  possibleDuplicateIds: [],
});

expect(classifyTaskDuplicate({
  ...input,
  title: '整理第二个独立行动',
  sourceQuote: '另一个明确且不同的行动证据',
}, [existing])).toEqual({
  existingTaskId: null,
  possibleDuplicateIds: [],
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/unit/services/task-deduplication.test.ts`

Expected: FAIL because `task-deduplication.ts` does not exist.

- [ ] **Step 3: Implement the pure classifier**

Use normalized NFKC lowercase text, title bigram Jaccard, and quote containment/similarity. Only hard-match when source keys are equal or source notes are equal and both title and quote evidence cross conservative thresholds:

```ts
export interface TaskDuplicateInput {
  title: string;
  sourceKey: string;
  sourceNote: string | null;
  sourceQuote: string | null;
}

export interface TaskDuplicateResult {
  existingTaskId: string | null;
  possibleDuplicateIds: string[];
}

export function classifyTaskDuplicate(
  input: TaskDuplicateInput,
  tasks: readonly Task[],
): TaskDuplicateResult;
```

Hard evidence rule:

```ts
const hardEvidenceMatch = sameSourceNote
  && titleSimilarity >= 0.6
  && (quoteContains || quoteSimilarity >= 0.72);
```

Soft duplicate rule remains title similarity `>= 0.8` when source evidence does not hard-match.

- [ ] **Step 4: Run the pure tests and verify GREEN**

Run: `pnpm vitest run tests/unit/services/task-deduplication.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing `captureTask` order-independence tests**

Create one candidate with `origin=explicit_wechat_todo` and a legacy-derived key, then submit the same source/action with `origin=obsidian_sync`; repeat in reverse order. Assert one stored task in both cases and that the second call returns the first task ID.

- [ ] **Step 6: Run the integration test and verify RED**

Run: `pnpm vitest run tests/integration/services/capture-task.test.ts`

Expected: FAIL because current capture only hard-matches `sourceKey`.

- [ ] **Step 7: Route `captureTask` through the classifier**

Replace local title-only duplicate logic with `classifyTaskDuplicate`. Return the stored task when `existingTaskId` is non-null; otherwise assign the returned soft IDs to `possibleDuplicateIds`. Preserve source-key locking and audit behavior.

- [ ] **Step 8: Run dedupe and capture tests**

Run: `pnpm vitest run tests/unit/services/task-deduplication.test.ts tests/integration/services/capture-task.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit the core slice**

```bash
git add src/services/task-deduplication.ts src/services/capture-task.ts tests/unit/services/task-deduplication.test.ts tests/integration/services/capture-task.test.ts
git commit -m "feat: deduplicate task capture across sources"
```

## Task 2: Persist Safe Capture State

**Files:**
- Modify: `src/obsidian-plugin/settings.ts`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts`
- Create: `tests/unit/obsidian-plugin/capture-state.test.ts`

- [ ] **Step 1: Write failing settings migration tests**

Assert missing state gets defaults, invalid timestamps/fingerprints are dropped, and only the newest 10,000 unique fingerprints survive:

```ts
expect(normalizeSettings({}).capture).toEqual({
  lastSuccessfulScanAt: null,
  reviewedFingerprints: [],
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/unit/obsidian-plugin/settings.test.ts tests/unit/obsidian-plugin/capture-state.test.ts`

Expected: FAIL because capture state is absent.

- [ ] **Step 3: Implement capture-state normalization**

Add:

```ts
export interface CaptureState {
  lastSuccessfulScanAt: string | null;
  reviewedFingerprints: string[];
}

export const MAX_REVIEWED_FINGERPRINTS = 10_000;

export function compactReviewedFingerprints(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => /^[a-f0-9]{64}$/.test(value)))]
    .slice(-MAX_REVIEWED_FINGERPRINTS);
}
```

Add `capture` to `AtlPluginSettings`, `DEFAULT_SETTINGS`, and `normalizeSettings`. Do not add credentials or source content.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm vitest run tests/unit/obsidian-plugin/settings.test.ts tests/unit/obsidian-plugin/capture-state.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/settings.ts tests/unit/obsidian-plugin/settings.test.ts tests/unit/obsidian-plugin/capture-state.test.ts
git commit -m "feat: persist Obsidian capture checkpoints"
```

## Task 3: Read and Fingerprint Sync Sources

**Files:**
- Create: `src/obsidian-plugin/sync-source-reader.ts`
- Create: `tests/unit/obsidian-plugin/sync-source-reader.test.ts`

- [ ] **Step 1: Write failing date-window and source-splitting tests**

Use an injected read-only file interface and synthetic Markdown. Prove first scan selects yesterday/today, later scans start from the saved local date, nested files are excluded, and an aggregate note becomes timestamped records:

```ts
expect(records.map(({ recordedAt }) => recordedAt)).toEqual([
  '2026-07-17T09:15:00+08:00',
  '2026-07-17T11:40:00+08:00',
]);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/obsidian-plugin/sync-source-reader.test.ts`

Expected: FAIL because the reader module is absent.

- [ ] **Step 3: Implement source records and scan plan**

```ts
export interface SyncSourceRecord {
  fingerprint: string;
  sourceDate: string;
  sourceNote: string;
  recordedAt: string | null;
  content: string;
}

export interface SyncSourceReaderFileSystem {
  listMarkdownFiles(relativeDirectory: string): Promise<string[]>;
  read(relativePath: string): Promise<string>;
}

export function sourceDateRange(
  now: Date,
  lastSuccessfulScanAt: string | null,
  timeZone?: string,
): string[];

export async function readSyncSourceRecords(input: {
  fileSystem: SyncSourceReaderFileSystem;
  now: Date;
  lastSuccessfulScanAt: string | null;
}): Promise<{ filesScanned: number; records: SyncSourceRecord[] }>;
```

Hash `relativePath + recordedAt + normalizedContent` with SHA-256. Keep content in memory only.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm vitest run tests/unit/obsidian-plugin/sync-source-reader.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/sync-source-reader.ts tests/unit/obsidian-plugin/sync-source-reader.test.ts
git commit -m "feat: scan Obsidian sync sources incrementally"
```

## Task 4: Extract Candidates Through Restricted Claude CLI

**Files:**
- Create: `src/obsidian-plugin/candidate-extractor.ts`
- Create: `tests/unit/obsidian-plugin/candidate-extractor.test.ts`
- Modify: `src/runner/claude-driver.ts`
- Modify: `tests/unit/runner/claude-driver.test.ts`

- [ ] **Step 1: Write failing schema, prompt, and batching tests**

Assert invalid priorities, unknown source fingerprints, source quotes longer than 300 characters, and non-JSON output are rejected. Assert batches contain no more than 40 records or 60,000 input characters.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/obsidian-plugin/candidate-extractor.test.ts`

Expected: FAIL because the extractor does not exist.

- [ ] **Step 3: Extract a reusable restricted structured-output executor**

Refactor the existing Claude process safety checks without changing research behavior. Export a focused function that accepts prompt, JSON schema, model settings, timeout, and executor dependencies:

```ts
export interface ClaudeStructuredInput<T> {
  prompt: string;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  timeoutMs: number;
}

export interface ClaudeStructuredExecutor {
  execute<T>(input: ClaudeStructuredInput<T>): Promise<T>;
}
```

It must preserve executable identity checks, `--safe-mode`, `--no-session-persistence`, `--permission-mode dontAsk`, `--tools ''`, output limits, temporary HOME cleanup, inherited Claude config, optional model, and optional `ANTHROPIC_BASE_URL`.

- [ ] **Step 4: Implement candidate extraction**

```ts
export interface ExtractedCandidate {
  title: string;
  summary: string;
  priority: Priority;
  sourceRecordFingerprint: string;
  sourceQuote: string;
}

export async function extractTaskCandidates(input: {
  records: readonly SyncSourceRecord[];
  executor: ClaudeStructuredExecutor;
}): Promise<ExtractedCandidate[]>;
```

Prompt rules must exclude pure information, emotions, completed actions, and vague observations; they must not invent project/objective/acceptance criteria.

- [ ] **Step 5: Run extractor and research-driver regressions**

Run: `pnpm vitest run tests/unit/obsidian-plugin/candidate-extractor.test.ts tests/unit/runner/claude-driver.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/obsidian-plugin/candidate-extractor.ts src/runner/claude-driver.ts tests/unit/obsidian-plugin/candidate-extractor.test.ts tests/unit/runner/claude-driver.test.ts
git commit -m "feat: extract task candidates with Claude"
```

## Task 5: Orchestrate Scan, Selection, and Idempotent Capture

**Files:**
- Create: `src/obsidian-plugin/capture-controller.ts`
- Create: `tests/integration/obsidian-plugin/capture-controller.test.ts`

- [ ] **Step 1: Write failing controller integration tests**

Use a temporary Vault, synthetic source reader, fake extractor, and real repositories. Prove:

```ts
const prepared = await controller.scan();
expect(prepared.candidates).toHaveLength(2);

await controller.commit(prepared, [prepared.candidates[0]!.candidateId]);
expect((await context.ctx.tasks.list())).toHaveLength(1);
expect(savedState.reviewedFingerprints).toContain(prepared.candidates[1]!.candidateId);
```

Also prove cancel does not call commit, partial write failure does not advance state, and retry returns the already-created task through shared dedupe.

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/integration/obsidian-plugin/capture-controller.test.ts`

Expected: FAIL because the controller is absent.

- [ ] **Step 3: Implement the controller contract**

```ts
export interface PreparedCapture {
  scanId: string;
  filesScanned: number;
  recordsConsidered: number;
  candidates: CaptureCandidateView[];
  completedAt: string;
}

export class CaptureController {
  scan(): Promise<PreparedCapture>;
  commit(prepared: PreparedCapture, selectedCandidateIds: readonly string[]): Promise<{
    createdTaskIds: string[];
    existingTaskIds: string[];
  }>;
}
```

Map selected candidates to `captureTask` with `origin=obsidian_sync`, source date/note/quote, deterministic source key, candidate summary body, and `autoExecutable=false` inherited from the service.

- [ ] **Step 4: Run and verify GREEN**

Run: `pnpm vitest run tests/integration/obsidian-plugin/capture-controller.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/obsidian-plugin/capture-controller.ts tests/integration/obsidian-plugin/capture-controller.test.ts
git commit -m "feat: coordinate sync candidate capture"
```

## Task 6: Add Manual Quick Capture Modal

**Files:**
- Create: `src/obsidian-plugin/quick-capture-modal.ts`
- Modify: `src/obsidian-plugin/styles.css`
- Create: `tests/unit/obsidian-plugin/quick-capture-modal.test.ts`

- [ ] **Step 1: Write failing form-state tests**

Extract and test a pure form validator in the modal module:

```ts
expect(validateQuickCapture({ title: '   ', body: '', priority: 'normal' }))
  .toEqual({ title: '请输入任务标题' });
expect(toQuickCaptureInput({ title: '调研方案', body: '', priority: 'high' }, now, id))
  .toMatchObject({
    title: '调研方案',
    body: '调研方案',
    origin: 'manual_obsidian',
    priority: 'high',
  });
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/obsidian-plugin/quick-capture-modal.test.ts`

Expected: FAIL because the modal module is absent.

- [ ] **Step 3: Implement centered Obsidian modal**

Use `Modal` and `Setting`. Render title, optional description, priority, inline title error, cancel, and CTA “加入 Inbox”. Submit via an injected callback returning a Promise; disable actions while submitting and preserve input on failure.

- [ ] **Step 4: Add scoped responsive styles**

Use `.atl-quick-capture-modal` with `width: min(600px, calc(100vw - 32px))`, no nested cards, no viewport-scaled fonts, and stable textarea dimensions.

- [ ] **Step 5: Run tests and build plugin**

Run: `pnpm vitest run tests/unit/obsidian-plugin/quick-capture-modal.test.ts && pnpm build:obsidian`

Expected: PASS and `build/obsidian-plugin/main.js` produced.

- [ ] **Step 6: Commit**

```bash
git add src/obsidian-plugin/quick-capture-modal.ts src/obsidian-plugin/styles.css tests/unit/obsidian-plugin/quick-capture-modal.test.ts
git commit -m "feat: add Obsidian quick task capture"
```

## Task 7: Add Candidate Review Modal and Plugin Entrypoints

**Files:**
- Create: `src/obsidian-plugin/capture-candidates-modal.ts`
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `src/obsidian-plugin/styles.css`
- Create: `tests/unit/obsidian-plugin/capture-candidates-modal.test.ts`
- Modify: `tests/integration/obsidian-plugin/confirmation-controller.test.ts`

- [ ] **Step 1: Write failing selection-state tests**

Test all candidates selected initially, stable toggle behavior, selected ID output, empty selection, and submitting state:

```ts
const state = createCandidateSelection(['a', 'b']);
expect(selectedCandidateIds(state)).toEqual(['a', 'b']);
expect(selectedCandidateIds(toggleCandidate(state, 'b'))).toEqual(['a']);
```

- [ ] **Step 2: Run and verify RED**

Run: `pnpm vitest run tests/unit/obsidian-plugin/capture-candidates-modal.test.ts`

Expected: FAIL because the module is absent.

- [ ] **Step 3: Implement candidate review modal**

Render summary counts, one checkbox row per candidate, title, summary, source date, and a 300-character excerpt. Use Obsidian checkbox controls, a stable scroll region, cancel, and CTA “将所选任务加入 Inbox”. Keep the modal open with a readable error when commit fails.

- [ ] **Step 4: Register ATL-owned ribbon icons and commands**

In `onload()` register:

```ts
this.addRibbonIcon('square-pen', 'ATL：新建任务', () => this.openQuickCapture());
this.addRibbonIcon('list-restart', 'ATL：从同步助手获取待办', () => {
  void this.scanSyncAssistant();
});

this.addCommand({
  id: 'quick-capture-task',
  name: '新建任务',
  callback: () => this.openQuickCapture(),
});

this.addCommand({
  id: 'capture-from-sync-assistant',
  name: '从同步助手获取待办',
  callback: () => { void this.scanSyncAssistant(); },
});
```

Both actions must enforce Vault authorization and desktop filesystem support. The scan action must reuse one in-flight Promise, detect/configure Claude from existing settings, and show Notice states for missing directory, no new records, no candidates, success, and failure.

- [ ] **Step 5: Add scoped candidate-list styles**

Use a maximum modal height with a scrollable list, 36px stable checkbox column, `overflow-wrap: anywhere`, and mobile stacking below 560px. Do not style TaskNotes classes.

- [ ] **Step 6: Run plugin-focused tests and build**

Run: `pnpm vitest run tests/unit/obsidian-plugin tests/integration/obsidian-plugin && pnpm typecheck && pnpm build:obsidian`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/obsidian-plugin/capture-candidates-modal.ts src/obsidian-plugin/main.ts src/obsidian-plugin/styles.css tests/unit/obsidian-plugin/capture-candidates-modal.test.ts tests/integration/obsidian-plugin/confirmation-controller.test.ts
git commit -m "feat: add instant sync capture entrypoints"
```

## Task 8: Route Daily Review Through Packaged Capture

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/integration/cli/core-loop.test.ts`
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`
- Deploy-only modify: `/Users/linctex/.codex/automations/obsidian/automation.toml`

- [ ] **Step 1: Add a failing packaged CLI cross-channel regression**

Build the runner, call `atl-runner.mjs task capture --stdin-json` twice with different origin/source keys but matching source note, quote, and action title, then assert `task list --json` returns one task. Also assert invalid JSON and input larger than 1 MiB fail without echoing source content.

- [ ] **Step 2: Run and verify RED if Task 1 does not cover packaged behavior**

Run: `pnpm vitest run tests/integration/cli/core-loop.test.ts`

Expected: FAIL because `--stdin-json` is not implemented.

- [ ] **Step 3: Implement bounded JSON stdin capture**

Add a mutually exclusive `--stdin-json` option to `task capture`. Read at most 1 MiB, parse JSON, pass the same validated fields to `captureTask`, and keep current field flags backward compatible:

```ts
const input = options.stdinJson
  ? await readBoundedJsonInput(process.stdin, 1024 * 1024)
  : options;

const result = await captureTask(ctx, {
  title: requiredString(input.title, 'title'),
  body: requiredString(input.body, 'body'),
  origin: requiredString(input.origin, 'origin'),
  sourceDate: nullableString(input.sourceDate),
  sourceNote: nullableString(input.sourceNote),
  sourceQuote: nullableString(input.sourceQuote),
  sourceKey: requiredString(input.sourceKey, 'sourceKey'),
  priority: priorityValue(input.priority),
});
```

Errors must report a stable usage code and never include input content.

- [ ] **Step 4: Run the CLI regression and verify GREEN**

Run: `pnpm vitest run tests/integration/cli/core-loop.test.ts`

Expected: PASS.

- [ ] **Step 5: Document the user workflow**

README user section must explain:

```markdown
### 随手记录与立即获取

- 点击左侧 ATL 新建按钮，把想法放入 Inbox。
- 点击 ATL 同步按钮，扫描笔记同步助手的新内容并勾选候选。
- 每日复盘与立即扫描共用 ATL 收集服务；同一来源的同一行动不会重复创建。
- 新任务只进入 Inbox，不会自动交给 Agent。
```

Operations docs must include authorization, model readiness, scan windows, cancellation semantics, and error recovery without asking the user to run terminal commands.

- [ ] **Step 6: Update the live daily-review automation in place**

Preserve schedule, model, cwd, review output, source-read-only rules, and the 3-5 candidate cap. Replace direct task-file writes with an instruction to invoke:

```bash
ATL_VAULT_ROOT=/Users/linctex/Documents/ClawVault \
ATL_ALLOW_REAL_WRITES=1 \
node /Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/atl-runner.mjs \
task capture --stdin-json --json < /tmp/atl-daily-candidate.json
```

The automation writes each candidate as UTF-8 JSON to a private temporary file, invokes the static command above, then deletes the temporary file. The prompt must state that command failure is reported and must not fall back to directly writing task Markdown.

- [ ] **Step 7: Verify the persisted automation contract**

Run: `rg -n "rrule|stdin-json|不得.*直接.*任务|ATL_ALLOW_REAL_WRITES" /Users/linctex/.codex/automations/obsidian/automation.toml`

Expected: schedule remains `FREQ=DAILY;INTERVAL=1;BYHOUR=20;BYMINUTE=0`, and the prompt contains the capture bridge and no-fallback rule.

- [ ] **Step 8: Commit repository-owned changes**

```bash
git add src/cli.ts tests/integration/cli/core-loop.test.ts README.md docs/operations/obsidian-plugin.md
git commit -m "docs: connect daily review to ATL capture"
```

## Task 9: Full Verification, Real Installation, CR, and Push

**Files:**
- Verify: all changed files
- Install: `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/`

- [ ] **Step 1: Run complete quality gates**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check origin/main...HEAD
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform a security and privacy review**

Inspect the diff for credentials, unrestricted process environments, source-content logging, direct source writes, path traversal, command injection, unsafe executable resolution, and task writes outside services:

```bash
git diff origin/main...HEAD -- src tests README.md docs
rg -n "API_KEY|AUTH_TOKEN|source.*content|writeFile|appendFile|spawn|exec" src/obsidian-plugin src/services
```

Expected: no credential values, no sync-source writes, no shell interpolation, and all task writes routed through `captureTask`.

- [ ] **Step 3: Install the built plugin without Terminal-facing user steps**

Copy the verified `main.js`, `manifest.json`, `styles.css`, `atl-runner.mjs`, and source maps from `build/obsidian-plugin/` into the existing real plugin directory. Preserve `data.json`.

- [ ] **Step 4: Verify Obsidian UI and read-only scan behavior**

Reload the plugin in Obsidian. Confirm both ribbon tooltips and command-palette entries exist. Open quick capture and cancel without writing. Run sync scan against the real Vault, record source file hashes before/after, and do not commit candidates unless the user has explicitly selected them.

Expected: source hashes unchanged, candidate modal usable, no text overlap at normal window width, and no task becomes Ready automatically.

- [ ] **Step 5: Self-CR the complete branch**

Review `origin/main...HEAD` for correctness, regressions, missing tests, and scope. Fix any P0-P2 finding with a failing regression test and rerun full gates. Record non-blocking P3 improvements as GitHub issues instead of expanding the MVP.

- [ ] **Step 6: Push branch and open a ready PR**

```bash
git push -u origin codex/instant-sync-capture
gh pr create --base main --head codex/instant-sync-capture \
  --title "feat: capture Obsidian tasks from synced notes" \
  --body-file /tmp/atl-instant-sync-capture-pr.md
```

The PR body must include user workflow, architecture boundary, daily-review migration, test evidence, real-Vault read-only verification, and any non-blocking issues.

- [ ] **Step 7: Merge and verify public state when CR and checks pass**

Merge only after the PR is review-clean and required checks pass. Confirm `origin/main` contains the merge and the GitHub repository displays the updated README. Create a patch/minor release only if the repository's release convention requires it for Obsidian installation artifacts.
