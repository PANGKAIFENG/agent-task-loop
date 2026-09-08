import type {
  MulticaResearchConnector,
  MulticaRunRecord,
} from '../connectors/multica-cli-connector.js';
import {
  commentAttachmentSource,
  runOutputSource,
  type RemoteArtifactSource,
} from '../domain/remote-artifact.js';
import { FileExecutionBindingRepository } from '../storage/file-execution-binding-repository.js';
import { FileRemoteArtifactRepository } from '../storage/file-remote-artifact-repository.js';
import { assertTransition } from '../domain/transitions.js';
import type { ServiceContext } from './service-context.js';
import { executionBindingFreshnessMatches } from './execution-binding-freshness.js';

export interface ReadResearchArtifactsDependencies {
  connector: MulticaResearchConnector;
  runtimeRoot: string;
}

export interface ReadResearchArtifactsOutcome {
  status: 'recorded';
  taskId: string;
  receiptId: string;
  sourceCount: number;
  created: boolean;
}

export interface ReadResearchArtifactsOptions {
  deadlineAt?: number;
}

export interface ResearchArtifactsPendingOutcome {
  status: 'pending';
  taskId: string;
}

export class ResearchArtifactReadError extends Error {
  readonly code = 'research_artifact_read_invalid';

  constructor(
    message: string,
    readonly reason: 'invalid' | 'run_not_completed' = 'invalid',
  ) {
    super(message);
    this.name = 'ResearchArtifactReadError';
  }
}

const ACTIVE_MULTICA_RUN_STATUSES = new Set(['queued', 'running', 'in_progress']);

function exactRun(runs: readonly MulticaRunRecord[], runId: string): MulticaRunRecord {
  const matches = runs.filter((run) => run.runId === runId);
  if (matches.length !== 1) {
    throw new ResearchArtifactReadError('The bound Multica Run is missing or ambiguous');
  }
  return matches[0]!;
}

function attachmentSources(input: {
  issueId: string;
  workspaceId: string;
  runId: string;
  agentId: string;
  comments: Awaited<ReturnType<MulticaResearchConnector['listComments']>>['comments'];
}): RemoteArtifactSource[] {
  const marker = `[ATL_ARTIFACT_RUN:${input.runId}]`;
  const sources: RemoteArtifactSource[] = [];
  for (const comment of input.comments) {
    if (!comment.body.includes(marker)) continue;
    const attachments = comment.attachments ?? [];
    if (attachments.length > 0 && comment.authorType !== 'agent') {
      throw new ResearchArtifactReadError('Run-marked Artifact comment is not agent-authored');
    }
    for (const attachment of attachments) {
      // The marker is Agent-authored prose and therefore cannot establish
      // which Run produced a Work-level attachment. Only the server-issued
      // attachment Run identity can promote it into Artifact evidence.
      if (attachment.runId === null) continue;
      if (
        attachment.runId !== input.runId
        ||
        attachment.commentId !== comment.commentId
        || attachment.issueId !== input.issueId
        || attachment.workspaceId !== input.workspaceId
        || attachment.uploaderType !== 'agent'
        || attachment.uploaderId !== input.agentId
      ) {
        throw new ResearchArtifactReadError(
          'Run-marked Artifact attachment conflicts with the execution binding',
        );
      }
      sources.push(commentAttachmentSource({
        runId: input.runId,
        commentId: comment.commentId,
        attachmentId: attachment.attachmentId,
        filename: attachment.filename,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        downloadUrl: attachment.downloadUrl,
        markdownUrl: attachment.markdownUrl,
        url: attachment.url,
        uploaderId: attachment.uploaderId,
      }));
    }
  }
  return sources;
}

