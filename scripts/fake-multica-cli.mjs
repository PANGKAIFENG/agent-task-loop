#!/usr/bin/env node
// Synthetic Multica CLI fixture for PAW-GOAL-003 T1 (TECH §4.1 "测试使用
// fake connector，禁止真实 Multica"). Implements exactly the argv surface the
// MulticaCliConnector emits, backed by a JSON file so cross-process state
// persists. Never contacts a real Multica daemon.
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

const storePath = process.env.FAKE_MULTICA_STORE;
if (!storePath) {
  process.stderr.write('FAKE_MULTICA_STORE is required\n');
  process.exit(2);
}

async function loadStore() {
  try {
    return JSON.parse(await readFile(storePath, 'utf8'));
  } catch {
    return { issues: [], nextNumber: 100 };
  }
}

async function saveStore(store) {
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith('--')) {
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[value.slice(2)] = next;
        index += 1;
      } else {
        flags[value.slice(2)] = true;
      }
    } else {
      positional.push(value);
    }
  }
  return { flags, positional };
}

function issuePublic(issue) {
  return {
    assignee_id: null,
    assignee_type: null,
    created_at: issue.created_at,
    creator_id: 'synthetic',
    creator_type: 'agent',
    description: issue.description,
    due_date: null,
    id: issue.id,
    identifier: issue.identifier,
    labels: [],
    last_activity_at: issue.created_at,
    metadata: issue.metadata,
    number: issue.number,
    parent_issue_id: null,
    position: -1,
    priority: 'normal',
    project_id: issue.project_id,
    properties: {},
    revision: 1,
    stage: null,
    start_date: null,
    status: issue.status,
    status_category: issue.status,
    title: issue.title,
    updated_at: issue.created_at,
    workspace_id: issue.workspace_id,
  };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { resolve(data); });
  });
}

// Global flags (--profile, --workspace-id) precede the subcommand in the
// connector's argv, so the command shape comes from the positional tokens.
const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const [subcommand, group, action, ...rest] = positional;

if (subcommand !== 'issue') {
  process.stderr.write(`unsupported subcommand: ${subcommand}\n`);
  process.exit(1);
}

const store = await loadStore();

