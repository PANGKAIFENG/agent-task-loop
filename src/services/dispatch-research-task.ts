import { createHash } from 'node:crypto';

import type { MulticaDispatchConnector } from '../connectors/multica-cli-connector.js';
import type { ContextManifest } from '../domain/context-manifest.js';
import type { ContextCandidate } from '../domain/context-manifest.js';
import type { ExecutionBindingReceipt } from '../domain/execution-binding.js';
import { executionLinkIdempotencyKey } from '../domain/execution-link.js';
import {
  projectContextSha256,
  type ResolvedProjectContext,
} from '../domain/project-context-resolution.js';
import {
  isExternalExecutionTask,
  readinessErrors,
} from '../domain/task.js';
import {
  buildContextBundle,
  taskDispatchContentSha256,
  taskContextVersion,
  type AdditionalLocalContext,
  type ContextBlock,
  type ContextBundle,
} from '../runner/context-bundle.js';
import { persistContextManifest } from '../runner/context-manifest-runtime.js';
import { readContextManifestForRun } from '../runner/context-manifest-runtime.js';
import { FileExecutionBindingRepository } from '../storage/file-execution-binding-repository.js';
import type { ServiceContext } from './service-context.js';
import {
  executionBindingFreshnessMatches,
  vaultExecutionIdentity,
} from './execution-binding-freshness.js';
import {
  attemptAgeMs,
  freshExecutionLink,
  MULTICA_DISPATCH_DESCRIPTION_LIMIT,
  MULTICA_DISPATCH_ENSURE_MARGIN_MS,
  MULTICA_DISPATCH_IN_FLIGHT_MS,
  type MulticaDispatchTarget,
} from './dispatch-development-task.js';

export interface ResearchContextDiscovery {
  additionalLocalContexts: AdditionalLocalContext[];
  candidates: ContextCandidate[];
  includeSourceNote?: boolean;
  selectedProjectResourceIndexes?: number[];
}

export interface DispatchResearchTaskDependencies {
  connector: MulticaDispatchConnector;
  target: MulticaDispatchTarget;
  runtimeRoot: string;
  allowedContextRoots: readonly string[];
  contextBaseRoot?: string;
  discoverContext(input: {
    task: Awaited<ReturnType<ServiceContext['tasks']['get']>>;
    project: Awaited<ReturnType<ServiceContext['projects']['get']>>;
  }): Promise<ResearchContextDiscovery>;
}

export type DispatchResearchOutcome =
  | {
    status: 'context_blocked';
    taskId: string;
    manifestId: string;
    manifestSha256: string;
    issues: string[];
  }
  | {
    status: 'linked';
    taskId: string;
    issueId: string;
    issueIdentifier: string;
    recovered: boolean;
    manifestId: string;
    manifestSha256: string;
    executionBindingReceiptId: string;
    runId: string;
  }
  | { status: 'duplicate_conflict'; taskId: string; candidateIssueIds: string[] }
  | { status: 'in_flight'; taskId: string; reason: string }
  | { status: 'remote_write_unknown' | 'failed'; taskId: string; reason: string };

export class ResearchDispatchNotAdmittedError extends Error {
  readonly code = 'research_dispatch_not_admitted';
  readonly errors: readonly string[];

  constructor(errors: readonly string[]) {
    super('Research task is not admissible for Multica dispatch');
    this.name = 'ResearchDispatchNotAdmittedError';
    this.errors = errors;
  }
}

function researchAdmissionErrors(
  task: Awaited<ReturnType<ServiceContext['tasks']['get']>>,
): string[] {
  return [
    ...(isExternalExecutionTask(task) ? [] : ['executionTarget must be multica']),
    ...(task.status === 'agent_executable' ? [] : ['status must be agent_executable']),
    ...(task.reviewState === 'confirmed' ? [] : ['reviewState must be confirmed']),
    ...readinessErrors(task),
  ];
}

