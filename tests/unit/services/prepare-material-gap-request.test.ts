import { describe, expect, it } from 'vitest';

import { prepareMaterialGapRequest } from '../../../src/services/prepare-material-gap-request.js';

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
});