try {
  if (group === 'comment' && action === 'list') {
    // T2 roundtrip surface, speaking the REAL CLI wire (T2 CR fix 1): no
    // --limit flag exists (reject it exactly like the shipped binary), the
    // JSON response is a top-level array whose body field is `content`, and
    // neither --since nor the plain list emits a pagination cursor. --full is
    // accepted; this fake never folds resolved threads.
    if (flags.limit !== undefined) {
      process.stderr.write('unknown flag: --limit\n');
      process.exit(1);
    }
    const issue = store.issues.find((candidate) => candidate.id === rest[0]);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${rest[0]}\n`);
      process.exit(1);
    }
    let comments = issue.comments ?? [];
    if (flags.since) {
      comments = comments.filter((comment) => comment.created_at >= flags.since);
    }
    comments = [...comments].sort((left, right) => left.created_at.localeCompare(right.created_at));
    process.stdout.write(`${JSON.stringify(comments.map((comment) => ({
      attachments: [],
      author_id: 'synthetic-agent',
      author_type: comment.author_type ?? 'agent',
      content: comment.body,
      created_at: comment.created_at,
      id: comment.id,
      issue_id: issue.id,
      parent_id: comment.parent_id ?? null,
      reactions: [],
      resolved_at: null,
      resolved_by_id: null,
      resolved_by_type: null,
      revision: 1,
      source_task_id: null,
      type: 'comment',
      updated_at: comment.created_at,
    })))}\n`);
  } else if (group === 'comment' && action === 'add') {
    const issue = store.issues.find((candidate) => candidate.id === rest[0]);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${rest[0]}\n`);
      process.exit(1);
    }
    if (flags['content-stdin'] !== true) {
      process.stderr.write('--content-stdin is required\n');
      process.exit(1);
    }
    const body = await readStdin();
    store.nextComment = (store.nextComment ?? 0) + 1;
    const comment = {
      id: `cmt-${String(store.nextComment).padStart(4, '0')}`,
      parent_id: flags.parent ?? null,
      body,
      created_at: new Date().toISOString(),
      author_type: 'agent',
    };
    issue.comments = [...(issue.comments ?? []), comment];
    await saveStore(store);
    process.stdout.write(`${JSON.stringify({ id: comment.id, ok: true })}\n`);
  } else if (group === 'runs') {
    // Real wire (T2 CR fix 1): a top-level array of run records.
    const issue = store.issues.find((candidate) => candidate.id === action);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${action}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify((issue.runs ?? []).map((run) => ({
      agent_id: null,
      attempt: 1,
      completed_at: run.status === 'completed' ? run.created_at ?? null : null,
      created_at: run.created_at ?? '2026-08-20T09:00:00.000Z',
      error: null,
      id: run.id,
      issue_id: issue.id,
      kind: 'agent_task',
      max_attempts: 1,
      priority: 'normal',
      result: null,
      runtime_id: null,
      started_at: run.created_at ?? null,
      status: run.status,
      workspace_id: issue.workspace_id,
    })))}\n`);
  } else if (group === 'status') {
    // A run-starting status change (no --no-start): flips the issue status and
    // enqueues exactly one new run — the rerun trigger the resume path uses.
    const issue = store.issues.find((candidate) => candidate.id === action);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${action}\n`);
      process.exit(1);
    }
    if (flags['no-start'] === true) {
      process.stderr.write('--no-start must not be used by the resume path\n');
      process.exit(1);
    }
    issue.status = rest[0] ?? issue.status;
    // UUID-suffixed so a synthesized run id can never collide with a seeded
    // baseline run id (the resume diff depends on that distinction).
    issue.runs = [
      { id: `run-syn-${randomUUID().slice(0, 8)}`, status: 'queued' },
      ...(issue.runs ?? []),
    ];
    await saveStore(store);
    process.stdout.write(`${JSON.stringify({ ok: true, status: issue.status })}\n`);
  } else if (group === 'list') {
    let issues = store.issues;
    if (flags.project) {
      issues = issues.filter((issue) => issue.project_id === flags.project);
    }
    if (flags.metadata) {
      const [key, ...valueParts] = flags.metadata.split('=');
      const value = valueParts.join('=');
      issues = issues.filter((issue) => issue.metadata?.[key] === value);
    }
    const limit = Number.parseInt(flags.limit ?? '50', 10);
    const offset = Number.parseInt(flags.offset ?? '0', 10);
    if (Number.isFinite(limit)) {
      issues = issues.slice(
        Number.isFinite(offset) ? offset : 0,
        (Number.isFinite(offset) ? offset : 0) + limit,
      );
    }
    process.stdout.write(`${JSON.stringify({ has_more: false, issues: issues.map(issuePublic) })}\n`);
  } else if (group === 'create') {
    if (!flags.title) {
      process.stderr.write('--title is required\n');
      process.exit(1);
    }
    const description = flags['description-stdin'] === true
      ? await readStdin()
      : flags.description ?? null;
    if (flags.assignee || flags['assignee-id']) {
      process.stderr.write('assignee must not be set by the dispatch path\n');
      process.exit(1);
    }
    store.nextNumber = (store.nextNumber ?? 100) + 1;
    const issue = {
      id: randomUUID(),
      identifier: `TEP-${store.nextNumber}`,
      workspace_id: flags['workspace-id'],
      project_id: flags.project ?? null,
      title: flags.title,
      description,
      status: flags.status ?? 'backlog',
      metadata: {},
      created_at: new Date().toISOString(),
      number: store.nextNumber,
    };
    store.issues.push(issue);
    await saveStore(store);
    process.stdout.write(`${JSON.stringify(issuePublic(issue))}\n`);
  } else if (group === 'get') {
    const issue = store.issues.find((candidate) => candidate.id === action);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${action}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(issuePublic(issue))}\n`);
  } else if (group === 'metadata' && action === 'list') {
    // T3.1 real wire: `issue metadata list --output json` prints a bare
    // top-level object map whose values are the raw `--value` strings. A JSON
    // receipt reference survives byte-exact — the exact-match read-back in
    // writeReleaseReceipt depends on that. Like the real metadata surface,
    // this command touches neither comments nor runs.
    const issue = store.issues.find((candidate) => candidate.id === rest[0]);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${rest[0]}\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(issue.metadata ?? {})}\n`);
  } else if (group === 'metadata' && action === 'set') {
    const issue = store.issues.find((candidate) => candidate.id === rest[0]);
    if (issue === undefined) {
      process.stderr.write(`issue not found: ${rest[0]}\n`);
      process.exit(1);
    }
    issue.metadata = { ...(issue.metadata ?? {}), [flags.key]: flags.value };
    await saveStore(store);
    process.stdout.write('{}\n');
  } else {
    process.stderr.write(`unsupported command: ${argv.join(' ')}\n`);
    process.exit(1);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
