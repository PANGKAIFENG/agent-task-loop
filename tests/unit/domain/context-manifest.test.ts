import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildContextManifest,
  ContextManifestInputError,
  isValidContextManifest,
  type ContextCandidate,
  type ContextKind,
} from '../../../src/domain/context-manifest.js';
import {
  projectContextSha256,
  type ResolvedProjectContext,
} from '../../../src/domain/project-context-resolution.js';

const TASK_SHA = 'a'.repeat(64);
const PROJECT_SHA = 'b'.repeat(64);
const FEEDBACK_SHA = 'c'.repeat(64);
const ATL_PROJECT = {
  projectId: 'atl-skill-eval',
  name: 'Synthetic Skill Eval',
  description: 'Synthetic only.',
  resources: [],
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-31T10:00:00.000Z',
};

const projectResolution: ResolvedProjectContext = {
  status: 'resolved',
  projectId: 'project-skill-eval',
  match: {
    kind: 'explicit_project_id',
    value: 'project-skill-eval',
    sourceRef: null,
  },
  registry: {
    projectId: 'project-skill-eval',
    aliases: ['skill eval'],
    verification: 'verified',
    canonicalProjectRef: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
  },
  canonical: {
    projectId: 'project-skill-eval',
    ref: 'projects://skill-eval/home',
    atlProjectId: 'atl-skill-eval',
    repoRefs: ['repo://personal-ai-workbench'],
    version: 'v3',
    sha256: PROJECT_SHA,
  },
  atl: {
    project: ATL_PROJECT,
    ref: 'atl-project://atl-skill-eval',
    canonicalProjectRef: 'projects://skill-eval/home',
    repoRefs: ['repo://personal-ai-workbench'],
    sha256: projectContextSha256(ATL_PROJECT),
  },
};

function candidates(): ContextCandidate[] {
  return [
    {
      candidateId: 'task-current',
      category: 'task',
      sourceRef: 'task://synthetic-96',
      version: '2026-08-31T10:00:00.000Z',
      expectedSha256: TASK_SHA,
      selection: 'selected',
      selectionReason: 'Current task objective and acceptance are always required.',
      blockLabel: 'task',
    },
    {
      candidateId: 'project-current',
      category: 'project',
      sourceRef: 'projects://skill-eval/home',
      version: 'v3',
      expectedSha256: PROJECT_SHA,
      selection: 'selected',
      selectionReason: 'The resolved project owns the requested decision.',
      blockLabel: 'project',
    },
    {
      candidateId: 'feedback-applicable',
      category: 'feedback',
      sourceRef: 'feedback://synthetic/context-depth',
      version: 'v1',
      expectedSha256: FEEDBACK_SHA,
      selection: 'selected',
      selectionReason: 'Confirmed context-depth feedback applies to this task.',
      blockLabel: 'feedback_context_depth',
    },
    {
      candidateId: 'feedback-unrelated',
      category: 'feedback',
      sourceRef: 'feedback://synthetic/html-layout',
      version: 'v1',
      expectedSha256: null,
      selection: 'excluded',
      selectionReason: 'The task is about a decision workflow, not HTML layout.',
      exclusionReason: 'not_applicable',
    },
  ];
}

function consumedBlock(
  label: string,
  kind: ContextKind,
  sha256: string,
): BuildContextManifestBlock {
  const selected = candidates().find((candidate) => candidate.blockLabel === label);
  if (selected === undefined) throw new Error(`Missing synthetic candidate: ${label}`);
  return {
    label,
    kind,
    category: selected.category,
    sourceRef: selected.sourceRef,
    version: selected.version,
    readRef: `memory://${label}`,
    sha256,
  };
}

type BuildContextManifestBlock = Parameters<typeof buildContextManifest>[0]['context']['blocks'][number];

function resignManifest(
  manifest: ReturnType<typeof buildContextManifest>,
  mutate: (candidate: ReturnType<typeof buildContextManifest>) => void,
): ReturnType<typeof buildContextManifest> {
  const candidate = structuredClone(manifest);
  mutate(candidate);
  const unsigned = { ...candidate } as Partial<typeof candidate>;
  delete unsigned.manifestId;
  delete unsigned.sha256;
  const sha256 = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  return {
    ...candidate,
    manifestId: `cm_${sha256.slice(0, 24)}`,
    sha256,
  };
}