export async function readResearchArtifacts(
  ctx: ServiceContext,
  dependencies: ReadResearchArtifactsDependencies,
  taskId: string,
  options: ReadResearchArtifactsOptions = {},
): Promise<ReadResearchArtifactsOutcome> {
  const task = await ctx.tasks.get(taskId);
  const localProjectId = task.projectId;
  const link = task.executionLink;
  if (
    localProjectId === null
    || localProjectId === undefined
    || localProjectId.trim() === ''
    ||
    link?.executionBindingReceiptId === undefined
    || link.executionBindingReceiptId === null
    || link.issueId === null
    || link.activationRunId === undefined
    || link.activationRunId === null
  ) {
    throw new ResearchArtifactReadError('Task has no complete research execution binding');
  }
  const binding = await new FileExecutionBindingRepository(dependencies.runtimeRoot)
    .get(link.executionBindingReceiptId);
  if (
    binding === null
    || binding.taskId !== taskId
    || binding.receiptId !== link.executionBindingReceiptId
    || binding.workspaceId !== link.workspaceId
    || binding.projectId !== link.projectId
    || binding.issueId !== link.issueId
    || binding.run.runId !== link.activationRunId
    || binding.agent.agentId !== link.activationAssigneeId
    || binding.agent.runtimeId !== link.activationAgentRuntimeId
    || binding.run.runtimeId !== link.activationRunRuntimeId
  ) {
    throw new ResearchArtifactReadError('Execution Link conflicts with its persisted binding');
  }
  if (!await executionBindingFreshnessMatches(ctx, dependencies.runtimeRoot, binding)) {
    throw new ResearchArtifactReadError('Execution binding freshness no longer matches the Task, Project, or Vault');
  }

  const callOptions = options.deadlineAt === undefined
    ? undefined
    : { deadlineAt: options.deadlineAt };
  const run = exactRun(
    await dependencies.connector.runs(binding.issueId, callOptions),
    binding.run.runId,
  );
  if (
    run.issueId !== binding.issueId
    || run.agentId !== binding.agent.agentId
    || run.runtimeId !== binding.agent.runtimeId
  ) {
    throw new ResearchArtifactReadError('Multica Run identity conflicts with the execution binding');
  }
  if (ACTIVE_MULTICA_RUN_STATUSES.has(run.status) && run.completedAt === null) {
    throw new ResearchArtifactReadError(
      'The bound Multica Run is not completed',
      'run_not_completed',
    );
  }
  if (run.status !== 'completed' || run.completedAt === null) {
    throw new ResearchArtifactReadError(
      `The bound Multica Run cannot produce an Artifact: status=${run.status}`,
    );
  }

  const comments = await dependencies.connector.listComments(binding.issueId, {
    full: true,
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
  });
  const sources: RemoteArtifactSource[] = [
    ...(run.output === null || run.output.trim() === ''
      ? []
      : [runOutputSource(run.runId, run.output)]),
    ...attachmentSources({
      issueId: binding.issueId,
      workspaceId: binding.workspaceId,
      runId: run.runId,
      agentId: binding.agent.agentId,
      comments: comments.comments,
    }),
  ];
  if (sources.length === 0) {
    throw new ResearchArtifactReadError('The bound Multica Run has no readable Artifact');
  }
  return ctx.tasks.withTaskLock(taskId, async () => (
    ctx.projects.withProjectLock(localProjectId, async () => {
      const current = await ctx.tasks.get(taskId);
      if (
        current.projectId !== localProjectId
        || current.executionLink?.executionBindingReceiptId !== binding.receiptId
        || !await executionBindingFreshnessMatches(ctx, dependencies.runtimeRoot, binding)
      ) {
        throw new ResearchArtifactReadError(
          'Execution binding freshness changed before Artifact receipt creation',
        );
      }
      const stored = await new FileRemoteArtifactRepository(dependencies.runtimeRoot).createOrGet({
        taskId,
        executionBindingReceiptId: binding.receiptId,
        workspaceId: binding.workspaceId,
        projectId: binding.projectId,
        issueId: binding.issueId,
        issueIdentifier: binding.issueIdentifier,
        run: {
          runId: run.runId,
          agentId: binding.agent.agentId,
          runtimeId: binding.agent.runtimeId,
          status: run.status,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          completedAt: run.completedAt,
        },
        sources,
        createdAt: ctx.clock().toISOString(),
      });

      const receiptIds = current.executionLink.remoteArtifactReceiptIds ?? [];
      const artifactRef = `remote-artifact://${stored.receipt.receiptId}`;
      // A create-only receipt may survive a crash before the Task projection
      // is saved. Re-reading the same verified receipt must heal that partial
      // state instead of leaving the user-facing task executable forever.
      const advancesToReview = current.status === 'agent_executable';
      if (advancesToReview) {
        assertTransition(current.status, 'review');
      }
      await ctx.tasks.save({
        ...current,
        status: advancesToReview ? 'review' : current.status,
        artifactRefs: current.artifactRefs.includes(artifactRef)
          ? current.artifactRefs
          : [...current.artifactRefs, artifactRef],
        executionLink: {
          ...current.executionLink,
          remoteArtifactReceiptIds: receiptIds.includes(stored.receipt.receiptId)
            ? receiptIds
            : [...receiptIds, stored.receipt.receiptId],
          artifactRefs: current.executionLink.artifactRefs.includes(artifactRef)
            ? current.executionLink.artifactRefs
            : [...current.executionLink.artifactRefs, artifactRef],
          activationRunStatus: run.status,
          remoteState: run.status === 'completed' ? 'completed' : current.executionLink.remoteState,
          lastSyncedAt: ctx.clock().toISOString(),
        },
        updatedAt: ctx.clock().toISOString(),
      });

      return {
        status: 'recorded' as const,
        taskId,
        receiptId: stored.receipt.receiptId,
        sourceCount: stored.receipt.sources.length,
        created: stored.created,
      };
    })
  ));
}

export async function readResearchArtifactsIfCompleted(
  ctx: ServiceContext,
  dependencies: ReadResearchArtifactsDependencies,
  taskId: string,
  options: ReadResearchArtifactsOptions = {},
): Promise<ReadResearchArtifactsOutcome | ResearchArtifactsPendingOutcome> {
  try {
    return await readResearchArtifacts(ctx, dependencies, taskId, options);
  } catch (error) {
    if (
      error instanceof ResearchArtifactReadError
      && error.reason === 'run_not_completed'
    ) {
      return { status: 'pending', taskId };
    }
    throw error;
  }
}
