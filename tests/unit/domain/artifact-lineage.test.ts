import { describe, expect, it } from 'vitest';

import {
  relatedLineageNodes,
  validateArtifactLineage,
  type ArtifactLineageInput,
} from '../../../src/domain/artifact-lineage.js';

const ARTIFACT_SHA = 'a'.repeat(64);
const MANIFEST_SHA = 'b'.repeat(64);
const SOURCE_PACK_SHA = 'c'.repeat(64);
const CONTINUATION_MANIFEST_SHA = 'd'.repeat(64);
const CONTINUATION_PACK_SHA = 'e'.repeat(64);

function lineage(overrides: Partial<ArtifactLineageInput> = {}): ArtifactLineageInput {
  const artifact = {
    taskId: 'task-synthetic-96',
    ref: 'Artifacts/task-synthetic-96/attempt-001.md',
    version: 1,
    sha256: ARTIFACT_SHA,
  };
  return {
    taskId: 'task-synthetic-96',
    sourceRunId: 'run-synthetic-96-a',
    contextManifest: {
      manifestId: 'cm_1234567890abcdef12345678',
      sha256: MANIFEST_SHA,
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      status: 'ready',
    },
    sourceRuntimePack: {
      packId: 'pack-1234567890abcdef12345678',
      sha256: SOURCE_PACK_SHA,
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      continuationOfRunId: null,
      contextManifestId: 'cm_1234567890abcdef12345678',
      contextManifestSha256: MANIFEST_SHA,
    },
    artifactProduction: {
      identity: artifact,
      runId: 'run-synthetic-96-a',
      packId: 'pack-1234567890abcdef12345678',
    },
    currentArtifact: artifact,
    artifact,
    decision: {
      decisionId: 'decision-synthetic-96-a',
      traceId: 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4',
      artifactRef: artifact.ref,
      artifactVersion: artifact.version,
      artifactSha256: artifact.sha256,
    },
    feedback: [{
      feedbackId: 'fb_01j9z8w7q3v5x2m4n6p8',
      traceId: 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V4',
    }],
    trigger: {
      triggerId: 'trigger-synthetic-96-a',
      receiptId: 'tr_1234567890abcdef12345678',
      decisionId: 'decision-synthetic-96-a',
      artifactRef: artifact.ref,
      artifactVersion: artifact.version,
      artifactSha256: artifact.sha256,
      state: 'started',
      continuationRunId: 'run-synthetic-96-b',
    },
    continuation: {
      runId: 'run-synthetic-96-b',
      continuationOfRunId: 'run-synthetic-96-a',
      taskId: 'task-synthetic-96',
      contextManifest: {
        manifestId: 'cm_abcdef1234567890abcdef12',
        sha256: CONTINUATION_MANIFEST_SHA,
        taskId: 'task-synthetic-96',
        runId: 'run-synthetic-96-b',
        status: 'ready',
      },
      runtimePack: {
        packId: 'pack-abcdef1234567890abcdef12',
        sha256: CONTINUATION_PACK_SHA,
        taskId: 'task-synthetic-96',
        runId: 'run-synthetic-96-b',
        continuationOfRunId: 'run-synthetic-96-a',
        contextManifestId: 'cm_abcdef1234567890abcdef12',
        contextManifestSha256: CONTINUATION_MANIFEST_SHA,
      },
    },
    settlement: {
      planId: 'sp_1234567890abcdef12345678',
      receiptId: 'sr_1234567890abcdef12345678',
      decisionId: 'decision-synthetic-96-a',
      artifactRef: artifact.ref,
      artifactVersion: artifact.version,
      artifactSha256: artifact.sha256,
    },
    ...overrides,
  };
}

