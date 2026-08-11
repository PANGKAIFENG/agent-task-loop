# TaskNotes 编辑弹窗智能完善入口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 TaskNotes 编辑任务弹窗左下角增加“智能完善”入口，并确保未保存字段先由 TaskNotes 原生保存，再打开 ATL 任务完善弹窗。

**Architecture:** 新增一个只依赖公开 DOM 的 `TaskNotesTaskBriefActionBridge`，通过特征检测识别 TaskNotes 编辑弹窗、注入幂等按钮，并以弹窗关闭作为原生保存成功信号。主插件只负责注入 Vault 任务路径、图标、通知和既有 `openTaskBrief(path)` 回调；Bridge 不读取 TaskNotes runtime、不写 Markdown、不修改 TaskNotes 配置。

**Tech Stack:** TypeScript、Obsidian Plugin API、DOM `MutationObserver`、Vitest、jsdom、Vite、pnpm / Node 24

---

### Task 1: 实现可测试的 TaskNotes 弹窗 Bridge

**Files:**
- Create: `src/obsidian-plugin/tasknotes-task-brief-action-bridge.ts`
- Create: `tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

- [x] **Step 1: 写入注入行为的失败测试**

构造带 `.minimalist-task-modal`、`.tn-task-modal__button-bar`、`.tn-task-modal__open-note-button` 的编辑弹窗，断言 `start()` 后在“打开笔记”前插入唯一的 `[data-atl-task-brief-action]` 按钮；再次触发 DOM 变化仍只有一个按钮。另构造缺少“打开笔记”的创建弹窗与普通 Obsidian 弹窗，断言不注入。

- [x] **Step 2: 运行目标测试并确认 RED**

Run: `fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

Expected: FAIL，因为 `tasknotes-task-brief-action-bridge.ts` 尚不存在。

- [x] **Step 3: 实现最小注入生命周期**

定义以下依赖边界，并实现 `start()`、弹窗扫描和 `stop()`：

```ts
export interface TaskNotesTaskBriefActionBridgeDependencies {
  document: Document;
  getEligibleTaskPaths(): string[];
  open(path: string): void;
  notice(message: string): void;
  setIcon(element: HTMLElement, icon: string): void;
  saveTimeoutMs?: number;
}

export class TaskNotesTaskBriefActionBridge {
  start(): void;
  stop(): void;
}
```

`start()` 观察 `document.body` 的 `childList/subtree` 变化并扫描已有弹窗；只有按钮栏和“打开笔记”同时存在时才注入。按钮使用 `data-atl-task-brief-action` 保证幂等，`stop()` 断开观察器并移除全部 ATL 注入按钮。

- [x] **Step 4: 运行目标测试并确认 GREEN**

Run: `fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

Expected: 新增的注入、创建态跳过、普通弹窗跳过和幂等测试全部 PASS。

- [x] **Step 5: 写入保存切换与失败保护的失败测试**

新增测试覆盖：

```ts
it('saves the uniquely matched task before opening ATL');
it('disables the action while TaskNotes is saving');
it('fails closed when no eligible path or multiple paths match');
it('restores the action and reports when saving times out');
it('cancels pending waits and removes actions on stop');
```

唯一匹配用完整 Vault 相对路径出现在弹窗文本中表示；零匹配、多匹配、缺少 `.mod-cta` 保存按钮时均断言不点击保存、不打开 ATL，并保留 TaskNotes 弹窗。

- [x] **Step 6: 运行目标测试并确认 RED**

Run: `fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

Expected: FAIL，因为点击处理、路径解析和等待关闭尚未实现。

- [x] **Step 7: 实现先保存后打开和 fail-closed 清理**

点击时读取当前 modal 的可见文本，在 `getEligibleTaskPaths()` 返回值中筛选完整路径包含匹配，只有一个匹配才继续。按钮进入 disabled / `正在保存...` 状态，点击当前 modal 内的 `button.mod-cta`，用独立 `MutationObserver` 等待该 modal 与 DOM 断开；关闭后清理等待资源并调用 `open(path)`。超时恢复按钮为 `智能完善` 并提示 `任务尚未保存，请检查当前字段后重试`；无法唯一识别时提示 `无法识别当前任务，请使用文件菜单中的智能完善任务`。所有 pending observer/timer 都登记到 Bridge，由 `stop()` 统一清理。

- [x] **Step 8: 运行目标测试并确认 GREEN**

