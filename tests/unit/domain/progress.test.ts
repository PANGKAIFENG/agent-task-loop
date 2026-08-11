import { describe, expect, it } from 'vitest';

import {
  assessProgressEligibility,
  resolveContributionAttribution,
  type ProgressDraft,
} from '../../../src/domain/progress.js';

function draft(overrides: Partial<ProgressDraft> = {}): ProgressDraft {
  return {
    topic: '精恭纺验收分类',
    reportCategory: 'project_acceptance',
    primaryProjectId: 'project-jinggongfang',
    occurredAt: '2026-08-10T16:00:00+08:00',
    sources: ['08_Meetings/2026-08/meeting.md'],
    statements: [
      {
        kind: 'fact',
        text: '已确认按四类整理验收表。',
        sourceRefs: ['08_Meetings/2026-08/meeting.md'],
      },
    ],
    evidence: [{
      kind: 'confirmed_decision',
      summary: '验收表分为四类',
      sourceRef: '08_Meetings/2026-08/meeting.md',
    }],
    selfEvidence: [],
    agentEvidence: [],
    ...overrides,
  };
}

describe('progress eligibility', () => {
  it('accepts a traceable item with a confirmed decision', () => {
    expect(assessProgressEligibility(draft(), {
      startDate: '2026-08-10',
      endDate: '2026-08-16',
    })).toEqual({
      status: 'eligible',
      matchedEvidence: ['confirmed_decision'],
      reasons: [],
    });
  });

  it('rejects a routine check that only proves attendance and discussion', () => {
    const result = assessProgressEligibility(draft({
      topic: 'skill进展核对',
      evidence: [
        { kind: 'attendance', summary: '参加会议', sourceRef: '08_Meetings/meeting.md' },
        { kind: 'discussion', summary: '讨论了 Skill 进展', sourceRef: '08_Meetings/meeting.md' },
      ],
    }), {
      startDate: '2026-08-10',
      endDate: '2026-08-16',
    });

    expect(result.status).toBe('ineligible');
    expect(result.reasons).toContain('只有参会、讨论或计划，没有真实变化证据');
  });

  it('requires every numeric statement to cite an openable source', () => {
    const result = assessProgressEligibility(draft({
      statements: [{ kind: 'fact', text: '共有 47 项待验收。', sourceRefs: [] }],
    }), {
      startDate: '2026-08-10',
      endDate: '2026-08-16',
    });

    expect(result.status).toBe('needs_confirmation');
    expect(result.reasons).toContain('数字缺少可定位来源');
  });

  it('defaults attribution to team and requires direct evidence for self or Agent', () => {
    expect(resolveContributionAttribution(draft())).toBe('team');
    expect(resolveContributionAttribution(draft({ selfEvidence: ['commit:abc'] }))).toBe('self');
    expect(resolveContributionAttribution(draft({ agentEvidence: ['run:123', 'artifact:path'] })))
      .toBe('agent');
    expect(resolveContributionAttribution(draft({
      selfEvidence: ['commit:abc'],
      agentEvidence: ['run:123', 'artifact:path'],
    }))).toBe('pending');
  });
});
