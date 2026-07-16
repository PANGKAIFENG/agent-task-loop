# Plan: Agent Task Loop V0.1 Production Readiness

> Source PRD: `docs/PRD-Agent-Task-Loop-V0.1.md`

## Completion definition

V0.1 is technically ready when the restricted Claude driver passes its live
compatibility check, one disposable-vault task completes through Artifact and
Review, the real vault passes a read-only integrity audit, and the bounded
LaunchAgent is installed with the documented safety configuration. The PRD's
two-week real-task observation remains an operational acceptance period rather
than a reason to add more MVP features.

## Architectural decisions

- **Source of truth**: Obsidian-compatible Markdown under `10_Tasks`; GitHub
  Issues track product work only and never become the personal task database.
- **Admission**: only manually confirmed, complete, `read_only_research` tasks
  with `auto_executable=true` may enter the automatic queue.
- **Execution**: one local Claude Code process runs with safe mode, no session
  persistence, a strict tool allowlist, structured output, a hard timeout and a
  USD budget cap.
- **Scheduling**: macOS LaunchAgent runs hourly from 08:00 through 22:00 in
  `Asia/Shanghai`, with concurrency one and a daily quota.
- **User surfaces**: CLI owns trusted lifecycle mutations; the V0.1 board is a
  local read-only operational view. Board mutations and task-detail editing are
  post-MVP work.
- **Safety**: real-vault writes require both the exact vault root and the
  explicit write flag. Test and smoke runs use disposable data only.

---

## Phase 1: Restricted Runtime Compatibility

**User stories**: Agent can execute a complete read-only research task without
code, configuration or external-message permissions.

### What to build

Upgrade the local Claude Code runtime and prove that its command contract
supports every fail-closed restriction required by the driver.

### Acceptance criteria

- [x] Claude Code is upgraded from the unsupported local release.
- [x] OAuth authentication is available without copying secrets into ATL.
- [x] The canonical executable passes the driver's live compatibility check.

---

## Phase 2: Disposable End-to-End Research

**User stories**: A confirmed Ready task is automatically claimed, researched
and submitted for human review with an auditable Artifact.

### What to build

Run one sanitized public-research task in a disposable vault through the real
Claude driver. Inspect the result and storage state without touching a personal
Vault.

### Acceptance criteria

- [x] The run exits successfully and reports a unique run identifier.
- [x] The task moves from Ready through In Progress to Review, never directly
  to Done.
- [x] The Artifact contains findings, HTTPS evidence with access time,
  uncertainties, recommended actions and acceptance-criterion responses.
- [x] The disposable vault passes the read-only storage doctor afterward.

Checkpoint evidence: a sanitized public-research task completed in a disposable
vault, produced an Artifact, entered Review and left the disposable vault with
a clean doctor result. Human review found weak
acceptance coverage and questionable evidence quality; that remains a tracked
post-MVP hardening item and is why V0.1 never auto-approves research.

---

## Phase 3: Real Vault Readiness Audit

**User stories**: Existing personal tasks remain intact and unsafe or malformed
tasks cannot be silently executed.

### What to build

Run read-only integrity and queue checks against the real vault. Record the
current Inbox, Ready, In Progress, Review and Blocked counts before enabling the
scheduler.

### Acceptance criteria

- [x] The storage doctor reports no integrity errors, or every error is treated
  as an explicit deployment blocker.
- [x] No unexpected In Progress task or executable Ready task is present.
- [x] Real personal content is not copied into repository logs or fixtures.

Checkpoint evidence: the read-only audit found no unexpected In Progress or
executable Ready task and no storage issues. Counts and personal task details
remain local and are intentionally excluded from this repository.

---

## Phase 4: Bounded Local Scheduling

**User stories**: Eligible research tasks are picked up automatically during
the configured daytime window while the user retains manual stop and review.

### What to build

Install the managed local scheduler with canonical Node, Claude and vault paths,
then inspect the installed job without creating a real task solely for testing.

### Acceptance criteria

- [x] The LaunchAgent plist validates and is loaded in the current user domain.
- [x] The job contains no task body, API token or unrelated environment data.
- [x] The schedule is hourly from 08:00 through 22:00, concurrency one, with the
  documented daily limit.
- [x] Status and log locations are documented and independently inspectable.

Checkpoint evidence: the scheduler plist passed validation in a disposable
deployment, contained the expected bounded hourly triggers and daily limit, and
did not include task content or credentials.

---

## Phase 5: Handoff and Observation

**User stories**: The owner can capture, confirm, inspect, stop and review work,
and can tell whether the automated loop remains healthy.

### What to build

Update the operator documentation and deployment blocker, run all repository
quality gates, and push the verified branch. Start the two-week observation
period only when the owner confirms a real Ready task.

### Acceptance criteria

- [x] The obsolete Claude runtime blocker is closed with verification evidence.
- [x] Documentation distinguishes technical readiness from the two-week real
  task observation requirement.
- [x] Typecheck, lint, build and the full test suite pass after documentation
  changes.
- [x] Noncritical UI and hardening items remain tracked as post-MVP Issues.

Final readiness evidence: Issue #6 was closed with the runtime and smoke-test
record; typecheck, lint and build exited successfully; all 325 tests passed.
Research evidence and acceptance coverage hardening is tracked in Issue #20.

## Explicit post-MVP scope

- Board-based capture, confirmation, run, stop, review and task-detail editing.
- Automatic task expansion or completion of vague Inbox items.
- Agent, Skill, squad and multi-agent orchestration management.
- Team collaboration, public SaaS, mobile application and external messaging.
- Existing P2 hardening and visual-polish Issues unless their risk is upgraded
  by new evidence.
