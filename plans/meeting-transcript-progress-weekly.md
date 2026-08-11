# Plan: 会议听记到工作进展周报自动化

> Source PRD: `/Users/linctex/Documents/Codex/会议听记工作进展周报自动化-PRD/PRD.md` V0.1, Round 2 `Ready with assumptions`

## Architectural decisions

- **Runtime boundary**: V1 is single-user and local-first. The ATL Runner and Obsidian plugin own orchestration; no new hosted account or service is introduced.
- **Source ownership**: `TaskNotes/DingTalk` remains read-only. Qianwen is read through a visible, logged-in, read-only connector; credentials and raw transcripts never enter Git or tests.
- **State separation**: connector health and each recording's transcription lifecycle are independent state machines. A successful scan can coexist with recordings that are still transcribing or failed.
- **Storage**: confirmed meeting evidence lives in `08_Meetings`; progress items and weekly snapshots live in `09_Progress/Items` and `09_Progress/Weekly`; durable manual decisions live in `09_Progress/Decisions`.
- **Matching**: automatic association requires at least two independent strong signals and no decisive contradiction. Date, temporal proximity, compatible duration, and generic topic words are weak signals and cannot independently authorize a write.
- **Scheduling**: the daily Qianwen scan targets 22:00 `Asia/Shanghai`. When that run is missed, the next Runner startup backfills that local date at most once.
- **Mutation boundary**: all persisted domain-state changes go through services. Agent runs may create evidence and artifacts but may not directly mutate task state.
- **Outbound boundary**: material requests, formal publication, and automatic outbound messages are disabled by default. DingTalk V1 only sends a minimal notification to the user with a fixed Obsidian navigation instruction and a title that exactly matches the local acceptance object.
- **Versioning**: weekly reports are immutable snapshots. Rejection creates a new weekly version; source progress changes only through an explicit action that creates a new progress version.
- **Safety**: tests use synthetic temporary fixtures. Real Vault writes require both `ATL_VAULT_ROOT` and `ATL_ALLOW_REAL_WRITES=1` and remain disabled until the release gate.

## Mandatory preflight gates

- [ ] Connector health and per-recording transcription states are represented and tested separately before source ingestion is considered complete.
- [ ] Missed-run catch-up is proven idempotent by local date before enabling the daily schedule.
- [x] The 2026-08-11 real-client preflight found that DingTalk does not expose `obsidian://`, `127.0.0.1`, or `localhost` as executable links. V1 uses a verified product fallback: notify and locate by `Obsidian -> ATL：工作沉淀 -> 待验收`, with an exact title match. Clickable deep links are deferred.

---

## Phase 1: Trusted Qianwen acquisition

**User stories**: PRD 4.0 - daily/manual source acquisition, login recovery, incomplete-transcription retry, idempotent recording updates.

### What to build

Deliver one complete local path that takes a read-only connector result, validates and versions normalized recordings, exposes connector health separately from individual recording status, and runs once for a due local date. A missed 22:00 run is backfilled once on the next Runner startup without treating source failure as an empty result.

### Acceptance criteria

- [ ] Connector results distinguish connected, login-required, incompatible, network-failed, and genuinely empty scans.
- [ ] Recordings independently distinguish waiting, available, and failed transcription states.
- [ ] The same recording ID and version are idempotent; changed source content creates a new local version without duplicating meeting evidence.
- [ ] A missed local-date run is backfilled once and remains once after restart or retry.
- [ ] No Qianwen password, real transcript, or personal fixture is persisted in tests or Git.

---

## Phase 2: Conservative calendar matching and meeting evidence

**User stories**: PRD 4.1 and 4.2 - calendar occurrence states, delayed recordings, conflict handling, user-confirmed or no-calendar outcomes.

### What to build

Deliver a complete path from normalized recordings and read-only DingTalk events to either safe meeting evidence, an explicit conflict queue, or a no-match state. The UI explains supporting, opposing, and missing evidence and never converts a lone high score based on weak signals into an automatic write.

### Acceptance criteria

- [ ] Historical false-positive fixtures with one time-window/keyword candidate remain pending confirmation.
- [ ] Automatic association requires two independent strong signals and no decisive contradiction.
- [ ] One recording cannot be assigned to multiple calendar occurrences.
- [ ] User confirmation and no-corresponding-calendar decisions are durable and reversible.
- [ ] Confirmed evidence is idempotently written under `08_Meetings`; DingTalk mirrors remain byte-for-byte unchanged.

---

