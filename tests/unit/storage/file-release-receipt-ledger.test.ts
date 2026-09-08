import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import type { ReleaseReceipt } from '../../../src/domain/release-receipt.js';
import {
  FileReleaseReceiptLedger,
  LEGACY_MULTICA_RECEIPT_METADATA_KEY,
} from '../../../src/storage/file-release-receipt-ledger.js';
import { createTestServiceContext } from '../../helpers/service-context.js';

const HASH = 'd'.repeat(64);
const execFileAsync = promisify(execFile);

function currentReceipt(acceptanceId: string): ReleaseReceipt {
  const receiptId = `release-receipt:${acceptanceId}`;
  return {
    schemaVersion: 1,
    receiptId,
    acceptanceId,
    atlTaskId: 'task-legacy-ledger',
    eventId: 'evt-legacy-ledger',
    headSha: 'a'.repeat(40),
    status: 'passed',
    startedAt: '2026-08-21T01:00:00.000Z',
    completedAt: '2026-08-21T02:00:00.000Z',
    rejectionReason: null,
    verification: {
      nodeVersion: 'v24.15.0',
      headCheck: { command: 'git rev-parse HEAD', observedHeadSha: 'a'.repeat(40), matched: true },
      candidateCheck: {
        statusCommand: 'git status --porcelain=v1 --untracked-files=all',
        cleanBefore: true,
        cleanAfter: true,
        postHeadCommand: 'git rev-parse HEAD',
        observedHeadShaAfter: 'a'.repeat(40),
        headMatchedAfter: true,
      },
      commands: [{ command: 'pnpm test', exitCode: 0, durationMs: 1, outputTail: 'passed' }],
    },
    merge: {
      repository: 'PANGKAIFENG/personal-ai-workbench',
      pr: '20',
      headSha: 'a'.repeat(40),
      mergeSha: 'b'.repeat(40),
      prStatus: 'merged',
      issueStatus: 'closed',
    },
    plugin: {
      backup: null,
      install: {
        pluginDir: '/tmp/plugin',
        manifest: 'agent-task-loop',
        version: '0.9.1',
        fileHashes: [{ path: 'qianwen-accessibility-helper', sha256: HASH, mode: 0o755 }],
        installedAt: '2026-08-21T01:30:00.000Z',
      },
      rollback: null,
    },
    liveVerification: {
      canaryTaskId: 'task-canary',
      multicaIssueId: 'issue-id',
      multicaRunId: 'run-id',
      dingTalkMessageId: 'message-id',
      dingTalkStreamEventId: 'stream-id',
      passed: true,
      summary: 'passed',
    },
    readBack: {
      github: {
        repository: 'PANGKAIFENG/personal-ai-workbench',
        mergeSha: 'b'.repeat(40),
        prStatus: 'merged',
        issueStatus: 'closed',
        headSha: 'a'.repeat(40),
      },
      multica: {
        issueId: 'issue-id',
        issueIdentifier: 'TEP-53',
        receiptMetadataKey: 'atl_release_receipt',
        receiptMetadataValue: JSON.stringify({ schema_version: 1, receipt_id: receiptId }),
      },
      dingtalk: { messageId: 'message-id', streamEventId: 'stream-id' },
      atl: {
        taskId: 'task-legacy-ledger',
        taskStatus: 'done',
        frontmatterPath: '/tmp/task.md',
        finalSummary: 'done',
      },
    },
  };
}

