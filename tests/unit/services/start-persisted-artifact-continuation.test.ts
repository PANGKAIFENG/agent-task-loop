import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MulticaAppendResponseResult,
  MulticaResearchContinuationConnector,
  MulticaResumeResult,
  MulticaVerifiedAgentSnapshot,
} from '../../../src/connectors/multica-cli-connector.js';
import { createArtifactDecisionBinding } from '../../../src/domain/artifact-decision.js';
import { artifactNodeId } from '../../../src/domain/artifact-identity.js';
import type { ContextCandidate } from '../../../src/domain/context-manifest.js';
import type { DecisionTrace } from '../../../src/domain/decision-trace.js';
import {
  projectContextSha256,
  resolveProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import type { Project } from '../../../src/domain/project.js';
import { runOutputSource } from '../../../src/domain/remote-artifact.js';
import type { Task } from '../../../src/domain/task.js';
import {
  buildContextBundle,
  taskContextVersion,
  taskDispatchContentSha256,
} from '../../../src/runner/context-bundle.js';
import { persistContextManifest } from '../../../src/runner/context-manifest-runtime.js';
import {
  ArtifactContinuationEvidenceError,
  startPersistedArtifactContinuation,
} from '../../../src/services/start-persisted-artifact-continuation.js';
import { vaultExecutionIdentity } from '../../../src/services/execution-binding-freshness.js';
import { FileArtifactDecisionRepository } from '../../../src/storage/file-artifact-decision-repository.js';
import { FileArtifactTriggerRepository } from '../../../src/storage/file-artifact-trigger-repository.js';
import { FileExecutionBindingRepository } from '../../../src/storage/file-execution-binding-repository.js';
import { FileRemoteArtifactRepository } from '../../../src/storage/file-remote-artifact-repository.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const NOW = '2026-09-01T10:00:00.000Z';
const TASK_ID = 'task-20260901-remote-continuation';
const SOURCE_RUN_ID = 'run-remote-source';
const CONTINUATION_RUN_ID = 'run-remote-continuation';
const ISSUE_ID = '01a03d19-bd5f-7263-a069-6f0cfde75b8e';
const TRACE_ID = 'dt_remotecontinuation12';
const AGENT_ID = '2e7fa123-cd0b-4469-b6a8-584aedc128dc';
const RUNTIME_ID = '5f282aa0-e717-421d-ab84-d1f0d4aab551';
const contexts: TestServiceContext[] = [];

function project(): Project {
  return {
    projectId: 'project-remote-continuation',
    name: 'Remote continuation',
    description: 'Synthetic project for remote continuation tests.',
    resources: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function task(): Task {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    title: 'Continue a remote Artifact',
    body: '\nSynthetic remote continuation fixture.\n',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: project().projectId,
    taskType: 'research',
    objective: 'Continue from an accepted remote Artifact.',
    acceptanceCriteria: ['Bind the actual Multica continuation Run.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    executionTarget: null,
    origin: 'synthetic_test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'synthetic:remote-continuation',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resolvedProject(atlProject: Project) {
  const resolution = resolveProjectContext({
    requestedProjectId: atlProject.projectId,
    sourceSignals: [],
    registry: [{
      projectId: atlProject.projectId,
      aliases: [],
      verification: 'verified',
      canonicalProjectRef: 'projects://remote-continuation/home',
      atlProjectId: atlProject.projectId,
      repoRefs: [],
    }],
    canonicalProjects: [{
      projectId: atlProject.projectId,
      ref: 'projects://remote-continuation/home',
      atlProjectId: atlProject.projectId,
      repoRefs: [],
      version: 'v1',
      sha256: 'a'.repeat(64),
    }],
    atlProjects: [{
      project: atlProject,
      ref: `atl-project://${atlProject.projectId}`,
      canonicalProjectRef: 'projects://remote-continuation/home',
      repoRefs: [],
      sha256: projectContextSha256(atlProject),
    }],
  });
  if (resolution.status !== 'resolved') throw new Error('Expected resolved project');
  return resolution;
}

interface Fixture {
  harness: TestServiceContext;
  runtimeRoot: string;
  taskId: string;
  artifactRef: string;
  decisionId: string;
  trace: DecisionTrace;
}

async function fixture(): Promise<Fixture> {
  const harness = await createTestServiceContext({ now: new Date(NOW) });
  contexts.push(harness);
  const runtimeRoot = `${harness.root}/.atl-runtime`;
  const atlProject = project();
  const sourceTask = task();
  await harness.ctx.projects.save(atlProject);
  await harness.ctx.tasks.save(sourceTask);
  const context = await buildContextBundle(sourceTask, atlProject, { allowedLocalRoots: [] });
  const candidates: ContextCandidate[] = context.blocks.map((block) => ({
    candidateId: `candidate-${block.label}`,
    category: block.category,
    sourceRef: block.sourceRef,
    version: block.version,
    expectedSha256: block.sha256,
    selection: 'selected',
    selectionReason: 'Required by the synthetic remote continuation fixture.',
    blockLabel: block.label,
  }));
  const manifest = await persistContextManifest(runtimeRoot, {
    taskId: TASK_ID,
    runId: 'dispatch_remote_continuation',
    asOf: NOW,
    projectResolution: resolvedProject(atlProject),
    context,
    candidates,
  });
  const binding = await new FileExecutionBindingRepository(runtimeRoot).createOrGet({
    taskId: TASK_ID,
    taskContextVersion: taskContextVersion(sourceTask),
    taskContentSha256: taskDispatchContentSha256(sourceTask),
    projectContextSha256: projectContextSha256(atlProject),
    vaultIdentity: await vaultExecutionIdentity(runtimeRoot),
    dispatchAttemptId: manifest.manifest.runId,
    manifestId: manifest.manifest.manifestId,
    manifestSha256: manifest.manifest.sha256,
    workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
    projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
    issueId: ISSUE_ID,
    issueIdentifier: 'TEP-999',
    assigneeType: 'agent',
    agent: {
      agentId: AGENT_ID,
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      model: 'gpt-5.6-sol',
      maxConcurrentTasks: 10,
      runtimeId: RUNTIME_ID,
      status: 'idle',
    },
    run: {
      runId: SOURCE_RUN_ID,
      agentId: AGENT_ID,
      runtimeId: RUNTIME_ID,
      status: 'completed',
    },
    createdAt: NOW,
  });
  const remote = await new FileRemoteArtifactRepository(runtimeRoot).createOrGet({
    taskId: TASK_ID,
    executionBindingReceiptId: binding.receipt.receiptId,
    workspaceId: binding.receipt.workspaceId,
    projectId: binding.receipt.projectId,
    issueId: ISSUE_ID,
    issueIdentifier: binding.receipt.issueIdentifier,
    run: {
      runId: SOURCE_RUN_ID,
      agentId: binding.receipt.agent.agentId,
      runtimeId: binding.receipt.agent.runtimeId,
      status: 'completed',
      createdAt: NOW,
      startedAt: NOW,
      completedAt: '2026-09-01T10:05:00.000Z',
    },
    sources: [runOutputSource(SOURCE_RUN_ID, 'Synthetic remote research result.')],
    createdAt: '2026-09-01T10:05:01.000Z',
  });
  const artifactRef = `remote-artifact://${remote.receipt.receiptId}`;
  const production = await new FileRemoteArtifactRepository(runtimeRoot)
    .readProductionEvidence(artifactRef);
  const currentTask = await harness.ctx.tasks.get(TASK_ID);
  await harness.ctx.tasks.save({
    ...currentTask,
    artifactRefs: [artifactRef],
    updatedAt: '2026-09-01T10:05:01.000Z',
  });
  const artifactNode = artifactNodeId(production.identity);
  const trace: DecisionTrace = {
    trace_id: TRACE_ID,
    policy_ref: 'policy.remote-continuation@v001',
    dimension: 'result-acceptance',
    input_refs: [artifactNode, `context-manifest:${manifest.manifest.manifestId}`],
    decision: 'Continue the accepted remote Artifact.',
    reasoning_summary: 'The persisted evidence supports one bounded continuation.',
    evidence_refs: [artifactNode],
    confidence: 'high',
    user_feedback: 'accepted',
    final_outcome: 'continue',
    status: 'feedback_recorded',
    feedback_summary_status: 'fresh',
    feedback_count: 1,
    latest_feedback_at: '2026-09-01T10:06:00.000Z',
    created_at: '2026-09-01T10:06:00.000Z',
    closed_at: null,
    updated_at: '2026-09-01T10:06:00.000Z',
    status_history: [],
  };
  const decision = createArtifactDecisionBinding({
    traceId: TRACE_ID,
    artifact: production.identity,
    createdAt: '2026-09-01T10:07:00.000Z',
  });
  await new FileArtifactDecisionRepository(runtimeRoot).createOrGet(decision);
  return {
    harness,
    runtimeRoot,
    taskId: TASK_ID,
    artifactRef,
    decisionId: decision.decisionId,
    trace,
  };
}

function connector(input: {
  runIds: () => string[] | Promise<string[]>;
  append?: () => MulticaAppendResponseResult;
  resume?: () => MulticaResumeResult;
  runs?: () => Array<Record<string, unknown>>;
  verifyAgent?: () => MulticaVerifiedAgentSnapshot | null;
}) {
  return {
    runIds: vi.fn(async () => input.runIds()),
    runs: vi.fn(async () => input.runs?.() ?? []),
    verifyAgent: vi.fn(async () => input.verifyAgent === undefined ? ({
      agentId: AGENT_ID,
      workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
      model: 'gpt-5.6-sol',
      maxConcurrentTasks: 10,
      runtimeId: RUNTIME_ID,
      status: 'idle',
    }) : input.verifyAgent()),
    appendResponse: vi.fn(async () => input.append?.() ?? ({
      commentId: 'comment-remote-continuation',
      deduplicated: false,
    })),
    resume: vi.fn(async () => input.resume?.() ?? ({
      status: 'confirmed',
      newRunIds: [CONTINUATION_RUN_ID],
    })),
  } as unknown as MulticaResearchContinuationConnector;
}

function remoteRun(
  runId: string,
  options: {
    deliveredCommentIds?: string[];
    triggerCommentId?: string | null;
    agentId?: string | null;
    runtimeId?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    runId,
    issueId: ISSUE_ID,
    agentId: options.agentId ?? AGENT_ID,
    runtimeId: options.runtimeId ?? RUNTIME_ID,
    status: runId === SOURCE_RUN_ID ? 'completed' : 'in_progress',
    output: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: runId === SOURCE_RUN_ID ? NOW : null,
    deliveredCommentIds: options.deliveredCommentIds ?? [],
    triggerCommentId: options.triggerCommentId ?? null,
  };
}

function dependencies(
  value: Fixture,
  remote: MulticaResearchContinuationConnector,
  createRunner = vi.fn(async () => {
    throw new Error('The local model must not load for remote production evidence');
  }),
) {
  return {
    ctx: value.harness.ctx,
    runtimeRoot: value.runtimeRoot,
    triggers: new FileArtifactTriggerRepository(value.runtimeRoot),
    traces: { get: async (traceId: string) => traceId === value.trace.trace_id
      ? value.trace
      : null },
    connector: remote,
    createRunner,
  };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('startPersistedArtifactContinuation remote production', () => {
  it('fails closed before remote continuation when the bound Task drifts', async () => {
    const value = await fixture();
    const current = await value.harness.ctx.tasks.get(TASK_ID);
    await value.harness.ctx.tasks.save({
      ...current,
      title: `${current.title} changed`,
    });
    const remote = connector({ runIds: () => [SOURCE_RUN_ID] });
    const deps = dependencies(value, remote);

    await expect(startPersistedArtifactContinuation(deps, value))
      .rejects.toBeInstanceOf(ArtifactContinuationEvidenceError);
    expect(remote.runIds).not.toHaveBeenCalled();
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('fails closed before remote continuation when the bound Project drifts', async () => {
    const value = await fixture();
    const current = await value.harness.ctx.projects.get(project().projectId);
    await value.harness.ctx.projects.save({
      ...current,
      description: `${current.description} changed`,
    });
    const remote = connector({ runIds: () => [SOURCE_RUN_ID] });
    const deps = dependencies(value, remote);

    await expect(startPersistedArtifactContinuation(deps, value))
      .rejects.toBeInstanceOf(ArtifactContinuationEvidenceError);
    expect(remote.runIds).not.toHaveBeenCalled();
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('fails closed before comment or resume when the Task drifts during baseline Run read', async () => {
    const value = await fixture();
    const baselineReadStarted = Promise.withResolvers<void>();
    const releaseBaselineRead = Promise.withResolvers<void>();
    const remote = connector({
      runIds: async () => {
        baselineReadStarted.resolve();
        await releaseBaselineRead.promise;
        return [SOURCE_RUN_ID];
      },
    });
    const deps = dependencies(value, remote);
    const started = startPersistedArtifactContinuation(deps, value);
    await baselineReadStarted.promise;

    const current = await value.harness.ctx.tasks.get(TASK_ID);
    await value.harness.ctx.tasks.save({
      ...current,
      title: `${current.title} changed during Run read`,
      updatedAt: '2026-09-01T10:08:00.000Z',
    });
    releaseBaselineRead.resolve();

    await expect(started).rejects.toMatchObject({
      code: 'artifact_trigger_recovery_required',
    });
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('fails closed before comment or resume when the Project drifts during baseline Run read', async () => {
    const value = await fixture();
    const baselineReadStarted = Promise.withResolvers<void>();
    const releaseBaselineRead = Promise.withResolvers<void>();
    const remote = connector({
      runIds: async () => {
        baselineReadStarted.resolve();
        await releaseBaselineRead.promise;
        return [SOURCE_RUN_ID];
      },
    });
    const deps = dependencies(value, remote);
    const started = startPersistedArtifactContinuation(deps, value);
    await baselineReadStarted.promise;

    const current = await value.harness.ctx.projects.get(project().projectId);
    await value.harness.ctx.projects.save({
      ...current,
      description: `${current.description} changed during Run read`,
      updatedAt: '2026-09-01T10:08:00.000Z',
    });
    releaseBaselineRead.resolve();

    await expect(started).rejects.toMatchObject({
      code: 'artifact_trigger_recovery_required',
    });
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('waits for a Task writer that owns the lock first, then rejects its committed drift', async () => {
    const value = await fixture();
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const baselineReadObserved = Promise.withResolvers<void>();
    const writer = value.harness.ctx.tasks.withTaskLock(TASK_ID, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      const current = await value.harness.ctx.tasks.get(TASK_ID);
      await value.harness.ctx.tasks.save({
        ...current,
        title: `${current.title} changed by writer-first Task save`,
        updatedAt: '2026-09-01T10:08:00.000Z',
      });
    });
    await writerEntered.promise;
    const remote = connector({
      runIds: () => {
        baselineReadObserved.resolve();
        return [SOURCE_RUN_ID];
      },
    });
    const deps = dependencies(value, remote);
    const started = startPersistedArtifactContinuation(deps, value);
    await baselineReadObserved.promise;
    expect(remote.appendResponse).not.toHaveBeenCalled();

    releaseWriter.resolve();
    await writer;
    await expect(started).rejects.toMatchObject({
      code: 'artifact_trigger_recovery_required',
    });
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('waits for a Project writer that owns the lock first, then rejects its committed drift', async () => {
    const value = await fixture();
    const writerEntered = Promise.withResolvers<void>();
    const releaseWriter = Promise.withResolvers<void>();
    const baselineReadObserved = Promise.withResolvers<void>();
    const writer = value.harness.ctx.projects.withProjectLock(project().projectId, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
      const current = await value.harness.ctx.projects.get(project().projectId);
      await value.harness.ctx.projects.save({
        ...current,
        description: `${current.description} changed by writer-first Project save`,
        updatedAt: '2026-09-01T10:08:00.000Z',
      });
    });
    await writerEntered.promise;
    const remote = connector({
      runIds: () => {
        baselineReadObserved.resolve();
        return [SOURCE_RUN_ID];
      },
    });
    const deps = dependencies(value, remote);
    const started = startPersistedArtifactContinuation(deps, value);
    await baselineReadObserved.promise;
    expect(remote.appendResponse).not.toHaveBeenCalled();

    releaseWriter.resolve();
    await writer;
    await expect(started).rejects.toMatchObject({
      code: 'artifact_trigger_recovery_required',
    });
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('appends one deterministic response, resumes Multica, and persists the actual Run ID', async () => {
    const value = await fixture();
    const events: string[] = [];
    const remote = connector({
      runIds: () => { events.push('runIds'); return [SOURCE_RUN_ID]; },
      append: () => {
        events.push('appendResponse');
        return { commentId: 'comment-remote-continuation', deduplicated: false };
      },
      resume: () => {
        events.push('resume');
        return { status: 'confirmed', newRunIds: [CONTINUATION_RUN_ID] };
      },
      runs: () => {
        events.push('runs');
        return [
          remoteRun(CONTINUATION_RUN_ID, {
            deliveredCommentIds: ['comment-remote-continuation'],
          }),
          remoteRun(SOURCE_RUN_ID),
        ];
      },
    });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({
      started: true,
      receipt: {
        executionTarget: 'multica',
        sourceRunId: SOURCE_RUN_ID,
        state: 'started',
        continuationRunId: CONTINUATION_RUN_ID,
      },
    });
    expect(events).toEqual(['runIds', 'appendResponse', 'resume', 'runs']);
    expect(remote.appendResponse).toHaveBeenCalledWith(ISSUE_ID, expect.objectContaining({
      streamEventId: result.receipt.idempotencyKey,
      parentCommentId: null,
    }));
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('keeps the trigger unknown when the resumed Run belongs to another Agent', async () => {
    const value = await fixture();
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      runs: () => [
        remoteRun(CONTINUATION_RUN_ID, {
          agentId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          deliveredCommentIds: ['comment-remote-continuation'],
        }),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.verifyAgent).toHaveBeenCalledTimes(1);
    expect(remote.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps the trigger unknown when the source Run no longer matches the bound runtime', async () => {
    const value = await fixture();
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      runs: () => [
        remoteRun(CONTINUATION_RUN_ID, {
          deliveredCommentIds: ['comment-remote-continuation'],
        }),
        remoteRun(SOURCE_RUN_ID, {
          runtimeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        }),
      ],
    });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.resume).toHaveBeenCalledTimes(1);
  });

  it('stops before comment or resume when the verified Research Agent configuration drifts', async () => {
    const value = await fixture();
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      verifyAgent: () => null,
    });
    const deps = dependencies(value, remote);

    await expect(startPersistedArtifactContinuation(deps, value)).rejects.toMatchObject({
      code: 'artifact_trigger_recovery_required',
    });
    expect(remote.verifyAgent).toHaveBeenCalledTimes(1);
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('persists unknown and never resumes when the response comment write is unknown', async () => {
    const value = await fixture();
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => ({ status: 'remote_write_unknown', reason: 'timeout' }),
    });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.resume).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('recovers only the Run that explicitly carries the idempotently recovered response comment', async () => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [
        remoteRun(CONTINUATION_RUN_ID, {
          triggerCommentId: 'comment-remote-continuation',
        }),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({
      started: false,
      receipt: { state: 'started', continuationRunId: CONTINUATION_RUN_ID },
    });
    expect(remote.appendResponse).toHaveBeenCalledTimes(2);
    expect(remote.runs).toHaveBeenCalledTimes(1);
    expect(remote.resume).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });

  it('keeps unknown recovery unknown when the newer carrier uses another runtime', async () => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [
        remoteRun(CONTINUATION_RUN_ID, {
          runtimeId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          triggerCommentId: 'comment-remote-continuation',
        }),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.verifyAgent).toHaveBeenCalledTimes(2);
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('keeps recovery unknown when only an older Run after the source carries the response comment', async () => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [
        remoteRun(SOURCE_RUN_ID),
        remoteRun('run-older-history', {
          triggerCommentId: 'comment-remote-continuation',
        }),
      ],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.appendResponse).toHaveBeenCalledTimes(2);
    expect(remote.runs).toHaveBeenCalledTimes(1);
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('keeps recovery unknown when the source Run is absent from the readback', async () => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [{
        runId: CONTINUATION_RUN_ID,
        issueId: ISSUE_ID,
        agentId: '2e7fa123-cd0b-4469-b6a8-584aedc128dc',
        runtimeId: '5f282aa0-e717-421d-ab84-d1f0d4aab551',
        status: 'in_progress',
        output: null,
        createdAt: NOW,
        startedAt: NOW,
        completedAt: null,
        deliveredCommentIds: ['comment-remote-continuation'],
        triggerCommentId: null,
      }],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it.each([
    ['a blank Run ID', () => [
      remoteRun(CONTINUATION_RUN_ID, {
        deliveredCommentIds: ['comment-remote-continuation'],
      }),
      remoteRun(SOURCE_RUN_ID),
      remoteRun(' '),
    ]],
    ['a duplicate Run ID', () => [
      remoteRun(CONTINUATION_RUN_ID, {
        deliveredCommentIds: ['comment-remote-continuation'],
      }),
      remoteRun(SOURCE_RUN_ID),
      remoteRun('run-unrelated-duplicate'),
      remoteRun('run-unrelated-duplicate'),
    ]],
  ])('keeps recovery unknown when the full readback contains %s', async (_label, runs) => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs,
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('does not recover an unrelated concurrent Run that appeared after an unknown response', async () => {
    const value = await fixture();
    let appendCalls = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendCalls += 1;
        return appendCalls === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [
        remoteRun('run-unrelated-concurrent', {
          deliveredCommentIds: ['different-comment'],
        }),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.appendResponse).toHaveBeenCalledTimes(2);
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('does not accept already_running when the only newer Run lacks the response comment', async () => {
    const value = await fixture();
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      resume: () => ({
        status: 'already_running',
        runIds: ['run-unrelated-concurrent', SOURCE_RUN_ID],
      }),
      runs: () => [
        remoteRun('run-unrelated-concurrent', { triggerCommentId: 'different-comment' }),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.runs).toHaveBeenCalledTimes(1);
  });

  it('fails closed when recovery sees more than one Run carrying the response comment', async () => {
    const value = await fixture();
    let appendAttempts = 0;
    const remote = connector({
      runIds: () => [SOURCE_RUN_ID],
      append: () => {
        appendAttempts += 1;
        return appendAttempts === 1
          ? { status: 'remote_write_unknown', reason: 'timeout' }
          : { commentId: 'comment-remote-continuation', deduplicated: true };
      },
      runs: () => [
        ...['run-conflict-b', 'run-conflict-a'].map((runId) => remoteRun(runId, {
          deliveredCommentIds: ['comment-remote-continuation'],
        })),
        remoteRun(SOURCE_RUN_ID),
      ],
    });
    const deps = dependencies(value, remote);
    await startPersistedArtifactContinuation(deps, value);

    const recovered = await startPersistedArtifactContinuation(deps, value);

    expect(recovered).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.appendResponse).toHaveBeenCalledTimes(2);
    expect(remote.runs).toHaveBeenCalledTimes(1);
    expect(remote.resume).not.toHaveBeenCalled();
  });

  it('fails closed before any remote write when the source Run is absent', async () => {
    const value = await fixture();
    const remote = connector({ runIds: () => ['run-unrelated'] });
    const deps = dependencies(value, remote);

    const result = await startPersistedArtifactContinuation(deps, value);

    expect(result).toMatchObject({ started: false, receipt: { state: 'unknown' } });
    expect(remote.appendResponse).not.toHaveBeenCalled();
    expect(remote.resume).not.toHaveBeenCalled();
    expect(deps.createRunner).not.toHaveBeenCalled();
  });
});
