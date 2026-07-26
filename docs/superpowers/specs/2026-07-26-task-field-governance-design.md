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

### C. Apply a reversible TaskNotes data preset from ATL

ATL updates only the documented field visibility entries in TaskNotes'
`modalFieldsConfig`. It preserves all task files and unrelated TaskNotes
settings, records the previous visibility values, and provides a restore
button. This is the selected approach.

## Architecture

Add a focused `TaskNotesFieldGovernanceController` owned by the ATL Obsidian
adapter. It reads `.obsidian/plugins/tasknotes/data.json`, validates the
supported version and the nine exact field records, and changes only
`visibleInCreation` and `visibleInEdit` to `false`.

Before the first write, the controller stores the previous visibility values in
`.obsidian/plugins/agent-task-loop/tasknotes-field-layout-backup.json`. The
backup contains only the nine governed fields, so restoration does not roll
back unrelated TaskNotes settings changed later.

All writes are atomic. Symlinks, paths outside the current Vault, malformed
JSON, unsupported modal configuration versions, duplicate field ids, missing
fields, or non-boolean visibility values fail closed without changing either
file.

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
- No field key, display name, order, type, `enabled` value, or user field
  definition is changed.
- TaskNotes remains independently upgradeable.
- The controller supports `modalFieldsConfig.version: 1`, used by TaskNotes
  4.11.1. Unknown versions are rejected rather than guessed.
- Reapplying is idempotent and does not overwrite the first backup.

## Error Handling

- Missing TaskNotes data: report unavailable; do not create a synthetic config.
- Invalid or unsupported config: show a concise error and do not write.
- Unsafe file or backup path: reject the operation.
- Failed atomic write: keep the original data file and report failure.
- Missing backup during restore: report that there is nothing to restore.

## Testing

Unit tests use temporary Vault fixtures and cover status reporting, exact field
changes, preservation of unrelated settings, idempotent backup, selective
restore, malformed configuration, duplicate/missing fields, and symlink escape
rejection. Plugin settings rendering remains covered by the existing settings
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
7. Unsupported or unsafe configurations fail without partial writes.

## Out of Scope

- Agent provider selection, execution rules, workspace mapping, and session ids.
- Redesigning the source and artifact fields.
- Changing TaskNotes card layout, calendar layout, or task statuses.
- Deleting, renaming, or migrating task frontmatter properties.
