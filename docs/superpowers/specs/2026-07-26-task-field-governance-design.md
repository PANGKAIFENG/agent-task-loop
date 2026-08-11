# TaskNotes Task Field Governance Design

## Background

The TaskNotes task editor currently exposes 23 fields. Nine of them add noise to
the user's daily manual task workflow or expose ATL implementation metadata.
The values remain useful to TaskNotes, ATL, deduplication, audit, and future
Agent execution, so this change must hide editor controls without deleting or
renaming persisted Markdown properties.

Agent execution and Codex/Claude session integration are being developed on a
separate branch. This design deliberately leaves those behaviors untouched.

## Confirmed Field Policy

Hide in both TaskNotes task creation and task editing:

| TaskNotes field id | User-facing field | Reason |
| --- | --- | --- |
| `contexts` | Contexts | Not used in the current workflow |
| `tags` | Tags | Optional classification currently adds editing cost |
| `projects` | TaskNotes projects | Duplicates ATL/business project concepts |
| `blocked-by` | Blocked by | Advanced dependency metadata |
| `blocking` | Blocking | Advanced dependency metadata |
| `atl_project_id` | ATL project | Raw implementation field; future UI will replace it |
| `atl_review_state` | Confirmation state | ATL-managed state |
| `atl_task_id` | Task ID | Stable system identifier |
| `atl_review_feedback` | Review feedback | System workflow data, not a daily input |

Keep the remaining fields unchanged. In particular, `atl_auto_executable`,
`atl_origin`, and `atl_artifact_refs` stay available so the parallel Agent
execution work can redesign them without this branch pre-empting its contract.

## Approaches Considered

### A. Ask the user to configure TaskNotes manually

This uses only TaskNotes public UI, but it is hard to reproduce, difficult to
restore, and cannot become a reliable ATL default.

### B. Fork or patch TaskNotes

This gives full UI control but creates a permanent upstream maintenance burden
and violates ATL's existing integration boundary. Rejected.

### C. Apply a reversible TaskNotes runtime preset from ATL

ATL updates only the documented field visibility entries in the live TaskNotes
runtime. It preserves all task files and unrelated TaskNotes settings, records
the previous visibility values in ATL-owned state, and provides a restore
button. This is the selected approach.

## Architecture

Add a focused `TaskNotesFieldGovernanceController` that accepts a structural
TaskNotes runtime adapter: `{ settings: unknown; saveSettings(): Promise<void> }`.
The installed TaskNotes 4.11.1 runtime was confirmed to expose `settings` plus
async `saveSettings()` and `saveSettingsDataOnly()`; the controller uses
`saveSettings()` so TaskNotes owns persistence and save serialization.

The controller validates `modalFieldsConfig.version: 1` and the nine exact
field records, then changes only `visibleInCreation` and `visibleInEdit` to
`false`. It receives an ATL-owned backup-store adapter that loads and persists
the first versioned selective visibility backup. The backup contains only the
nine governed fields, so restoration does not roll back unrelated TaskNotes
settings changed later.

Controller operations are serialized per live runtime. After awaiting first
backup persistence, apply re-reads and revalidates the runtime and fails closed
when governed visibility changed. A failed TaskNotes save conditionally rolls
back only the visibility properties still matching ATL's in-memory mutation.
No ATL code directly reads, writes, renames, links, or otherwise manages
TaskNotes `data.json`.

## User Experience

ATL settings gains a `Task editor fields` row in the existing Task Board
section:

- When TaskNotes is missing, it explains that TaskNotes was not found.
- When the preset is not active, it offers `Apply concise fields`.
- When active, it states that nine low-frequency/system fields are hidden.
- Once a backup exists, it also offers `Restore original fields`.

Applying or restoring shows a notice that Obsidian must be restarted for the
TaskNotes editor to reload its settings. No terminal is required.

## Data and Compatibility

- No Markdown task file is read or written by this feature.
- ATL does not write TaskNotes plugin files directly; TaskNotes persists its own
  live settings through `saveSettings()`.
- No field key, display name, order, type, `enabled` value, or user field
  definition is changed.
- TaskNotes remains independently upgradeable.
- The controller supports `modalFieldsConfig.version: 1`, used by TaskNotes
  4.11.1. Unknown versions are rejected rather than guessed.
- Reapplying is idempotent and does not overwrite the first backup.

## Error Handling

- Missing or malformed TaskNotes runtime, including a missing `saveSettings()`:
  report unavailable or reject the operation without mutation.
- Invalid or unsupported config: show a concise error and do not save.
- Invalid ATL-owned backup: fail closed and do not save.
- Failed `saveSettings()`: conditionally roll back only ATL's in-memory
  visibility mutations and retain the first backup for retry.
- Missing backup during restore: report that there is nothing to restore.

## Testing

Unit tests use in-memory TaskNotes runtime and ATL backup-store fixtures. They
cover status reporting, exact field changes, preservation of unrelated
settings, idempotent first backup, selective restore, malformed runtime
configuration and backup data, save-failure rollback, and overlapping
operations. Plugin settings rendering remains covered by the existing settings
test suite. Final verification runs tests, typecheck, lint, and the production
build before installing the built plugin into ClawVault.

## Acceptance Criteria

1. Applying the preset hides exactly the nine confirmed fields in TaskNotes
   creation and editing.
2. The underlying Markdown properties and existing values remain unchanged.
3. All other TaskNotes field records and settings remain unchanged.
4. A second apply is safe and does not replace the original backup.
5. Restore reinstates the nine previous visibility values while preserving
   unrelated TaskNotes settings changed after apply.
6. The feature is operated entirely from Obsidian settings and communicates the
   restart requirement.
7. Unsupported runtime configurations, invalid backups, and failed saves fail
   closed without direct TaskNotes-file writes.

## Out of Scope

- Agent provider selection, execution rules, workspace mapping, and session ids.
- Redesigning the source and artifact fields.
- Changing TaskNotes card layout, calendar layout, or task statuses.
- Deleting, renaming, or migrating task frontmatter properties.
