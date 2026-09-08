import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MULTICA_RELEASE_RECEIPT_METADATA_KEY,
  MulticaCallTimedOutError,
  MulticaCliConnector,
  MulticaConnectorConfigError,
  multicaReleaseReceiptMetadataValue,
  type MulticaCommandRequest,
  type MulticaCommandRunner,
} from '../../../src/connectors/multica-cli-connector.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROFILE = 'desktop-api.multica.ai';
const BINARY = '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';

// The wire fixture holds the SYNTHETIC CAPTURE of the real CLI
// (`issue metadata list --output json`, shipped binary, read-only): a bare
// top-level object map whose values are the raw `--value` strings. A JSON
// receipt reference survives byte-exact — quoting included — which is what
// the exact-match read-back depends on.
const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/multica/cli',
);

function loadFixture(name: string): Promise<string> {
  return readFile(join(fixturesRoot, name), 'utf8');
}

const receipt = {
  receiptId: 'release-receipt:rc-acceptance:0f0a0b0c0d0e',
  body: [
    'ATL 发布完成，Release Receipt 已生成并回读。',
    '- merge_sha: ffffffffffffffffffffffffffffffffffffffff',
  ].join('\n'),
};

function receiptValue(overrides: Partial<typeof receipt> = {}): string {
  return multicaReleaseReceiptMetadataValue({ ...receipt, ...overrides });
}

interface MetadataStore {
  metadata: Record<string, string>;
  setFailsWith?: Error | undefined;
  /** The set mutates the store BEFORE failing (a landed-but-unconfirmed write). */
  setLandsBeforeFailure?: boolean | undefined;
  listFailsWith?: Error | undefined;
  /** Overrides the map the read AFTER `metadata set` returns (default: store). */
  listAfterSet?: Record<string, string> | undefined;
}

// Stateful metadata-only CLI: answers `issue metadata list/set` from a mutable
// map and throws on ANY other command — so a test that lets a comment add or a
// run-starting status change slip through fails on the unexpected command.
class RecordingMetadataRunner {
  readonly requests: MulticaCommandRequest[] = [];
  readonly store: MetadataStore;
  private setCount = 0;

  constructor(store: MetadataStore) {
    this.store = store;
  }

  run: MulticaCommandRunner = async (request) => {
    this.requests.push(request);
    const { args } = request;
    if (args.includes('metadata') && args.includes('list')) {
      if (this.store.listFailsWith !== undefined) throw this.store.listFailsWith;
      const map = this.setCount > 0 && this.store.listAfterSet !== undefined
        ? this.store.listAfterSet
        : this.store.metadata;
      return { stdout: `${JSON.stringify(map)}\n`, stderr: '' };
    }
    if (args.includes('metadata') && args.includes('set')) {
      if (this.store.setFailsWith === undefined || this.store.setLandsBeforeFailure === true) {
        this.setCount += 1;
        const key = args[args.indexOf('--key') + 1] ?? '';
        const value = args[args.indexOf('--value') + 1] ?? '';
        this.store.metadata = { ...this.store.metadata, [key]: value };
      }
      if (this.store.setFailsWith !== undefined) throw this.store.setFailsWith;
      return { stdout: `${JSON.stringify(this.store.metadata)}\n`, stderr: '' };
    }
    throw new Error(`unexpected command: ${args.join(' ')}`);
  };

  commands(): string[][] {
    return this.requests.map(({ args }) => [...args]);
  }

  setCommands(): string[][] {
    return this.commands().filter((args) => args.includes('set'));
  }
}

function connectorFor(runner: MulticaCommandRunner): MulticaCliConnector {
  return new MulticaCliConnector({
    binaryPath: BINARY,
    profile: PROFILE,
    workspaceId: WORKSPACE_ID,
    projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    runner,
  });
}

describe('multicaReleaseReceiptMetadataValue', () => {
  it('serializes a versioned receipt reference with stable field order', () => {
    const value = multicaReleaseReceiptMetadataValue(receipt);
    expect(JSON.parse(value)).toEqual({
      schema_version: 1,
      receipt_id: receipt.receiptId,
      body: receipt.body,
    });
    // Deterministic serialization: the same receipt always yields the same
    // bytes, so an exact-match read-back is a stable equality.
    expect(multicaReleaseReceiptMetadataValue(receipt)).toBe(value);
    expect(
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    ).toBe(true);
  });
});

