# Calendar Event Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep long TaskNotes calendar titles inside their cards and display concurrent ATL and DingTalk events side by side without overlap.

**Architecture:** Configure TaskNotes' public FullCalendar option through ATL-managed Base files, and add narrowly scoped CSS under ATL's existing theme class. Extend the current board backup/status workflow instead of mutating TaskNotes plugin data or DOM.

**Tech Stack:** TypeScript, YAML, Obsidian Bases, TaskNotes 4.11.1, FullCalendar CSS, Vitest, Vite

---

### Task 1: Configure non-overlapping TaskNotes calendars

**Files:**
- Modify: `tests/unit/obsidian-plugin/unified-calendar-controller.test.ts`
- Modify: `tests/unit/obsidian-plugin/board-appearance-controller.test.ts`
- Modify: `src/obsidian-plugin/unified-calendar-controller.ts`
- Modify: `src/obsidian-plugin/board-appearance-controller.ts`

- [ ] **Step 1: Write failing unified-calendar and board-preset tests**

Extend the unified calendar assertion to inspect the generated calendar view:

```ts
const calendar = parsed.views.find((view) => view.name === '统一日历');
expect(calendar).toMatchObject({
  type: 'tasknotesCalendar',
  options: expect.objectContaining({ slotEventOverlap: false }),
});
```

Extend the board preset test to require:

```ts
expect(parsed.views[1]).toMatchObject({
  type: 'tasknotesCalendar',
  name: '日历',
  options: { slotEventOverlap: false },
});
```

Add one status regression test where the Kanban fields already match the ATL preset but the calendar lacks `slotEventOverlap: false`; assert `applied: false` before applying and `applied: true` afterward. Add one safety test with two supported calendar views named `日历` and `日历视图`; assert rejection and no backup.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
pnpm vitest run tests/unit/obsidian-plugin/unified-calendar-controller.test.ts tests/unit/obsidian-plugin/board-appearance-controller.test.ts
```

Expected: FAIL because generated and updated Base views do not contain `slotEventOverlap: false`, and ambiguous calendar views are not rejected.

- [ ] **Step 3: Add the public TaskNotes calendar option**

In `UNIFIED_CALENDAR_BASE`, add:

```yaml
      slotEventOverlap: false
