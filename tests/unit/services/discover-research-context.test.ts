import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../src/domain/project.js';
import type { Task } from '../../../src/domain/task.js';
import { discoverResearchContext } from '../../../src/services/discover-research-context.js';

const roots: string[] = [];
const NOW = '2026-09-01T05:00:00.000Z';

function task(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260826-context01',
    title: 'Study AI native development lifecycle',
    body: 'Compare the official guide with community practice.',
    status: 'agent_executable',
    reviewState: 'confirmed',
    projectId: 'project-context',
    taskType: 'research',
    objective: 'Produce decision-ready learning input.',
    acceptanceCriteria: ['Explain the mechanism and useful practices.'],
    autoExecutable: true,
    permissionProfile: 'read_only_research',
    executionTarget: 'multica',
    origin: 'synthetic_test',
    sourceDate: '2026-08-26',
    sourceNote: '笔记同步助手/2026-08-26/task-input.md',
    sourceQuote: null,
    sourceKey: 'synthetic:dynamic-context',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function project(localResource: string): Project {
  return {
    projectId: 'project-context',
    name: 'Synthetic context project',
    description: 'Synthetic project context only.',
    resources: [{
      kind: 'local_path',
      value: localResource,
      label: 'Project architecture',
    }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atl-research-context-'));
  roots.push(root);
  const paths = {
    source: join(root, '笔记同步助手/2026-08-26/task-input.md'),
    sameDay: join(root, '笔记同步助手/2026-08-26/AI native official guide.md'),
    previousDay: join(root, '笔记同步助手/2026-08-25/community practice.md'),
    projectResource: join(root, 'Projects/project-context/architecture.md'),
    contextPack: join(root, '07_System/Context_Packs/personal-research-preferences.md'),
    registry: join(root, '07_System/Project Registry.md'),
  };
  await Promise.all([
    mkdir(join(root, '笔记同步助手/2026-08-26'), { recursive: true }),
    mkdir(join(root, '笔记同步助手/2026-08-25'), { recursive: true }),
    mkdir(join(root, 'Projects/project-context'), { recursive: true }),
    mkdir(join(root, '07_System/Context_Packs'), { recursive: true }),
  ]);
  await Promise.all(Object.entries(paths).map(([name, path]) => (
    writeFile(path, `${name}: synthetic content only\n`, 'utf8')
  )));
  return { root, paths };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('discoverResearchContext', () => {
  it('selects an explicit remote Project resource for auditable bundle consumption', async () => {
    const { root } = await fixture();
    const remoteProject: Project = {
      ...project('unused-local-resource'),
      resources: [{
        kind: 'github_repo',
        value: 'https://github.com/example/synthetic-research-source',
        label: 'Synthetic upstream repository',
      }],
    };

    const result = await discoverResearchContext({
      task: task({ sourceNote: null, sourceDate: null }),
      project: remoteProject,
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 8,
      maxTotalBytes: 256 * 1024,
    });

    expect(result.selectedProjectResourceIndexes).toEqual([0]);
    expect(result.candidates).toContainEqual(expect.objectContaining({
      candidateId: 'project-resource-001',
      sourceRef: 'https://github.com/example/synthetic-research-source',
      selection: 'selected',
      blockLabel: 'project_resource_001',
    }));
  });

  it('discovers source-adjacent, project, personal, and registry context without case routing', async () => {
    const { root, paths } = await fixture();
    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.projectResource),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 8,
      maxTotalBytes: 256 * 1024,
    });

    expect(result.includeSourceNote).toBe(true);
    expect(result.selectedProjectResourceIndexes).toEqual([0]);
    const selectedRefs = result.candidates
      .filter(({ selection }) => selection === 'selected')
      .map(({ sourceRef }) => sourceRef);
    expect(selectedRefs).toEqual(expect.arrayContaining([
      expect.stringContaining('task-input.md'),
      expect.stringContaining('architecture.md'),
      expect.stringContaining('AI%20native%20official%20guide.md'),
      expect.stringContaining('community%20practice.md'),
      expect.stringContaining('personal-research-preferences.md'),
      expect.stringContaining('Project%20Registry.md'),
    ]));
    expect(result.additionalLocalContexts).toHaveLength(4);
    expect(result.candidates.map(({ candidateId }) => candidateId).join('\n'))
      .not.toMatch(/TEP-(92|93|96|97)/u);
  });

  it('preserves explicit sources first and records budget exclusions', async () => {
    const { root, paths } = await fixture();
    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.projectResource),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 2,
      maxTotalBytes: 256 * 1024,
    });

    expect(result.includeSourceNote).toBe(true);
    expect(result.selectedProjectResourceIndexes).toEqual([0]);
    expect(result.additionalLocalContexts).toEqual([]);
    expect(result.candidates.filter(({ selection }) => selection === 'excluded'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ exclusionReason: 'context_file_budget_exceeded' }),
      ]));
  });

  it('reads one canonical file once when source note and Project resource overlap', async () => {
    const { root, paths } = await fixture();

    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.source),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 8,
      maxTotalBytes: 256 * 1024,
    });

    expect(result.includeSourceNote).toBe(true);
    expect(result.selectedProjectResourceIndexes).toEqual([]);
    expect(result.candidates).toContainEqual(expect.objectContaining({
      candidateId: 'project-resource-001',
      selection: 'excluded',
      exclusionReason: 'duplicate_context_source',
    }));
    expect(result.candidates.filter(({ sourceRef, selection }) => (
      selection === 'selected' && sourceRef.includes('task-input.md')
    ))).toHaveLength(1);
  });

  it('keeps an over-budget explicit source mandatory but unread so dispatch will block', async () => {
    const { root, paths } = await fixture();
    await writeFile(paths.source, 'x'.repeat(128), 'utf8');

    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.projectResource),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 8,
      maxTotalBytes: 64,
    });

    expect(result.includeSourceNote).toBe(false);
    expect(result.selectedProjectResourceIndexes).toEqual([]);
    expect(result.candidates).toContainEqual(expect.objectContaining({
      candidateId: 'task-source-note',
      selection: 'selected',
      blockLabel: 'task_source_note',
    }));
    expect(result.candidates).not.toContainEqual(expect.objectContaining({
      candidateId: 'task-source-note',
      selection: 'excluded',
    }));
  });

  it.each([
    ['file count', { maxLocalFiles: 1, maxTotalBytes: 256 * 1024 }],
    ['single-file size', { maxLocalFiles: 8, maxTotalBytes: 1024 * 1024 }],
    ['total bytes', { maxLocalFiles: 8, maxTotalBytes: 96 }],
  ])('excludes an optional Project resource that exceeds the %s budget', async (
    boundary,
    budget,
  ) => {
    const { root, paths } = await fixture();
    if (boundary === 'single-file size') {
      await writeFile(paths.projectResource, 'p'.repeat(256 * 1024 + 1), 'utf8');
    } else if (boundary === 'total bytes') {
      await writeFile(paths.source, 's'.repeat(64), 'utf8');
      await writeFile(paths.projectResource, 'p'.repeat(64), 'utf8');
    }

    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.projectResource),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      ...budget,
    });

    expect(result.includeSourceNote).toBe(true);
    expect(result.selectedProjectResourceIndexes).toEqual([]);
    expect(result.candidates).toContainEqual(expect.objectContaining({
      candidateId: 'project-resource-001',
      selection: 'excluded',
      exclusionReason: boundary === 'single-file size'
        ? 'context_file_too_large'
        : 'context_file_budget_exceeded',
    }));
  });

  it('spends a tight same-day budget on the more relevant file instead of filename order', async () => {
    const { root, paths } = await fixture();
    const unrelated = join(root, '笔记同步助手/2026-08-26/A unrelated prompt.md');
    const related = join(root, '笔记同步助手/2026-08-26/Z AI native lifecycle.md');
    await Promise.all([
      writeFile(unrelated, 'u'.repeat(128), 'utf8'),
      writeFile(related, 'r'.repeat(128), 'utf8'),
    ]);

    const result = await discoverResearchContext({
      task: task(),
      project: project(paths.projectResource),
    }, {
      vaultRoot: root,
      allowedLocalRoots: [root],
      maxLocalFiles: 4,
      maxTotalBytes: 512,
    });

    expect(result.candidates).toContainEqual(expect.objectContaining({
      sourceRef: expect.stringContaining('Z%20AI%20native%20lifecycle.md'),
      selection: 'selected',
    }));
    expect(result.candidates).toContainEqual(expect.objectContaining({
      sourceRef: expect.stringContaining('A%20unrelated%20prompt.md'),
      selection: 'excluded',
      exclusionReason: 'context_file_budget_exceeded',
    }));
  });
});
