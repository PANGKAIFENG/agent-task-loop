import { describe, expect, it } from 'vitest';

import { prepareMeetingProgressDrafts } from '../../../src/services/prepare-meeting-progress-drafts.js';

describe('prepare meeting progress drafts', () => {
  it('splits a meeting summary into bounded editable topic drafts with preserved evidence', () => {
    const drafts = prepareMeetingProgressDrafts({
      meetingTitle: '精恭纺验收推进会议',
      occurredAt: '2026-08-10T17:42:00+08:00',
      sourceRef: '08_Meetings/2026-08/meeting.md',
      summary: [
        '## 验收分类',
        '已讨论按四类整理验收事项。',
        '## 交付资料',
        '需求分类表仍待补齐。',
      ].join('\n'),
    });

    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.topic)).toEqual(['验收分类', '交付资料']);
    expect(drafts[0]).toMatchObject({
      primaryProjectId: null,
      occurredAt: '2026-08-10T17:42:00+08:00',
      sources: ['08_Meetings/2026-08/meeting.md'],
      evidence: [{
        kind: 'discussion',
        sourceRef: '08_Meetings/2026-08/meeting.md',
      }],
    });
  });

  it('falls back to top-level bullets and caps noisy summaries', () => {
    const drafts = prepareMeetingProgressDrafts({
      meetingTitle: '周会',
      occurredAt: '2026-08-11T10:00:00+08:00',
      sourceRef: '08_Meetings/2026-08/weekly.md',
      summary: Array.from({ length: 12 }, (_, index) => `- 主题 ${index + 1}：讨论内容`).join('\n'),
    });

    expect(drafts).toHaveLength(8);
    expect(drafts[0]?.topic).toBe('主题 1');
  });
});
