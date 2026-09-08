import { createHash } from 'node:crypto';

import type {
  MulticaRunRecord,
  MulticaResearchContinuationConnector,
  MulticaResumeResult,
  MulticaVerifiedAgentSnapshot,
} from '../connectors/multica-cli-connector.js';
import { artifactNodeId } from '../domain/artifact-identity.js';
import {
  readContextManifestById,
} from '../runner/context-manifest-runtime.js';
import type { RunnerController } from '../runner/runner-controller.js';
import {
  readRuntimePackById,
  readRuntimePackForRun,
} from '../runner/runtime-pack.js';
import {
  FileArtifactProductionEvidenceRepository,
} from '../storage/file-artifact-production-evidence-repository.js';
import { FileArtifactDecisionRepository } from '../storage/file-artifact-decision-repository.js';
import { FileExecutionBindingRepository } from '../storage/file-execution-binding-repository.js';
import type { ArtifactTriggerRepository } from './start-artifact-trigger.js';
import {
  startArtifactTrigger,
  type ArtifactTriggerRecoveryResult,
} from './start-artifact-trigger.js';
import type { DecisionTraceRepository } from '../storage/markdown-decision-trace-repository.js';
import type { ServiceContext } from './service-context.js';
import { executionBindingFreshnessMatches } from './execution-binding-freshness.js';

export interface StartPersistedArtifactContinuationInput {
  taskId: string;
  artifactRef: string;
  decisionId: string;
}

export interface StartPersistedArtifactContinuationDependencies {
  ctx: ServiceContext;
  runtimeRoot: string;
  triggers: ArtifactTriggerRepository;
  traces: Pick<DecisionTraceRepository, 'get'>;
  connector: Pick<
    MulticaResearchContinuationConnector,
    'runIds' | 'runs' | 'verifyAgent' | 'appendResponse' | 'resume'
  >;
  createRunner: (runId: string) => Promise<Pick<RunnerController, 'runAndWait'>>;
}

export class ArtifactContinuationEvidenceError extends Error {
  readonly code = 'artifact_continuation_evidence_invalid';

  constructor() {
    super('Artifact continuation evidence is missing, conflicting, or not executable');
    this.name = 'ArtifactContinuationEvidenceError';
  }
}

