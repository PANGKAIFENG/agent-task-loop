import { describe, expect, it, vi } from 'vitest';

import type { AcceptanceObject } from '../../../src/domain/acceptance-object.js';
import {
  notifyAcceptance,
  type AcceptanceDelivery,
  type AcceptanceNotificationLedger,
  type AcceptanceNotificationRecord,
} from '../../../src/services/notify-acceptance.js';

const NOW = '2026-08-11T14:00:00.000Z';

function object(overrides: Partial<AcceptanceObject> = {}): AcceptanceObject {
  return {
    objectType: 'artifact',
    objectId: 'task-artifact-a',
    version: 2,
    title: 'Staywork 需求方案',
    state: 'pending',
    pendingCount: 2,
    path: '10_Tasks/Artifacts/task-artifact-a/attempt-002.md',
    artifact: {
      reference: 'task-artifact-a@v2',
      summary: '完成 Staywork 需求方案并验证两个验收项。',
      evidenceCount: 3,
      checks: { met: 1, partial: 1, notMet: 0 },
    },
    notification: null,
    ...overrides,
  };
}

function memoryLedger(): AcceptanceNotificationLedger & {
  records: Map<string, AcceptanceNotificationRecord>;
} {
  const records = new Map<string, AcceptanceNotificationRecord>();
  return {
    records,
    withLock: async (operation) => operation(),
    get: async (key) => records.get(key) ?? null,
    save: async (record) => { records.set(record.idempotencyKey, record); },
    list: async () => [...records.values()],
  };
}

describe('notify acceptance', () => {
  it('sends a unique visible Artifact once with a stable UUID and review-ready payload', async () => {
    const acceptance = object();
    const ledger = memoryLedger();
    const send = vi.fn<AcceptanceDelivery['send']>(async () => ({
      taskId: 'task-dingtalk-a',
      messageId: null,
    }));
    const context = {
      ledger,
      delivery: { send },
      target: { kind: 'self' as const },
      listAcceptanceObjects: async () => [acceptance],
      clock: () => new Date(NOW),
    };

    const first = await notifyAcceptance(context, acceptance);
    const second = await notifyAcceptance(context, acceptance);

    expect(first).toMatchObject({
      status: 'sent',
      idempotencyKey: 'artifact:task-artifact-a:2',
      attemptedAt: NOW,
      taskId: 'task-dingtalk-a',
    });
    expect(second).toEqual(first);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      uuid: first.uuid,
      title: 'ATL 待验收通知',
      text: [
        '标题：Staywork 需求方案',
        '任务 ID：task-artifact-a',
        'Artifact：task-artifact-a@v2',
        '结果：完成 Staywork 需求方案并验证两个验收项。',
        '自检：通过 1；部分通过 1；未通过 0；证据 3',
        '状态：待验收',
        '待确认：2 项',
        '位置：Obsidian -> ATL：工作沉淀 -> 待验收',
        '回复操作：',
        '接受 task-artifact-a v2',
        '要求修改 task-artifact-a v2：请说明需要修改的内容',
        '阻塞 task-artifact-a v2：请说明阻塞原因',
        '取消 task-artifact-a v2：请说明取消原因',
      ].join('\n'),
    });
    expect(first.uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(send.mock.calls[0]?.[0].text).not.toMatch(
      /obsidian:\/\/|localhost|127\.0\.0\.1|10_Tasks|\/Users\/|token|听记原文/u,
    );
  });

  it('rejects an Artifact summary containing a private local path', async () => {
    const acceptance = object({
      artifact: {
        reference: 'task-artifact-a@v2',
        summary: '结果保存在 /Users/example/private.md',
        evidenceCount: 1,
        checks: { met: 1, partial: 0, notMet: 0 },
      },
    });
    const send = vi.fn<AcceptanceDelivery['send']>();

    const result = await notifyAcceptance({
      ledger: memoryLedger(),
      delivery: { send },
      target: { kind: 'self' },
      listAcceptanceObjects: async () => [acceptance],
      clock: () => new Date(NOW),
    }, acceptance);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'acceptance_payload_rejected',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', []],
    ['multiple', [object(), object({ objectId: 'task-artifact-b', version: 1 })]],
  ])('blocks delivery when the title has %s visible matches', async (_label, visible) => {
    const ledger = memoryLedger();
    const send = vi.fn<AcceptanceDelivery['send']>();

    const result = await notifyAcceptance({
      ledger,
      delivery: { send },
      target: { kind: 'self' },
      listAcceptanceObjects: async () => visible,
      clock: () => new Date(NOW),
    }, object());

    expect(result).toMatchObject({
      status: 'conflict',
      errorCode: 'acceptance_location_conflict',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { kind: 'group' as const, groupId: 'group-a' },
    { kind: 'user' as const, userId: 'other-user' },
  ])('refuses a non-self target before delivery', async (target) => {
    const acceptance = object();
    const send = vi.fn<AcceptanceDelivery['send']>();

    const result = await notifyAcceptance({
      ledger: memoryLedger(),
      delivery: { send },
      target,
      listAcceptanceObjects: async () => [acceptance],
      clock: () => new Date(NOW),
    }, acceptance);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'acceptance_recipient_not_self',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    'obsidian://open?vault=Private',
    '/Users/example/secret.md',
    '客户合同回款 12345678',
    'token=synthetic-secret',
  ])('rejects an unsafe title before serializing the payload: %s', async (title) => {
    const acceptance = object({ title });
    const send = vi.fn<AcceptanceDelivery['send']>();

    const result = await notifyAcceptance({
      ledger: memoryLedger(),
      delivery: { send },
      target: { kind: 'self' },
      listAcceptanceObjects: async () => [acceptance],
      clock: () => new Date(NOW),
    }, acceptance);

    expect(result).toMatchObject({
      status: 'failed',
      errorCode: 'acceptance_payload_rejected',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('reuses the same UUID when a failed delivery is retried', async () => {
    const acceptance = object();
    const ledger = memoryLedger();
    const uuids: string[] = [];
    const send = vi.fn<AcceptanceDelivery['send']>(async (message) => {
      uuids.push(message.uuid);
      if (uuids.length === 1) {
        throw Object.assign(new Error('synthetic failure'), {
          code: 'dingtalk_delivery_unavailable',
        });
      }
      return { taskId: 'task-dingtalk-retry', messageId: null };
    });
    const context = {
      ledger,
      delivery: { send },
      target: { kind: 'self' as const },
      listAcceptanceObjects: async () => [acceptance],
      clock: () => new Date(NOW),
    };

    await expect(notifyAcceptance(context, acceptance)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'dingtalk_delivery_unavailable',
    });
    await expect(notifyAcceptance(context, acceptance)).resolves.toMatchObject({
      status: 'sent',
      taskId: 'task-dingtalk-retry',
    });
    expect(uuids).toHaveLength(2);
    expect(uuids[0]).toBe(uuids[1]);
  });
});