## Phase 3: Evidence-backed progress items

**User stories**: PRD 4.3 - split multi-topic meetings, associate project/task/artifact context, produce reportable changes without manufacturing task completion.

### What to build

Deliver a complete path from meeting evidence and explicitly linked work artifacts to versioned progress items. Each topic has one primary reporting owner, separates facts/inference/pending items, records contribution attribution, and produces an `eligible`, `ineligible`, or `needs_confirmation` weekly decision.

### Acceptance criteria

- [ ] One meeting can become multiple independently reviewable topics without creating tasks.
- [ ] Each progress item has exactly one primary reporting owner and traceable sources.
- [ ] Numbers require an openable source; unsupported numbers are removed or marked pending.
- [ ] Attendance, discussion, planning, and routine checks alone are ineligible.
- [ ] Task/project state change, confirmed decision, updated artifact, or impactful blocker can make an item eligible when base traceability conditions pass.
- [ ] Contribution defaults to team; self and Agent attribution require direct evidence.

---

## Phase 4: Material-gap recovery

**User stories**: PRD 4.4 - search existing context, show source coverage, draft a controlled request, retain degraded reporting when facts stay unavailable.

### What to build

Deliver one complete material-gap flow that records what was searched, attaches a verified hit when available, or creates a reviewable message draft when no readable source is found. V1 stops before sending unless the user explicitly authorizes that exact message.

### Acceptance criteria

- [ ] Search attempts, hits, permission failures, and timestamps are visible and traceable.
- [ ] Unreadable content is not treated as nonexistent and no number is inferred from it.
- [ ] Suggested contacts are evidence-based and the complete outbound text is shown before authorization.
- [ ] Draft-only is the default; no automatic send, retry, or group message occurs.
- [ ] A missing material can remain an explicit blocker while other progress items continue.

---

## Phase 5: Versioned weekly report and Obsidian acceptance

**User stories**: PRD 4.5 - project-oriented weekly draft, partial success, evidence coverage, accept/reject/later, independent publication state.

### What to build

Deliver a complete weekly-report path that selects eligible progress versions for a local week, renders project-oriented summaries, preserves partial success, and supports Obsidian acceptance. Rejection creates a new weekly version and never silently rewrites source progress.

### Acceptance criteria

- [ ] Only eligible progress versions enter the weekly snapshot.
- [ ] Report sections emphasize change, conclusion, artifact, blocker, and next step according to work type.
- [ ] A missing project source produces partial success instead of blocking complete sections.
- [ ] Accept, reject, later, and publish are distinct states and actions.
- [ ] Rejecting creates a new weekly version; source progress changes only after explicit synchronization.
- [ ] Every statement can open or locate its evidence.

---

## Phase 6: DingTalk acceptance notification and release

**User stories**: PRD 1 and 4.5 - notify the user when an Artifact or weekly version is ready, locate the unique same-titled Obsidian object, preserve local acceptance when notification fails.

### What to build

After the real-client preflight selects the fallback, deliver a minimal-disclosure DingTalk notification for each Artifact or weekly version. The notification tells the user exactly where to find the same-titled object in Obsidian and has no acceptance callback; delivery is idempotent and its failure never changes the local artifact or report state.

### Acceptance criteria

- [x] Real DingTalk preflight evidence records that custom-scheme and loopback links are not executable, and the approved V1 fallback is explicit.
- [ ] The notification contains only title, state, pending-count, and the fixed navigation instruction `Obsidian -> ATL：工作沉淀 -> 待验收`.
- [ ] Before delivery, the title exactly matches one and only one object in the current visible `待验收` collection; zero or multiple matches block delivery and surface a local location-conflict error.
- [ ] The adapter accepts only the configured user's own DingTalk target and rejects group chats or any other recipient without fallback.
- [ ] The same version sends once; the idempotency key is object type + object ID + version, retry reuses that key, and the final result is recorded.
- [ ] Notification failure leaves the local object available for acceptance and visibly reports the failure.
- [ ] Negative payload tests prove that `obsidian://`, loopback URLs, filesystem paths, local tokens, transcripts, customer text, contracts, payments, and sensitive numbers cannot be serialized.
- [ ] The adapter has no acceptance callback and cannot change acceptance or publication state.
- [ ] Before release, a synthetic notification is delivered to the user's own real client and manually verified to locate exactly one same-titled local object through the fixed navigation instruction.
- [ ] Build, typecheck, lint, focused tests, full regression, security scan, package consistency, and independent CR pass before release.
