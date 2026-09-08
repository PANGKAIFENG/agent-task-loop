import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCandidateUnderstanding,
  type CandidateUnderstanding,
} from '../../../src/domain/candidate-understanding.js';
import type { RunnerController } from '../../../src/runner/runner-controller.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { createApp } from '../../../src/server/app.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const BOARD_ORIGIN = 'http://127.0.0.1:4173';
const BOARD_TOKEN = 'synthetic-candidate-token';
const contexts: TestServiceContext[] = [];

async function authorizeResearch(): Promise<never> {
  throw new Error('Research authorization is outside this candidate route test');
}

function runner(): RunnerController {
  return {
    runAndWait: async () => ({}) as never,
    start: async () => ({ runId: 'unused' }),
    continueAfterDecision: async () => ({}) as never,
  };
}

async function setup() {
  const context = await createTestServiceContext({
    ids: ['task-20260822-candidate-route'],
  });
  contexts.push(context);
  const app = await createApp({
    ctx: context.ctx,
    runner: runner(),
    authorizeResearch,
    boardOrigin: BOARD_ORIGIN,
    environment: { ATL_BOARD_TOKEN: BOARD_TOKEN },
    sourceRoot: context.root,
  });
  const captured = await captureTask(context.ctx, {
    title: '核对候选 inspector',
    body: '原始正文不能通过列表或保存被覆盖。',
    origin: 'synthetic_fixture',
    sourceDate: '2026-08-22',
    sourceNote: 'fixtures/candidate.md',
    sourceQuote: '核对候选 inspector 并形成可评审结果。',
    sourceKey: 'synthetic:candidate:route',
    priority: 'normal',
  });
  const understanding = buildCandidateUnderstanding({
    task: {
      taskId: captured.taskId,
      title: captured.title,
      body: captured.body,
      taskType: 'research',
    },
    sourceRefs: [{
      sourceRefId: 'source-candidate-route',
      sourceType: 'synthetic_fixture',
      sourceKey: 'synthetic:candidate:route',
      sourceNote: 'fixtures/candidate.md',
      anchor: '#candidate',
      quote: '核对候选 inspector 并形成可评审结果。',
      capturedAt: captured.createdAt,
      lastVerifiedAt: captured.createdAt,
      status: 'available',
      failureReason: null,
      parentContext: null,
      lastVerifiedEvidence: {
        resolvedNote: 'fixtures/candidate.md',
        checkedCharacters: 64,
        quoteMatched: true,
        truncated: false,
      },
    }],
    aiDraft: {
      objective: '形成可评审结果',
      nextAction: '核对 inspector 字段',
      expectedArtifact: '候选 inspector 证据',
      completionCriteria: 'Web 与 Obsidian 显示一致',
    },
  });
  const task = await context.ctx.tasks.save({
    ...captured,
    candidateUnderstanding: {
      ...understanding,
      revision: 1,
      confirmed: false,
      updatedAt: captured.updatedAt,
    },
  });
  return { app, context, task };
}

function headers() {
  return { origin: BOARD_ORIGIN, 'x-atl-token': BOARD_TOKEN };
}

