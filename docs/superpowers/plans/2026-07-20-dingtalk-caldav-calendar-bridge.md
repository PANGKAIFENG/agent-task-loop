# DingTalk CalDAV Calendar Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read the DingTalk primary calendar into editable TaskNotes files without ever writing back to DingTalk or adding imported events to ATL's execution queue.

**Architecture:** The Obsidian adapter stores non-secret configuration and the remote snapshot ledger in plugin settings while keeping the password in Obsidian `SecretStorage`, with a read-only macOS Keychain migration fallback. A read-only CalDAV client returns synthetic-friendly calendar resources, `ical.js` expands them into stable occurrences, and a merge service applies only changed remote-owned fields to TaskNotes Markdown under `TaskNotes/DingTalk/`.

**Tech Stack:** TypeScript 5.9, Obsidian API, `tsdav`, `ical.js`, YAML, Vitest, Vite, pnpm 10, Node.js 24.

---

## File Map

- Create `src/obsidian-plugin/dingtalk-calendar-types.ts`: shared remote event, ledger, result, and dependency contracts.
- Create `src/obsidian-plugin/dingtalk-credential-store.ts`: Obsidian `SecretStorage` and legacy macOS Keychain migration boundary.
- Create `src/obsidian-plugin/dingtalk-caldav-client.ts`: read-only CalDAV discovery and calendar-object fetches; no write method is exposed.
- Create `src/obsidian-plugin/dingtalk-calendar-parser.ts`: ICS parsing, recurrence expansion, time-zone normalization, identity, and snapshot hashing.
- Create `src/obsidian-plugin/dingtalk-calendar-merge.ts`: three-way field decisions based on the previous remote snapshot.
- Create `src/obsidian-plugin/dingtalk-calendar-writer.ts`: TaskNotes Markdown rendering, managed-region replacement, moved-file lookup, tombstones, and Vault writes.
- Create `src/obsidian-plugin/dingtalk-calendar-controller.ts`: connection test, single-flight sync, safe ledger advancement, cancellation, and result summaries.
- Modify `src/obsidian-plugin/settings.ts`: normalized non-secret CalDAV configuration and ledger migration.
- Modify `src/obsidian-plugin/main.ts`: command, load/interval lifecycle, settings controls, notices, and credential wiring.
- Modify `src/obsidian-plugin/styles.css`: compact calendar status and warning styles.
- Modify `src/obsidian-plugin/manifest.json`: require Obsidian 1.11.4 for `SecretStorage`.
- Modify `package.json` and `pnpm-lock.yaml`: add `tsdav` and `ical.js`.
- Modify `README.md` and `docs/operations/obsidian-plugin.md`: user-facing setup, one-way ownership rules, local dragging, and recovery.
- Create matching tests under `tests/unit/obsidian-plugin/` and `tests/integration/obsidian-plugin/`; all fixtures are synthetic and temporary.

### Task 1: Persist Safe Calendar Configuration and Credentials

**Files:**
- Create: `src/obsidian-plugin/dingtalk-calendar-types.ts`
- Create: `src/obsidian-plugin/dingtalk-credential-store.ts`
- Modify: `src/obsidian-plugin/settings.ts`
- Test: `tests/unit/obsidian-plugin/dingtalk-credential-store.test.ts`
- Test: `tests/unit/obsidian-plugin/settings.test.ts`

- [ ] **Step 1: Write failing settings and credential tests**

Add tests that require valid defaults, reject non-HTTPS remote URLs, discard secrets from legacy `data.json`, preserve a bounded ledger, prefer `SecretStorage`, migrate a legacy Keychain password once, and never return a password from serialized settings.

```ts
it('normalizes DingTalk state without retaining persisted passwords', () => {
  const settings = normalizeSettings({ dingtalkCalendar: {
    enabled: true,
    serverUrl: 'https://calendar.dingtalk.com/caldav',
    username: 'user@example.com',
    password: 'must-not-survive',
    events: {},
  } });
  expect(settings.dingtalkCalendar.password).toBeUndefined();
  expect(settings.dingtalkCalendar.serverUrl).toBe(
    'https://calendar.dingtalk.com/caldav',
  );
});

it('migrates the legacy keychain password into SecretStorage', async () => {
  const secrets = new Map<string, string>();
  const store = createDingTalkCredentialStore({
    secretStorage: mapSecretStorage(secrets),
    readLegacyKeychain: async () => 'legacy-secret',
  });
  await expect(store.getPassword()).resolves.toBe('legacy-secret');
  expect(secrets.get('agent-task-loop-dingtalk-caldav')).toBe('legacy-secret');
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/unit/obsidian-plugin/settings.test.ts tests/unit/obsidian-plugin/dingtalk-credential-store.test.ts
```