interface DerivedContinuation {
  taskId: string;
  sourceRunId: string;
  decisionId: string;
  artifactRef: string;
  artifactVersion: number;
  artifactSha256: string;
  executionTarget: 'local' | 'multica';
  idempotencyKey: string;
  continuationRunId: string | null;
  issueId: string | null;
  agent: MulticaVerifiedAgentSnapshot | null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function deriveContinuation(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
): Promise<DerivedContinuation> {
  if (
    input.taskId.trim() === ''
    || input.artifactRef.trim() === ''
    || input.decisionId.trim() === ''
  ) throw new ArtifactContinuationEvidenceError();

  const decisions = new FileArtifactDecisionRepository(dependencies.runtimeRoot);
  const productions = FileArtifactProductionEvidenceRepository.fromRuntimeRoot(
    dependencies.runtimeRoot,
  );
  const [task, artifactProduction, decision] = await Promise.all([
    dependencies.ctx.tasks.get(input.taskId),
    productions.readProductionEvidence(input.artifactRef),
    decisions.get(input.decisionId),
  ]);
  if (decision === null) throw new ArtifactContinuationEvidenceError();
  const trace = await dependencies.traces.get(decision.traceId);
  const artifact = artifactProduction.identity;
  if (
    trace === null
    || decision.artifact.taskId !== artifact.taskId
    || decision.artifact.ref !== artifact.ref
    || decision.artifact.version !== artifact.version
    || decision.artifact.sha256 !== artifact.sha256
    || artifact.taskId !== input.taskId
    || artifact.ref !== input.artifactRef
    || task.artifactRefs.filter((ref) => ref === input.artifactRef).length !== 1
  ) throw new ArtifactContinuationEvidenceError();

  let executionTarget: 'local' | 'multica';
  let sourceManifestId: string;
  let sourceManifestSha256: string;
  let sourceManifestRunId: string;
  let sourceEvidence: Record<string, string>;
  let issueId: string | null = null;
  let agent: MulticaVerifiedAgentSnapshot | null = null;
  if ('packId' in artifactProduction) {
    const sourcePack = await readRuntimePackById(
      dependencies.runtimeRoot,
      artifactProduction.packId,
    );
    if (
      sourcePack === null
      || sourcePack.pack.packId !== artifactProduction.packId
      || sourcePack.pack.taskId !== input.taskId
      || sourcePack.pack.runId !== artifactProduction.runId
      || sourcePack.pack.contextManifestId === null
      || sourcePack.pack.contextManifestSha256 === null
    ) throw new ArtifactContinuationEvidenceError();
    executionTarget = 'local';
    sourceManifestId = sourcePack.pack.contextManifestId;
    sourceManifestSha256 = sourcePack.pack.contextManifestSha256;
    sourceManifestRunId = artifactProduction.runId;
    sourceEvidence = {
      packId: sourcePack.pack.packId,
      manifestId: sourceManifestId,
      manifestSha256: sourceManifestSha256,
    };
  } else {
    const binding = await new FileExecutionBindingRepository(dependencies.runtimeRoot)
      .get(artifactProduction.executionBindingReceiptId);
    if (
      binding === null
      || binding.receiptId !== artifactProduction.executionBindingReceiptId
      || binding.taskId !== input.taskId
      || binding.manifestId !== artifactProduction.manifestId
      || binding.manifestSha256 !== artifactProduction.manifestSha256
      || binding.issueId !== artifactProduction.issueId
      || binding.run.runId !== artifactProduction.runId
      || !await executionBindingFreshnessMatches(
        dependencies.ctx,
        dependencies.runtimeRoot,
        binding,
      )
    ) throw new ArtifactContinuationEvidenceError();
    executionTarget = 'multica';
    sourceManifestId = binding.manifestId;
    sourceManifestSha256 = binding.manifestSha256;
    sourceManifestRunId = binding.dispatchAttemptId;
    issueId = binding.issueId;
    sourceEvidence = {
      executionBindingReceiptId: binding.receiptId,
      manifestId: binding.manifestId,
      manifestSha256: binding.manifestSha256,
      issueId: binding.issueId,
    };
    agent = binding.agent;
  }

  const sourceManifest = await readContextManifestById(
    dependencies.runtimeRoot,
    sourceManifestId,
  );
  const artifactNode = artifactNodeId(artifact);
  if (
    sourceManifest === null
    || sourceManifest.status !== 'ready'
    || sourceManifest.taskId !== input.taskId
    || sourceManifest.runId !== sourceManifestRunId
    || sourceManifest.sha256 !== sourceManifestSha256
    || trace.trace_id !== decision.traceId
    || !trace.input_refs.includes(artifactNode)
    || !trace.evidence_refs.includes(artifactNode)
    || !trace.input_refs.includes(`context-manifest:${sourceManifest.manifestId}`)
  ) throw new ArtifactContinuationEvidenceError();

  const identity = {
    schemaVersion: 1,
    executionTarget,
    taskId: input.taskId,
    sourceRunId: artifactProduction.runId,
    decisionId: decision.decisionId,
    artifact,
    sourceManifestId: sourceManifest.manifestId,
    sourceEvidence,
  };
  const identitySha256 = digest(identity);
  return {
    taskId: input.taskId,
    sourceRunId: artifactProduction.runId,
    decisionId: decision.decisionId,
    artifactRef: artifact.ref,
    artifactVersion: artifact.version,
    artifactSha256: artifact.sha256,
    executionTarget,
    idempotencyKey: `artifact-continuation-${identitySha256}`,
    continuationRunId: executionTarget === 'local'
      ? `run-artifact-${digest({ identitySha256, purpose: 'continuation-run' }).slice(0, 24)}`
      : null,
    issueId,
    agent,
  };
}

function newerRunIds(
  runIds: readonly string[],
  sourceRunId: string,
): string[] | null {
  if (
    runIds.some((runId) => runId.trim() === '')
    || new Set(runIds).size !== runIds.length
  ) return null;
  const sourceIndex = runIds.indexOf(sourceRunId);
  if (sourceIndex < 0) return null;
  return runIds.slice(0, sourceIndex);
}

function runCarriesResponse(run: MulticaRunRecord, commentId: string): boolean {
  return run.triggerCommentId === commentId || run.deliveredCommentIds.includes(commentId);
}

function runMatchesBoundAgent(
  run: MulticaRunRecord,
  continuation: DerivedContinuation,
): boolean {
  return continuation.agent !== null
    && run.agentId === continuation.agent.agentId
    && run.runtimeId === continuation.agent.runtimeId;
}

function verifiedAgentMatchesBinding(
  verified: MulticaVerifiedAgentSnapshot | null,
  continuation: DerivedContinuation,
): boolean {
  const bound = continuation.agent;
  return verified !== null
    && bound !== null
    && verified.agentId === bound.agentId
    && verified.workspaceId === bound.workspaceId
    && verified.model === bound.model
    && verified.maxConcurrentTasks === bound.maxConcurrentTasks
    && verified.runtimeId === bound.runtimeId;
}

function causalRemoteRunId(
  runs: readonly MulticaRunRecord[],
  continuation: DerivedContinuation,
  commentId: string,
  allowedRunIds?: ReadonlySet<string>,
): string | null {
  if (continuation.issueId === null) return null;
  const runIds = runs.map(({ runId }) => runId);
  if (
    runIds.some((runId) => runId.trim() === '')
    || new Set(runIds).size !== runIds.length
    || runs.filter((run) => (
      run.runId === continuation.sourceRunId
      && run.issueId === continuation.issueId
      && runMatchesBoundAgent(run, continuation)
    )).length !== 1
  ) return null;
  const candidates = runs.filter((run) => (
    run.runId !== continuation.sourceRunId
    && run.issueId === continuation.issueId
    && runMatchesBoundAgent(run, continuation)
    && (allowedRunIds === undefined || allowedRunIds.has(run.runId))
    && runCarriesResponse(run, commentId)
  ));
  return candidates.length === 1 ? candidates[0]!.runId : null;
}

async function withFreshRemoteContinuation<T>(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
  continuation: DerivedContinuation,
  action: (issueId: string) => Promise<T>,
): Promise<T> {
  if (continuation.issueId === null) throw new ArtifactContinuationEvidenceError();
  return dependencies.ctx.tasks.withTaskLock(continuation.taskId, async () => {
    const lockedTask = await dependencies.ctx.tasks.get(continuation.taskId);
    if (lockedTask.projectId === null) throw new ArtifactContinuationEvidenceError();
    return dependencies.ctx.projects.withProjectLock(lockedTask.projectId, async () => {
      const lockedEvidence = await deriveContinuation(dependencies, input);
      const current = await dependencies.ctx.tasks.get(continuation.taskId);
      if (
        JSON.stringify(lockedEvidence) !== JSON.stringify(continuation)
        || current.projectId !== lockedTask.projectId
        || current.status !== 'agent_executable'
        || current.claim !== null
        || current.artifactRefs.at(-1) !== continuation.artifactRef
      ) throw new ArtifactContinuationEvidenceError();
      const verifiedAgent = await dependencies.connector.verifyAgent();
      if (!verifiedAgentMatchesBinding(verifiedAgent, continuation)) {
        throw new ArtifactContinuationEvidenceError();
      }
      return action(continuation.issueId!);
    });
  });
}

async function recoverRemoteContinuation(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
  continuation: DerivedContinuation,
): Promise<ArtifactTriggerRecoveryResult> {
  try {
    return await withFreshRemoteContinuation(dependencies, input, continuation, async (issueId) => {
      const appended = await dependencies.connector.appendResponse(issueId, {
        streamEventId: continuation.idempotencyKey,
        body: remoteResponseBody(continuation),
        parentCommentId: null,
      });
      if ('status' in appended) return { status: 'unknown' as const };
      const runs = await dependencies.connector.runs(issueId);
      const candidates = newerRunIds(
        runs.map(({ runId }) => runId),
        continuation.sourceRunId,
      );
      if (candidates === null) return { status: 'unknown' as const };
      const runId = causalRemoteRunId(
        runs,
        continuation,
        appended.commentId,
        new Set(candidates),
      );
      return runId === null
        ? { status: 'unknown' as const }
        : { status: 'started' as const, runId };
    });
  } catch {
    return { status: 'unknown' };
  }
}

async function recoverContinuation(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
  continuation: DerivedContinuation,
): Promise<ArtifactTriggerRecoveryResult> {
  if (continuation.executionTarget === 'multica') {
    return recoverRemoteContinuation(dependencies, input, continuation);
  }
  if (continuation.continuationRunId === null) return { status: 'unknown' };
  const task = await dependencies.ctx.tasks.get(continuation.taskId);
  if (task.claim?.runId === continuation.continuationRunId) {
    return { status: 'started', runId: continuation.continuationRunId };
  }

  try {
    const pack = await readRuntimePackForRun(
      dependencies.runtimeRoot,
      continuation.taskId,
      continuation.continuationRunId,
    );
    if (pack !== null) {
      return pack.pack.continuationOfRunId === continuation.sourceRunId
        ? { status: 'started', runId: continuation.continuationRunId }
        : { status: 'unknown' };
    }
  } catch {
    return { status: 'unknown' };
  }

  for (const artifactRef of task.artifactRefs) {
    try {
      const production = await FileArtifactProductionEvidenceRepository.fromRuntimeRoot(
        dependencies.runtimeRoot,
      ).readProductionEvidence(artifactRef);
      if (production.runId === continuation.continuationRunId) {
        return production.identity.taskId === continuation.taskId
          ? { status: 'started', runId: continuation.continuationRunId }
          : { status: 'unknown' };
      }
    } catch {
      return { status: 'unknown' };
    }
  }

  const audit = await dependencies.ctx.audit.listForTask(continuation.taskId);
  if (audit.some((event) => (
    event.event === 'task.claimed'
    && event.runId === continuation.continuationRunId
  ))) {
    return { status: 'started', runId: continuation.continuationRunId };
  }
  if (
    task.status === 'agent_executable'
    && task.claim === null
    && task.artifactRefs.at(-1) === continuation.artifactRef
  ) return { status: 'not_found' };
  return { status: 'unknown' };
}

function remoteResponseBody(continuation: DerivedContinuation): string {
  return [
    'Continue this task from the accepted Artifact Decision.',
    '',
    `Task: ${continuation.taskId}`,
    `Decision: ${continuation.decisionId}`,
    `Artifact: ${continuation.artifactRef}`,
  ].join('\n');
}

function resumedRunIds(
  continuation: DerivedContinuation,
  result: MulticaResumeResult,
): ReadonlySet<string> | null {
  if (result.status === 'confirmed') {
    if (
      result.newRunIds.length === 0
      || result.newRunIds.some((runId) => runId.trim() === '' || runId === continuation.sourceRunId)
      || new Set(result.newRunIds).size !== result.newRunIds.length
    ) return null;
    return new Set(result.newRunIds);
  }
  if (result.status === 'already_running') {
    const candidates = newerRunIds(result.runIds, continuation.sourceRunId);
    return candidates === null || candidates.length === 0 ? null : new Set(candidates);
  }
  return null;
}

async function executeRemoteContinuation(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
  continuation: DerivedContinuation,
) {
  if (continuation.issueId === null) return { status: 'unknown' as const };
  const issueId = continuation.issueId;
  let baselineRunIds: string[];
  try {
    baselineRunIds = await dependencies.connector.runIds(issueId);
  } catch {
    return { status: 'unknown' as const };
  }
  const preexisting = newerRunIds(baselineRunIds, continuation.sourceRunId);
  if (preexisting === null || preexisting.length !== 0) {
    return { status: 'unknown' as const };
  }
  return withFreshRemoteContinuation(dependencies, input, continuation, async () => {
    try {
      const appended = await dependencies.connector.appendResponse(
        issueId,
        {
          streamEventId: continuation.idempotencyKey,
          body: remoteResponseBody(continuation),
          parentCommentId: null,
        },
      );
      if ('status' in appended) return { status: 'unknown' as const };
      const resumed = await dependencies.connector.resume(issueId, {
        baselineRunIds,
      });
      const allowedRunIds = resumedRunIds(continuation, resumed);
      if (allowedRunIds === null) return { status: 'unknown' as const };
      const runId = causalRemoteRunId(
        await dependencies.connector.runs(issueId),
        continuation,
        appended.commentId,
        allowedRunIds,
      );
      return runId === null
        ? { status: 'unknown' as const }
        : { status: 'started' as const, runId };
    } catch {
      return { status: 'unknown' as const };
    }
  });
}

export async function startPersistedArtifactContinuation(
  dependencies: StartPersistedArtifactContinuationDependencies,
  input: StartPersistedArtifactContinuationInput,
) {
  const continuation = await deriveContinuation(dependencies, input);
  return startArtifactTrigger({
    repository: dependencies.triggers,
    clock: dependencies.ctx.clock,
    recoverUnknown: () => recoverContinuation(dependencies, input, continuation),
    execute: async () => {
      const currentEvidence = await deriveContinuation(dependencies, input);
      const current = await dependencies.ctx.tasks.get(continuation.taskId);
      if (
        JSON.stringify(currentEvidence) !== JSON.stringify(continuation)
        ||
        current.status !== 'agent_executable'
        || current.claim !== null
        || current.artifactRefs.at(-1) !== continuation.artifactRef
      ) throw new ArtifactContinuationEvidenceError();
      if (continuation.executionTarget === 'multica') {
        return executeRemoteContinuation(dependencies, input, continuation);
      }
      if (continuation.continuationRunId === null) {
        throw new ArtifactContinuationEvidenceError();
      }
      const runner = await dependencies.createRunner(continuation.continuationRunId);
      const outcome = await runner.runAndWait({
        mode: 'manual',
        taskId: continuation.taskId,
        continuationOfRunId: continuation.sourceRunId,
      });
      return 'runId' in outcome && outcome.runId === continuation.continuationRunId
        ? { status: 'started' as const, runId: outcome.runId }
        : { status: 'unknown' as const };
    },
  }, {
    idempotencyKey: continuation.idempotencyKey,
    executionTarget: continuation.executionTarget,
    taskId: continuation.taskId,
    sourceRunId: continuation.sourceRunId,
    decisionId: continuation.decisionId,
    artifactRef: continuation.artifactRef,
    artifactVersion: continuation.artifactVersion,
    artifactSha256: continuation.artifactSha256,
  });
}
