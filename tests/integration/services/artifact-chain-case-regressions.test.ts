import { describe, expect, it, vi } from 'vitest';

import {
  createArtifactSettlementPlan,
  type ArtifactSettlementPlan,
} from '../../../src/domain/artifact-settlement.js';
import {
  evaluateContextConsumption,
  type FeedbackContextRule,
} from '../../../src/domain/context-consumption-proof.js';
import { buildContextManifest } from '../../../src/domain/context-manifest.js';
import type { Project } from '../../../src/domain/project.js';
import {
  projectContextSha256,
  resolveProjectContext,
  type ResolvedProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import { executeArtifactSettlement } from '../../../src/services/execute-artifact-settlement.js';

const artifact = {
  taskId: 'task-synthetic-case',
  ref: 'Artifacts/task-synthetic-case/attempt-001.md',
  version: 1,
  sha256: 'a'.repeat(64),
};

function plan(input: {
  decisionId: string;
  requestedDestination: 'task_only' | 'project_knowledge' | 'personal_knowledge';
  targetRef: string;
  authorizedDestinations: Array<'task_only' | 'project_knowledge' | 'personal_knowledge'>;
}): ArtifactSettlementPlan {
  return createArtifactSettlementPlan({
    artifact,
    ...input,
    createdAt: '2026-08-31T12:00:00.000Z',
  });
}

function atlProject(): Project {
  return {
    projectId: 'atl-stylework-runtime',
    name: 'Synthetic StyleWork Runtime',
    description: 'Synthetic repository comparison project.',
    resources: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

function resolvedStyleworkProject(): ResolvedProjectContext {
  const project = atlProject();
  const repoRefs = [
    'repo://grok-bot-0.18-reconstructed@synthetic-source-sha',
    'repo://stylework-frontend@synthetic-front-sha',
    'repo://stylework-backend@synthetic-back-sha',
  ];
  const resolution = resolveProjectContext({
    requestedProjectId: 'project-stylework-runtime',
    sourceSignals: [],
    registry: [{
      projectId: 'project-stylework-runtime',
      aliases: ['StyleWork runtime comparison'],
      verification: 'verified',
      canonicalProjectRef: 'projects://stylework/runtime',
      atlProjectId: project.projectId,
      repoRefs,
    }],
    canonicalProjects: [{
      projectId: 'project-stylework-runtime',
      ref: 'projects://stylework/runtime',
      atlProjectId: project.projectId,
      repoRefs,
      version: 'v1',
      sha256: 'b'.repeat(64),
    }],
    atlProjects: [{
      project,
      ref: `atl-project://${project.projectId}`,
      canonicalProjectRef: 'projects://stylework/runtime',
      repoRefs,
      sha256: projectContextSha256(project),
    }],
  });
  if (resolution.status !== 'resolved') throw new Error('Synthetic project did not resolve');
  return resolution;
}

describe('Artifact Chain case regressions', () => {
  it('keeps a TEP-92-shaped learning Artifact in the Task without auto-promoting it', async () => {
    const taskPlan = plan({
      decisionId: 'decision-synthetic-92-learn-first',
      requestedDestination: 'task_only',
      targetRef: 'task://synthetic-92/artifacts/learning-input',
      authorizedDestinations: ['task_only'],
    });
    expect(taskPlan).toMatchObject({
      logicalDestination: 'task_only',
      state: 'ready',
    });

    const personalPromotion = plan({
      decisionId: 'decision-synthetic-92-promote-later',
      requestedDestination: 'personal_knowledge',
      targetRef: 'personal-knowledge://ai-native-sdlc',
      authorizedDestinations: [],
    });
    const writer = vi.fn();
    const result = await executeArtifactSettlement(personalPromotion.planId, {
      repository: {
        getPlan: async (planId) => (
          planId === personalPromotion.planId ? personalPromotion : null
        ),
        getAuthorization: async () => null,
      },
      writer,
    });

    expect(result).toEqual({
      plan: expect.objectContaining({
        state: 'pending_authorization',
        requiredPermission: 'settle:personal_knowledge',
      }),
      executed: false,
      receipt: null,
    });
    expect(writer).not.toHaveBeenCalled();
  });

  it('creates a controlled TEP-93-shaped project knowledge plan only after confirmation', () => {
    const awaitingConfirmation = plan({
      decisionId: 'decision-synthetic-93-topic-shape',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://research-skill-system/topic-restructure',
      authorizedDestinations: [],
    });
    const confirmed = plan({
      decisionId: 'decision-synthetic-93-topic-shape',
      requestedDestination: 'project_knowledge',
      targetRef: 'projects://research-skill-system/topic-restructure',
      authorizedDestinations: ['project_knowledge'],
    });

    expect(awaitingConfirmation.state).toBe('pending_authorization');
    expect(confirmed).toMatchObject({
      state: 'ready',
      logicalDestination: 'project_knowledge',
      targetRef: 'projects://research-skill-system/topic-restructure',
    });
  });

  it('blocks a TEP-97-shaped run when repository or reconstructed-source identity drifts', () => {
    const resolved = resolvedStyleworkProject();
    const registryConflict = resolveProjectContext({
      requestedProjectId: resolved.projectId,
      sourceSignals: [],
      registry: [resolved.registry],
      canonicalProjects: [{
        ...resolved.canonical,
        repoRefs: [
          'repo://grok-bot-0.18-reconstructed@different-source-sha',
          'repo://stylework-frontend@synthetic-front-sha',
          'repo://stylework-backend@synthetic-back-sha',
        ],
      }],
      atlProjects: [resolved.atl],
    });
    expect(registryConflict).toMatchObject({
      status: 'conflict',
      issues: [expect.objectContaining({ code: 'repo_ref_mismatch' })],
    });

    const sourceManifest = buildContextManifest({
      taskId: 'task-synthetic-97',
      runId: 'run-synthetic-97',
      asOf: '2026-08-31T12:00:00.000Z',
      projectResolution: resolved,
      context: {
        taskId: 'task-synthetic-97',
        blocks: [{
          label: 'reconstructed_source',
          kind: 'local_file',
          category: 'source',
          sourceRef: 'repo://grok-bot-0.18-reconstructed@synthetic-source-sha',
          version: 'synthetic-source-sha',
          readRef: 'file:///synthetic/grok-bot-0.18-reconstructed',
          sha256: 'e'.repeat(64),
        }],
      },
      candidates: [{
        candidateId: 'grok-reconstructed-source',
        category: 'source',
        sourceRef: 'repo://grok-bot-0.18-reconstructed@synthetic-source-sha',
        version: 'synthetic-source-sha',
        expectedSha256: 'd'.repeat(64),
        selection: 'selected',
        selectionReason: 'The comparison must use the frozen reconstructed repository baseline.',
        blockLabel: 'reconstructed_source',
      }],
    });
    expect(sourceManifest).toMatchObject({
      status: 'blocked',
      issues: [{
        code: 'context_version_conflict',
        subject: 'grok-reconstructed-source',
      }],
    });
  });

  it('does not apply TEP-96 decision-readiness Feedback to an unrelated rendering task', () => {
    const rule: FeedbackContextRule = {
      feedbackId: 'fb_01j9z8w7q3v5x2m4n6p8',
      candidateId: 'feedback-decision-ready',
      version: 'v1',
      sha256: 'f'.repeat(64),
      stability: 'confirmed_pattern',
      confidence: 'high',
      validFrom: '2026-08-01T00:00:00.000Z',
      validUntil: null,
      scope: {
        taskIds: [],
        taskTypes: ['research'],
        projectIds: ['project-skill-eval'],
        requiredTags: ['decision_input'],
        excludedTags: ['html_rendering'],
      },
    };
    const counterexampleTask = {
      taskId: 'task-synthetic-92-rendering',
      taskType: 'research',
      projectId: 'project-research-layout',
      tags: ['html_rendering'],
      asOf: '2026-08-31T13:00:00.000Z',
    };

    const correctlyExcluded = evaluateContextConsumption({
      task: counterexampleTask,
      rules: [rule],
      manifestEntries: [{
        candidateId: rule.candidateId,
        category: 'feedback',
        sourceRef: `feedback://${rule.feedbackId}`,
        version: rule.version,
        sha256: null,
        status: 'excluded',
      }],
    });
    const wronglyConsumed = evaluateContextConsumption({
      task: counterexampleTask,
      rules: [rule],
      manifestEntries: [{
        candidateId: rule.candidateId,
        category: 'feedback',
        sourceRef: `feedback://${rule.feedbackId}`,
        version: rule.version,
        sha256: rule.sha256,
        status: 'consumed',
      }],
    });

    expect(correctlyExcluded.status).toBe('not_applicable');
    expect(correctlyExcluded.consumedFeedbackIds).toEqual([]);
    expect(wronglyConsumed).toMatchObject({
      status: 'misapplied',
      misappliedFeedbackIds: [rule.feedbackId],
    });
  });
});
