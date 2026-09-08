import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MulticaCallFailedError,
  MulticaCallTimedOutError,
  MulticaCliConnector,
  MulticaOutputUnparseableError,
  type MulticaCommandRequest,
  type MulticaCommandRunner,
} from '../../../src/connectors/multica-cli-connector.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROFILE = 'desktop-api.multica.ai';
const BINARY = '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';

// CR fix 1 contract tests: the fixtures under tests/fixtures/multica/cli hold
// the SYNTHETIC CAPTURE of the real CLI wire (shipped binary, read-only
// invocations): `comment list --output json` prints a top-level array whose
// body field is `content`, and `issue runs --output json` is a top-level
// array of run records. The adapter must parse exactly this shape and must
// never send flags the CLI rejects (`--limit` on comment list).
const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/multica/cli',
);

function loadFixture(name: string): Promise<string> {
  return readFile(join(fixturesRoot, name), 'utf8');
}

class RecordingRunner {
  readonly requests: MulticaCommandRequest[] = [];
  private readonly handler: (request: MulticaCommandRequest) => Promise<{
    stdout: string;
    stderr?: string;
    exitCode?: number;
  }>;

  constructor(
    handler: (request: MulticaCommandRequest) => Promise<{ stdout: string; stderr?: string; exitCode?: number }>,
  ) {
    this.handler = handler;
  }

  run: MulticaCommandRunner = async (request) => {
    this.requests.push(request);
    const result = await this.handler(request);
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      throw new MulticaCallFailedError(
        `Multica CLI exited with ${result.exitCode}: ${result.stderr?.slice(0, 400) ?? ''}`,
      );
    }
    return { stdout: result.stdout, stderr: result.stderr ?? '' };
  };

  commands(): string[][] {
    return this.requests.map(({ args }) => [...args]);
  }
}

function connectorFor(runner: RecordingRunner): MulticaCliConnector {
  return new MulticaCliConnector({
    binaryPath: BINARY,
    profile: PROFILE,
    workspaceId: WORKSPACE_ID,
    projectId: 'b70aeddc-4a32-47ed-a288-573f5475634a',
    runner: runner.run,
  });
}

function isCommentList(args: readonly string[]): boolean {
  return args.includes('comment') && args.includes('list');
}