Expected: FAIL because `dingtalkCalendar` and `createDingTalkCredentialStore` do not exist.

- [ ] **Step 3: Implement the minimal contracts, normalizer, and credential store**

Define the persisted state without a password field:

```ts
export interface DingTalkCalendarSettings {
  stateVersion: 1;
  enabled: boolean;
  serverUrl: string;
  username: string;
  calendarId: 'primary';
  syncWindowDays: 90;
  intervalMinutes: 15;
  syncToken: string | null;
  lastSuccessfulSyncAt: string | null;
  lastResult: DingTalkSyncResult | null;
  lastError: string | null;
  events: Record<string, DingTalkEventLedgerEntry>;
}
```

Expose only `getPassword`, `setPassword`, and `clearPassword`. Implement the fallback using injected `readLegacyKeychain`; production wiring uses `execFile('security', ['find-generic-password', '-w', '-s', 'ai.agent-task-loop.dingtalk-caldav', '-a', 'default'])`. Do not interpolate shell strings and do not log stdout, stderr, username, or password.

- [ ] **Step 4: Run tests and confirm GREEN**

Run the Task 1 command again. Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/obsidian-plugin/dingtalk-calendar-types.ts src/obsidian-plugin/dingtalk-credential-store.ts src/obsidian-plugin/settings.ts tests/unit/obsidian-plugin/dingtalk-credential-store.test.ts tests/unit/obsidian-plugin/settings.test.ts
git commit -m "feat: add secure DingTalk calendar settings"
```

### Task 2: Add a Strictly Read-Only CalDAV Boundary

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/obsidian-plugin/dingtalk-caldav-client.ts`
- Test: `tests/unit/obsidian-plugin/dingtalk-caldav-client.test.ts`

- [ ] **Step 1: Add dependencies**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm add tsdav@2.3.1 ical.js@2.2.1
```

Expected: `package.json` and `pnpm-lock.yaml` contain only these runtime dependency additions.

- [ ] **Step 2: Write failing client tests**

Require HTTPS, Basic credentials, primary-calendar selection, bounded time-range queries, and read-only methods. Assert every captured HTTP method is `PROPFIND` or `REPORT` and that the public client has no `create`, `update`, `delete`, `PUT`, or `DELETE` capability.

```ts
const client = createReadOnlyDingTalkCalDavClient({
  transport: captureTransport(responses),
});
await client.fetchPrimaryCalendar(input);
expect(requests.every(({ method }) => ['PROPFIND', 'REPORT'].includes(method)))
  .toBe(true);
expect('deleteCalendarObject' in client).toBe(false);
```

- [ ] **Step 3: Run the test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/unit/obsidian-plugin/dingtalk-caldav-client.test.ts
```

Expected: FAIL because the read-only client module does not exist.

- [ ] **Step 4: Implement the read-only adapter**

Expose this narrow surface only:

```ts
export interface ReadOnlyDingTalkCalDavClient {
  testConnection(input: DingTalkCalDavConnection): Promise<ConnectionSummary>;
  fetchPrimaryCalendar(input: DingTalkCalendarQuery): Promise<{
    calendar: { id: 'primary'; displayName: string; url: string };
    objects: ReadonlyArray<{ href: string; etag: string | null; data: string }>;
    syncToken: string | null;
  }>;
}
```

Use `tsdav` only for discovery and calendar-object reads. Validate that the selected collection is the account's primary/default calendar and reject cleartext non-loopback HTTP. Never expose the underlying mutable DAV client.

- [ ] **Step 5: Run the client test and confirm GREEN**

Run the Task 2 test command again. Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```bash
git add package.json pnpm-lock.yaml src/obsidian-plugin/dingtalk-caldav-client.ts tests/unit/obsidian-plugin/dingtalk-caldav-client.test.ts
git commit -m "feat: add read-only CalDAV client"
```

### Task 3: Parse Calendar Objects into Stable Occurrences

**Files:**
- Create: `src/obsidian-plugin/dingtalk-calendar-parser.ts`
- Test: `tests/unit/obsidian-plugin/dingtalk-calendar-parser.test.ts`
- Test fixture: `tests/fixtures/dingtalk/simple-events.ics`
- Test fixture: `tests/fixtures/dingtalk/recurring-events.ics`

