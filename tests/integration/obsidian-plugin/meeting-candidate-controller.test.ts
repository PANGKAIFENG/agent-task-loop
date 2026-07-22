import { afterEach, describe, expect, it } from 'vitest';

import {
  MeetingCandidateController,
} from '../../../src/obsidian-plugin/meeting-candidate-controller.js';
import type { MeetingAnalysisResult } from '../../../src/obsidian-plugin/meeting-analysis.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];
const MEETING_NOTE = '/tmp/synthetic-vault/08_Meetings/2026-07/2026-07-22-周会-aaaaaaaa.md';

function analysis(): MeetingAnalysisResult {
  return {
    summary: '团队确认先完成方案，再安排用户验证。',
    conclusions: ['先完成方案'],
    taskCandidates: [
      {
        title: '周五提交方案',
        explanation: '李四承诺在周五提交方案。',
        priority: 'high',
        sourceQuote: '李四：周五提交方案。',
      },
      {
        title: '安排用户验证',
        explanation: '方案完成后需要安排用户验证。',
        priority: 'normal',
        sourceQuote: '张三：方案后安排用户验证。',
      },
    ],
  };
}

async function fixture(): Promise<{
  context: TestServiceContext;
  controller: MeetingCandidateController;
}> {
  const context = await createTestServiceContext({
    ids: ['task-20260722-meeting-0001', 'task-20260722-meeting-0002'],
  });
  contexts.push(context);
  return {
    context,
    controller: new MeetingCandidateController({ context: context.ctx }),
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('MeetingCandidateController', () => {
  it('prepares stable candidate IDs and meeting-note evidence for the existing modal', async () => {
    const { controller } = await fixture();
    const input = {
      meetingNotePath: MEETING_NOTE,
      meetingDate: '2026-07-22',
      analysis: analysis(),
    } as const;

    const first = controller.prepare(input);
    const second = controller.prepare(input);

    expect(first).toEqual(second);
    expect(first.candidates).toHaveLength(2);
    expect(first.candidates[0]).toMatchObject({
      title: '周五提交方案',
      summary: '李四承诺在周五提交方案。',
      sourceDate: '2026-07-22',
      sourceNote: MEETING_NOTE,
      sourceQuote: '李四：周五提交方案。',
    });
    expect(first.candidates[0]?.candidateId).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.candidates[0]?.candidateId).not.toBe(
      first.candidates[1]?.candidateId,
    );
  });

  it('captures only explicitly selected candidates as non-executable Inbox tasks', async () => {
    const { context, controller } = await fixture();
    const prepared = controller.prepare({
      meetingNotePath: MEETING_NOTE,
      meetingDate: '2026-07-22',
      analysis: analysis(),
    });

    const result = await controller.commit(
      prepared,
      [prepared.candidates[1]!.candidateId],
    );

    expect(result.createdTaskIds).toEqual(['task-20260722-meeting-0001']);
    const tasks = await context.ctx.tasks.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: '安排用户验证',
      status: 'inbox',
      reviewState: 'candidate',
      autoExecutable: false,
      origin: 'obsidian_meeting',
      sourceDate: '2026-07-22',
      sourceNote: MEETING_NOTE,
      sourceQuote: '张三：方案后安排用户验证。',
    });
  });

  it('retries idempotently without creating duplicate tasks', async () => {
    const { context, controller } = await fixture();
    const prepared = controller.prepare({
      meetingNotePath: MEETING_NOTE,
      meetingDate: '2026-07-22',
      analysis: analysis(),
    });
    const selected = [prepared.candidates[0]!.candidateId];

    const first = await controller.commit(prepared, selected);
    const second = await controller.commit(prepared, selected);

    expect(first.createdTaskIds).toHaveLength(1);
    expect(second.existingTaskIds).toEqual(first.createdTaskIds);
    await expect(context.ctx.tasks.list()).resolves.toHaveLength(1);
  });

  it('rejects candidate IDs that do not belong to the prepared meeting', async () => {
    const { context, controller } = await fixture();
    const prepared = controller.prepare({
      meetingNotePath: MEETING_NOTE,
      meetingDate: '2026-07-22',
      analysis: analysis(),
    });

    await expect(controller.commit(prepared, ['unknown-candidate']))
      .rejects.toThrow('不属于');
    await expect(context.ctx.tasks.list()).resolves.toEqual([]);
  });
});
