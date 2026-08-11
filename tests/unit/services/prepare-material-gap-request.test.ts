import { describe, expect, it } from 'vitest';

import {
  listRelatedMaterialSources,
  prepareMaterialGapRequest,
} from '../../../src/services/prepare-material-gap-request.js';

const progress = {
  schemaVersion: 1 as const,
  progressId: 'progress-a',
  version: 1,
  lifecycleStatus: 'eligible' as const,
  topic: '精恭纺验收分类',
  reportCategory: 'project_acceptance' as const,
  primaryProjectId: 'project-jgf',
  occurredAt: '2026-08-10T17:42:00+08:00',
  sources: ['08_Meetings/2026-08/meeting.md'],
  statements: [],
  evidence: [],
  selfEvidence: [],
  agentEvidence: [],
  contribution: 'team' as const,
  eligibility: { status: 'eligible' as const, matchedEvidence: [], reasons: [] },
  supersedesVersion: null,
  createdAt: '2026-08-11T10:00:00+08:00',
};

describe('prepare material gap request', () => {
  it('records local source searches and resolves a traceable numeric material', async () => {
    const input = await prepareMaterialGapRequest({
      loadProgress: async () => progress,
      readSource: async () => '验收分类数量：第一类 12 项。\n',
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
    }, {
      progressId: progress.progressId,
      progressVersion: progress.version,
      missing: {
        kind: 'numeric',
        description: '验收分类数量',
        purpose: '精恭纺验收周报',
      },
    });

    expect(input.searches).toEqual([{
      source: 'meeting_link',
      target: '08_Meetings/2026-08/meeting.md',
      status: 'found',
      searchedAt: '2026-08-12T02:00:00.000Z',
      sourceRef: '08_Meetings/2026-08/meeting.md',
    }]);
    expect(input.suggestedContact).toBeNull();
  });

  it('creates a contact suggestion only from a structured source identity', async () => {
    const input = await prepareMaterialGapRequest({
      loadProgress: async () => progress,
      readSource: async () => [
        '---',
        'material_contacts:',
        '  - userId: user-maintainer',
        '    displayName: 材料维护人',
        '    reason: 会议材料维护人',
        '---',
        '尚未附验收表。',
      ].join('\n'),
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
    }, {
      progressId: progress.progressId,
      progressVersion: progress.version,
      missing: {
        kind: 'document',
        description: '验收分类表',
        purpose: '精恭纺验收周报',
      },
    });

    expect(input.searches[0]?.status).toBe('not_found');
    expect(input.suggestedContact).toEqual({
      userId: 'user-maintainer',
      displayName: '材料维护人',
      reason: '会议材料维护人',
      sourceRef: '08_Meetings/2026-08/meeting.md',
    });
  });

  it('does not treat frontmatter or unrelated dates as numeric evidence', async () => {
    const input = await prepareMaterialGapRequest({
      loadProgress: async () => progress,
      readSource: async () => [
        '---',
        'meeting_date: 2026-08-10',
        'qianwen_duration_seconds: 701',
        '---',
        '验收分类数量仍待补齐。',
        '下次核对时间：2026-08-13 10:00。',
      ].join('\n'),
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
    }, {
      progressId: progress.progressId,
      progressVersion: progress.version,
      missing: {
        kind: 'numeric',
        description: '验收分类数量',
        purpose: '精恭纺验收周报',
      },
    });

    expect(input.searches[0]).toMatchObject({
      target: '08_Meetings/2026-08/meeting.md',
      status: 'not_found',
      sourceRef: null,
    });
  });

  it('records bounded related meeting, project, task, and artifact sources in the ledger', async () => {
    const calendarPath = `TaskNotes/DingTalk/sha256-${'a'.repeat(64)}.md`;
    const attachmentPath = `08_Meetings/2026-08/attachments/${'a'.repeat(64)}/evidence.md`;
    const projectResourcePath = '03_Resources/project-jgf/acceptance-table.md';
    const taskSourcePath = '笔记同步助手/2026-08-10/精恭纺.md';
    const artifactPath = '10_Tasks/Artifacts/task-jgf/attempt-001.md';
    const meeting = [
      '---',
      'type: meeting',
      `calendar_event: "[[${calendarPath.slice(0, -3)}]]"`,
      'attachments:',
      `  - id: sha256:${'b'.repeat(64)}`,
      '    name: evidence.md',
      `    path: ${attachmentPath}`,
      '    media_type: text/markdown',
      '    size: 128',
      '    role: reference',
      '    analyzable: true',
      '    include_in_analysis: true',
      '---',
      '',
      'Synthetic meeting.',
    ].join('\n');
    const related = await listRelatedMaterialSources({
      readSource: async (path) => (
        path === '08_Meetings/2026-08/meeting.md' ? meeting : null
      ),
      loadProject: async () => ({
        resources: [
          { kind: 'local_path', value: projectResourcePath },
          { kind: 'local_path', value: '/outside/vault.md' },
          { kind: 'url', value: 'https://example.com/table' },
        ],
      }),
      listTasks: async () => [{
        taskId: 'task-jgf',
        projectId: progress.primaryProjectId,
        sourceNote: taskSourcePath,
        artifactRefs: ['Artifacts/task-jgf/attempt-001.md'],
      }, {
        taskId: 'task-other',
        projectId: 'project-other',
        sourceNote: '03_Resources/other.md',
        artifactRefs: [],
      }],
    }, progress);
    const input = await prepareMaterialGapRequest({
      loadProgress: async () => progress,
      readSource: async (path) => (
        path === artifactPath ? '验收分类表：已输出。' : '未找到验收分类表。'
      ),
      listRelatedSources: async () => related,
      clock: () => new Date('2026-08-12T02:00:00.000Z'),
    }, {
      progressId: progress.progressId,
      progressVersion: progress.version,
      missing: {
        kind: 'document',
        description: '验收分类表',
        purpose: '精恭纺验收周报',
      },
    });

    expect(input.searches.map(({ source, target }) => ({ source, target }))).toEqual([
      { source: 'meeting_link', target: '08_Meetings/2026-08/meeting.md' },
      { source: 'calendar_attachment', target: calendarPath },
      { source: 'calendar_attachment', target: attachmentPath },
      { source: 'project_context', target: '10_Tasks/Projects/project-jgf.md' },
      { source: 'project_context', target: projectResourcePath },
      { source: 'project_context', target: taskSourcePath },
      { source: 'code_artifact', target: artifactPath },
    ]);
    expect(input.searches.at(-1)).toMatchObject({
      source: 'code_artifact',
      target: artifactPath,
      status: 'found',
      sourceRef: artifactPath,
    });
  });
});