- [ ] **Step 1: Write failing parser tests with synthetic ICS**

Cover timed events with offsets, UTC events, all-day events, cancellation, escaped text, `RRULE`, `RDATE`, `EXDATE`, and overridden `RECURRENCE-ID`. Require stable identity independent of title and `href`.

```ts
const [before] = parseCalendarObjects({ calendarId: 'primary', objects, window });
const [after] = parseCalendarObjects({
  calendarId: 'primary',
  objects: renamedAndMovedObjects,
  window,
});
expect(after?.eventKeyHash).toBe(before?.eventKeyHash);
expect(after?.snapshot.title).toBe('Renamed meeting');
```

- [ ] **Step 2: Run the parser test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/unit/obsidian-plugin/dingtalk-calendar-parser.test.ts
```

Expected: FAIL because the parser module does not exist.

- [ ] **Step 3: Implement parsing and hashing**

Use `ical.js` to expand only occurrences intersecting `[today, today + 90 days]`. Produce:

```ts
export interface DingTalkCalendarOccurrence {
  eventKeyHash: string;
  remoteUid: string;
  recurrenceId: string | null;
  href: string;
  etag: string | null;
  snapshotHash: string;
  snapshot: DingTalkRemoteSnapshot;
}
```

Hash identity as `sha256(calendarId + '|' + uid + '|' + recurrenceIdOrStart)` and hash a canonical JSON object for the snapshot. Timed values use ISO timestamps with their effective UTC offset; all-day values remain `YYYY-MM-DD`. Invalid individual VEVENTs return structured parse issues without preventing other resources from parsing.

- [ ] **Step 4: Run the parser test and confirm GREEN**

Run the Task 3 test command again. Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/obsidian-plugin/dingtalk-calendar-parser.ts tests/unit/obsidian-plugin/dingtalk-calendar-parser.test.ts tests/fixtures/dingtalk/simple-events.ics tests/fixtures/dingtalk/recurring-events.ics
git commit -m "feat: parse DingTalk calendar occurrences"
```

### Task 4: Merge Remote-Owned Fields without Erasing Local Edits

**Files:**
- Create: `src/obsidian-plugin/dingtalk-calendar-merge.ts`
- Test: `tests/unit/obsidian-plugin/dingtalk-calendar-merge.test.ts`

- [ ] **Step 1: Write failing merge tests**

Cover new imports, unchanged remote snapshots, remote rename/reschedule, simultaneous local/remote conflicts, cancellation, restoration, and preservation of project, tags, notes, priority, and local status.

```ts
const result = mergeDingTalkOccurrence({ current, previousRemote, nextRemote });
expect(result.document.data).toMatchObject({
  scheduled: '2026-07-20T15:00:00+08:00',
  project: 'Local project',
  priority: 'high',
});
expect(result.overriddenLocalFields).toEqual(['scheduled']);
expect(result.document.body).toContain('Local preparation note');
```

- [ ] **Step 2: Run the merge test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/unit/obsidian-plugin/dingtalk-calendar-merge.test.ts
```

Expected: FAIL because the merge service does not exist.

- [ ] **Step 3: Implement the field-level three-way merge**

Compare each next remote field with the corresponding previous remote field. When unchanged, leave the current Markdown value byte-for-byte. When changed, update only `title`, `scheduled`, `timeEstimate`, `dingtalk_state`, and the managed body region. Preserve all unknown frontmatter keys and everything outside:

```md
<!-- ATL_DINGTALK_MANAGED_START -->
...
<!-- ATL_DINGTALK_MANAGED_END -->
```

On cancellation, set `status: cancelled` and `cancelledBySync: true`. On restoration, return to `inbox` only if the current status is still `cancelled` and the ledger says ATL set it.

- [ ] **Step 4: Run the merge test and confirm GREEN**

Run the Task 4 test command again. Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add src/obsidian-plugin/dingtalk-calendar-merge.ts tests/unit/obsidian-plugin/dingtalk-calendar-merge.test.ts
git commit -m "feat: merge DingTalk calendar changes"
```

### Task 5: Write TaskNotes Files and Maintain Tombstones

**Files:**
- Create: `src/obsidian-plugin/dingtalk-calendar-writer.ts`
- Test: `tests/integration/obsidian-plugin/dingtalk-calendar-writer.test.ts`

- [ ] **Step 1: Write failing temporary-Vault integration tests**