```

In `board-appearance-controller.ts`, extend parsing to return zero or one supported calendar view. Reject more than one. Add focused helpers that validate/create the calendar `options` record, set `slotEventOverlap = false`, and include that value in preset status. Leave boards with no calendar view unchanged.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused test command. Expected: both files pass with no warnings.

- [ ] **Step 5: Commit the behavior change**

```bash
git add src/obsidian-plugin/unified-calendar-controller.ts src/obsidian-plugin/board-appearance-controller.ts tests/unit/obsidian-plugin/unified-calendar-controller.test.ts tests/unit/obsidian-plugin/board-appearance-controller.test.ts
git commit -m "fix(obsidian): prevent calendar event overlap"
```

### Task 2: Contain long event titles

**Files:**
- Create: `tests/unit/obsidian-plugin/calendar-event-layout-styles.test.ts`
- Modify: `src/obsidian-plugin/styles.css`
- Modify: `src/obsidian-plugin/main.ts`

- [ ] **Step 1: Write a failing stylesheet contract test**

Create a test that reads the source stylesheet and asserts that ATL-scoped time-grid selectors contain `min-width: 0`, `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('calendar event layout styles', () => {
  it('contains long TaskNotes event titles inside ATL themed cards', async () => {
    const css = await readFile(
      new URL('../../../src/obsidian-plugin/styles.css', import.meta.url),
      'utf8',
    );
    expect(css).toContain('body.atl-task-card-theme .tasknotes-plugin .advanced-calendar-view .fc-timegrid-event');
    expect(css).toContain('text-overflow: ellipsis;');
    expect(css).toContain('white-space: nowrap;');
  });
});
```

- [ ] **Step 2: Run the stylesheet test and verify RED**

Run:

```bash
pnpm vitest run tests/unit/obsidian-plugin/calendar-event-layout-styles.test.ts
```

Expected: FAIL because ATL does not yet style TaskNotes time-grid events.

- [ ] **Step 3: Add minimal scoped containment CSS**

Add ATL-themed selectors for `.fc-timegrid-event`, `.fc-event-main`, `.fc-event-main-frame`, `.fc-event-title-container`, and `.fc-event-title`. Constrain all containers with `min-width: 0` and hidden overflow; constrain the title to one line with an ellipsis. Do not change event positioning, pointer events, colors, or TaskNotes files.

Update the existing setting description from only the TaskNotes board to the TaskNotes board and calendar. Do not add a new setting.

- [ ] **Step 4: Run focused tests and build the Obsidian bundle**

```bash
pnpm vitest run tests/unit/obsidian-plugin/calendar-event-layout-styles.test.ts tests/unit/obsidian-plugin/settings.test.ts
pnpm build:obsidian
```

Expected: tests pass and `build/obsidian/styles.css` contains the ATL-scoped calendar selectors.

- [ ] **Step 5: Commit the visual fix**

```bash
git add src/obsidian-plugin/styles.css src/obsidian-plugin/main.ts tests/unit/obsidian-plugin/calendar-event-layout-styles.test.ts
git commit -m "fix(obsidian): contain long calendar titles"
```

### Task 3: Document and version the release

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `src/version.ts`
- Modify: `versions.json`
- Modify: `tests/unit/version.test.ts`
- Modify: `tests/integration/runner/packaged-runner.test.ts`

- [ ] **Step 1: Write failing version expectations**

Change version assertions to `0.5.6` in the version and packaged-runner tests. `0.5.5` was published by the DingTalk automatic completion change while this branch was in progress.

- [ ] **Step 2: Run version tests and verify RED**

```bash
pnpm vitest run tests/unit/version.test.ts tests/integration/runner/packaged-runner.test.ts
```

Expected: FAIL because production metadata still reports `0.5.4`.

- [ ] **Step 3: Update release metadata and user documentation**

Set the package, both manifests, `ATL_VERSION`, and `versions.json` to `0.5.6`. Document that applying the ATL recommended board layout makes concurrent events non-overlapping and long calendar titles compact, while TaskNotes remains an independent plugin.

- [ ] **Step 4: Run version tests and full quality checks**

```bash
pnpm vitest run tests/unit/version.test.ts tests/integration/runner/packaged-runner.test.ts
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: every command exits zero; Vitest reports no failing files or tests.

- [ ] **Step 5: Commit release preparation**

```bash
git add README.md docs/operations/obsidian-plugin.md package.json manifest.json src/obsidian-plugin/manifest.json src/version.ts versions.json tests/unit/version.test.ts tests/integration/runner/packaged-runner.test.ts
git commit -m "chore: prepare v0.5.6 release"
```

### Task 4: Install, visually verify, and publish

**Files:**
- Runtime install: `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/`
- Runtime board: `/Users/linctex/Documents/ClawVault/10_Tasks/Views/任务总看板.base`

- [ ] **Step 1: Install the verified bundle into the local Vault**

Copy the built `main.js`, `styles.css`, `manifest.json`, runner bundle, and source maps to the existing ATL plugin directory without changing TaskNotes files or user task notes.

- [ ] **Step 2: Reload ATL and apply the updated recommended layout**

Use Obsidian's plugin/UI controls to reload ATL and apply the recommended board layout. Confirm the existing `.atl-backup` remains available.

- [ ] **Step 3: Verify the real calendar**

Open the weekly TaskNotes calendar and verify long titles show an ellipsis, concurrent events are side by side, and clicking, dragging, and resizing remain usable. Inspect both an ATL task and an imported DingTalk event.

- [ ] **Step 4: Review and publish**

Run a final independent review over the complete branch, fix all critical or important findings, push `codex/fix-calendar-event-layout`, open a PR linked to issue `#56`, merge after checks, tag `v0.5.6`, and publish the release bundle and concise user-facing release notes.
