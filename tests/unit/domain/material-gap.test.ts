import { describe, expect, it } from 'vitest';

import { prepareMaterialGap } from '../../../src/domain/material-gap.js';

describe('material gap preparation', () => {
  it('preserves permission failures and produces a draft without sending it', () => {
    const gap = prepareMaterialGap({
      gapId: 'gap-jgf-table',
      progressId: 'progress-jgf-classification',
      progressVersion: 1,
      missing: {
        kind: 'numeric',
        description: '精恭纺验收分类表与四类数量',
        purpose: '核验本周项目验收进展',
      },
      searches: [
        {
          source: 'meeting_link',
          target: 'synthetic-meeting',
          status: 'not_found',
          searchedAt: '2026-08-11T02:00:00.000Z',
          sourceRef: null,
        },
        {
          source: 'dingtalk_doc',
          target: 'synthetic-table',
          status: 'permission_denied',
          searchedAt: '2026-08-11T02:01:00.000Z',
          sourceRef: 'dingtalk://document/synthetic-table',
        },
      ],
      suggestedContact: {
        userId: 'synthetic-user',
        displayName: '材料维护人',
        reason: '日程组织者且在会议中被明确提及为表格维护人',
        sourceRef: '08_Meetings/2026-08/synthetic-meeting.md',
      },
      createdAt: '2026-08-11T02:02:00.000Z',
    });

    expect(gap.status).toBe('needs_material');
    expect(gap.searches[1]?.status).toBe('permission_denied');
    expect(gap.messageDraft).toMatchObject({
      recipientUserId: 'synthetic-user',
      state: 'draft',
      authorization: 'required',
      delivery: null,
    });
    expect(gap.messageDraft?.body).toContain('精恭纺验收分类表与四类数量');
    expect(gap.messageDraft?.body).toContain('核验本周项目验收进展');
  });

  it('resolves from a readable hit without creating an outbound draft', () => {
    const gap = prepareMaterialGap({
      gapId: 'gap-resolved',
      progressId: 'progress-1',
      progressVersion: 1,
      missing: {
        kind: 'document',
        description: '验收表',
        purpose: '核验周报',
      },
      searches: [{
        source: 'dingtalk_aitable',
        target: 'synthetic-table',
        status: 'found',
        searchedAt: '2026-08-11T02:00:00.000Z',
        sourceRef: 'dingtalk://aitable/synthetic-table',
      }],
      suggestedContact: null,
      createdAt: '2026-08-11T02:02:00.000Z',
    });

    expect(gap.status).toBe('resolved');
    expect(gap.resolvedSourceRef).toBe('dingtalk://aitable/synthetic-table');
    expect(gap.messageDraft).toBeNull();
  });

  it('does not invent a recipient when contact evidence is missing', () => {
    const gap = prepareMaterialGap({
      gapId: 'gap-no-contact',
      progressId: 'progress-1',
      progressVersion: 1,
      missing: {
        kind: 'status',
        description: '当前验收状态',
        purpose: '核验周报',
      },
      searches: [],
      suggestedContact: null,
      createdAt: '2026-08-11T02:02:00.000Z',
    });

    expect(gap.status).toBe('needs_contact');
    expect(gap.messageDraft).toBeNull();
  });

  it.each(['not_connected', 'failed'] as const)(
    'preserves the %s external search status',
    (status) => {
      const gap = prepareMaterialGap({
        gapId: `gap-${status}`,
        progressId: 'progress-a',
        progressVersion: 1,
        missing: {
          kind: 'document',
          description: '验收分类表',
          purpose: '周报',
        },
        searches: [{
          source: status === 'not_connected' ? 'yunxiao' : 'dingtalk_drive',
          target: 'query:验收分类表',
          status,
          searchedAt: '2026-08-12T02:00:00.000Z',
          sourceRef: null,
        }],
        suggestedContact: null,
        createdAt: '2026-08-12T02:00:00.000Z',
      });

      expect(gap.searches[0]?.status).toBe(status);
    },
  );
});