function assertCurrentPreflightIdentity(input: {
  originalTaskContextVersion: string;
  originalTaskContentSha256: string;
  originalProjectSha256: string;
  task: Awaited<ReturnType<ServiceContext['tasks']['get']>>;
  project: Awaited<ReturnType<ServiceContext['projects']['get']>>;
}): void {
  const errors = researchAdmissionErrors(input.task);
  if (taskContextVersion(input.task) !== input.originalTaskContextVersion) {
    errors.push('taskContextVersion changed during context preflight');
  }
  if (taskDispatchContentSha256(input.task) !== input.originalTaskContentSha256) {
    errors.push('Task dispatch content changed during context preflight');
  }
  if (projectContextSha256(input.project) !== input.originalProjectSha256) {
    errors.push('Project context changed during context preflight');
  }
  if (errors.length > 0) throw new ResearchDispatchNotAdmittedError(errors);
}

function localDispatchAttemptId(input: {
  taskId: string;
  taskContextVersion: string;
  taskContentSha256: string;
  projectSha256: string;
  context: Awaited<ReturnType<typeof buildContextBundle>>;
  candidates: readonly ContextCandidate[];
}): string {
  const digest = createHash('sha256').update(JSON.stringify({
    taskId: input.taskId,
    taskContextVersion: input.taskContextVersion,
    taskContentSha256: input.taskContentSha256,
    projectSha256: input.projectSha256,
    blocks: input.context.blocks.map((block) => ({
      label: block.label,
      category: block.category,
      sourceRef: block.sourceRef,
      version: block.version,
      sha256: block.sha256,
    })),
    candidates: [...input.candidates].sort((left, right) => (
      left.candidateId.localeCompare(right.candidateId)
    )),
  })).digest('hex');
  return `dispatch_${digest.slice(0, 24)}`;
}

function localProjectResolution(
  project: Awaited<ReturnType<ServiceContext['projects']['get']>>,
): ResolvedProjectContext {
  const sha256 = projectContextSha256(project);
  const canonicalRef = `atl-project://${project.projectId}`;
  return {
    status: 'resolved',
    projectId: project.projectId,
    match: {
      kind: 'explicit_project_id',
      value: project.projectId,
      sourceRef: null,
    },
    registry: {
      projectId: project.projectId,
      aliases: [],
      verification: 'verified',
      canonicalProjectRef: canonicalRef,
      atlProjectId: project.projectId,
      repoRefs: [],
    },
    canonical: {
      projectId: project.projectId,
      ref: canonicalRef,
      atlProjectId: project.projectId,
      repoRefs: [],
      version: project.updatedAt,
      sha256,
    },
    atl: {
      project,
      ref: canonicalRef,
      canonicalProjectRef: canonicalRef,
      repoRefs: [],
      sha256,
    },
  };
}

function requiredResearchCandidates(
  task: Awaited<ReturnType<ServiceContext['tasks']['get']>>,
  project: Awaited<ReturnType<ServiceContext['projects']['get']>>,
): ContextCandidate[] {
  return [
    {
      candidateId: 'task-current',
      category: 'task',
      sourceRef: `task://${task.taskId}`,
      version: taskContextVersion(task),
      expectedSha256: null,
      selection: 'selected',
      selectionReason: 'The current Task defines the objective and acceptance.',
      blockLabel: 'task',
    },
    {
      candidateId: 'project-current',
      category: 'project',
      sourceRef: `atl-project://${project.projectId}`,
      version: project.updatedAt,
      expectedSha256: null,
      selection: 'selected',
      selectionReason: 'The owning Project defines the durable project context.',
      blockLabel: 'project',
    },
  ];
}

function preflightFailureCandidate(taskId: string): ContextCandidate {
  return {
    candidateId: 'context-preflight-failure',
    category: 'source',
    sourceRef: `context-preflight://${taskId}/failure`,
    version: null,
    expectedSha256: null,
    selection: 'selected',
    selectionReason: 'Dynamic context discovery or safe local reading did not complete.',
    blockLabel: 'context_preflight_failure',
  };
}