describe('listComments wire contract', () => {
  it('parses the captured --since output: top-level array with content bodies', async () => {
    const captured = await loadFixture('comment-list-since.json');
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: captured };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const result = await connector.listComments(ISSUE_ID, { since: '2026-08-20T09:50:00.000Z' });
    expect(result.comments.map((comment) => comment.commentId)).toEqual(['c1', 'c2']);
    expect(result.comments[0]).toEqual({
      commentId: 'c1',
      parentCommentId: null,
      body: 'progress note',
      createdAt: '2026-08-20T10:00:00.000Z',
      authorType: 'agent',
    });
    expect(result.comments[1]?.body).toContain('schema_version');
    expect(result.comments[1]?.parentCommentId).toBe('c1');
  });

  it('never sends flags the current CLI rejects and passes the overlap window through', async () => {
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: '[]' };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const result = await connector.listComments(ISSUE_ID, { since: '2026-08-20T09:50:00.000Z' });
    expect(result.comments).toEqual([]);

    const command = runner.commands().find(isCommentList);
    expect(command).toBeDefined();
    // The shipped CLI has no --limit on comment list: sending it fails the
    // whole invocation with `unknown flag` (exit 1).
    expect(command).not.toContain('--limit');
    expect(command).toContain(ISSUE_ID);
    expect(command).toContain('--since');
    expect(command?.[command.indexOf('--since') + 1]).toBe('2026-08-20T09:50:00.000Z');
    expect(command?.at(-1)).toBe('json');
    expect(command).toContain('--profile');
    expect(command).toContain('--workspace-id');
  });

  it('treats an empty window as an empty page, not an error', async () => {
    const runner = new RecordingRunner(async () => ({ stdout: '[]' }));
    const connector = connectorFor(runner);
    const result = await connector.listComments(ISSUE_ID);
    expect(result.comments).toEqual([]);
  });

  it('preserves attachment identity and download references from comment readback', async () => {
    const runner = new RecordingRunner(async () => ({
      stdout: JSON.stringify([{
        id: 'comment-artifact-1',
        parent_id: null,
        content: 'Research artifact attached.',
        created_at: '2026-09-01T06:00:00.000Z',
        author_type: 'agent',
        attachments: [{
          id: 'attachment-artifact-1',
          comment_id: 'comment-artifact-1',
          issue_id: ISSUE_ID,
          workspace_id: WORKSPACE_ID,
          filename: 'synthetic-report.html',
          content_type: 'text/html; charset=utf-8',
          size_bytes: 2048,
          download_url: '/api/attachments/attachment-artifact-1/download',
          markdown_url: 'https://multica.example/api/attachments/attachment-artifact-1/download',
          url: 'https://static.multica.example/workspaces/synthetic-report.html',
          uploader_id: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
          uploader_type: 'agent',
        }],
      }]),
    }));
    const connector = connectorFor(runner);

    const result = await connector.listComments(ISSUE_ID, { full: true });

    expect(result.comments[0]?.attachments).toEqual([{
      attachmentId: 'attachment-artifact-1',
      commentId: 'comment-artifact-1',
      issueId: ISSUE_ID,
      workspaceId: WORKSPACE_ID,
      runId: null,
      filename: 'synthetic-report.html',
      contentType: 'text/html; charset=utf-8',
      sizeBytes: 2048,
      downloadUrl: '/api/attachments/attachment-artifact-1/download',
      markdownUrl: 'https://multica.example/api/attachments/attachment-artifact-1/download',
      url: 'https://static.multica.example/workspaces/synthetic-report.html',
      uploaderId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
      uploaderType: 'agent',
    }]);
  });

  it('rejects the legacy {comments: [{body}]} envelope as an unparseable wire', async () => {
    const runner = new RecordingRunner(async () => ({
      stdout: JSON.stringify({ comments: [{ id: 'c1', body: 'old fake shape' }] }),
    }));
    const connector = connectorFor(runner);
    await expect(connector.listComments(ISSUE_ID)).rejects.toBeInstanceOf(MulticaOutputUnparseableError);
  });

  it('parses the captured issue runs output as a top-level array', async () => {
    const captured = await loadFixture('issue-runs.json');
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('runs')) {
        return { stdout: captured };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const runIds = await connector.runIds(ISSUE_ID);
    expect(runIds).toEqual([
      '01234567-aaaa-4cde-8f01-234567890aaa',
      '01234567-bbbb-4cde-8f01-234567890bbb',
    ]);

    const runs = await connector.runs(ISSUE_ID);
    expect(runs[0]).toMatchObject({
      runId: '01234567-aaaa-4cde-8f01-234567890aaa',
      deliveredCommentIds: ['c9'],
      triggerCommentId: 'c8',
    });
    expect(runs[1]).toMatchObject({
      runId: '01234567-bbbb-4cde-8f01-234567890bbb',
      deliveredCommentIds: [],
      triggerCommentId: null,
    });
  });

  it('rejects the legacy {runs: [...]} envelope as an unparseable wire', async () => {
    const runner = new RecordingRunner(async () => ({
      stdout: JSON.stringify({ runs: [{ id: 'run-1', status: 'completed' }] }),
    }));
    const connector = connectorFor(runner);
    await expect(connector.runIds(ISSUE_ID)).rejects.toBeInstanceOf(MulticaOutputUnparseableError);
  });
});

