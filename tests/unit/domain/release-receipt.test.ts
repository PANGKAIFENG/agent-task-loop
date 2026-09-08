import { describe, expect, it } from 'vitest';

import { releaseAcceptanceForApproval } from '../../../src/domain/release-acceptance.js';
import {
  releaseReceiptGaps,
  releaseReceiptSchema,
  type ReleaseReceipt,
} from '../../../src/domain/release-receipt.js';
import type { MulticaEvent } from '../../../src/domain/multica-event.js';

const TASK_ID = 'task-20260821-rel00001';
const HEAD_SHA = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const SHA256 = 'd'.repeat(64);

function rcEvent(): MulticaEvent {
  return {
    schemaVersion: 1,
    eventId: 'evt-rc-0001',
    atlTaskId: TASK_ID,
    state: 'release_candidate_ready',
    summary: 'Fresh CR passed on the immutable candidate',
    decision: null,
    recoverability: null,
    artifactRefs: [],
    release: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      issue: null,
      pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
      headSha: HEAD_SHA,
    },
    occurredAt: '2026-08-21T02:00:00.000Z',
  };
}

const acceptance = releaseAcceptanceForApproval({
  event: rcEvent(),
  streamEventId: 'stream-approve-0001',
  freshReviewRef: 'TEP-51',
  acceptedAt: '2026-08-21T02:05:00.000Z',
});

function completeReceipt(overrides: Partial<ReleaseReceipt> = {}): ReleaseReceipt {
  return {
    schemaVersion: 1,
    receiptId: `release-receipt:${acceptance.acceptanceId}`,
    acceptanceId: acceptance.acceptanceId,
    atlTaskId: TASK_ID,
    eventId: acceptance.eventId,
    headSha: HEAD_SHA,
    status: 'passed',
    startedAt: '2026-08-21T02:06:00.000Z',
    completedAt: '2026-08-21T02:09:00.000Z',
    rejectionReason: null,
    verification: {
      nodeVersion: 'v24.15.0',
      headCheck: { command: 'git rev-parse HEAD', observedHeadSha: HEAD_SHA, matched: true },
      candidateCheck: {
        statusCommand: 'git status --porcelain=v1 --untracked-files=all',
        cleanBefore: true,
        cleanAfter: true,
        postHeadCommand: 'git rev-parse HEAD',
        observedHeadShaAfter: HEAD_SHA,
        headMatchedAfter: true,
      },
      commands: [
        {
          command: 'pnpm --dir apps/agent-task-loop test',
          exitCode: 0,
          durationMs: 1_000,
          outputTail: 'Test Files 10 passed',
        },
      ],
    },
    merge: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
      headSha: HEAD_SHA,
      mergeSha: MERGE_SHA,
      prStatus: 'merged',
      issueStatus: 'closed',
    },
    plugin: {
      backup: {
        backupPath: '/tmp/backup/agent-task-loop-backup-20260821T020600Z',
        createdAt: '2026-08-21T02:06:00.000Z',
        files: [{ path: 'manifest.json', sha256: SHA256, mode: 0o644 }],
        skippedReason: null,
      },
      install: {
        pluginDir: '/tmp/plugins/agent-task-loop',
        manifest: 'agent-task-loop',
        version: '0.9.1',
        fileHashes: [
          { path: 'manifest.json', sha256: SHA256, mode: 0o644 },
          { path: 'qianwen-accessibility-helper', sha256: SHA256, mode: 0o755 },
        ],
        installedAt: '2026-08-21T02:08:00.000Z',
      },
      rollback: null,
    },
    liveVerification: {
      canaryTaskId: 'task-20260821-canary001',
      multicaIssueId: '01234567-89ab-4cde-8f01-234567890abc',
      multicaRunId: 'run-0001',
      dingTalkMessageId: 'msg-0001',
      dingTalkStreamEventId: 'stream-approve-0001',
      passed: true,
      summary: 'canary projected its terminal event and read back every system',
    },
    readBack: {
      github: {
        repository: 'PANGKAIFENG/personal-ai-workbench',
        mergeSha: MERGE_SHA,
        prStatus: 'merged',
        issueStatus: 'closed',
        headSha: HEAD_SHA,
      },
      multica: {
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-53',
        receiptMetadataKey: 'atl_release_receipt',
        receiptMetadataValue: '{"schema_version":1,"receipt_id":"release-receipt:rc-acceptance:0f0a0b0c0d0e","body":"ATL 发布完成，Release Receipt 已生成并回读。"}',
      },
      dingtalk: { messageId: 'msg-0001', streamEventId: 'stream-approve-0001' },
      atl: {
        taskId: TASK_ID,
        taskStatus: 'done',
        frontmatterPath: '/vault/10_Tasks/Archive/2026/task.md',
        finalSummary: 'released with plugin 0.9.1',
      },
    },
    ...overrides,
  };
}