function envelopeBudgetFailureCandidate(taskId: string): ContextCandidate {
  return {
    candidateId: 'dispatch-envelope-budget',
    category: 'source',
    sourceRef: `atl-dispatch://${taskId}/description-budget`,
    version: null,
    expectedSha256: null,
    selection: 'selected',
    selectionReason: 'The complete consumed context must fit the Multica dispatch envelope.',
    blockLabel: 'dispatch_envelope_budget',
  };
}

function researchEnvelope(
  task: Awaited<ReturnType<ServiceContext['tasks']['get']>>,
  target: MulticaDispatchTarget,
  manifest: Pick<ContextManifest, 'manifestId' | 'sha256' | 'runId'>,
  context: Awaited<ReturnType<typeof buildContextBundle>>,
) {
  const lines = [
    `[ATL_TASK_ID:${executionLinkIdempotencyKey(task.taskId)}]`,
    '',
    '## ATL research task',
    `- task_id: ${task.taskId}`,
    `- project_id: ${task.projectId ?? ''}`,
    `- workspace_id: ${target.workspaceId}`,
    `- multica_project_id: ${target.projectId}`,
    '',
    '## Context Manifest',
    `- manifest_id: ${manifest.manifestId}`,
    `- manifest_sha256: ${manifest.sha256}`,
    `- dispatch_attempt_id: ${manifest.runId}`,
    '',
    '## Consumed context',
  ];
  for (const block of context.blocks) {
    lines.push(
      '',
      `### ${block.label}`,
      `source_ref: ${block.sourceRef}`,
      `sha256: ${block.sha256}`,
      '',
      block.content,
    );
  }
  return {
    idempotencyKey: executionLinkIdempotencyKey(task.taskId),
    title: task.title,
    description: lines.join('\n'),
  };
}

const MIN_DISPATCH_EXCERPT_CHARS = 256;
const REQUIRED_RESEARCH_BLOCK_LABELS = new Set([
  'task',
  'project',
  'task_source_note',
]);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function excerptBlock(block: ContextBlock, bodyLength: number): {
  block: ContextBlock;
  bodyLength: number;
  excerptSha256: string;
  range: string;
} {
  const body = block.content.slice(0, bodyLength);
  const excerptSha256 = sha256(body);
  const range = `chars[0,${body.length})`;
  const content = [
    '[ATL_CONTEXT_EXCERPT]',
    `full_source_sha256: ${block.sha256}`,
    `excerpt_range: ${range}`,
    `excerpt_sha256: ${excerptSha256}`,
    '',
    body,
  ].join('\n');
  return {
    block: {
      ...block,
      content,
      sha256: sha256(content),
    },
    bodyLength: body.length,
    excerptSha256,
    range,
  };
}

function excludedForEnvelopeBudget(candidate: ContextCandidate): ContextCandidate {
  return {
    candidateId: candidate.candidateId,
    category: candidate.category,
    sourceRef: candidate.sourceRef,
    version: candidate.version,
    expectedSha256: candidate.expectedSha256,
    selection: 'excluded',
    selectionReason: candidate.selectionReason,
    exclusionReason: 'dispatch_envelope_budget',
  };
}