describe('appendResponse', () => {
  it('does not treat a quoted marker as the canonical response comment', async () => {
    const captured = JSON.parse(await loadFixture('comment-list-since.json')) as Array<{
      content: string;
    }>;
    captured[1]!.content = 'prior decision [ATL_RESPONSE:stream-evt-9] done';
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: JSON.stringify(captured) };
      }
      if (args.includes('comment') && args.includes('add')) {
        return { stdout: JSON.stringify({ id: 'c9', ok: true }) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-9',
      body: 'response body',
      parentCommentId: 'c0',
    });
    expect(receipt).toEqual({ commentId: 'c9', deduplicated: false });
    expect(runner.commands().filter((args) => args.includes('add'))).toHaveLength(1);
    // The marker reply can sit inside a resolved thread; only the unfolder
    // read is a complete scan.
    const scan = runner.commands().find(isCommentList);
    expect(scan).toContain('--full');
    expect(scan).not.toContain('--since');
  });

  it('deduplicates one exact canonical response comment without writing', async () => {
    const captured = JSON.parse(await loadFixture('comment-list-since.json')) as Array<{
      content: string;
    }>;
    captured[1]!.content = '[ATL_RESPONSE:stream-evt-9]\n\nresponse body';
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: JSON.stringify(captured) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-9',
      body: 'response body',
      parentCommentId: 'c0',
    });

    expect(receipt).toEqual({ commentId: 'c2', deduplicated: true });
    expect(runner.commands().some((args) => args.includes('add'))).toBe(false);
  });

  it('fails closed when the marker already exists with conflicting response content', async () => {
    const captured = JSON.parse(await loadFixture('comment-list-since.json')) as Array<{
      content: string;
    }>;
    captured[1]!.content = '[ATL_RESPONSE:stream-evt-9]\n\ntampered response body';
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: JSON.stringify(captured) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-9',
      body: 'response body',
      parentCommentId: 'c0',
    });

    expect(receipt).toMatchObject({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('conflict'),
    });
    expect(runner.commands().some((args) => args.includes('add'))).toBe(false);
  });

  it('fails closed when more than one exact canonical response comment exists', async () => {
    const canonicalBody = '[ATL_RESPONSE:stream-evt-9]\n\nresponse body';
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return {
          stdout: JSON.stringify([
            {
              id: 'c-exact-1',
              parent_id: null,
              content: canonicalBody,
              created_at: '2026-09-01T06:00:00.000Z',
              author_type: 'member',
            },
            {
              id: 'c-exact-2',
              parent_id: null,
              content: canonicalBody,
              created_at: '2026-09-01T06:01:00.000Z',
              author_type: 'member',
            },
          ]),
        };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-9',
      body: 'response body',
      parentCommentId: null,
    });

    expect(receipt).toMatchObject({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('multiple'),
    });
    expect(runner.commands().some((args) => args.includes('add'))).toBe(false);
  });

  it('writes one comment with the parent thread reference and reads the id back', async () => {
    const runner = new RecordingRunner(async ({ args, stdin }) => {
      if (isCommentList(args)) {
        return { stdout: '[]' };
      }
      if (args.includes('comment') && args.includes('add')) {
        expect(args).toContain(ISSUE_ID);
        expect(args).toContain('--content-stdin');
        expect(args).toContain('--parent');
        expect(args[args.indexOf('--parent') + 1]).toBe('c0');
        expect(stdin).toContain('[ATL_RESPONSE:stream-evt-10]');
        return { stdout: JSON.stringify({ id: 'c9', ok: true }) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-10',
      body: 'approved retry with fixture',
      parentCommentId: 'c0',
    });
    expect(receipt).toEqual({ commentId: 'c9', deduplicated: false });
    expect(runner.commands().filter((args) => args.includes('add'))).toHaveLength(1);
  });

  it('omits --parent when the response has no parent comment', async () => {
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        return { stdout: '[]' };
      }
      if (args.includes('add')) {
        return { stdout: JSON.stringify({ id: 'c2' }) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);
    await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-11',
      body: 'ok',
      parentCommentId: null,
    });
    const add = runner.commands().find((args) => args.includes('add'));
    expect(add).not.toContain('--parent');
  });

  it('maps a timed-out add to an uncertain receipt instead of failing silently', async () => {
    let addAttempted = false;
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('list')) {
        return { stdout: '[]' };
      }
      if (args.includes('add')) {
        addAttempted = true;
        throw new MulticaCallTimedOutError(args);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);
    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-12',
      body: 'ok',
      parentCommentId: null,
    });
    expect(addAttempted).toBe(true);
    expect('status' in receipt && receipt.status === 'remote_write_unknown').toBe(true);
  });

  it('heals a timed-out add only when one exact canonical response appears', async () => {
    let listCount = 0;
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        listCount += 1;
        return listCount === 1
          ? { stdout: '[]' }
          : {
              stdout: JSON.stringify([{
                id: 'c-healed',
                parent_id: null,
                content: '[ATL_RESPONSE:stream-evt-13]\n\nresponse body',
                created_at: '2026-09-01T06:00:00.000Z',
                author_type: 'member',
              }]),
            };
      }
      if (args.includes('add')) {
        throw new MulticaCallTimedOutError(args);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-13',
      body: 'response body',
      parentCommentId: null,
    });

    expect(receipt).toEqual({ commentId: 'c-healed', deduplicated: true });
    expect(runner.commands().filter((args) => args.includes('add'))).toHaveLength(1);
    expect(runner.commands().filter(isCommentList)).toHaveLength(2);
  });

  it('fails closed when timed-out add healing finds the marker with conflicting content', async () => {
    let listCount = 0;
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        listCount += 1;
        return listCount === 1
          ? { stdout: '[]' }
          : {
              stdout: JSON.stringify([{
                id: 'c-conflict',
                parent_id: null,
                content: '[ATL_RESPONSE:stream-evt-14]\n\ntampered body',
                created_at: '2026-09-01T06:00:00.000Z',
                author_type: 'member',
              }]),
            };
      }
      if (args.includes('add')) {
        throw new MulticaCallTimedOutError(args);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-14',
      body: 'response body',
      parentCommentId: null,
    });

    expect(receipt).toMatchObject({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('conflict'),
    });
  });

  it('fails closed when timed-out add healing finds duplicate exact responses', async () => {
    let listCount = 0;
    const canonicalBody = '[ATL_RESPONSE:stream-evt-15]\n\nresponse body';
    const runner = new RecordingRunner(async ({ args }) => {
      if (isCommentList(args)) {
        listCount += 1;
        return listCount === 1
          ? { stdout: '[]' }
          : {
              stdout: JSON.stringify(['c-healed-1', 'c-healed-2'].map((id, index) => ({
                id,
                parent_id: null,
                content: canonicalBody,
                created_at: `2026-09-01T06:0${index}:00.000Z`,
                author_type: 'member',
              }))),
            };
      }
      if (args.includes('add')) {
        throw new MulticaCallTimedOutError(args);
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);

    const receipt = await connector.appendResponse(ISSUE_ID, {
      streamEventId: 'stream-evt-15',
      body: 'response body',
      parentCommentId: null,
    });

    expect(receipt).toMatchObject({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('multiple'),
    });
  });
});

