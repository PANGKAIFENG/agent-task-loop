import { describe, expect, it } from 'vitest';

import {
  mergeDingTalkOccurrence,
} from '../../../src/obsidian-plugin/dingtalk-calendar-merge.js';
import type { DingTalkRemoteSnapshot } from '../../../src/obsidian-plugin/dingtalk-calendar-types.js';

const original: DingTalkRemoteSnapshot = {
  title: 'Remote meeting',
  start: '2026-07-20T14:00:00+08:00',
  end: '2026-07-20T15:00:00+08:00',
  allDay: false,
  description: 'Remote agenda',
  location: 'Room A',
  state: 'active',
};

describe('mergeDingTalkOccurrence', () => {
  it('builds a new TaskNotes document without due or ATL execution fields', () => {
    const result = mergeDingTalkOccurrence({
      current: null,
      previousRemote: null,
      nextRemote: original,
      cancelledBySync: false,
    });

    expect(result.document.data).toMatchObject({
      type: 'task',
      title: 'Remote meeting',
      status: 'inbox',
      scheduled: '2026-07-20T14:00:00+08:00',
      timeEstimate: 60,
      origin: 'dingtalk_caldav',
      tags: ['dingtalk_calendar'],
      dingtalk_state: 'active',
    });
    expect(result.document.data).not.toHaveProperty('due');
    expect(result.document.data).not.toHaveProperty('project_id');
    expect(result.document.body).toContain('地点：Room A');
    expect(result.document.body).toContain('Remote agenda');
  });

  it('does not overwrite a local drag when the remote snapshot is unchanged', () => {
    const current = mergeDingTalkOccurrence({
      current: null,
      previousRemote: null,
      nextRemote: original,
      cancelledBySync: false,
    }).document;
    current.data.scheduled = '2026-07-20T16:00:00+08:00';
    current.data.timeEstimate = 90;
    current.body += '\nLocal preparation note.\n';

    const result = mergeDingTalkOccurrence({
      current,
      previousRemote: original,
      nextRemote: { ...original },
      cancelledBySync: false,
    });

    expect(result.changed).toBe(false);
    expect(result.document).toEqual(current);
    expect(result.overriddenLocalFields).toEqual([]);
  });

  it('updates changed remote fields while preserving all local-owned fields and body', () => {
    const current = mergeDingTalkOccurrence({
      current: null,
      previousRemote: null,
      nextRemote: original,
      cancelledBySync: false,
    }).document;
    current.data.scheduled = '2026-07-20T16:00:00+08:00';
    current.data.project = 'Local project';
    current.data.priority = 'high';
    current.data.tags = ['dingtalk_calendar', 'local-tag'];
    current.data.status = 'in_progress';
    current.body += '\nLocal preparation note.\n';

    const result = mergeDingTalkOccurrence({
      current,
      previousRemote: original,
      nextRemote: {
        ...original,
        title: 'Renamed meeting',
        start: '2026-07-20T15:00:00+08:00',
        end: '2026-07-20T16:30:00+08:00',
        location: 'Room B',
      },
      cancelledBySync: false,
    });

    expect(result.document.data).toMatchObject({
      title: 'Renamed meeting',
      scheduled: '2026-07-20T15:00:00+08:00',
      timeEstimate: 90,
      project: 'Local project',
      priority: 'high',
      tags: ['dingtalk_calendar', 'local-tag'],
      status: 'in_progress',
    });
    expect(result.document.body).toContain('地点：Room B');
    expect(result.document.body).toContain('Local preparation note.');
    expect(result.overriddenLocalFields).toEqual(['scheduled']);
  });

  it('cancels remotely and only restores the status ATL previously cancelled', () => {
    const current = mergeDingTalkOccurrence({
      current: null,
      previousRemote: null,
      nextRemote: original,
      cancelledBySync: false,
    }).document;
    const cancelledRemote = { ...original, state: 'cancelled' as const };
    const cancelled = mergeDingTalkOccurrence({
      current,
      previousRemote: original,
      nextRemote: cancelledRemote,
      cancelledBySync: false,
    });
    expect(cancelled.document.data.status).toBe('cancelled');
    expect(cancelled.cancelledBySync).toBe(true);

    const restored = mergeDingTalkOccurrence({
      current: cancelled.document,
      previousRemote: cancelledRemote,
      nextRemote: original,
      cancelledBySync: true,
    });
    expect(restored.document.data.status).toBe('inbox');
    expect(restored.cancelledBySync).toBe(false);

    cancelled.document.data.status = 'done';
    const locallyCompleted = mergeDingTalkOccurrence({
      current: cancelled.document,
      previousRemote: cancelledRemote,
      nextRemote: original,
      cancelledBySync: true,
    });
    expect(locallyCompleted.document.data.status).toBe('done');
    expect(locallyCompleted.cancelledBySync).toBe(false);
  });
});
