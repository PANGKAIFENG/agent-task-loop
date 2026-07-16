# Agent Task Loop V0.2 Background Setup And Board Cards Design

## Goal

Make the existing ATL research runner usable from Obsidian without asking the user to open Terminal, and make TaskNotes task cards match the concise ATL board prototype closely enough for daily scanning.

The release remains a macOS desktop MVP. It manages ATL itself but does not download, install, or authenticate third-party runtimes. Node.js and Claude Code must already exist on the machine; the plugin detects them and explains any missing prerequisite in product language.

## Product Boundary

### Included

- Detect the current Vault, Node.js, Claude Code, Claude login state, the packaged ATL runner, and the managed macOS LaunchAgent.
- Configure allowed local source directories without editing environment variables.
- Install or update the managed LaunchAgent from Obsidian.
- Trigger one bounded runner attempt from Obsidian and show the resulting health state.
- Remove the managed LaunchAgent from Obsidian.
- Apply an ATL task-card theme to TaskNotes cards.
- Apply a recommended field preset to `10_Tasks/Views/任务总看板.base` after explicit confirmation.
- Preserve the original Base file so the user can restore it.

### Excluded

- Downloading or installing Node.js, Claude Code, or model credentials.
- Supporting Windows, Linux, mobile Obsidian, or remote runners.
- Replacing TaskNotes, forking TaskNotes, or calling TaskNotes private APIs.
- A general scheduler editor, multi-agent orchestration, or automatic task expansion.
- Automatic completion of Review tasks.

## Architecture

The Obsidian plugin gains two bounded adapters.

`BackgroundRuntimeController` is responsible for detection and lifecycle actions. It builds an explicit runtime configuration from the local Vault and saved settings, delegates LaunchAgent writes to the existing scheduler service, and invokes only fixed ATL/Claude commands. It never writes task domain state directly.

`BoardAppearanceController` is responsible for the visual preset. Theme enablement is represented by a class on `document.body`. The Base preset is applied through YAML parsing and serialization, not string replacement. Before the first change, the controller writes one adjacent ATL backup and never overwrites that backup. Restore replaces the managed Base file from that backup.

The release gains a standalone `atl-runner.mjs` bundle. The LaunchAgent points to this packaged file rather than to a Git checkout, so users do not need a cloned repository or `pnpm install`. Node.js and Claude Code remain external prerequisites.

## Settings Experience

The existing `Agent Task Loop` settings page is divided into three sections.

### Vault Access

The current authorization toggle remains unchanged. Background installation is disabled until Vault management is allowed.

### Background Execution

The section shows one summary state:

- `未配置`: a required executable or runner bundle is missing.
- `待安装`: prerequisites are healthy but the managed LaunchAgent is absent.
- `已就绪`: the managed LaunchAgent is installed and configuration matches.
- `配置异常`: a conflicting or unreadable LaunchAgent exists, Claude is logged out, or a stored path is invalid.
- `正在执行`: the LaunchAgent process is active during a manual run.

Below the summary, four compact checks show ATL Runner, Node.js, Claude Code, and Claude login. Missing checks include a short recovery message. Paths remain hidden by default and are shown only in an expandable technical-details area.

The user can select allowed source folders with a native macOS folder picker. The Vault itself is always available for task storage but is not automatically added as a broad research source.

Available actions are context-dependent:

- `检测环境`: read-only refresh.
- `启用后台执行`: install or update the managed LaunchAgent.
- `立即试跑`: invoke one bounded scheduled run through `launchctl kickstart`; it does not force an ineligible task to execute.
- `停用后台执行`: remove only a LaunchAgent whose label is managed by ATL.

All actions show an Obsidian Notice and refresh the visible state. Failures use stable Chinese messages and preserve the previous scheduler file when installation cannot complete.

## Runtime Detection And Configuration

Detection is deterministic and does not execute user-provided shell text.

Node.js candidates are checked in this order:

1. The previously saved absolute executable path.
2. The executable resolved by `/usr/bin/which node` with the plugin process environment.
3. Common absolute paths under Homebrew, Volta, fnm, and nvm.

Only an absolute, existing, executable file that returns a supported Node.js major version is accepted.

Claude candidates use the same saved-path-first rule, followed by `/usr/bin/which claude` and common package-manager locations. The selected binary must return valid JSON from `claude auth status`; `loggedIn: true` is required for an `已就绪` state.

The scheduler receives an explicit environment containing the Vault root, Claude executable, Claude config directory, selected source roots, daily limit, model, and write authorization. Secrets are not stored in the Vault, plugin settings, plist, or logs.

The packaged runner uses the current fixed schedule already supported by ATL: hourly attempts between 08:00 and 22:00 in `Asia/Shanghai`. Empty queues are successful no-op runs.

## Board Appearance

The ATL task-card theme is enabled by default for TaskNotes cards and can be disabled from settings. It uses TaskNotes' stable public CSS class names only and never queries or mutates card DOM nodes.

The target card contains:

- A two-line maximum task title with strong but compact typography.
- A second line containing confirmation state and source date.
- The existing TaskNotes context menu.
- A four-pixel priority accent on the left.
- A quiet border, small shadow, and six-pixel radius.

The recommended Base preset changes only the `任务总看板` view:

- Card order becomes `review_state`, then `source_date`.
- `file.name`, property labels, Agent authorization, project, and priority are removed from the visible card body.
- Column width becomes `320`.
- Compact layout, column order, grouping, filters, and sort remain intact.

This preset does not change task Markdown or status values. Dragging a task between columns continues to be handled by TaskNotes.

## Safety And Recovery

- Scheduler lifecycle code keeps its managed-label checks and atomic file replacement.
- The plugin never uninstalls or overwrites a LaunchAgent with a different label.
- The runner bundle path must remain inside the ATL plugin installation directory.
- Allowed source roots must be absolute existing directories and are canonicalized before persistence.
- The Base preset requires Vault authorization and an explicit button click.
- The first Base change creates `任务总看板.base.atl-backup`; later applications preserve that original backup.
- Restore is available only when the backup exists.
- No tests may read or write the real ClawVault.

## Release And Compatibility

Version `0.2.0` ships `main.js`, `styles.css`, `manifest.json`, and `atl-runner.mjs`. The release ZIP contains all four files. The README installation flow remains Finder plus Obsidian and no longer requires a cloned developer repository for ATL background execution.

The feature supports macOS desktop Obsidian only. Users missing Node.js or Claude Code can still use collection, confirmation, and the visual board; background execution remains visibly unavailable until prerequisites are installed and authenticated.

## Acceptance Criteria

1. A clean plugin package can detect the current Vault, a valid Node.js executable, Claude Code, and Claude login without opening Terminal.
2. From Obsidian settings, a user can install a managed LaunchAgent that points at the packaged runner rather than the repository checkout.
3. `立即试跑` can process one eligible Ready research task through the existing bounded runner and leave its result in Review, or report that no eligible task exists.
4. Scheduler conflicts, missing prerequisites, invalid source roots, and logged-out Claude states are shown without corrupting the previous scheduler configuration.
5. The recommended Base preset makes cards show only title, review state, and source date while retaining TaskNotes drag and menu behavior.
6. The priority accent, border, spacing, and typography visually match the approved ATL prototype direction in both light and dark themes.
7. The original Base file can be restored from the ATL backup.
8. The release workflow publishes the runner bundle and all automated quality gates pass.