Run: `fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

Expected: 目标文件全部 PASS，且没有未处理异常或定时器泄漏。

### Task 2: 接入 ATL 插件生命周期并保持既有入口

**Files:**
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `src/obsidian-plugin/styles.css`
- Test: `tests/unit/obsidian-plugin/task-brief-plugin-lifecycle.test.ts`
- Test: `tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts`

- [x] **Step 1: 写入插件接线契约的失败测试**

在 Bridge 单测中补充导出属性/文案/图标契约，确保按钮是非 CTA 的次级按钮、图标为 `sparkles`、文案为 `智能完善`、位置位于 `.tn-task-modal__open-note-button` 之前。既有 `TaskBriefPluginLifecycle` 测试继续断言命令面板和文件菜单入口存在。

- [x] **Step 2: 运行相关测试并确认 RED**

Run: `fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts tests/unit/obsidian-plugin/task-brief-plugin-lifecycle.test.ts`

Expected: 新增的样式/图标契约测试 FAIL，既有入口测试 PASS。

- [x] **Step 3: 在主插件中启动并注册 Bridge**

从 Obsidian 导入 `setIcon`，导入新 Bridge。在 `onload()` 中确认已启用的插件 registry 可取得 `tasknotes` 后创建 Bridge：

```ts
const bridge = new TaskNotesTaskBriefActionBridge({
  document,
  getEligibleTaskPaths: () => this.app.vault.getMarkdownFiles()
    .filter((file) => isAtlTaskPath(file.path) || isTaskNotesTaskPath(
      file.path,
      this.app.metadataCache.getFileCache(file)?.frontmatter,
    ))
    .map((file) => file.path),
  open: (path) => { void this.openTaskBrief(path); },
  notice: (message) => { new Notice(message); },
  setIcon,
});
bridge.start();
this.register(() => bridge.stop());
```

不要移除 `TaskBriefPluginLifecycle`，不要访问 TaskNotes runtime 私有方法。

- [x] **Step 4: 添加局部样式**

只对 `[data-atl-task-brief-action]` 设置原生按钮所需的 inline-flex、图标尺寸和间距；不使用 `.mod-cta`，不固定按钮栏宽度，允许窄窗口自然换行。

- [x] **Step 5: 运行相关测试、typecheck 和 lint 并确认 GREEN**

Run:

```bash
fnm exec --using 24 pnpm exec vitest run tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts tests/unit/obsidian-plugin/task-brief-plugin-lifecycle.test.ts
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
```

Expected: 命令均退出 0。

### Task 3: 全量验证、代码审查与真实 Obsidian 冒烟

**Files:**
- Modify only if review finds material defects in the files above
- Verify: `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop`
- Verify unchanged: `/Users/linctex/Documents/ClawVault/.obsidian/plugins/tasknotes`

- [x] **Step 1: 执行完整自动化验证**

Run:

```bash
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm build
```

Expected: 全部退出 0，无失败测试、类型错误、lint 错误或构建错误。

- [x] **Step 2: 执行代码审查并修复重要问题**

以 `origin/main` 到当前 HEAD 的 diff 对照设计逐项审查：DOM 契约、路径误匹配、重复点击、保存超时、卸载清理、多弹窗独立性、TaskNotes 所有权边界。Critical / Important 发现必须修复并补回归测试；不影响 MVP 的 Minor 记录为 GitHub issue。

- [x] **Step 3: 重新执行完整自动化验证**

Run:

```bash
fnm exec --using 24 pnpm test
fnm exec --using 24 pnpm typecheck
fnm exec --using 24 pnpm lint
fnm exec --using 24 pnpm build
```

Expected: 全部退出 0。

- [x] **Step 4: 安装构建产物并保护 TaskNotes**

先记录 TaskNotes 插件目录文件清单与 hash，再将 ATL `build/obsidian/main.js`、`src/obsidian-plugin/manifest.json`、`src/obsidian-plugin/styles.css` 安装到 `/Users/linctex/Documents/ClawVault/.obsidian/plugins/agent-task-loop`。安装后再次核对 TaskNotes hash 完全不变。

- [x] **Step 5: 真实 Obsidian 冒烟验证**

完全退出并重启 Obsidian，在一个测试用 TaskNotes 任务的编辑弹窗验证：按钮位于“打开笔记”前；修改一个可恢复字段后点击“智能完善”；TaskNotes 保存并关闭后 ATL 弹窗打开正确任务；取消 ATL 后返回原页面；创建任务弹窗无该按钮。验证后恢复测试字段，不改 DingTalk 源文件。

### Task 4: 提交、PR、合并与发布

**Files:**
- Modify: `package.json`
- Modify: `manifest.json`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `src/version.ts`
- Modify: `versions.json`
- Modify: version assertions in existing tests when required by repository release convention

- [x] **Step 1: 提交功能实现**

Run:

```bash
git add docs/superpowers/plans/2026-07-26-tasknotes-modal-smart-action.md src/obsidian-plugin/tasknotes-task-brief-action-bridge.ts src/obsidian-plugin/main.ts src/obsidian-plugin/styles.css tests/unit/obsidian-plugin/tasknotes-task-brief-action-bridge.test.ts tests/unit/obsidian-plugin/task-brief-plugin-lifecycle.test.ts
git commit -m "feat: add smart action to TaskNotes task modal"
```

- [x] **Step 2: 推送功能分支并创建 PR**

Run:

```bash
git push -u origin codex/tasknotes-modal-smart-action
gh pr create --base main --head codex/tasknotes-modal-smart-action --title "feat: add smart action to TaskNotes task modal" --body-file <generated-pr-body>
```

- [ ] **Step 3: 合并 PR 并按仓库惯例发布补丁版本**

合并前确认分支包含最新 `origin/main`；合并后在新的发布分支同步 package、两个 manifest、`src/version.ts`、`versions.json` 与版本测试，执行完整验证，创建并合并发布 PR，打签名/普通 annotated tag（遵循仓库现有方式）并等待 GitHub Release workflow 成功。

- [ ] **Step 4: 安装最终发布产物并复验**

下载或使用与 release tag 同 commit 构建的插件产物覆盖本地 ATL 插件，核对版本号、文件 hash、TaskNotes 目录未变化，并重复“智能完善”真实弹窗冒烟。
