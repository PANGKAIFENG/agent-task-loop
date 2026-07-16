# Agent Task Loop V0.2 Model Service Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Obsidian-only switch between inheriting Claude Code configuration and applying an ATL-specific Model and Base URL without storing credentials.

**Architecture:** Keep validation and migration in the pure settings module, pass validated optional overrides through the background controller, and serialize them in the managed LaunchAgent. The Obsidian adapter only renders and saves fields; Claude Code remains responsible for credentials and provider execution.

**Tech Stack:** TypeScript 5.9, Obsidian API, Vitest 3, macOS launchd, Claude Code CLI.

---

### Task 1: Model Service Settings And Validation

**Files:**
- Modify: `src/obsidian-plugin/settings.ts`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts`

- [ ] **Step 1: Write failing normalization and validation tests**

```ts
expect(normalizeSettings({ allowVaultManagement: true }).background)
  .toMatchObject({ modelServiceMode: 'inherit', baseUrl: '' });

expect(modelServiceConfiguration({
  modelServiceMode: 'custom',
  model: 'glm-4-flash',
  baseUrl: 'https://api.example.com/anthropic/',
})).toEqual({
  valid: true,
  model: 'glm-4-flash',
  baseUrl: 'https://api.example.com/anthropic/',
});

expect(modelServiceConfiguration({
  modelServiceMode: 'custom',
  model: 'bad model',
  baseUrl: 'https://user:secret@example.com?token=x',
}).valid).toBe(false);
```

- [ ] **Step 2: Run the settings test and verify RED**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts`

Expected: FAIL because `modelServiceMode`, `baseUrl`, and `modelServiceConfiguration` do not exist.

- [ ] **Step 3: Implement pure model and URL validation**

```ts
export type ModelServiceMode = 'inherit' | 'custom';

export function modelServiceConfiguration(input: Pick<BackgroundSettings,
  'modelServiceMode' | 'model' | 'baseUrl'>): ModelServiceConfiguration {
  if (input.modelServiceMode === 'inherit') {
    return { valid: true, model: undefined, baseUrl: undefined };
  }
  const model = validModel(input.model) ? input.model : undefined;
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  return { valid: model !== undefined && baseUrl !== undefined, model, baseUrl };
}
```

Default new and legacy settings to `inherit`. Accept only `http` and `https` URLs without credentials, query, or fragment.

- [ ] **Step 4: Run the settings tests and typecheck**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts && pnpm typecheck`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the settings slice**

```bash
git add src/obsidian-plugin/settings.ts tests/unit/obsidian-plugin/settings.test.ts
git commit -m "feat: add model service settings"
```

### Task 2: Optional LaunchAgent Overrides

**Files:**
- Modify: `src/scheduler/launch-agent.ts`
- Modify: `tests/unit/scheduler/launch-agent.test.ts`

- [ ] **Step 1: Write failing scheduler tests for inherit and custom modes**

```ts
const inherited = await renderLaunchAgent({
  ...options,
  environment: environmentWithoutModelOrBaseUrl,
});
expect(inherited.environmentVariables).not.toHaveProperty('ATL_CLAUDE_MODEL');
expect(inherited.environmentVariables).not.toHaveProperty('ANTHROPIC_BASE_URL');

const custom = await renderLaunchAgent({
  ...options,
  environment: {
    ...environmentWithoutModelOrBaseUrl,
    ATL_CLAUDE_MODEL: 'glm-4-flash',
    ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
  },
});
expect(custom.environmentVariables).toMatchObject({
  ATL_CLAUDE_MODEL: 'glm-4-flash',
  ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
});
expect(custom.plist).not.toContain('ANTHROPIC_AUTH_TOKEN');
expect(custom.plist).not.toContain('ANTHROPIC_API_KEY');
```

- [ ] **Step 2: Run the scheduler test and verify RED**

Run: `pnpm test tests/unit/scheduler/launch-agent.test.ts`

Expected: FAIL because `ATL_CLAUDE_MODEL` is required and Base URL is discarded.

- [ ] **Step 3: Implement optional validated override serialization**

```ts
function optionalModelName(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!MODEL_PATTERN.test(value)) throw new LaunchAgentError('ATL_CLAUDE_MODEL must be a valid model name');
  return value;
}

function optionalBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
    || parsed.search || parsed.hash || !parsed.hostname) {
    throw new LaunchAgentError('ANTHROPIC_BASE_URL must be a safe http or https URL');
  }
  return value;
}
```

Build `environmentVariables` with conditional spreads so omitted values never appear in the plist.

- [ ] **Step 4: Run scheduler and driver regressions**

Run: `pnpm test tests/unit/scheduler/launch-agent.test.ts tests/unit/runner/claude-driver.test.ts`

Expected: PASS with no secrets in snapshots or output.

- [ ] **Step 5: Commit the scheduler slice**

```bash
git add src/scheduler/launch-agent.ts tests/unit/scheduler/launch-agent.test.ts
git commit -m "feat: pass optional Claude endpoint overrides"
```

### Task 3: Background Controller Configuration Flow

**Files:**
- Modify: `src/obsidian-plugin/background-runtime-controller.ts`
- Modify: `tests/unit/obsidian-plugin/background-runtime-controller.test.ts`

- [ ] **Step 1: Write failing controller tests for both modes**

```ts
await controller.enable({ ...settings, modelServiceMode: 'inherit', baseUrl: '' });
expect(deps.installScheduler).toHaveBeenCalledWith(expect.objectContaining({
  environment: expect.not.objectContaining({
    ATL_CLAUDE_MODEL: expect.anything(),
    ANTHROPIC_BASE_URL: expect.anything(),
  }),
}));

