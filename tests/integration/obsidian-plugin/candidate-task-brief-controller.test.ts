import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskBriefController } from '../../../src/obsidian-plugin/task-brief-controller.js';
import { captureTask } from '../../../src/services/capture-task.js';
import { readCandidateInspector } from '../../../src/services/read-candidate-inspector.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('ATL candidate TaskBriefController', () => {
  it('resolves bounded source evidence and confirms through the candidate revision service', async () => {
    const context = await createTestServiceContext({
      now: new Date('2026-08-22T05:00:00.000Z'),
      ids: ['task-20260822-brief-controller'],
    });
    contexts.push(context);
    await mkdir(join(context.root, 'Sources'), { recursive: true });
    await writeFile(
      join(context.root, 'Sources/candidate.md'),
      '# 合成清单\n\n- 核对候选字段并形成可评审方案。\n- 其他无关事项。\n',
      'utf8',
    );
    const captured = await captureTask(context.ctx, {
      title: '核对候选字段',
      body: '原始正文必须保留。',
      origin: 'synthetic_fixture',
      sourceDate: '2026-08-22',
      sourceNote: 'Sources/candidate.md',
      sourceQuote: '核对候选字段并形成可评审方案。',
      sourceKey: 'synthetic:candidate:brief-controller',
      priority: 'normal',
    });
    const task = await context.ctx.tasks.save({ ...captured, taskType: 'research' });
    const openResolvedSource = vi.fn(async () => undefined);
    const controller = new TaskBriefController(context.ctx, {
      sourceRoot: context.root,
      openResolvedSource,
    });

    const prepared = await controller.prepare(task.taskId);

    expect(prepared.candidateInspector?.sourceRefs[0]).toMatchObject({
      status: 'available',
      anchor: 'line:3',
      quote: '核对候选字段并形成可评审方案。',
      parentContext: expect.stringContaining('其他无关事项'),
      lastVerifiedEvidence: expect.objectContaining({
        resolvedNote: 'Sources/candidate.md',
        quoteMatched: true,
      }),
    });
    expect(prepared.candidateInspector?.sourceActions).toEqual([{
      actionId: 'open_source',
      sourceRefId: `task-source-${task.taskId}`,
      intent: 'open',
      label: '打开原始输入并定位',
    }]);
    await expect(controller.openSource(
      task.taskId,
      `task-source-${task.taskId}`,
    )).resolves.toMatchObject({ outcome: 'located' });
    expect(openResolvedSource).toHaveBeenCalledWith({
      sourceNote: 'Sources/candidate.md',
      anchor: 'line:3',
    });
    const web = await readCandidateInspector(context.ctx, task, 'web');
    expect(prepared.candidateInspector?.admission.reasons.map(({ code }) => code))
      .toEqual(web.admission.reasons.map(({ code }) => code));

    const saved = await controller.saveCandidate(task.taskId, {
      understanding: prepared.candidateUnderstanding!,
      expectedRevision: 0,
      expectedTaskUpdatedAt: task.updatedAt,
      confirm: true,
      values: {
        title: '核对候选字段',
        objective: '形成可评审字段方案',
        next_action: '逐项核对字段',
        expected_artifact: '字段取舍清单',
        completion_criteria: '每个字段都有明确取舍和依据',
      },
    });
    const persisted = await context.ctx.tasks.get(task.taskId);

    expect(saved.taskIdentity).toMatchObject({
      candidateRevision: 1,
      candidateConfirmed: true,
      status: 'ready',
      autoExecutable: false,
    });
    expect(persisted).toMatchObject({
      body: task.body,
      sourceKey: task.sourceKey,
      sourceNote: task.sourceNote,
      sourceQuote: task.sourceQuote,
      autoExecutable: false,
    });
  });

  it('uses the bounded moved-source locator supplied by the production adapter', async () => {
    const context = await createTestServiceContext({
      now: new Date('2026-08-22T05:30:00.000Z'),
      ids: ['task-20260822-moved-source'],
    });
    contexts.push(context);
    await mkdir(join(context.root, 'Moved'), { recursive: true });
    await writeFile(
      join(context.root, 'Moved/candidate.md'),
      '# 合成清单\n\n- 核对移动后的候选来源。\n',
      'utf8',
    );
    const captured = await captureTask(context.ctx, {
      title: '核对移动后的候选来源',
      body: '原始正文必须保留。',
      origin: 'synthetic_fixture',
      sourceDate: '2026-08-22',
      sourceNote: 'Sources/original-candidate.md',
      sourceQuote: '核对移动后的候选来源。',
      sourceKey: 'synthetic:candidate:moved',
      priority: 'normal',
    });
    const controller = new TaskBriefController(context.ctx, {
      sourceRoot: context.root,
      locateMoved: async (sourceKey) => (
        sourceKey === captured.sourceKey ? 'Moved/candidate.md' : null
      ),
    });

    const prepared = await controller.prepare(captured.taskId);

    expect(prepared.candidateInspector?.sourceRefs[0]).toMatchObject({
      status: 'moved',
      sourceNote: 'Moved/candidate.md',
      failureReason: 'source_moved',
      lastVerifiedEvidence: expect.objectContaining({
        resolvedNote: 'Moved/candidate.md',
        quoteMatched: true,
      }),
    });
  });
});
