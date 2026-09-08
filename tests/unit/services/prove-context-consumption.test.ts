import { describe, expect, it } from 'vitest';

import type { FeedbackContextRule } from '../../../src/domain/context-consumption-proof.js';
import { buildContextManifest } from '../../../src/domain/context-manifest.js';
import type { Project } from '../../../src/domain/project.js';
import {
  projectContextSha256,
  resolveProjectContext,
} from '../../../src/domain/project-context-resolution.js';
import { proveContextConsumption } from '../../../src/services/prove-context-consumption.js';

const feedbackId = 'fb_01j9z8w7q3v5x2m4n6p8';
const contextSha256 = 'a'.repeat(64);

function manifest() {
  const project: Project = {
    projectId: 'atl-synthetic-feedback',
    name: 'Synthetic Feedback Project',
    description: 'Synthetic persisted Feedback proof fixture.',
    resources: [],
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
  const projectResolution = resolveProjectContext({
    requestedProjectId: 'project-synthetic-feedback',
    sourceSignals: [],
    registry: [{
      projectId: 'project-synthetic-feedback',
      aliases: [],
      verification: 'verified',
      canonicalProjectRef: 'projects://synthetic-feedback/home',
      atlProjectId: project.projectId,
      repoRefs: ['repo://personal-ai-workbench@synthetic'],
    }],
    canonicalProjects: [{
      projectId: 'project-synthetic-feedback',
      ref: 'projects://synthetic-feedback/home',
      atlProjectId: project.projectId,
      repoRefs: ['repo://personal-ai-workbench@synthetic'],
      version: 'v1',
      sha256: 'b'.repeat(64),
    }],
    atlProjects: [{
      project,
      ref: `atl-project://${project.projectId}`,
      canonicalProjectRef: 'projects://synthetic-feedback/home',
      repoRefs: ['repo://personal-ai-workbench@synthetic'],
      sha256: projectContextSha256(project),
    }],
  });
  if (projectResolution.status !== 'resolved') throw new Error('Synthetic project conflict');
  return buildContextManifest({
    taskId: 'task-synthetic-feedback',
    runId: 'run-synthetic-feedback',
    asOf: '2026-08-31T13:00:00.000Z',
    projectResolution,
    context: {
      taskId: 'task-synthetic-feedback',
      blocks: [{
        label: 'feedback_rule',
        kind: 'feedback',
        category: 'feedback',
        sourceRef: `feedback://${feedbackId}`,
        version: 'v1',
        readRef: 'file:///synthetic/feedback-rule.md',
        sha256: contextSha256,
      }],
    },
    candidates: [{
      candidateId: 'feedback-rule',
      category: 'feedback',
      sourceRef: `feedback://${feedbackId}`,
      version: 'v1',
      expectedSha256: contextSha256,
      selection: 'selected',
      selectionReason: 'The persisted project rule applies.',
      blockLabel: 'feedback_rule',
    }],
  });
}

function blockedManifest() {
  const ready = manifest();
  return buildContextManifest({
    taskId: ready.taskId,
    runId: `${ready.runId}-blocked`,
    asOf: ready.asOf,
    projectResolution: resolveProjectContext({
      requestedProjectId: ready.projectId,
      sourceSignals: [],
      registry: [{
        projectId: ready.projectId,
        aliases: [],
        verification: 'verified',
        canonicalProjectRef: ready.projectEvidence.canonicalRef,
        atlProjectId: 'atl-synthetic-feedback',
        repoRefs: ['repo://personal-ai-workbench@synthetic'],
      }],
      canonicalProjects: [{
        projectId: ready.projectId,
        ref: ready.projectEvidence.canonicalRef,
        atlProjectId: 'atl-synthetic-feedback',
        repoRefs: ['repo://personal-ai-workbench@synthetic'],
        version: ready.projectEvidence.canonicalVersion,
        sha256: ready.projectEvidence.canonicalSha256,
      }],
      atlProjects: [{
        project: {
          projectId: 'atl-synthetic-feedback',
          name: 'Synthetic Feedback Project',
          description: 'Synthetic persisted Feedback proof fixture.',
          resources: [],
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        },
        ref: ready.projectEvidence.atlRef,
        canonicalProjectRef: ready.projectEvidence.canonicalRef,
        repoRefs: ['repo://personal-ai-workbench@synthetic'],
        sha256: ready.projectEvidence.atlSha256,
      }],
    }) as ReturnType<typeof resolveProjectContext> & { status: 'resolved' },
    context: {
      taskId: ready.taskId,
      blocks: ready.entries.filter(({ status }) => status === 'consumed').map((entry) => ({
        label: entry.blockLabel!,
        kind: entry.kind!,
        category: entry.category,
        sourceRef: entry.sourceRef,
        version: entry.version,
        readRef: entry.readRef!,
        sha256: entry.sha256!,
      })),
    },
    candidates: [
      {
        candidateId: 'feedback-rule',
        category: 'feedback',
        sourceRef: `feedback://${feedbackId}`,
        version: 'v1',
        expectedSha256: contextSha256,
        selection: 'selected',
        selectionReason: 'The persisted project rule applies.',
        blockLabel: 'feedback_rule',
      },
      {
        candidateId: 'policy-required',
        category: 'policy',
        sourceRef: 'policy://synthetic/required',
        version: 'v1',
        expectedSha256: 'd'.repeat(64),
        selection: 'selected',
        selectionReason: 'The required policy must be read before proof is possible.',
        blockLabel: 'policy_required',
      },
    ],
  });
}

const rule: FeedbackContextRule = {
  feedbackId,
  candidateId: 'feedback-rule',
  version: 'v1',
  sha256: contextSha256,
  stability: 'confirmed_pattern',
  confidence: 'high',
  validFrom: '2026-08-01T00:00:00.000Z',
  validUntil: null,
  scope: {
    taskIds: [],
    taskTypes: ['research'],
    projectIds: ['project-synthetic-feedback'],
    requiredTags: ['decision_input'],
    excludedTags: [],
  },
};

describe('proveContextConsumption', () => {
  it('rebuilds proof from a persisted Manifest, task context, and Feedback rules', async () => {
    const persistedManifest = manifest();

    const result = await proveContextConsumption({
      repository: {
        getManifest: async (manifestId) => (
          manifestId === persistedManifest.manifestId ? persistedManifest : null
        ),
        getTaskContext: async (taskId) => taskId === persistedManifest.taskId
          ? {
              taskId,
              taskType: 'research',
              projectId: persistedManifest.projectId,
              tags: ['decision_input'],
            }
          : null,
        getRuntimePackForRun: async () => ({
          taskId: persistedManifest.taskId,
          runId: persistedManifest.runId,
          contextManifestId: persistedManifest.manifestId,
          contextManifestSha256: persistedManifest.sha256,
        }),
        listFeedbackRules: async () => [rule],
      },
    }, persistedManifest.manifestId);

    expect(result.status).toBe('proven');
    expect(result.consumedFeedbackIds).toEqual([feedbackId]);
  });

  it('fails closed instead of proving consumption from a blocked Manifest', async () => {
    const persistedManifest = blockedManifest();

    await expect(proveContextConsumption({
      repository: {
        getManifest: async () => persistedManifest,
        getTaskContext: async () => ({
          taskId: persistedManifest.taskId,
          taskType: 'research',
          projectId: persistedManifest.projectId,
          tags: ['decision_input'],
        }),
        getRuntimePackForRun: async () => null,
        listFeedbackRules: async () => [rule],
      },
    }, persistedManifest.manifestId)).rejects.toMatchObject({
      code: 'context_consumption_evidence_invalid',
    });
  });

  it('does not prove a ready Manifest without a persisted Runtime Pack for that Run', async () => {
    const persistedManifest = manifest();

    await expect(proveContextConsumption({
      repository: {
        getManifest: async () => persistedManifest,
        getTaskContext: async () => ({
          taskId: persistedManifest.taskId,
          taskType: 'research',
          projectId: persistedManifest.projectId,
          tags: ['decision_input'],
        }),
        getRuntimePackForRun: async () => null,
        listFeedbackRules: async () => [rule],
      },
    }, persistedManifest.manifestId)).rejects.toMatchObject({
      code: 'context_consumption_evidence_invalid',
    });
  });
});