function fitResearchContextToEnvelope(input: {
  task: Awaited<ReturnType<ServiceContext['tasks']['get']>>;
  target: MulticaDispatchTarget;
  context: ContextBundle;
  candidates: readonly ContextCandidate[];
}): {
  context: ContextBundle;
  candidates: ContextCandidate[];
  requiredContentExceeded: boolean;
} {
  const placeholderManifest = {
    manifestId: `cm_${'0'.repeat(24)}`,
    sha256: '0'.repeat(64),
    runId: `dispatch_${'0'.repeat(24)}`,
  };
  const candidates = input.candidates.map((candidate) => ({ ...candidate }));
  const candidateIndexByLabel = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.selection === 'selected' && candidate.blockLabel !== undefined) {
      candidateIndexByLabel.set(candidate.blockLabel, index);
    }
  }
  const requiredBlocks = input.context.blocks.filter(({ label }) => (
    REQUIRED_RESEARCH_BLOCK_LABELS.has(label)
  ));
  const requiredContext = { ...input.context, blocks: requiredBlocks };
  const requiredContentExceeded = researchEnvelope(
    input.task,
    input.target,
    placeholderManifest,
    requiredContext,
  ).description.length > MULTICA_DISPATCH_DESCRIPTION_LIMIT;
  const fittedBlocks = [...requiredBlocks];

  for (const block of input.context.blocks) {
    if (REQUIRED_RESEARCH_BLOCK_LABELS.has(block.label)) continue;
    const candidateIndex = candidateIndexByLabel.get(block.label);
    if (candidateIndex === undefined) {
      fittedBlocks.push(block);
      continue;
    }
    const candidate = candidates[candidateIndex]!;
    if (requiredContentExceeded) {
      candidates[candidateIndex] = excludedForEnvelopeBudget(candidate);
      continue;
    }
    const withFullBlock = { ...input.context, blocks: [...fittedBlocks, block] };
    if (researchEnvelope(
      input.task,
      input.target,
      placeholderManifest,
      withFullBlock,
    ).description.length <= MULTICA_DISPATCH_DESCRIPTION_LIMIT) {
      fittedBlocks.push(block);
      continue;
    }

    let lower = 0;
    let upper = block.content.length;
    let best: ReturnType<typeof excerptBlock> | null = null;
    while (lower <= upper) {
      const middle = Math.floor((lower + upper) / 2);
      const excerpt = excerptBlock(block, middle);
      const descriptionLength = researchEnvelope(
        input.task,
        input.target,
        placeholderManifest,
        { ...input.context, blocks: [...fittedBlocks, excerpt.block] },
      ).description.length;
      if (descriptionLength <= MULTICA_DISPATCH_DESCRIPTION_LIMIT) {
        best = excerpt;
        lower = middle + 1;
      } else {
        upper = middle - 1;
      }
    }
    if (best === null || best.bodyLength < MIN_DISPATCH_EXCERPT_CHARS) {
      candidates[candidateIndex] = excludedForEnvelopeBudget(candidate);
      continue;
    }
    fittedBlocks.push(best.block);
    candidates[candidateIndex] = {
      ...candidate,
      selectionReason: [
        candidate.selectionReason,
        `Dispatch excerpt full_source_sha256=${block.sha256}`,
        `range=${best.range}`,
        `excerpt_sha256=${best.excerptSha256}`,
      ].join(' '),
    };
  }

  return {
    context: { ...input.context, blocks: fittedBlocks },
    candidates,
    requiredContentExceeded,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function linkedOutcome(
  taskId: string,
  binding: ExecutionBindingReceipt,
  recovered: boolean,
): DispatchResearchOutcome {
  return {
    status: 'linked',
    taskId,
    issueId: binding.issueId,
    issueIdentifier: binding.issueIdentifier,
    recovered,
    manifestId: binding.manifestId,
    manifestSha256: binding.manifestSha256,
    executionBindingReceiptId: binding.receiptId,
    runId: binding.run.runId,
  };
}

async function projectPersistedBinding(
  ctx: ServiceContext,
  dependencies: DispatchResearchTaskDependencies,
  taskId: string,
  dispatchAttemptId: string,
  binding: ExecutionBindingReceipt,
): Promise<DispatchResearchOutcome> {
  await ctx.tasks.withTaskLock(taskId, async () => {
    const current = await ctx.tasks.get(taskId);
    if (current.projectId === null) {
      throw new Error('Persisted Research binding conflicts with its Context Manifest or target');
    }
    await ctx.projects.withProjectLock(current.projectId, async () => {
      const lockedTask = await ctx.tasks.get(taskId);
      const manifest = await readContextManifestForRun(
        dependencies.runtimeRoot,
        taskId,
        dispatchAttemptId,
      );
      if (
        binding.taskId !== taskId
        || manifest === null
        || manifest.status !== 'ready'
        || manifest.manifestId !== binding.manifestId
        || manifest.sha256 !== binding.manifestSha256
        || binding.workspaceId !== dependencies.target.workspaceId
        || binding.projectId !== dependencies.target.projectId
        || !await executionBindingFreshnessMatches(ctx, dependencies.runtimeRoot, binding)
      ) {
        throw new Error('Persisted Research binding conflicts with its Context Manifest or target');
      }
      if (
        lockedTask.projectId !== current.projectId
        || taskContextVersion(lockedTask) !== binding.taskContextVersion
        || taskDispatchContentSha256(lockedTask) !== binding.taskContentSha256
      ) {
        throw new ResearchDispatchNotAdmittedError([
          'Task dispatch content changed after the persisted Research binding',
        ]);
      }
      const existing = lockedTask.executionLink;
      if (
        (existing?.executionBindingReceiptId != null
          && existing.executionBindingReceiptId !== binding.receiptId)
        || (existing?.issueId != null && existing.issueId !== binding.issueId)
        || (existing?.activationRunId != null && existing.activationRunId !== binding.run.runId)
      ) {
        throw new Error('Task Execution Link conflicts with the persisted Research binding');
      }
      const timestamp = ctx.clock().toISOString();
      await ctx.tasks.save({
        ...lockedTask,
        executionLink: {
          ...(existing ?? freshExecutionLink(taskId, dependencies.target)),
          issueId: binding.issueId,
          issueIdentifier: binding.issueIdentifier,
          activationAssigneeId: binding.agent.agentId,
          activationRunId: binding.run.runId,
          contextManifestId: binding.manifestId,
          contextManifestSha256: binding.manifestSha256,
          executionBindingReceiptId: binding.receiptId,
          activationAgentModel: binding.agent.model,
          activationAgentMaxConcurrentTasks: binding.agent.maxConcurrentTasks,
          activationAgentRuntimeId: binding.agent.runtimeId,
          activationRunStatus: binding.run.status,
          activationRunRuntimeId: binding.run.runtimeId,
          dispatchState: 'linked',
          remoteState: binding.run.status === 'completed' ? 'completed' : 'active',
          lastSyncedAt: timestamp,
        },
        updatedAt: timestamp,
      });
    });
  });
  return linkedOutcome(taskId, binding, true);
}

async function recoverPersistedBinding(
  ctx: ServiceContext,
  dependencies: DispatchResearchTaskDependencies,
  repository: FileExecutionBindingRepository,
  taskId: string,
  dispatchAttemptId: string,
): Promise<DispatchResearchOutcome | null> {
  const binding = await repository.getByAttempt(taskId, dispatchAttemptId);
  return binding === null
    ? null
    : projectPersistedBinding(ctx, dependencies, taskId, dispatchAttemptId, binding);
}

async function waitForPersistedBinding(
  ctx: ServiceContext,
  dependencies: DispatchResearchTaskDependencies,
  repository: FileExecutionBindingRepository,
  taskId: string,
  dispatchAttemptId: string,
  waitMs: number,
): Promise<DispatchResearchOutcome> {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    const recovered = await recoverPersistedBinding(
      ctx,
      dependencies,
      repository,
      taskId,
      dispatchAttemptId,
    );
    if (recovered !== null) return recovered;
    const current = await ctx.tasks.get(taskId);
    const state = current.executionLink?.dispatchState;
    if (state !== 'pending' && state !== 'resolving_remote') {
      if (state === 'duplicate_conflict') {
        return { status: 'duplicate_conflict', taskId, candidateIssueIds: [] };
      }
      if (state === 'failed' || state === 'remote_write_unknown') {
        return {
          status: state,
          taskId,
          reason: `concurrent Research dispatch finished with ${state}`,
        };
      }
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return {
    status: 'in_flight',
    taskId,
    reason: 'Research dispatch is still owned by another live lease',
  };
}

async function recordRemoteFailure(
  ctx: ServiceContext,
  taskId: string,
  result: Exclude<Awaited<ReturnType<MulticaDispatchConnector['ensureIssue']>>, { status: 'linked' }>,
): Promise<DispatchResearchOutcome> {
  await ctx.tasks.withTaskLock(taskId, async () => {
    const current = await ctx.tasks.get(taskId);
    const timestamp = ctx.clock().toISOString();
    await ctx.tasks.save({
      ...current,
      executionLink: current.executionLink === null || current.executionLink === undefined
        ? current.executionLink
        : { ...current.executionLink, dispatchState: result.status },
      updatedAt: timestamp,
    });
  });
  if (result.status === 'duplicate_conflict') {
    return { status: result.status, taskId, candidateIssueIds: result.candidateIssueIds };
  }
  return { status: result.status, taskId, reason: result.reason };
}

export async function dispatchResearchTask(
  ctx: ServiceContext,
  dependencies: DispatchResearchTaskDependencies,
  taskId: string,
): Promise<DispatchResearchOutcome> {
  const task = await ctx.tasks.get(taskId);
  const admissionErrors = researchAdmissionErrors(task);
  if (admissionErrors.length > 0) {
    throw new ResearchDispatchNotAdmittedError(admissionErrors);
  }
  const bindingRepository = new FileExecutionBindingRepository(dependencies.runtimeRoot);
  const initialVaultIdentity = await vaultExecutionIdentity(dependencies.runtimeRoot);
  const initialTaskContentSha256 = taskDispatchContentSha256(task);
  const linkedReceiptId = task.executionLink?.executionBindingReceiptId;
  if (linkedReceiptId !== undefined && linkedReceiptId !== null) {
    const linkedBinding = await bindingRepository.get(linkedReceiptId);
    if (linkedBinding === null || linkedBinding.taskId !== taskId) {
      throw new Error('Task Execution Link references a missing Research binding');
    }
    if (
      linkedBinding.taskContextVersion !== taskContextVersion(task)
      || linkedBinding.taskContentSha256 !== initialTaskContentSha256
      || !await executionBindingFreshnessMatches(ctx, dependencies.runtimeRoot, linkedBinding)
    ) {
      throw new ResearchDispatchNotAdmittedError([
        'Task dispatch content changed after the persisted Research binding',
      ]);
    }
    return projectPersistedBinding(
      ctx,
      dependencies,
      taskId,
      linkedBinding.dispatchAttemptId,
      linkedBinding,
    );
  }
  const project = await ctx.projects.get(task.projectId!);
  let discovery: ResearchContextDiscovery;
  let preflightFailed = false;
  try {
    discovery = await dependencies.discoverContext({ task, project });
  } catch {
    preflightFailed = true;
    discovery = {
      additionalLocalContexts: [],
      candidates: [
        ...requiredResearchCandidates(task, project),
        preflightFailureCandidate(taskId),
      ],
      includeSourceNote: false,
      selectedProjectResourceIndexes: [],
    };
  }
  let context;
  try {
    if (preflightFailed) throw new Error('Context discovery failed');
    context = await buildContextBundle(task, project, {
      allowedLocalRoots: dependencies.allowedContextRoots,
      additionalLocalContexts: discovery.additionalLocalContexts,
      ...(dependencies.contextBaseRoot === undefined
        ? {}
        : { localPathBase: dependencies.contextBaseRoot }),
      ...(discovery.includeSourceNote === undefined
        ? {}
        : { includeSourceNote: discovery.includeSourceNote }),
      ...(discovery.selectedProjectResourceIndexes === undefined
        ? {}
        : { selectedProjectResourceIndexes: discovery.selectedProjectResourceIndexes }),
    });
  } catch {
    if (!discovery.candidates.some(({ candidateId }) => (
      candidateId === 'context-preflight-failure'
    ))) {
      discovery.candidates = [
        ...discovery.candidates,
        preflightFailureCandidate(taskId),
      ];
    }
    context = await buildContextBundle(task, project, {
      allowedLocalRoots: [],
      includeSourceNote: false,
      selectedProjectResourceIndexes: [],
    });
  }
  const budgeted = fitResearchContextToEnvelope({
    task,
    target: dependencies.target,
    context,
    candidates: discovery.candidates,
  });
  context = budgeted.context;
  discovery.candidates = budgeted.candidates;
  const projectResolution = localProjectResolution(project);
  if (budgeted.requiredContentExceeded) {
    discovery.candidates = [
      ...discovery.candidates,
      envelopeBudgetFailureCandidate(taskId),
    ];
  }
  const dispatchAttemptId = localDispatchAttemptId({
    taskId,
    taskContextVersion: taskContextVersion(task),
    taskContentSha256: initialTaskContentSha256,
    projectSha256: projectResolution.canonical.sha256,
    context,
    candidates: discovery.candidates,
  });
  const recoveredBeforeManifest = await recoverPersistedBinding(
    ctx,
    dependencies,
    bindingRepository,
    taskId,
    dispatchAttemptId,
  );
  if (recoveredBeforeManifest !== null) return recoveredBeforeManifest;
  const persisted = await persistContextManifest(dependencies.runtimeRoot, {
    taskId,
    runId: dispatchAttemptId,
    asOf: taskContextVersion(task),
    projectResolution,
    context,
    candidates: discovery.candidates,
  });
  if (persisted.manifest.status === 'blocked') {
    return {
      status: 'context_blocked',
      taskId,
      manifestId: persisted.manifest.manifestId,
      manifestSha256: persisted.manifest.sha256,
      issues: persisted.manifest.issues.map(({ code, subject }) => `${code}:${subject}`),
    };
  }
  const envelope = researchEnvelope(task, dependencies.target, persisted.manifest, context);
  if (envelope.description.length > MULTICA_DISPATCH_DESCRIPTION_LIMIT) {
    throw new Error('Ready Research Context Manifest exceeds the dispatch envelope limit');
  }

  const lease = await ctx.tasks.withTaskLock(taskId, async () => {
    const binding = await bindingRepository.getByAttempt(taskId, dispatchAttemptId);
    if (binding !== null) return { kind: 'recover' as const };
    const current = await ctx.tasks.get(taskId);
    const currentAdmissionErrors = researchAdmissionErrors(current);
    if (currentAdmissionErrors.length > 0) {
      throw new ResearchDispatchNotAdmittedError(currentAdmissionErrors);
    }
    const currentProject = await ctx.projects.get(current.projectId!);
    assertCurrentPreflightIdentity({
      originalTaskContextVersion: taskContextVersion(task),
      originalTaskContentSha256: initialTaskContentSha256,
      originalProjectSha256: projectResolution.canonical.sha256,
      task: current,
      project: currentProject,
    });
    const existing = current.executionLink ?? null;
    const age = attemptAgeMs(existing?.lastAttemptAt, ctx.clock().getTime());
    if (
      existing !== null
      && (existing.dispatchState === 'pending' || existing.dispatchState === 'resolving_remote')
      && age < MULTICA_DISPATCH_IN_FLIGHT_MS
    ) {
      return {
        kind: 'wait' as const,
        waitMs: MULTICA_DISPATCH_IN_FLIGHT_MS - Math.max(0, age),
      };
    }
    const timestamp = ctx.clock().toISOString();
    await ctx.tasks.save({
      ...current,
      executionLink: {
        ...(existing ?? freshExecutionLink(taskId, dependencies.target)),
        contextManifestId: persisted.manifest.manifestId,
        contextManifestSha256: persisted.manifest.sha256,
        dispatchState: 'pending',
        lastAttemptAt: timestamp,
      },
      updatedAt: timestamp,
    });
    return { kind: 'owner' as const };
  });
  if (lease.kind === 'recover') {
    const recovered = await recoverPersistedBinding(
      ctx,
      dependencies,
      bindingRepository,
      taskId,
      dispatchAttemptId,
    );
    if (recovered === null) throw new Error('Research binding disappeared during recovery');
    return recovered;
  }
  if (lease.kind === 'wait') {
    return waitForPersistedBinding(
      ctx,
      dependencies,
      bindingRepository,
      taskId,
      dispatchAttemptId,
      lease.waitMs,
    );
  }
  return ctx.tasks.withTaskLock(taskId, async () => (
    ctx.projects.withProjectLock(project.projectId, async () => {
      const current = await ctx.tasks.get(taskId);
      const currentAdmissionErrors = researchAdmissionErrors(current);
      if (currentAdmissionErrors.length > 0) {
        throw new ResearchDispatchNotAdmittedError(currentAdmissionErrors);
      }
      const currentProject = await ctx.projects.get(current.projectId!);
      assertCurrentPreflightIdentity({
        originalTaskContextVersion: taskContextVersion(task),
        originalTaskContentSha256: initialTaskContentSha256,
        originalProjectSha256: projectResolution.canonical.sha256,
        task: current,
        project: currentProject,
      });
      if (await vaultExecutionIdentity(dependencies.runtimeRoot) !== initialVaultIdentity) {
        throw new ResearchDispatchNotAdmittedError([
          'Vault identity changed during context preflight',
        ]);
      }
      const leaseNow = ctx.clock();
      const timestamp = leaseNow.toISOString();
      await ctx.tasks.save({
        ...current,
        executionLink: {
          ...(current.executionLink ?? freshExecutionLink(taskId, dependencies.target)),
          dispatchState: 'resolving_remote',
          lastAttemptAt: timestamp,
        },
        updatedAt: timestamp,
      });
      const result = await dependencies.connector.ensureIssue(envelope, {
        deadlineAt: leaseNow.getTime()
          + MULTICA_DISPATCH_IN_FLIGHT_MS
          - MULTICA_DISPATCH_ENSURE_MARGIN_MS,
      });
      if (result.status !== 'linked') {
        return recordRemoteFailure(ctx, taskId, result);
      }
      const agent = result.activation.agent;
      if (
        agent === undefined
        || result.activation.assigneeId !== agent.agentId
        || result.activation.runStatus === undefined
        || result.activation.runAgentId !== agent.agentId
        || result.activation.runRuntimeId === undefined
        || result.activation.runRuntimeId === null
      ) {
        return {
          status: 'failed' as const,
          taskId,
          reason: 'Research activation evidence is incomplete',
        };
      }
      const binding = await bindingRepository.createOrGet({
      taskId,
      taskContextVersion: taskContextVersion(task),
      taskContentSha256: initialTaskContentSha256,
      projectContextSha256: projectResolution.canonical.sha256,
      vaultIdentity: initialVaultIdentity,
      dispatchAttemptId,
      manifestId: persisted.manifest.manifestId,
      manifestSha256: persisted.manifest.sha256,
      workspaceId: dependencies.target.workspaceId,
      projectId: dependencies.target.projectId,
      issueId: result.ref.issueId,
      issueIdentifier: result.ref.issueIdentifier,
      assigneeType: 'agent',
      agent,
      run: {
        runId: result.activation.runId,
        agentId: result.activation.runAgentId,
        status: result.activation.runStatus,
        runtimeId: result.activation.runRuntimeId,
      },
      createdAt: ctx.clock().toISOString(),
      });
      await projectPersistedBinding(
        ctx,
        dependencies,
        taskId,
        dispatchAttemptId,
        binding.receipt,
      );
      return linkedOutcome(taskId, binding.receipt, result.recovered);
    })
  ));
}