describe('resume', () => {
  function runsJson(runIds: string[]): string {
    return JSON.stringify(runIds.map((runId, index) => ({
      id: runId,
      status: index === 0 ? 'in_progress' : 'completed',
    })));
  }

  function runsRunner(options: {
    before: string[];
    afterTrigger: string[];
  }): RecordingRunner {
    let statusChanged = false;
    return new RecordingRunner(async ({ args }) => {
      if (args.includes('runs')) {
        return { stdout: runsJson(statusChanged ? options.afterTrigger : options.before) };
      }
      if (args.includes('status')) {
        statusChanged = true;
        return { stdout: JSON.stringify({ ok: true }) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
  }

  it('skips the rerun when a new run already exists', async () => {
    // A run appeared between appendResponse and resume — someone else already
    // resumed the loop, so resume must not trigger another rerun.
    const runner = new RecordingRunner(async ({ args }) => {
      if (args.includes('runs')) {
        return { stdout: runsJson(['run-2', 'run-1']) };
      }
      throw new Error(`unexpected command: ${args.join(' ')}`);
    });
    const connector = connectorFor(runner);
    const receipt = await connector.resume(ISSUE_ID, { baselineRunIds: ['run-1'] });
    expect(receipt).toEqual({ status: 'already_running', runIds: ['run-2', 'run-1'] });
    expect(runner.commands().some((args) => args.includes('status'))).toBe(false);
  });

  it('triggers one rerun via a run-starting status change and confirms the new run id', async () => {
    const runner = runsRunner({ before: ['run-1'], afterTrigger: ['run-2', 'run-1'] });
    const connector = connectorFor(runner);
    const receipt = await connector.resume(ISSUE_ID, { baselineRunIds: ['run-1'] });
    expect(receipt).toEqual({ status: 'confirmed', newRunIds: ['run-2'] });
    const statusCommand = runner.commands().find((args) => args.includes('status'));
    expect(statusCommand).toBeDefined();
    expect(statusCommand).toContain(ISSUE_ID);
    expect(statusCommand).toContain('in_progress');
    expect(runner.commands().filter((args) => args.includes('status'))).toHaveLength(1);
  });

  it('reports duplicate_conflict when the trigger produces multiple new runs', async () => {
    const runner = runsRunner({ before: ['run-1'], afterTrigger: ['run-3', 'run-2', 'run-1'] });
    const connector = connectorFor(runner);
    const receipt = await connector.resume(ISSUE_ID, { baselineRunIds: ['run-1'] });
    expect(receipt.status).toBe('duplicate_conflict');
  });

  it('stays remote_write_unknown when no new run can be confirmed', async () => {
    const runner = runsRunner({ before: ['run-1'], afterTrigger: ['run-1'] });
    const connector = connectorFor(runner);
    const receipt = await connector.resume(ISSUE_ID, { baselineRunIds: ['run-1'] });
    expect(receipt.status).toBe('remote_write_unknown');
  });
});
