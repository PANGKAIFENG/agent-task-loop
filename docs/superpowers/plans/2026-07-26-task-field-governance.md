# TaskNotes Task Field Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reversible ATL settings action that hides the nine confirmed low-frequency or system fields from TaskNotes creation and editing without changing task data.

**Architecture:** A standalone controller validates and mutates TaskNotes'
live `modalFieldsConfig` through its verified runtime `settings` plus
`saveSettings()` API. A selective visibility backup belongs to ATL state through
an injected backup-store adapter. The existing ATL settings tab will later read
controller status and expose apply/restore actions with restart feedback.

**Tech Stack:** TypeScript, Obsidian Plugin API, TaskNotes runtime API, JSON,
Vitest, Vite, pnpm 10, Node.js 24.

---

## File Map

- `src/obsidian-plugin/tasknotes-field-governance-controller.ts`: validate, inspect, apply, back up, and restore TaskNotes field visibility.
- `tests/unit/obsidian-plugin/tasknotes-field-governance-controller.test.ts`: in-memory runtime, backup-store, save-failure, and serialization tests.
- `src/obsidian-plugin/main.ts`: controller ownership, settings status, apply/restore buttons, and notices.
- `tests/unit/obsidian-plugin/settings.test.ts`: settings source assertions for the new user-facing controls.
- `docs/operations/obsidian-plugin.md`: user instructions and exact governed field list.

### Task 1: Implement the Reversible Field Preset

**Files:**
- Create: `src/obsidian-plugin/tasknotes-field-governance-controller.ts`
- Create: `tests/unit/obsidian-plugin/tasknotes-field-governance-controller.test.ts`

- [ ] **Step 1: Write the failing behavior tests**

Create live runtime fixtures containing all nine governed ids plus one retained
field, and an ATL-owned backup-store fixture. Assert that `applyPreset()`
changes only each governed field's
`visibleInCreation/visibleInEdit`, preserves `enabled`, user fields and unrelated
settings, and writes a selective backup.

```ts
expect(governed.fields.find(({ id }) => id === 'tags')).toMatchObject({
  visibleInCreation: false,
  visibleInEdit: false,
  enabled: true,
});
expect(governed.fields.find(({ id }) => id === 'atl_origin')).toEqual(
  original.fields.find(({ id }) => id === 'atl_origin'),
);
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  pnpm test tests/unit/obsidian-plugin/tasknotes-field-governance-controller.test.ts
```

Expected: the test fails because the runtime-controller API is not implemented.

- [ ] **Step 3: Implement runtime validation and TaskNotes-owned persistence**

Export the exact governed ids, runtime/backup-store contracts, versioned backup
type, status type, error class, and controller. Require one record for every
governed id and boolean visibility values. Persist the first selective backup
through ATL before mutating the runtime, then call TaskNotes `saveSettings()`.
Re-read and validate after backup-store awaits, serialize operations, and
conditionally roll back in-memory visibility mutations after a failed save.

```ts
export const GOVERNED_TASKNOTES_FIELD_IDS = [
  'contexts', 'tags', 'projects', 'blocked-by', 'blocking',
  'atl_project_id', 'atl_review_state', 'atl_task_id',
  'atl_review_feedback',
] as const;
```

- [ ] **Step 4: Add restore and runtime safety tests**

Cover selective restore after an unrelated setting changes, reapply without
backup replacement, missing/duplicate fields, unsupported version, invalid
visibility data, missing/malformed runtime or backup, failed saves, and
overlapping controller operations. Do not add TaskNotes file or symlink tests;
the controller does not access plugin files.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all controller tests pass.

- [ ] **Step 6: Commit the controller**

```bash
git add src/obsidian-plugin/tasknotes-field-governance-controller.ts \
  tests/unit/obsidian-plugin/tasknotes-field-governance-controller.test.ts
git commit -m "feat: add reversible TaskNotes field preset"
```

### Task 2: Expose the Preset in Obsidian Settings

**Files:**
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts`

- [ ] **Step 1: Write failing settings source tests**

Assert that the settings source presents `Task editor fields`,
`Apply concise fields`, `Restore original fields`, and calls the controller
through dedicated methods.

```ts
expect(source).toContain(".setName('任务编辑字段')");
expect(source).toContain(".setButtonText('应用精简字段')");
expect(source).toContain(".setButtonText('恢复原字段')");
```

- [ ] **Step 2: Run settings tests and verify RED**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  pnpm test tests/unit/obsidian-plugin/settings.test.ts
```

Expected: assertions fail because the controls are absent.

- [ ] **Step 3: Wire controller status and actions**

Add a controller property to `AgentTaskLoopPlugin`, load its status with board
status, render the field row in `renderBoard()`, and add guarded apply/restore
methods. Both successful actions show `重启 Obsidian 后生效` and refresh status.

- [ ] **Step 4: Run focused plugin tests and verify GREEN**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" \
  pnpm test tests/unit/obsidian-plugin/settings.test.ts \
  tests/unit/obsidian-plugin/board-appearance-controller.test.ts \
  tests/unit/obsidian-plugin/tasknotes-field-governance-controller.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Commit the settings integration**

```bash
git add src/obsidian-plugin/main.ts tests/unit/obsidian-plugin/settings.test.ts
git commit -m "feat: manage TaskNotes editor fields from ATL"
```

### Task 3: Document and Verify the User Workflow

**Files:**
- Modify: `docs/operations/obsidian-plugin.md`

- [ ] **Step 1: Add the no-terminal operation guide**

Document `设置 -> Agent Task Loop -> 任务看板 -> 任务编辑字段`, list the nine
hidden fields, explain that task data is preserved, describe restore, and state
that Obsidian must be restarted after either action.

- [ ] **Step 2: Run full verification**

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm typecheck
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm lint
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm build
```

Expected: every command exits 0.

- [ ] **Step 3: Install in ClawVault and verify files**

After preserving the installed ATL bundle, copy the built `main.js`,
`manifest.json`, `styles.css`, and `atl-runner.mjs` into
`ClawVault/.obsidian/plugins/agent-task-loop/`. Use the settings action to apply
the preset, restart Obsidian, and verify the TaskNotes editor no longer renders
the nine governed fields while `atl_origin`, `atl_auto_executable`, and
`atl_artifact_refs` remain.

- [ ] **Step 4: Commit documentation**

```bash
git add docs/operations/obsidian-plugin.md
git commit -m "docs: explain TaskNotes field governance"
```

- [ ] **Step 5: Request independent code review**

Review the complete diff from `origin/main` through `HEAD` for data loss,
cross-plugin compatibility, unsafe path handling, missing tests, and scope creep.
Fix every critical or important finding and rerun the full verification commands.