describe('FileReleaseReceiptLedger legacy compatibility', () => {
  it('loads and preserves a schema v1 comment-based receipt while saving a current receipt', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = join(harness.root, '.atl-runtime');
      await mkdir(runtimeRoot, { recursive: true });
      const legacy = currentReceipt('legacy-acceptance');
      const legacyReadBack = {
        ...legacy.readBack!,
        multica: {
          issueId: legacy.readBack!.multica.issueId,
          issueIdentifier: legacy.readBack!.multica.issueIdentifier,
          receiptCommentId: 'legacy-comment-id',
        },
      };
      await writeFile(join(runtimeRoot, 'multica-release-receipts.json'), `${JSON.stringify({
        schemaVersion: 1,
        receipts: [{ ...legacy, readBack: legacyReadBack }],
      }, null, 2)}\n`);

      const ledger = new FileReleaseReceiptLedger(runtimeRoot);
      expect((await ledger.get('legacy-acceptance'))?.readBack?.multica).toMatchObject({
        receiptMetadataKey: LEGACY_MULTICA_RECEIPT_METADATA_KEY,
      });

      await ledger.save(currentReceipt('current-acceptance'));

      expect(await ledger.list()).toHaveLength(2);
      const persisted = JSON.parse(await readFile(
        join(runtimeRoot, 'multica-release-receipts.json'),
        'utf8',
      )) as { receipts: unknown[] };
      expect(persisted.receipts).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it('preserves concurrent saves through one ledger instance', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = join(harness.root, '.atl-runtime');
      const ledger = new FileReleaseReceiptLedger(runtimeRoot);

      await Promise.all([
        ledger.save(currentReceipt('concurrent-same-instance-a')),
        ledger.save(currentReceipt('concurrent-same-instance-b')),
      ]);

      expect((await ledger.list()).map((entry) => entry.acceptanceId)).toEqual([
        'concurrent-same-instance-a',
        'concurrent-same-instance-b',
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it('preserves concurrent saves through separate instances sharing one file', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = join(harness.root, '.atl-runtime');
      const first = new FileReleaseReceiptLedger(runtimeRoot);
      const second = new FileReleaseReceiptLedger(runtimeRoot);

      await Promise.all([
        first.save(currentReceipt('concurrent-cross-instance-a')),
        second.save(currentReceipt('concurrent-cross-instance-b')),
      ]);

      expect((await first.list()).map((entry) => entry.acceptanceId)).toEqual([
        'concurrent-cross-instance-a',
        'concurrent-cross-instance-b',
      ]);
    } finally {
      await harness.cleanup();
    }
  });

  it('preserves concurrent saves from separate Node processes', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = join(harness.root, '.atl-runtime');
      const ledgerModule = pathToFileURL(join(
        process.cwd(),
        'src/storage/file-release-receipt-ledger.ts',
      )).href;
      const tsxCli = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
      const script = [
        `import { FileReleaseReceiptLedger } from ${JSON.stringify(ledgerModule)};`,
        'void (async () => {',
        '  const receipt = JSON.parse(process.env.ATL_TEST_RECEIPT);',
        '  await new FileReleaseReceiptLedger(process.env.ATL_TEST_RUNTIME_ROOT).save(receipt);',
        '})();',
      ].join('\n');
      const acceptanceIds = Array.from(
        { length: 6 },
        (_, index) => `concurrent-process-${index}`,
      );

      await Promise.all(acceptanceIds.map((acceptanceId) => execFileAsync(
        process.execPath,
        [tsxCli, '--eval', script],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ATL_TEST_RECEIPT: JSON.stringify(currentReceipt(acceptanceId)),
            ATL_TEST_RUNTIME_ROOT: runtimeRoot,
          },
        },
      )));

      expect((await new FileReleaseReceiptLedger(runtimeRoot).list()).map((entry) => (
        entry.acceptanceId
      ))).toEqual(acceptanceIds);
    } finally {
      await harness.cleanup();
    }
  });

  it('allows a later save after an earlier queued save fails', async () => {
    const harness = await createTestServiceContext();
    try {
      const runtimeRoot = join(harness.root, '.atl-runtime');
      const path = join(runtimeRoot, 'multica-release-receipts.json');
      await mkdir(runtimeRoot, { recursive: true });
      await writeFile(path, '{ invalid json');
      const first = new FileReleaseReceiptLedger(runtimeRoot);
      const second = new FileReleaseReceiptLedger(runtimeRoot);

      await expect(first.save(currentReceipt('failed-save'))).rejects.toBeInstanceOf(SyntaxError);
      await writeFile(path, `${JSON.stringify({ schemaVersion: 1, receipts: [] })}\n`);
      await second.save(currentReceipt('recovered-save'));

      expect((await first.list()).map((entry) => entry.acceptanceId)).toEqual(['recovered-save']);
    } finally {
      await harness.cleanup();
    }
  });
});