describe('writeReleaseReceipt', () => {
  it('parses the captured metadata list wire: bare object map of raw strings', async () => {
    const captured = await loadFixture('metadata-list.json');
    const runner = new RecordingMetadataRunner({
      metadata: JSON.parse(captured) as Record<string, string>,
    });
    const connector = connectorFor(runner.run);

    // The captured map already holds this exact receipt reference.
    const capturedMap = JSON.parse(captured) as Record<string, string>;
    const result = await connector.writeReleaseReceipt(ISSUE_ID, {
      receiptId: 'release-receipt:rc-acceptance:0f0a0b0c0d0e',
      body: 'ATL 发布完成，Release Receipt 已生成并回读。',
    });
    expect(result).toEqual({
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: capturedMap[MULTICA_RELEASE_RECEIPT_METADATA_KEY],
      deduplicated: true,
    });
    expect(runner.setCommands()).toHaveLength(0);
  });

  it('never treats a bare-string legacy envelope as metadata', async () => {
    // Fail-closed wire check: a `metadata list` that is not a JSON object map
    // (here a legacy bare string) cannot prove the pre-write state, so no
    // unconditional set is allowed.
    const requests: MulticaCommandRequest[] = [];
    const runner: MulticaCommandRunner = async (request) => {
      requests.push(request);
      if (request.args.includes('list')) {
        return { stdout: '"legacy metadata string"\n', stderr: '' };
      }
      if (request.args.includes('set')) {
        return { stdout: '{}\n', stderr: '' };
      }
      throw new Error(`unexpected command: ${request.args.join(' ')}`);
    };
    const connector = connectorFor(runner);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('metadata pre-read'),
    });
    expect(requests.filter(({ args }) => args.includes('set'))).toHaveLength(0);
  });

  it('writes one typed metadata row and requires the exact value back', async () => {
    const runner = new RecordingMetadataRunner({ metadata: {} });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: receiptValue(),
      deduplicated: false,
    });

    const set = runner.setCommands().at(0);
    expect(set).toBeDefined();
    expect(set).toContain(ISSUE_ID);
    expect(set?.[set.indexOf('--key') + 1]).toBe(MULTICA_RELEASE_RECEIPT_METADATA_KEY);
    expect(set?.[set.indexOf('--type') + 1]).toBe('string');
    expect(set?.[set.indexOf('--value') + 1]).toBe(receiptValue());
    // Read-before and read-after both went through the stable key surface.
    expect(runner.commands().filter((args) => args.includes('list'))).toHaveLength(2);
    expect(runner.setCommands()).toHaveLength(1);
    // The trusted system channel never touches the member-comment surface and
    // never emits a run-starting command.
    expect(runner.commands().some((args) => args.includes('comment'))).toBe(false);
    expect(runner.commands().some((args) => args.includes('status'))).toBe(false);
  });

  it('deduplicates without writing when the exact value already sits under the key', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: { [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: receiptValue() },
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: receiptValue(),
      deduplicated: true,
    });
    expect(runner.setCommands()).toHaveLength(0);
    expect(runner.commands().some((args) => args.includes('comment'))).toBe(false);
  });

  it('stays remote_write_unknown when the post-write read-back does not match exactly', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: {},
      // The platform stored something else under the key (or echoed a stale
      // row): the exact-match gate must refuse to call it a write.
      listAfterSet: {
        [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: receiptValue({ body: 'different bytes' }),
      },
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('metadata read-back'),
    });
  });

  it('heals an unknown set outcome through the stable-key read-back', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: {},
      setFailsWith: new MulticaCallTimedOutError(['issue', 'metadata', 'set']),
      setLandsBeforeFailure: true,
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: receiptValue(),
      deduplicated: true,
    });
    expect(runner.setCommands()).toHaveLength(1);
  });

  it('stays remote_write_unknown when neither the set nor the heal read-back proves the write', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: {},
      setFailsWith: new MulticaCallTimedOutError(['issue', 'metadata', 'set']),
      listFailsWith: new MulticaCallTimedOutError(['issue', 'metadata', 'list']),
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('metadata pre-read'),
    });
    expect(runner.setCommands()).toHaveLength(0);
  });

  it('fails closed on a conflicting value recorded for the same receipt id', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: {
        [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: receiptValue({
          body: 'tampered or drifted receipt body',
        }),
      },
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'receipt_conflict',
      reason: expect.stringContaining(receipt.receiptId),
    });
    expect(runner.setCommands()).toHaveLength(0);
    expect(runner.commands().some((args) => args.includes('comment'))).toBe(false);
  });

  it('fails closed on an unparseable value sitting under the receipt key', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: { [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: 'not a receipt reference' },
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'receipt_conflict',
      reason: expect.stringContaining('not a versioned receipt reference'),
    });
    expect(runner.setCommands()).toHaveLength(0);
  });

  it('supersedes a recorded reference from a different receipt id', async () => {
    const runner = new RecordingMetadataRunner({
      metadata: {
        [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: receiptValue({
          receiptId: 'release-receipt:rc-acceptance:earlier',
        }),
      },
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: receiptValue(),
      deduplicated: false,
    });
    expect(runner.setCommands()).toHaveLength(1);
  });

  it('fails closed without metadata set when a conflicting receipt pre-read times out', async () => {
    const conflictingValue = receiptValue({ body: 'different trusted bytes' });
    const runner = new RecordingMetadataRunner({
      metadata: { [MULTICA_RELEASE_RECEIPT_METADATA_KEY]: conflictingValue },
      listFailsWith: new MulticaCallTimedOutError([
        'issue', 'metadata', 'list', ISSUE_ID,
      ]),
    });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, receipt);
    expect(result).toEqual({
      status: 'remote_write_unknown',
      reason: expect.stringContaining('metadata pre-read'),
    });
    expect(runner.store.metadata[MULTICA_RELEASE_RECEIPT_METADATA_KEY]).toBe(conflictingValue);
    expect(runner.setCommands()).toHaveLength(0);
  });

  it('rejects an oversized body before any CLI call', async () => {
    const runner = new RecordingMetadataRunner({ metadata: {} });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, {
      ...receipt,
      body: 'x'.repeat(2_001),
    });
    expect(result).toEqual({
      status: 'invalid_receipt',
      reason: expect.stringContaining('body'),
    });
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects a control-unsafe body before any CLI call', async () => {
    const runner = new RecordingMetadataRunner({ metadata: {} });
    const connector = connectorFor(runner.run);

    const result = await connector.writeReleaseReceipt(ISSUE_ID, {
      ...receipt,
      body: `line${String.fromCharCode(0)}break`,
    });
    expect(result).toEqual({ status: 'invalid_receipt', reason: expect.any(String) });
    expect(runner.requests).toHaveLength(0);
  });

  it('rejects an unsafe receipt id before any CLI call', async () => {
    const runner = new RecordingMetadataRunner({ metadata: {} });
    const connector = connectorFor(runner.run);

    const tooLong = await connector.writeReleaseReceipt(ISSUE_ID, {
      ...receipt,
      receiptId: `release-receipt:${'r'.repeat(600)}`,
    });
    expect(tooLong).toEqual({ status: 'invalid_receipt', reason: expect.any(String) });

    const controlUnsafe = await connector.writeReleaseReceipt(ISSUE_ID, {
      ...receipt,
      receiptId: `release-receipt:${String.fromCharCode(1)}`,
    });
    expect(controlUnsafe).toEqual({ status: 'invalid_receipt', reason: expect.any(String) });
    expect(runner.requests).toHaveLength(0);
  });

  it('throws on a malformed issue id without contacting the CLI', async () => {
    const runner = new RecordingMetadataRunner({ metadata: {} });
    const connector = connectorFor(runner.run);

    await expect(
      connector.writeReleaseReceipt('not-a-uuid', receipt),
    ).rejects.toBeInstanceOf(MulticaConnectorConfigError);
    expect(runner.requests).toHaveLength(0);
  });
});