await controller.enable({
  ...settings,
  modelServiceMode: 'custom',
  model: 'glm-4-flash',
  baseUrl: 'https://api.example.com/anthropic',
});
expect(deps.installScheduler).toHaveBeenCalledWith(expect.objectContaining({
  environment: expect.objectContaining({
    ATL_CLAUDE_MODEL: 'glm-4-flash',
    ANTHROPIC_BASE_URL: 'https://api.example.com/anthropic',
  }),
}));
```

- [ ] **Step 2: Run the controller test and verify RED**

Run: `pnpm test tests/unit/obsidian-plugin/background-runtime-controller.test.ts`

Expected: FAIL because mode and Base URL do not affect scheduler configuration.

- [ ] **Step 3: Validate before installing and conditionally build environment**

```ts
const service = modelServiceConfiguration(settings);
if (!service.valid) {
  throw new BackgroundRuntimeError('模型服务配置无效，请检查 Model 和 Base URL。');
}
const environment = {
  ...fixedEnvironment,
  ...(service.model === undefined ? {} : { ATL_CLAUDE_MODEL: service.model }),
  ...(service.baseUrl === undefined ? {} : { ANTHROPIC_BASE_URL: service.baseUrl }),
};
```

- [ ] **Step 4: Run controller, scheduler, and type tests**

Run: `pnpm test tests/unit/obsidian-plugin/background-runtime-controller.test.ts tests/unit/scheduler/launch-agent.test.ts && pnpm typecheck`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the controller slice**

```bash
git add src/obsidian-plugin/background-runtime-controller.ts tests/unit/obsidian-plugin/background-runtime-controller.test.ts
git commit -m "feat: configure background model service"
```

### Task 4: Obsidian Settings Interaction And User Documentation

**Files:**
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`
- Modify: `tests/unit/obsidian-plugin/settings.test.ts`

- [ ] **Step 1: Add a failing pure UI-state test**

```ts
expect(modelServiceFieldState({
  modelServiceMode: 'inherit', model: '', baseUrl: '',
})).toEqual({ showCustomFields: false, canApply: true });
expect(modelServiceFieldState({
  modelServiceMode: 'custom', model: '', baseUrl: 'notaurl',
})).toEqual({ showCustomFields: true, canApply: false });
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts`

Expected: FAIL because `modelServiceFieldState` does not exist.

- [ ] **Step 3: Render mode, Model, Base URL, and disclosure controls**

```ts
new Setting(containerEl)
  .setName('模型服务')
  .setDesc('沿用 Claude Code 当前配置，或为 ATL 单独指定服务。')
  .addDropdown((dropdown) => dropdown
    .addOption('inherit', '沿用 Claude Code 当前配置')
    .addOption('custom', '自定义服务')
    .setValue(settings.modelServiceMode)
    .onChange(async (value) => saveMode(value)));
```

Custom fields save on change, never accept API keys, and show the data-transfer disclosure. Disable `启用后台执行` or `更新后台配置` while custom fields are invalid.

- [ ] **Step 4: Update README and operations documentation**

Document the no-terminal flow, inherit mode, custom Model/Base URL mode, the explicit update button, and the credential boundary in user language.

- [ ] **Step 5: Run focused tests and build the plugin**

Run: `pnpm test tests/unit/obsidian-plugin/settings.test.ts && pnpm typecheck && pnpm build:obsidian`

Expected: PASS and `build/obsidian/{main.js,styles.css,manifest.json}` exist.

- [ ] **Step 6: Commit the UI and documentation slice**

```bash
git add src/obsidian-plugin/main.ts src/obsidian-plugin/settings.ts tests/unit/obsidian-plugin/settings.test.ts README.md docs/operations/obsidian-plugin.md
git commit -m "feat: add Obsidian model service controls"
```

### Task 5: Install, Verify, And Publish V0.2.0

**Files:**
- Generated: `build/obsidian/main.js`
- Generated: `build/obsidian/styles.css`
- Generated: `build/obsidian/manifest.json`
- Generated: `build/obsidian/atl-runner.mjs`
- Install to: `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/`

- [ ] **Step 1: Run all automated quality gates from a clean source tree**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Expected: every command exits 0.

- [ ] **Step 2: Inspect release contents and secret patterns**

Run: `find build/obsidian -maxdepth 1 -type f -print | sort`

Expected: exactly `main.js`, `styles.css`, `manifest.json`, and `atl-runner.mjs` plus no credential values in tracked files or release artifacts.

- [ ] **Step 3: Install the four release files into the real Vault**

Copy only the built plugin files after confirming `ATL_ALLOW_REAL_WRITES=1` for this explicit real-Vault operation. Preserve the existing `data.json` and normalize it through the plugin on reload.

- [ ] **Step 4: Reload and verify the Obsidian UI**

Confirm the dropdown, conditional custom fields, disclosure, environment checks, compact TaskNotes board, and existing candidate count. Keep the mode at `inherit` unless the user explicitly selects a custom ATL override.

- [ ] **Step 5: Update the managed LaunchAgent and run one bounded check**

Confirm the plist runner is `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop/atl-runner.mjs`, omitted override keys in inherit mode, no credential keys, and one successful no-op or eligible Ready research run. Verify no Inbox candidate is promoted or moved.

- [ ] **Step 6: Push, create and merge the PR, tag, and verify the release**

Push `codex/background-setup-and-board-cards`, open a ready PR, merge after checks pass, create tag `v0.2.0`, and verify the GitHub Release exposes the four direct files and release ZIP.