describe('validateArtifactLineage', () => {
  it('builds a valid graph whose stable references are traversable in both directions', () => {
    const report = validateArtifactLineage(lineage());

    expect(report.status).toBe('valid');
    expect(report.issues).toEqual([]);
    const artifactNode = `artifact:Artifacts/task-synthetic-96/attempt-001.md@v1#${ARTIFACT_SHA}`;
    expect(relatedLineageNodes(report, artifactNode)).toEqual(expect.arrayContaining([
      'decision:decision-synthetic-96-a',
      'run:run-synthetic-96-a',
      'settlement-plan:sp_1234567890abcdef12345678',
    ]));
    expect(relatedLineageNodes(report, 'decision:decision-synthetic-96-a'))
      .toContain(artifactNode);
  });

  it('rejects a Decision bound to a stale Artifact SHA', () => {
    const input = lineage();
    input.decision = { ...input.decision, artifactSha256: 'c'.repeat(64) };

    const report = validateArtifactLineage(input);

    expect(report.status).toBe('invalid');
    expect(report.issues).toContainEqual({
      code: 'artifact_decision_mismatch',
      subject: 'decision-synthetic-96-a',
    });
  });

  it('rejects a Feedback sample linked to another Decision Trace', () => {
    const input = lineage();
    input.feedback = [{
      feedbackId: 'fb_01j9z8w7q3v5x2m4n6p8',
      traceId: 'dt_01J9Z8W7Q3V5X2M4N6P8R0T2V5',
    }];

    const report = validateArtifactLineage(input);

    expect(report.issues).toContainEqual({
      code: 'feedback_trace_mismatch',
      subject: 'fb_01j9z8w7q3v5x2m4n6p8',
    });
  });

  it('rejects a continuation that does not match its Trigger receipt', () => {
    const input = lineage();
    input.continuation = {
      ...input.continuation!,
      runId: 'run-synthetic-unrelated',
    };

    const report = validateArtifactLineage(input);

    expect(report.issues).toContainEqual({
      code: 'trigger_continuation_mismatch',
      subject: 'trigger-synthetic-96-a',
    });
  });

  it('rejects a source Runtime Pack that is not bound to the exact source Manifest', () => {
    const input = lineage();
    if (input.sourceRuntimePack === null) throw new Error('Expected local production evidence');
    input.sourceRuntimePack = {
      ...input.sourceRuntimePack,
      contextManifestSha256: 'f'.repeat(64),
    };

    const report = validateArtifactLineage(input);

    expect(report.issues).toContainEqual({
      code: 'source_pack_manifest_mismatch',
      subject: 'pack-1234567890abcdef12345678',
    });
  });

  it('rejects persisted Artifact production from a different Runtime Pack', () => {
    const input = lineage();
    input.artifactProduction = {
      ...input.artifactProduction,
      packId: 'pack-ffffffffffffffffffffffff',
    };

    const report = validateArtifactLineage(input);

    expect(report.issues).toContainEqual({
      code: 'artifact_production_mismatch',
      subject: input.artifact.ref,
    });
  });

  it('rejects a continuation Pack bound to another continuation Manifest', () => {
    const input = lineage();
    if (input.continuation === null || input.continuation.executionTarget === 'multica') {
      throw new Error('Expected local continuation evidence');
    }
    input.continuation = {
      ...input.continuation,
      runtimePack: {
        ...input.continuation.runtimePack,
        contextManifestId: 'cm_ffffffffffffffffffffffff',
      },
    };

    const report = validateArtifactLineage(input);

    expect(report.issues).toContainEqual({
      code: 'continuation_pack_manifest_mismatch',
      subject: 'pack-abcdef1234567890abcdef12',
    });
  });

  it('builds a remote production chain through the execution binding without inventing a Runtime Pack', () => {
    const input = lineage({
      sourceRuntimePack: null,
      sourceExecutionBinding: {
        receiptId: 'ebr_1234567890abcdef12345678',
        taskId: 'task-synthetic-96',
        dispatchAttemptId: 'dispatch_1234567890abcdef12345678',
        manifestId: 'cm_1234567890abcdef12345678',
        manifestSha256: MANIFEST_SHA,
        issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
        runId: 'run-synthetic-96-a',
      },
      contextManifest: {
        manifestId: 'cm_1234567890abcdef12345678',
        sha256: MANIFEST_SHA,
        taskId: 'task-synthetic-96',
        runId: 'dispatch_1234567890abcdef12345678',
        status: 'ready',
      },
      artifactProduction: {
        identity: {
          taskId: 'task-synthetic-96',
          ref: 'remote-artifact://rar_1234567890abcdef12345678',
          version: 1,
          sha256: ARTIFACT_SHA,
        },
        runId: 'run-synthetic-96-a',
        executionBindingReceiptId: 'ebr_1234567890abcdef12345678',
        manifestId: 'cm_1234567890abcdef12345678',
        manifestSha256: MANIFEST_SHA,
        issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
      },
      currentArtifact: {
        taskId: 'task-synthetic-96',
        ref: 'remote-artifact://rar_1234567890abcdef12345678',
        version: 1,
        sha256: ARTIFACT_SHA,
      },
      artifact: {
        taskId: 'task-synthetic-96',
        ref: 'remote-artifact://rar_1234567890abcdef12345678',
        version: 1,
        sha256: ARTIFACT_SHA,
      },
      decision: {
        ...lineage().decision,
        artifactRef: 'remote-artifact://rar_1234567890abcdef12345678',
      },
      trigger: {
        ...lineage().trigger!,
        artifactRef: 'remote-artifact://rar_1234567890abcdef12345678',
        executionTarget: 'multica',
      },
      continuation: {
        executionTarget: 'multica',
        runId: 'run-synthetic-96-b',
        continuationOfRunId: 'run-synthetic-96-a',
        taskId: 'task-synthetic-96',
        issueId: '01a03d19-bd5f-7263-a069-6f0cfde75b8e',
      },
      settlement: {
        ...lineage().settlement!,
        artifactRef: 'remote-artifact://rar_1234567890abcdef12345678',
      },
    });

    const report = validateArtifactLineage(input);

    expect(report.issues).toEqual([]);
    expect(report.status).toBe('valid');
    expect(report.edges).toEqual(expect.arrayContaining([
      {
        from: 'context-manifest:cm_1234567890abcdef12345678',
        to: 'execution-binding:ebr_1234567890abcdef12345678',
        relation: 'bound_to',
      },
      {
        from: 'execution-binding:ebr_1234567890abcdef12345678',
        to: 'run:run-synthetic-96-a',
        relation: 'executed_as',
      },
      {
        from: 'run:run-synthetic-96-a',
        to: `artifact:remote-artifact://rar_1234567890abcdef12345678@v1#${ARTIFACT_SHA}`,
        relation: 'produced',
      },
    ]));
    expect(report.nodes.some((node) => node.startsWith('runtime-pack:'))).toBe(false);
  });
});
