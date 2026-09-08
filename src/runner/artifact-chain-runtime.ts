import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { projectContextSha256 } from '../domain/project-context-resolution.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';
import { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../storage/markdown-codex-feedback-repository.js';
import { loadSelectedCodexFeedbackContext } from '../services/select-codex-feedback-context.js';
import { taskContextVersion } from './context-bundle.js';
import type { ArtifactChainContextPlanner } from './run-once.js';

async function localSourceRef(path: string): Promise<string> {
  return pathToFileURL(await realpath(path)).href;
}

export function createArtifactChainContextPlanner(options: {
  vaultRoot?: string;
} = {}): ArtifactChainContextPlanner {
  const feedbackDependencies = options.vaultRoot === undefined
    ? undefined
    : {
        stateRepository: new FileCodexFeedbackStateRepository(
          join(options.vaultRoot, '.atl-runtime', 'codex-feedback'),
          { vaultRoot: options.vaultRoot },
        ),
        visibleRepository: new MarkdownCodexFeedbackRepository(options.vaultRoot),
      };
  return async ({ task, project }) => {
    const canonicalRef = `atl-local-projection://${project.projectId}`;
    const atlRef = `atl-project://${project.projectId}`;
    const repoRefs = project.resources
      .filter(({ kind }) => kind === 'github_repo')
      .map(({ value }) => value);
    const projectSha256 = projectContextSha256(project);
    const candidates: Awaited<ReturnType<ArtifactChainContextPlanner>>['candidates'] = [
      {
        candidateId: 'task-current',
        category: 'task',
        sourceRef: `task://${task.taskId}`,
        version: taskContextVersion(task),
        expectedSha256: null,
        selection: 'selected',
        selectionReason: 'The claimed Task defines the current objective and acceptance.',
        blockLabel: 'task',
      },
    ];

    const previousArtifactRef = task.artifactRefs.at(-1);
    if (previousArtifactRef !== undefined) {
      const parsed = parseArtifactReference(previousArtifactRef, task.taskId);
      if (parsed !== null) {
        candidates.push({
          candidateId: 'artifact-previous',
          category: 'artifact',
          sourceRef: previousArtifactRef,
          version: `v${parsed.attempt}`,
          expectedSha256: null,
          selection: 'selected',
          selectionReason: 'The latest Artifact is required for a continuation or rework Run.',
          blockLabel: 'previous_artifact',
        });
      }
    }

    if (task.sourceNote !== null && task.sourceNote.trim() !== '') {
      candidates.push({
        candidateId: 'task-source-note',
        category: 'source',
        sourceRef: await localSourceRef(task.sourceNote),
        version: null,
        expectedSha256: null,
        selection: 'selected',
        selectionReason: 'The Task explicitly references this source note.',
        blockLabel: 'task_source_note',
      });
    }

    candidates.push({
      candidateId: 'project-current',
      category: 'project',
      sourceRef: atlRef,
      version: project.updatedAt,
      expectedSha256: null,
      selection: 'selected',
      selectionReason: 'The persisted ATL Project is the Phase 0 project context projection.',
      blockLabel: 'project',
    });

    for (const [index, resource] of project.resources.entries()) {
      candidates.push({
        candidateId: `project-resource-${String(index + 1).padStart(3, '0')}`,
        category: 'source',
        sourceRef: resource.kind === 'local_path'
          ? await localSourceRef(resource.value)
          : resource.value,
        version: project.updatedAt,
        expectedSha256: null,
        selection: 'selected',
        selectionReason: 'The persisted ATL Project explicitly lists this resource.',
        blockLabel: `project_resource_${String(index + 1).padStart(3, '0')}`,
      });
    }

    const feedbackBinding = feedbackDependencies === undefined
      ? undefined
      : (await feedbackDependencies.stateRepository.read()).bindings.find(
          (binding) => binding.taskId === task.taskId,
        );
    const feedbackContext = feedbackDependencies === undefined || feedbackBinding === undefined
      ? {
          additionalLocalContexts: [],
          manifestCandidates: [],
        }
      : await loadSelectedCodexFeedbackContext(feedbackDependencies, {
          targetBindingId: feedbackBinding.bindingId,
        });

    return {
      projectContext: {
        requestedProjectId: project.projectId,
        sourceSignals: [],
        registry: [{
          projectId: project.projectId,
          aliases: project.name.trim() === '' ? [] : [project.name],
          verification: 'verified',
          canonicalProjectRef: canonicalRef,
          atlProjectId: project.projectId,
          repoRefs,
        }],
        canonicalProjects: [{
          projectId: project.projectId,
          ref: canonicalRef,
          atlProjectId: project.projectId,
          repoRefs,
          version: project.updatedAt,
          sha256: projectSha256,
        }],
        atlProjects: [{
          project,
          ref: atlRef,
          canonicalProjectRef: canonicalRef,
          repoRefs,
          sha256: projectSha256,
        }],
      },
      additionalLocalContexts: feedbackContext.additionalLocalContexts,
      candidates: [...candidates, ...feedbackContext.manifestCandidates],
    };
  };
}
