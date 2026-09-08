import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildCandidateUnderstanding } from '../../../src/domain/candidate-understanding.js';
import { captureTask } from '../../../src/services/capture-task.js';
import {
  CandidateUnderstandingAuditFailedError,
  CandidateUnderstandingBlockedError,
  CandidateUnderstandingInvalidStateError,
  confirmCandidateUnderstanding,
} from '../../../src/services/confirm-candidate-understanding.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';
import { TaskConflictError } from '../../../src/storage/markdown-task-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];
const NOW = new Date('2026-08-22T01:30:00.000Z');

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext({ now: NOW });
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

async function captured(context: TestServiceContext) {
  return captureTask(context.ctx, {
    title: '核对三条公开能力声明',
    body: '原始正文必须完整保留，候选理解只能写入独立 revision。',
    origin: 'synthetic_test',
    sourceDate: '2026-08-22',
    sourceNote: 'Sources/synthetic-record.md',
    sourceQuote: '核对三条公开能力声明',
    sourceKey: 'synthetic:candidate-confirmation',
    priority: 'normal',
  });
}

function generated(task: Awaited<ReturnType<typeof captured>>, complete = true) {
  return buildCandidateUnderstanding({
    task,
    sourceRefs: [{
      sourceRefId: 'source-synthetic-1',
      sourceType: 'synthetic_note',
      sourceKey: task.sourceKey,
      sourceNote: task.sourceNote,
      anchor: 'line:2',
      quote: task.sourceQuote ?? '',
      capturedAt: task.createdAt,
      lastVerifiedAt: NOW.toISOString(),
      status: 'available',
      failureReason: null,
      parentContext: '公开能力清单\n核对三条公开能力声明',
      lastVerifiedEvidence: {
        resolvedNote: task.sourceNote,
        checkedCharacters: 40,
        quoteMatched: true,
        truncated: false,
      },
    }],
    aiDraft: {
      taskType: 'research',
      objective: '核对三条能力声明是否有公开证据支持。',
      nextAction: '逐条收集并比较公开证据。',
      expectedArtifact: complete ? '一份有来源引用的核对摘要。' : '',
      completionCriteria: complete ? '三条声明均有明确结论和引用。' : '',
    },
  });
}

describe('confirmCandidateUnderstanding', () => {
  it('persists a confirmed revision and brief without overwriting body/source or authorizing Agent', async () => {
    const context = await makeContext();
    const task = await captured(context);
    const understanding = generated(task);

    const saved = await confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: true,
      values: { title: '核对三条公开能力声明及证据' },
    });

    expect(saved).toMatchObject({
      title: '核对三条公开能力声明及证据',
      body: task.body,
      sourceKey: task.sourceKey,
      sourceNote: task.sourceNote,
      sourceQuote: task.sourceQuote,
      status: 'ready',
      reviewState: 'confirmed',
      autoExecutable: false,
      taskType: 'research',
      objective: '核对三条能力声明是否有公开证据支持。',
      acceptanceCriteria: ['三条声明均有明确结论和引用。'],
      taskBrief: {
        objective: '核对三条能力声明是否有公开证据支持。',
        nextAction: '逐条收集并比较公开证据。',
        completionCriteria: '三条声明均有明确结论和引用。',
      },
      candidateUnderstanding: {
        revision: 1,
        confirmed: true,
        generationId: understanding.generationId,
      },
    });

    const path = join(context.root, '10_Tasks/Active/unassigned', `${task.taskId}.md`);
    const document = parseTaskDocument(await readFile(path, 'utf8'));
    expect(document.body).toBe(task.body);
    expect(document.data).toMatchObject({
      source_key: task.sourceKey,
      source_note: task.sourceNote,
      source_quote: task.sourceQuote,
      auto_executable: false,
      candidate_understanding: {
        schema_version: 1,
        revision: 1,
        confirmed: true,
      },
    });
    await expect(context.ctx.audit.listForTask(task.taskId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'task.candidate_understanding_confirmed',
          details: expect.objectContaining({ revision: 1, agentAuthorized: false }),
        }),
      ]),
    );
  });

  it('saves an incomplete draft revision without changing lifecycle or granting execution', async () => {
    const context = await makeContext();
    const task = await captured(context);
    const understanding = generated(task, false);

    const draft = await confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: false,
      values: {},
    });
    expect(draft).toMatchObject({
      status: 'inbox',
      reviewState: 'candidate',
      autoExecutable: false,
      candidateUnderstanding: { revision: 1, confirmed: false },
    });
    expect(draft.candidateUnderstanding?.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'blocking' }),
    ]));

    await expect(confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding: draft.candidateUnderstanding!,
      expectedRevision: 1,
      expectedTaskUpdatedAt: draft.updatedAt,
      confirm: true,
      values: {},
    })).rejects.toBeInstanceOf(CandidateUnderstandingBlockedError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      status: 'inbox',
      reviewState: 'candidate',
      autoExecutable: false,
      candidateUnderstanding: { revision: 1, confirmed: false },
    });
  });

  it('rejects stale task or candidate revisions without silently overwriting the newer draft', async () => {
    const context = await makeContext();
    const task = await captured(context);
    const understanding = generated(task, false);
    const first = await confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: false,
      values: { objective: '新的人工目标。' },
    });

    await expect(confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: false,
      values: { objective: '旧窗口覆盖值。' },
    })).rejects.toBeInstanceOf(TaskConflictError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toMatchObject({
      updatedAt: first.updatedAt,
      candidateUnderstanding: {
        revision: 1,
        suggestions: expect.arrayContaining([
          expect.objectContaining({ field: 'objective', suggestedValue: '新的人工目标。' }),
        ]),
      },
    });
  });

  it.each([
    ['inbox', 'confirmed'],
    ['ready', 'confirmed'],
    ['agent_executable', 'confirmed'],
    ['review', 'confirmed'],
  ] as const)('does not move a %s/%s task back through candidate confirmation', async (
    status,
    reviewState,
  ) => {
    const context = await makeContext();
    const task = await captured(context);
    const guarded = await context.ctx.tasks.save({
      ...task,
      status,
      reviewState,
      updatedAt: '2026-08-22T01:31:00.000Z',
    });

    await expect(confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding: generated(task),
      expectedRevision: 0,
      expectedTaskUpdatedAt: guarded.updatedAt,
      confirm: true,
      values: {},
    })).rejects.toBeInstanceOf(CandidateUnderstandingInvalidStateError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(guarded);
    const persisted = await context.ctx.tasks.get(task.taskId);
    expect(persisted.body).toBe(task.body);
    expect(persisted.sourceKey).toBe(task.sourceKey);
    expect(persisted.sourceNote).toBe(task.sourceNote);
    expect(persisted.sourceQuote).toBe(task.sourceQuote);
  });

  it('rolls the full task back when the audit append fails', async () => {
    const context = await makeContext();
    const task = await captured(context);
    const before = await context.ctx.tasks.get(task.taskId);
    context.ctx.audit.append = async () => { throw new Error('synthetic audit unavailable'); };

    await expect(confirmCandidateUnderstanding(context.ctx, task.taskId, {
      understanding: generated(task),
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: true,
      values: {},
    })).rejects.toBeInstanceOf(CandidateUnderstandingAuditFailedError);
    await expect(context.ctx.tasks.get(task.taskId)).resolves.toEqual(before);
  });
});
