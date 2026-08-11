import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AcceptanceNotificationRecord } from '../../../src/services/notify-acceptance.js';
import { FileAcceptanceNotificationLedger } from '../../../src/storage/file-acceptance-notification-ledger.js';

const roots: string[] = [];

async function runtimeRoot(): Promise<string> {
  const vaultRoot = join(
    tmpdir(),
    `atl-acceptance-ledger-${process.pid}-${Date.now()}-${roots.length}`,
  );
  roots.push(vaultRoot);
  const root = join(vaultRoot, '.atl-runtime');
  await mkdir(root, { recursive: true });
  return root;
}

function record(overrides: Partial<AcceptanceNotificationRecord> = {}): AcceptanceNotificationRecord {
  return {
    schemaVersion: 1,
    idempotencyKey: 'artifact:task-synthetic:1',
    objectType: 'artifact',
    objectId: 'task-synthetic',
    version: 1,
    uuid: 'cc9169e9-5326-54f8-a190-419f55ae8004',
    status: 'sent',
    attemptedAt: '2026-08-11T14:00:00.000Z',
    errorCode: null,
    taskId: 'task-dingtalk-synthetic',
    messageId: null,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('FileAcceptanceNotificationLedger', () => {
  it('atomically persists records without notification payload content', async () => {
    const root = await runtimeRoot();
    const ledger = new FileAcceptanceNotificationLedger(root);
    const sent = record();

    await ledger.withLock(async () => ledger.save(sent));

    const reloaded = new FileAcceptanceNotificationLedger(root);
    await expect(reloaded.get(sent.idempotencyKey)).resolves.toEqual(sent);
    await expect(reloaded.list()).resolves.toEqual([sent]);
    const raw = await readFile(join(root, 'acceptance-notifications.json'), 'utf8');
    expect(raw).not.toContain('Staywork');
    expect(JSON.parse(raw)).toEqual({ schemaVersion: 1, records: [sent] });
  });

  it('serializes operations across ledger instances', async () => {
    const root = await runtimeRoot();
    const left = new FileAcceptanceNotificationLedger(root);
    const right = new FileAcceptanceNotificationLedger(root);
    let releaseLeft!: () => void;
    let leftEntered!: () => void;
    const leftReady = new Promise<void>((resolve) => { leftEntered = resolve; });
    const leftRelease = new Promise<void>((resolve) => { releaseLeft = resolve; });
    const order: string[] = [];

    const first = left.withLock(async () => {
      order.push('left-enter');
      leftEntered();
      await leftRelease;
      await left.save(record());
      order.push('left-exit');
    });
    await leftReady;
    const second = right.withLock(async () => {
      order.push('right-enter');
      expect(await right.get('artifact:task-synthetic:1')).not.toBeNull();
      order.push('right-exit');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(order).toEqual(['left-enter']);

    releaseLeft();
    await Promise.all([first, second]);

    expect(order).toEqual(['left-enter', 'left-exit', 'right-enter', 'right-exit']);
  });
});