describe('buildContextManifest', () => {
  it('freezes actual consumed blocks separately from excluded candidates', () => {
    const manifest = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      asOf: '2026-08-31T10:05:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
          consumedBlock('feedback_context_depth', 'feedback', FEEDBACK_SHA),
        ],
      },
      candidates: candidates(),
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      manifestId: expect.stringMatching(/^cm_[0-9a-f]{24}$/),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-a',
      projectId: 'project-skill-eval',
      status: 'ready',
      issues: [],
    });
    expect(manifest.entries).toEqual([
      expect.objectContaining({ candidateId: 'task-current', status: 'consumed', sha256: TASK_SHA }),
      expect.objectContaining({ candidateId: 'project-current', status: 'consumed', sha256: PROJECT_SHA }),
      expect.objectContaining({
        candidateId: 'feedback-applicable',
        status: 'consumed',
        sha256: FEEDBACK_SHA,
      }),
      expect.objectContaining({
        candidateId: 'feedback-unrelated',
        status: 'excluded',
        reason: 'not_applicable',
      }),
    ]);
  });

  it('records a selected candidate as failed when no read block proves consumption', () => {
    const manifest = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-b',
      asOf: '2026-08-31T10:06:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
        ],
      },
      candidates: candidates(),
    });

    expect(manifest.status).toBe('blocked');
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      candidateId: 'feedback-applicable',
      status: 'failed',
      reason: 'selected_context_not_read',
    }));
    expect(manifest.issues).toContainEqual({
      code: 'missing_consumption_evidence',
      subject: 'feedback-applicable',
    });
  });

  it('detects content drift when the consumed SHA differs from the selected version', () => {
    const manifest = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-c',
      asOf: '2026-08-31T10:07:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
          consumedBlock('feedback_context_depth', 'feedback', 'e'.repeat(64)),
        ],
      },
      candidates: candidates(),
    });

    expect(manifest.status).toBe('blocked');
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      candidateId: 'feedback-applicable',
      status: 'conflict',
      reason: 'content_sha256_changed',
    }));
    expect(manifest.issues).toContainEqual({
      code: 'context_version_conflict',
      subject: 'feedback-applicable',
    });
  });

  it('fails closed when a consumed block has no registered candidate', () => {
    const manifest = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-d',
      asOf: '2026-08-31T10:08:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
          {
            label: 'unregistered_private_note',
            kind: 'local_file',
            category: 'source',
            sourceRef: 'file:///synthetic/private-note.md',
            version: null,
            readRef: 'file:///synthetic/private-note.md',
            sha256: 'f'.repeat(64),
          },
        ],
      },
      candidates: candidates().filter(({ category }) => category !== 'feedback'),
    });

    expect(manifest.status).toBe('blocked');
    expect(manifest.issues).toContainEqual({
      code: 'unregistered_consumed_block',
      subject: 'unregistered_private_note',
    });
  });

  it('does not let a candidate relabel a task read as Feedback consumption', () => {
    const manifest = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-relabeled',
      asOf: '2026-08-31T10:08:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [{
          label: 'task',
          kind: 'task',
          category: 'task',
          sourceRef: 'task://synthetic-96',
          version: '2026-08-31T10:00:00.000Z',
          readRef: 'memory://task',
          sha256: TASK_SHA,
        }],
      },
      candidates: [{
        candidateId: 'spoofed-feedback',
        category: 'feedback',
        sourceRef: 'feedback://synthetic/spoofed',
        version: 'v1',
        expectedSha256: TASK_SHA,
        selection: 'selected',
        selectionReason: 'Spoofed feedback identity must not be trusted.',
        blockLabel: 'task',
      }],
    });

    expect(manifest.status).toBe('blocked');
    expect(manifest.entries).toContainEqual(expect.objectContaining({
      candidateId: 'spoofed-feedback',
      status: 'conflict',
      reason: 'context_identity_mismatch',
    }));
    expect(manifest.issues).toContainEqual({
      code: 'context_identity_conflict',
      subject: 'spoofed-feedback',
    });
  });

  it('rejects a task/run manifest whose bundle belongs to another task', () => {
    expect(() => buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-e',
      asOf: '2026-08-31T10:09:00.000Z',
      projectResolution,
      context: { taskId: 'task-other', blocks: [] },
      candidates: [],
    })).toThrow(ContextManifestInputError);
  });

  it('rejects project evidence that was not produced by one verified consistent mapping', () => {
    expect(() => buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-spoofed-project',
      asOf: '2026-08-31T10:09:00.000Z',
      projectResolution: {
        ...projectResolution,
        registry: {
          ...projectResolution.registry,
          verification: 'unverified',
          canonicalProjectRef: 'projects://spoofed/home',
        },
        canonical: {
          ...projectResolution.canonical,
          sha256: 'not-a-sha',
        },
      },
      context: { taskId: 'task-synthetic-96', blocks: [] },
      candidates: [],
    })).toThrow(ContextManifestInputError);
  });

  it('rejects duplicate block labels before one read can overwrite another', () => {
    const taskBlock = consumedBlock('task', 'task', TASK_SHA);

    expect(() => buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-duplicate-block',
      asOf: '2026-08-31T10:09:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          taskBlock,
          {
            ...taskBlock,
            sourceRef: 'task://unregistered',
            readRef: 'memory://unregistered',
            sha256: 'f'.repeat(64),
          },
        ],
      },
      candidates: [candidates()[0]!],
    })).toThrow(ContextManifestInputError);
  });

  it('rejects re-signed manifests whose entry or issue semantics are invalid', () => {
    const ready = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-ready-tamper',
      asOf: '2026-08-31T10:10:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
          consumedBlock('feedback_context_depth', 'feedback', FEEDBACK_SHA),
        ],
      },
      candidates: candidates(),
    });
    const missingReadEvidence = resignManifest(ready, (candidate) => {
      candidate.entries[0]!.readRef = null;
    });

    const blocked = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-issue-tamper',
      asOf: '2026-08-31T10:11:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
        ],
      },
      candidates: candidates(),
    });
    const detachedIssue = resignManifest(blocked, (candidate) => {
      candidate.issues[0]!.subject = 'different-candidate';
    });

    expect(isValidContextManifest(missingReadEvidence)).toBe(false);
    expect(isValidContextManifest(detachedIssue)).toBe(false);
  });

  it('rejects a re-signed Manifest whose status is outside the closed status set', () => {
    const blocked = buildContextManifest({
      taskId: 'task-synthetic-96',
      runId: 'run-synthetic-96-forged-status',
      asOf: '2026-08-31T10:12:00.000Z',
      projectResolution,
      context: {
        taskId: 'task-synthetic-96',
        blocks: [
          consumedBlock('task', 'task', TASK_SHA),
          consumedBlock('project', 'project', PROJECT_SHA),
        ],
      },
      candidates: candidates(),
    });
    const forged = resignManifest(blocked, (candidate) => {
      candidate.status = 'forged' as typeof candidate.status;
    });

    expect(isValidContextManifest(forged)).toBe(false);
  });
});