Use a synthetic adapter rooted in `mkdtemp()` and verify:

```ts
expect(createdPath).toBe(`TaskNotes/DingTalk/${occurrence.eventKeyHash.replace(':', '-')}.md`);
expect(parsed.data).toMatchObject({
  type: 'task',
  status: 'inbox',
  origin: 'dingtalk_caldav',
  scheduled: '2026-07-20T14:00:00+08:00',
});
expect(parsed.data).not.toHaveProperty('due');
```

Also verify idempotency, moved-file discovery by `dingtalk_event_key_hash`, atomic update failure, local deletion tombstones, no automatic resurrection, and that no path under `10_Tasks` is touched.

- [ ] **Step 2: Run the writer test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/integration/obsidian-plugin/dingtalk-calendar-writer.test.ts
```

Expected: FAIL because the writer does not exist.

- [ ] **Step 3: Implement the writer service**

Inject a `DingTalkCalendarFileSystem` with `ensureDirectory`, `listMarkdownFiles`, `read`, `create`, and `modify` methods. Render new files with `type`, `title`, `status`, `scheduled`, optional `timeEstimate`, origin metadata, and the managed body region. Use the existing YAML document helpers and atomic file behavior; update the ledger only after the file operation succeeds.

- [ ] **Step 4: Run the writer test and confirm GREEN**

Run the Task 5 test command again. Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add src/obsidian-plugin/dingtalk-calendar-writer.ts tests/integration/obsidian-plugin/dingtalk-calendar-writer.test.ts
git commit -m "feat: write DingTalk events as TaskNotes"
```

### Task 6: Orchestrate Safe, Single-Flight Synchronization

**Files:**
- Create: `src/obsidian-plugin/dingtalk-calendar-controller.ts`
- Test: `tests/integration/obsidian-plugin/dingtalk-calendar-controller.test.ts`

- [ ] **Step 1: Write failing controller tests**

Test first sync, idempotent resync, local drag preservation, remote updates, explicit cancellation/deletion, local tombstones, partial parse/write failures, snapshot retry, sync-token fallback, and duplicate clicks returning the same Promise.

```ts
const first = controller.sync();
const second = controller.sync();
expect(second).toBe(first);
await expect(first).resolves.toMatchObject({ added: 1, updated: 0, errors: 0 });
expect(saveState).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run the controller test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/integration/obsidian-plugin/dingtalk-calendar-controller.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement connection testing and synchronization**

The controller should:

```ts
export interface DingTalkCalendarController {
  testConnection(): Promise<ConnectionSummary>;
  sync(): Promise<DingTalkSyncResult>;
  clearImportHistory(): Promise<void>;
}
```

Reject missing configuration before network access. Query today through 90 days, parse objects, locate files, merge, write one occurrence at a time, and persist only successfully written occurrence snapshots. Treat an explicitly deleted in-window resource as cancelled, never infer deletion solely from absence outside the query window. Summaries contain counts and redacted user-facing errors only.

- [ ] **Step 4: Run the controller test and confirm GREEN**

Run the Task 6 test command again. Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/obsidian-plugin/dingtalk-calendar-controller.ts tests/integration/obsidian-plugin/dingtalk-calendar-controller.test.ts
git commit -m "feat: synchronize DingTalk calendar safely"
```

### Task 7: Connect Obsidian UI, Lifecycle, Documentation, and Release Verification

**Files:**
- Modify: `src/obsidian-plugin/main.ts`
- Modify: `src/obsidian-plugin/styles.css`
- Modify: `src/obsidian-plugin/manifest.json`
- Modify: `tests/helpers/obsidian-runtime.ts`
- Create: `tests/unit/obsidian-plugin/dingtalk-calendar-plugin.test.ts`
- Modify: `README.md`
- Modify: `docs/operations/obsidian-plugin.md`

- [ ] **Step 1: Write failing plugin integration tests**

Require registration of `sync-dingtalk-calendar`, an on-load sync when enabled, a registered 15-minute interval, a single-flight manual action, no mobile startup, password submission to `SecretStorage`, a redacted settings display, and a two-step import-history confirmation.

```ts
expect(commands).toContainEqual(expect.objectContaining({
  id: 'sync-dingtalk-calendar',
  name: '立即同步钉钉日历',
}));
expect(savedPluginData.dingtalkCalendar).not.toHaveProperty('password');
expect(registeredIntervalMs).toBe(15 * 60 * 1000);
```