describe('releaseReceiptSchema', () => {
  it('round-trips a complete receipt', () => {
    const receipt = completeReceipt();
    expect(releaseReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('rejects a receipt with a non-hex plugin hash', () => {
    expect(() => releaseReceiptSchema.parse(completeReceipt({
      plugin: {
        backup: null,
        install: {
          pluginDir: '/tmp/plugins/agent-task-loop',
          manifest: 'agent-task-loop',
          version: '0.9.1',
          fileHashes: [{ path: 'main.js', sha256: 'not-a-hash', mode: 0o644 }],
          installedAt: '2026-08-21T02:08:00.000Z',
        },
        rollback: null,
      },
    }))).toThrow(/sha256/);
  });
});

describe('releaseReceiptGaps (the done gate)', () => {
  it('passes a complete, SHA-consistent receipt', () => {
    expect(releaseReceiptGaps(completeReceipt(), acceptance)).toEqual([]);
  });

  it('rejects a receipt bound to a different acceptance or head SHA', () => {
    expect(releaseReceiptGaps(completeReceipt({
      headSha: 'e'.repeat(40),
    }), acceptance).join(' ')).toContain('differs from accepted');
  });

  it('rejects a failing or unproven fixed verification', () => {
    expect(releaseReceiptGaps(completeReceipt({
      verification: {
        nodeVersion: 'v24.15.0',
        headCheck: null,
        candidateCheck: null,
        commands: [],
      },
    }), acceptance)).toContain('fixed verification must record at least one command');
    expect(releaseReceiptGaps(completeReceipt({
      verification: {
        nodeVersion: 'v24.15.0',
        headCheck: { command: 'git rev-parse HEAD', observedHeadSha: HEAD_SHA, matched: true },
        candidateCheck: {
          statusCommand: 'git status --porcelain=v1 --untracked-files=all',
          cleanBefore: true,
          cleanAfter: true,
          postHeadCommand: 'git rev-parse HEAD',
          observedHeadShaAfter: HEAD_SHA,
          headMatchedAfter: true,
        },
        commands: [
          { command: 'pnpm --dir apps/agent-task-loop lint', exitCode: 1, durationMs: 10, outputTail: 'error' },
        ],
      },
    }), acceptance)).toContain('fixed verification recorded a failing command');
  });

  it('rejects a receipt without clean pre- and post-verification candidate evidence', () => {
    expect(releaseReceiptGaps(completeReceipt({
      verification: {
        ...completeReceipt().verification!,
        candidateCheck: null,
      },
    }), acceptance)).toContain(
      'verification must prove a clean immutable candidate before and after the fixed suite',
    );
  });

  it('rejects an unmerged or foreign PR read-back', () => {
    expect(releaseReceiptGaps(completeReceipt({
      merge: {
        repository: 'PANGKAIFENG/personal-ai-workbench',
        pr: 'https://github.com/PANGKAIFENG/personal-ai-workbench/pull/16',
        headSha: HEAD_SHA,
        mergeSha: MERGE_SHA,
        prStatus: 'open',
        issueStatus: 'open',
      },
    }), acceptance)).toContain('merge read-back PR status must be merged, got open');
  });

  it('never lets a rolled-back plugin pass the gate', () => {
    const receipt = completeReceipt();
    const gaps = releaseReceiptGaps({
      ...receipt,
      plugin: {
        ...receipt.plugin!,
        rollback: { restoredFiles: [], rolledBackAt: '2026-08-21T02:10:00.000Z' },
      },
    }, acceptance);
    expect(gaps).toContain('a rolled-back plugin must never pass the release gate');
  });

  it('rejects legacy install evidence that does not record modes', () => {
    const receipt = completeReceipt();
    const gaps = releaseReceiptGaps({
      ...receipt,
      plugin: {
        ...receipt.plugin!,
        install: {
          ...receipt.plugin!.install!,
          fileHashes: receipt.plugin!.install!.fileHashes.map(({ path, sha256 }) => ({
            path,
            sha256,
          })),
        },
      },
    }, acceptance);
    expect(gaps).toContain('plugin install receipt must record file modes');
    expect(gaps).toContain('plugin install receipt must prove the Qianwen helper is executable');
  });

  it('requires the live canary and every four-system read-back block', () => {
    expect(releaseReceiptGaps(completeReceipt({
      liveVerification: null,
    }), acceptance)[0]).toContain('live verification');
    const partialReadBack = completeReceipt();
    expect(releaseReceiptGaps({
      ...partialReadBack,
      readBack: { ...partialReadBack.readBack!, dingtalk: { messageId: '', streamEventId: 's' } },
    }, acceptance)).toContain('DingTalk read-back must reference the notice message');
    const notDone = completeReceipt();
    expect(releaseReceiptGaps({
      ...notDone,
      readBack: { ...notDone.readBack!, atl: { ...notDone.readBack!.atl, taskStatus: 'review' } },
    }, acceptance)).toContain('ATL read-back task status must be done, got review');
  });
});
