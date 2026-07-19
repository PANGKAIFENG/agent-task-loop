import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExtractedCandidate } from '../../../src/obsidian-plugin/candidate-extractor.js';
import {
  CaptureController,
  type CaptureControllerDependencies,
} from '../../../src/obsidian-plugin/capture-controller.js';
import type { CaptureState } from '../../../src/obsidian-plugin/settings.js';
import type { SyncSourceRecord } from '../../../src/obsidian-plugin/sync-source-reader.js';
import { captureTask } from '../../../src/services/capture-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const contexts: TestServiceContext[] = [];
const NOW = new Date('2026-07-17T06:30:00.000Z');

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

function source(index: number): SyncSourceRecord {
  return {
    fingerprint: index.toString(16).padStart(64, '0'),
    sourceDate: '2026-07-17',
    sourceNote: '笔记同步助手/2026-07-17/同步助手_2026-07-17.md',
    recordedAt: `2026-07-17T0${index}:00:00+08:00`,
    content: `#待办 调研工具 ${index}`,
  };
}

function candidate(record: SyncSourceRecord): ExtractedCandidate {
  return {
    title: `调研工具 ${record.content.at(-1)}`,
    summary: `整理工具 ${record.content.at(-1)} 的能力和适用场景。`,
    priority: 'normal',
    topicKey: `工具-${record.content.at(-1)}`,
    sourceRecordFingerprint: record.fingerprint,
    sourceQuote: record.content,
  };
}

async function fixture(overrides: Partial<CaptureControllerDependencies> = {}) {
  const context = await createTestServiceContext({ now: NOW });
  contexts.push(context);
  const records = [source(1), source(2)];
  let state: CaptureState = {
    captureStateVersion: 2,
    lastSuccessfulScanAt: null,
    reviewedFingerprints: [],
    processedRecordFingerprints: [],
  };
  const saveState = vi.fn(async (next: CaptureState) => {
    state = structuredClone(next);
  });
  const dependencies: CaptureControllerDependencies = {
    context: context.ctx,
    readSources: vi.fn(async () => ({ filesScanned: 1, records })),
    extractCandidates: vi.fn(async (sourceRecords) => sourceRecords.map(candidate)),
    getState: () => structuredClone(state),
    saveState,
    clock: () => new Date(NOW),
    scanId: () => 'scan-001',
    ...overrides,
  };
  return {
    context,
    controller: new CaptureController(dependencies),
    records,
    saveState,
    getState: () => state,
  };
}