function understandingFromProjection(projection: {
  understandingIdentity: Pick<
    CandidateUnderstanding,
    'schemaVersion' | 'generationId' | 'taskType'
  >;
  suggestions: CandidateUnderstanding['suggestions'];
  sourceRefs: CandidateUnderstanding['sourceRefs'];
  gaps: CandidateUnderstanding['gaps'];
}) {
  return {
    ...projection.understandingIdentity,
    suggestions: projection.suggestions,
    sourceRefs: projection.sourceRefs,
    gaps: projection.gaps,
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('candidate inspector routes', () => {
  it('reads the shared inspector projection without exposing full task input', async () => {
    const { app, task } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-inspector`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({
      taskIdentity: expect.objectContaining({
        taskId: task.taskId,
        candidateRevision: 1,
        autoExecutable: false,
      }),
      suggestions: expect.arrayContaining([
        expect.objectContaining({ field: 'expected_artifact' }),
      ]),
      admission: expect.objectContaining({
        rule_version: 'agent-admission-v1',
        reasons: expect.any(Array),
      }),
    }));
    expect(response.body).not.toContain('原始正文不能通过列表');
    await app.close();
  });

  it('persists the bounded legacy understanding shown on Web read and keeps its source action stable', async () => {
    const context = await createTestServiceContext({
      ids: ['task-20260822-legacy-route'],
    });
    contexts.push(context);
    await mkdir(join(context.root, 'Sources'), { recursive: true });
    await writeFile(
      join(context.root, 'Sources/legacy.md'),
      '# 合成来源\n\n核对 legacy Web 来源。\n',
      'utf8',
    );
    const task = await captureTask(context.ctx, {
      title: '核对 legacy Web 来源',
      body: '原始 legacy 正文必须保持不变。',
      origin: 'synthetic_fixture',
      sourceDate: '2026-08-22',
      sourceNote: 'Sources/legacy.md',
      sourceQuote: '核对 legacy Web 来源。',
      sourceKey: 'synthetic:candidate:legacy-route',
      priority: 'normal',
    });
    const before = await context.ctx.tasks.get(task.taskId);
    const app = await createApp({
      ctx: context.ctx,
      runner: runner(),
      authorizeResearch,
      boardOrigin: BOARD_ORIGIN,
      environment: { ATL_BOARD_TOKEN: BOARD_TOKEN },
      sourceRoot: context.root,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-inspector`,
    });
    const firstProjection = response.json();
    const firstSource = firstProjection.sourceRefs[0];

    expect(response.statusCode).toBe(200);
    expect(firstProjection).toMatchObject({
      taskIdentity: { candidateRevision: 0 },
      suggestions: expect.arrayContaining([
        expect.objectContaining({ field: 'title', attribution: 'source_fact' }),
      ]),
      sourceRefs: [expect.objectContaining({
        status: 'available',
        sourceNote: 'Sources/legacy.md',
        anchor: 'line:3',
      })],
    });
    expect(response.body).not.toContain(before.body);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(before);

    const savedResponse = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.taskId}/candidate-understanding`,
      headers: headers(),
      payload: {
        understanding: understandingFromProjection(firstProjection),
        expectedRevision: 0,
        expectedTaskUpdatedAt: task.updatedAt,
        confirm: false,
        values: { next_action: '人工核对 legacy 来源' },
      },
    });
    const savedProjection = savedResponse.json();

    expect(savedResponse.statusCode).toBe(200);
    expect(savedProjection.taskIdentity.candidateRevision).toBe(1);
    expect(savedProjection.sourceRefs[0]).toEqual(firstSource);
    expect(savedProjection.sourceActions).toContainEqual(expect.objectContaining({
      actionId: 'open_source',
      sourceRefId: firstSource.sourceRefId,
      intent: 'open',
    }));

    const opened = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-sources/${firstSource.sourceRefId}/open`,
    });
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toMatchObject({
      actionId: 'open_source',
      outcome: 'located',
      sourceRefId: firstSource.sourceRefId,
      locator: { sourceNote: 'Sources/legacy.md', anchor: 'line:3' },
    });
    const savedTask = await context.ctx.tasks.get(task.taskId);
    expect(savedTask.body).toBe(before.body);
    expect(savedTask.sourceKey).toBe(before.sourceKey);
    await app.close();
  });

  it('fails closed when a legacy Web source path escapes the configured root', async () => {
    const context = await createTestServiceContext({
      ids: ['task-20260822-legacy-outside'],
    });
    contexts.push(context);
    const task = await captureTask(context.ctx, {
      title: '核对越界来源',
      body: '越界正文不得暴露。',
      origin: 'synthetic_fixture',
      sourceDate: '2026-08-22',
      sourceNote: '../outside.md',
      sourceQuote: '越界引用',
      sourceKey: 'synthetic:candidate:outside',
      priority: 'normal',
    });
    const before = await context.ctx.tasks.get(task.taskId);
    const app = await createApp({
      ctx: context.ctx,
      runner: runner(),
      authorizeResearch,
      boardOrigin: BOARD_ORIGIN,
      environment: { ATL_BOARD_TOKEN: BOARD_TOKEN },
      sourceRoot: context.root,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-inspector`,
    });

    expect(response.json().sourceRefs[0]).toMatchObject({
      status: 'unavailable',
      failureReason: 'source_path_outside_root',
    });
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(before);
    await app.close();
  });

  it('returns only a safely reverified locator for open_source and fails closed for traversal', async () => {
    const { app, context, task } = await setup();
    await mkdir(join(context.root, 'fixtures'), { recursive: true });
    await writeFile(
      join(context.root, 'fixtures/candidate.md'),
      '# 合成来源\n\n核对候选 inspector 并形成可评审结果。\n',
      'utf8',
    );

    const located = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-sources/source-candidate-route/open`,
    });

    expect(located.statusCode).toBe(200);
    expect(located.json()).toEqual({
      actionId: 'open_source',
      outcome: 'located',
      sourceRefId: 'source-candidate-route',
      locator: {
        sourceNote: 'fixtures/candidate.md',
        anchor: 'line:3',
      },
    });
    expect(located.body).not.toContain('原始正文不能通过列表');

    const source = task.candidateUnderstanding!.sourceRefs[0]!;
    await context.ctx.tasks.save({
      ...task,
      candidateUnderstanding: {
        ...task.candidateUnderstanding!,
        sourceRefs: [{
          ...source,
          sourceNote: '../outside.md',
          lastVerifiedEvidence: null,
        }],
      },
    });
    const rejected = await app.inject({
      method: 'GET',
      url: `/api/tasks/${task.taskId}/candidate-sources/source-candidate-route/open`,
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({
      actionId: 'open_source',
      outcome: 'recovery_required',
      sourceRefId: 'source-candidate-route',
      locator: null,
      status: 'unavailable',
      failureReason: 'source_path_outside_root',
    });
    await app.close();
  });

  it('saves a draft and confirms a later revision without granting Agent or write access', async () => {
    const { app, context, task } = await setup();
    const originalBody = task.body;
    const originalSourceKey = task.sourceKey;

    const draft = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.taskId}/candidate-understanding`,
      headers: headers(),
      payload: {
        understanding: task.candidateUnderstanding,
        expectedRevision: 1,
        expectedTaskUpdatedAt: task.updatedAt,
        confirm: false,
        values: { next_action: '人工核对全部字段' },
      },
    });
    const draftBody = draft.json();
    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.taskId}/candidate-understanding`,
      headers: headers(),
      payload: {
        understanding: understandingFromProjection(draftBody),
        expectedRevision: 2,
        expectedTaskUpdatedAt: draftBody.taskIdentity.updatedAt,
        confirm: true,
        values: {},
      },
    });
    const saved = await context.ctx.tasks.get(task.taskId);

    expect(draft.statusCode).toBe(200);
    expect(draftBody.taskIdentity).toMatchObject({
      status: 'inbox',
      reviewState: 'candidate',
      candidateRevision: 2,
      candidateConfirmed: false,
      autoExecutable: false,
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().taskIdentity).toMatchObject({
      status: 'ready',
      reviewState: 'confirmed',
      candidateRevision: 3,
      candidateConfirmed: true,
      autoExecutable: false,
    });
    expect(confirmed.json().permissionGate.authorized).toBe(false);
    expect(saved.body).toBe(originalBody);
    expect(saved.sourceKey).toBe(originalSourceKey);
    await app.close();
  });

  it('requires write protection and reports stale revision as conflict', async () => {
    const { app, task } = await setup();
    const payload = {
      understanding: task.candidateUnderstanding,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: false,
      values: {},
    };
    const unauthorized = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.taskId}/candidate-understanding`,
      headers: { origin: BOARD_ORIGIN },
      payload,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.taskId}/candidate-understanding`,
      headers: headers(),
      payload,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      code: 'task_conflict',
      message: 'Task conflict',
      details: null,
    });
    await app.close();
  });
});