- [ ] **Step 2: Run the plugin test and confirm RED**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test -- tests/unit/obsidian-plugin/dingtalk-calendar-plugin.test.ts
```

Expected: FAIL because calendar lifecycle and UI wiring are absent.

- [ ] **Step 3: Implement Obsidian wiring**

Add a “钉钉日历” setting section with enable toggle, URL, username, blank password input, read-only “主日历”, fixed 90-day window, fixed 15-minute frequency, “测试连接”, “立即同步”, last result, and “清除导入记录”. Show this fixed warning:

```text
只从钉钉读取，不会创建、修改或删除钉钉日程。
```

Create the controller lazily on desktop, call it once after layout readiness when enabled, register `window.setInterval(..., 15 * 60 * 1000)`, dispose the interval on unload, and surface redacted notices. Update `minAppVersion` to `1.11.4`.

- [ ] **Step 4: Run plugin tests and confirm GREEN**

Run the Task 7 test command again. Expected: PASS.

- [ ] **Step 5: Write user-facing documentation**

Document this workflow:

```text
设置 -> Agent Task Loop -> 钉钉日历 -> 填写连接 -> 测试连接 -> 启用 -> 立即同步
TaskNotes -> 日历：查看并拖动本地副本
钉钉发生变化：下次同步更新钉钉托管字段
本地项目、标签、状态、备注：同步时保留
```

State explicitly that imported files live in `TaskNotes/DingTalk/`, never enter ATL's `10_Tasks` board, use `scheduled` rather than `due`, and never write back to DingTalk.

- [ ] **Step 6: Run focused and full verification**

Run:

```bash
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm typecheck
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm lint
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm test
PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH" pnpm build
```

Expected: all commands exit 0 with no test failures or lint errors.

- [ ] **Step 7: Perform read-only release checks**

With the user's existing macOS Keychain credential, run only connection discovery and a bounded calendar read. Capture only calendar name, event count, and request methods. Confirm no request uses `PUT`, `POST`, `PATCH`, or `DELETE`; do not print credentials, event titles, descriptions, attendees, or locations. Install the built plugin into the real Vault only after setting both `ATL_VAULT_ROOT` and `ATL_ALLOW_REAL_WRITES=1`, then verify the settings section and one manual sync in Obsidian.

- [ ] **Step 8: Review the branch against the design**

Review `git diff origin/main...HEAD` for security, state advancement, recurrence identity, local-field preservation, cancellation/recovery, interval cleanup, and docs. Search for accidental secrets and write verbs:

```bash
git diff --check
rg -n "password:|BEGIN PRIVATE|calendarObject.*(?:create|update|delete)|method: ['\"](?:PUT|POST|PATCH|DELETE)" src tests README.md docs package.json
```

Expected: no secret material and no remote calendar write path. Test fixture passwords, if any, must be unmistakably synthetic.

- [ ] **Step 9: Commit Task 7**

```bash
git add src/obsidian-plugin/main.ts src/obsidian-plugin/styles.css src/obsidian-plugin/manifest.json tests/helpers/obsidian-runtime.ts tests/unit/obsidian-plugin/dingtalk-calendar-plugin.test.ts README.md docs/operations/obsidian-plugin.md
git commit -m "feat: expose DingTalk calendar sync in Obsidian"
```

- [ ] **Step 10: Push the verified feature branch**

```bash
git push -u origin codex/dingtalk-caldav-calendar-bridge
```

Expected: the remote feature branch is updated without modifying `main`.

## Plan Self-Review

- **Spec coverage:** Tasks 1-7 cover credential safety, primary-calendar-only reads, recurrence parsing, stable identity, three-way merge, local deletion tombstones, cancellation, TaskNotes placement, manual/automatic sync, no-terminal settings, regression verification, real read-only validation, and documentation.
- **Placeholder scan:** No forbidden placeholder markers or unspecified generic error-handling steps remain. Each implementation step names the API contract and exact behavior.
- **Type consistency:** `DingTalkCalendarSettings`, `DingTalkEventLedgerEntry`, `DingTalkRemoteSnapshot`, `DingTalkCalendarOccurrence`, `DingTalkSyncResult`, and `DingTalkCalendarController` are introduced once and reused with the same names. Persisted settings never contain a password.
- **Boundary check:** No public adapter exposes CalDAV mutations; imported Markdown lives outside `10_Tasks`; all tests use synthetic fixtures or temporary Vaults; real Vault validation retains the repository's explicit write gates.