describe('CaptureController', () => {
  it('writes selected candidates while leaving unselected candidates pending', async () => {
    const test = await fixture();
    const prepared = await test.controller.scan();

    expect(prepared.candidates).toHaveLength(2);
    expect(prepared).toMatchObject({
      scanId: 'scan-001',
      filesScanned: 1,
      recordsConsidered: 2,
      completedAt: NOW.toISOString(),
    });

    const result = await test.controller.commit(
      prepared,
      [prepared.candidates[0]!.candidateId],
    );

    expect(result.createdTaskIds).toHaveLength(1);
    expect(result.existingTaskIds).toEqual([]);
    const tasks = await test.context.ctx.tasks.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: 'inbox',
      reviewState: 'candidate',
      autoExecutable: false,
      origin: 'obsidian_sync',
      sourceNote: test.records[0]!.sourceNote,
    });
    expect(test.getState()).toEqual({
      captureStateVersion: 2,
      lastSuccessfulScanAt: NOW.toISOString(),
      reviewedFingerprints: [prepared.candidates[0]!.candidateId],
      processedRecordFingerprints: [test.records[0]!.fingerprint],
    });
  });

  it('marks an explicitly ignored candidate resolved without creating a task', async () => {
    const test = await fixture();
    const prepared = await test.controller.scan();

    await test.controller.commit(
      prepared,
      [],
      [prepared.candidates[0]!.candidateId],
    );

    await expect(test.context.ctx.tasks.list()).resolves.toEqual([]);
    expect(test.getState()).toEqual({
      captureStateVersion: 2,
      lastSuccessfulScanAt: NOW.toISOString(),
      reviewedFingerprints: [prepared.candidates[0]!.candidateId],
      processedRecordFingerprints: [test.records[0]!.fingerprint],
    });
  });

  it('does not advance scan state when the user only scans and cancels the modal', async () => {
    const test = await fixture();

    await test.controller.scan();

    expect(test.saveState).not.toHaveBeenCalled();
    expect(test.getState()).toEqual({
      captureStateVersion: 2,
      lastSuccessfulScanAt: null,
      reviewedFingerprints: [],
      processedRecordFingerprints: [],
    });
    await expect(test.context.ctx.tasks.list()).resolves.toEqual([]);
  });

  it('does not advance state after a partial write and retries idempotently', async () => {
    let shouldFail = true;
    const capture = vi.fn(async (...args: Parameters<typeof captureTask>) => {
      if (args[1].title.endsWith('2') && shouldFail) {
        shouldFail = false;
        throw new Error('synthetic second write failure');
      }
      return captureTask(...args);
    });
    const test = await fixture({ capture });
    const prepared = await test.controller.scan();
    const selected = prepared.candidates.map(({ candidateId }) => candidateId);

    await expect(test.controller.commit(prepared, selected))
      .rejects.toThrow('synthetic second write failure');
    expect(test.saveState).not.toHaveBeenCalled();
    await expect(test.context.ctx.tasks.list()).resolves.toHaveLength(1);

    const retry = await test.controller.commit(prepared, selected);

    expect(retry.existingTaskIds).toHaveLength(1);
    expect(retry.createdTaskIds).toHaveLength(1);
    await expect(test.context.ctx.tasks.list()).resolves.toHaveLength(2);
    expect(test.getState().lastSuccessfulScanAt).toBe(NOW.toISOString());
  });

  it('filters previously reviewed candidates after extraction', async () => {
    const test = await fixture();
    const first = await test.controller.scan();
    await test.controller.commit(
      first,
      [],
      first.candidates.map(({ candidateId }) => candidateId),
    );

    const second = await test.controller.scan();

    expect(second.candidates).toEqual([]);
  });

  it('does not send previously processed source records back to the model', async () => {
    const extractCandidates = vi.fn(async (records: readonly SyncSourceRecord[]) => (
      records.map(candidate)
    ));
    const test = await fixture({
      extractCandidates,
      getState: () => ({
        captureStateVersion: 2,
        lastSuccessfulScanAt: NOW.toISOString(),
        reviewedFingerprints: [],
        processedRecordFingerprints: [source(1).fingerprint],
      } as CaptureState),
    });

    const prepared = await test.controller.scan();

    expect(extractCandidates).toHaveBeenCalledWith([test.records[1]]);
    expect(prepared.recordsConsidered).toBe(1);
  });

  it('keeps source records pending when the model returns no candidates', async () => {
    const test = await fixture({ extractCandidates: vi.fn(async () => []) });
    const prepared = await test.controller.scan();

    await test.controller.commit(prepared, []);

    expect(test.getState()).toEqual({
      captureStateVersion: 2,
      lastSuccessfulScanAt: NOW.toISOString(),
      reviewedFingerprints: [],
      processedRecordFingerprints: [],
    });
  });

  it('clusters candidates with the same topic while retaining every source record', async () => {
    const test = await fixture({
      extractCandidates: vi.fn(async (records: readonly SyncSourceRecord[]) => (
        records.map((record, index) => ({
          ...candidate(record),
          title: index === 0 ? '设计 Obsidian 数据首页' : '补充 Obsidian 每日面板',
          topicKey: 'obsidian-data-home',
        }))
      )),
    });

    const prepared = await test.controller.scan();

    expect(prepared.candidates).toHaveLength(1);
    expect(prepared.candidates[0]).toMatchObject({
      topicKey: 'obsidian-data-home',
      sourceRecordFingerprints: test.records.map(({ fingerprint }) => fingerprint),
    });
    expect(prepared.candidates[0]?.sourceEvidence).toHaveLength(2);

    await test.controller.commit(prepared, [prepared.candidates[0]!.candidateId]);

    const [task] = await test.context.ctx.tasks.list();
    expect(task?.body).toContain(test.records[0]!.content);
    expect(task?.body).toContain(test.records[1]!.content);
    expect(test.getState().processedRecordFingerprints).toEqual(
      test.records.map(({ fingerprint }) => fingerprint),
    );
  });
});
