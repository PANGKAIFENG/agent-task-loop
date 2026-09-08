import { describe, expect, it } from 'vitest';

import {
  projectCandidateInspectorForObsidian,
  projectCandidateInspectorForWeb,
} from '../../../src/services/candidate-inspector-projection.js';
import type { ProjectedAgentAdmission } from '../../../src/services/agent-admission-projection.js';
import { buildCandidateUnderstanding } from '../../../src/domain/candidate-understanding.js';
import type { Task } from '../../../src/domain/task.js';

const admission: ProjectedAgentAdmission = {
  verdict: 'needs_completion',
  evaluated_at: '2026-08-22T02:00:00.000Z',
  rule_version: 'agent-admission-v1',
  input_fingerprint: 'a'.repeat(64),
  reasons: [{
    code: 'artifact_missing',
    field_or_gate: 'expected_artifact',
    message: 'Expected Artifact is required',
    recoverable: true,
    next_action: 'Add an Expected Artifact',
  }],
  permission_gate: {
    mode: 'draft',
    external_writes: [],
    requires_authorization: false,
    authorized: false,
  },
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-synthetic-inspector',
    title: '核对候选任务字段',
    body: '原始正文必须保留，不能进入 inspector DTO。',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: 'personal-workbench',
    taskType: 'research',
    objective: null,
    acceptanceCriteria: [],
    autoExecutable: false,
    permissionProfile: null,
    origin: 'synthetic_fixture',
    sourceDate: '2026-08-22',
    sourceNote: 'fixtures/source.md',
    sourceQuote: '核对候选任务字段，并形成可评审清单。',
    sourceKey: 'synthetic:inspector:source',
    possibleDuplicateIds: [],
    priority: 'normal',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: null,
    createdAt: '2026-08-22T01:00:00.000Z',
    updatedAt: '2026-08-22T01:00:00.000Z',
    ...overrides,
  };
}

describe('candidate inspector projection', () => {
  it('gives Web and Obsidian identical bounded candidate and #6 admission data', () => {
    const understanding = buildCandidateUnderstanding({
      task: {
        taskId: 'task-synthetic-inspector',
        title: '核对候选任务字段',
        body: '原始正文必须保留。',
        taskType: 'research',
      },
      sourceRefs: [{
        sourceRefId: 'source-synthetic-inspector',
        sourceType: 'synthetic_fixture',
        sourceKey: 'synthetic:inspector:source',
        sourceNote: 'fixtures/source.md',
        anchor: '#candidate',
        quote: '核对候选任务字段，并形成可评审清单。',
        capturedAt: '2026-08-22T01:00:00.000Z',
        lastVerifiedAt: '2026-08-22T01:30:00.000Z',
        status: 'available',
        failureReason: null,
        parentContext: null,
        lastVerifiedEvidence: {
          resolvedNote: 'fixtures/source.md',
          checkedCharacters: 120,
          quoteMatched: true,
          truncated: false,
        },
      }],
      aiDraft: {
        objective: '形成可评审清单',
        nextAction: '逐项核对字段',
        expectedArtifact: '候选字段清单',
        completionCriteria: '字段均有来源或缺失说明',
      },
    });
    const current = task({
      candidateUnderstanding: {
        ...understanding,
        revision: 2,
        confirmed: false,
        updatedAt: '2026-08-22T01:45:00.000Z',
      },
    });

    const web = projectCandidateInspectorForWeb(current, admission);
    const obsidian = projectCandidateInspectorForObsidian(current, admission);

    expect(web).toEqual(obsidian);
    expect(web.taskIdentity).toEqual({
      taskId: current.taskId,
      title: current.title,
      status: 'inbox',
      reviewState: 'candidate',
      updatedAt: current.updatedAt,
      candidateRevision: 2,
      candidateConfirmed: false,
      autoExecutable: false,
    });
    expect(web.suggestions).toHaveLength(5);
    expect(web.sourceRefs).toHaveLength(1);
    expect(web.sourceActions).toEqual([{
      actionId: 'open_source',
      sourceRefId: 'source-synthetic-inspector',
      intent: 'open',
      label: '打开原始输入并定位',
    }]);
    expect(web.admission.reasons[0]?.code).toBe('artifact_missing');
    expect(web.permissionGate).toEqual(admission.permission_gate);
    expect(web).not.toHaveProperty('body');
    expect(web).not.toHaveProperty('sourceKey');

    web.admission.reasons[0]!.message = 'mutated';
    web.sourceRefs[0]!.quote = 'mutated';
    expect(admission.reasons[0]?.message).toBe('Expected Artifact is required');
    expect(current.candidateUnderstanding?.sourceRefs[0]?.quote)
      .toBe('核对候选任务字段，并形成可评审清单。');
  });

  it.each(['changed', 'unavailable', 'missing'] as const)(
    'projects a bounded recovery action for a %s source',
    (status) => {
      const understanding = buildCandidateUnderstanding({
        task: task(),
        sourceRefs: [{
          sourceRefId: 'source-recovery',
          sourceType: 'synthetic_fixture',
          sourceKey: 'synthetic:recovery',
          sourceNote: 'fixtures/recovery.md',
          anchor: null,
          quote: '保留的有限引用',
          capturedAt: '2026-08-22T01:00:00.000Z',
          lastVerifiedAt: null,
          status,
          failureReason: `source_${status}`,
          parentContext: null,
          lastVerifiedEvidence: null,
        }],
      });
      const projection = projectCandidateInspectorForWeb(task({
        candidateUnderstanding: {
          ...understanding,
          revision: 1,
          confirmed: false,
          updatedAt: '2026-08-22T01:10:00.000Z',
        },
      }), admission);

      expect(projection.sourceActions).toEqual([{
        actionId: 'open_source',
        sourceRefId: 'source-recovery',
        intent: 'recover',
        label: '重新定位来源',
      }]);
    },
  );

  it('projects a legacy candidate without writing a revision or inventing missing values', () => {
    const legacy = task({
      taskBrief: {
        schemaVersion: 1,
        objective: '核对旧任务',
        nextAction: '读取旧 Task Brief',
        completionCriteria: '得到兼容投影',
        updatedAt: '2026-08-22T01:10:00.000Z',
      },
    });

    const projection = projectCandidateInspectorForWeb(legacy, admission);

    expect(projection.taskIdentity.candidateRevision).toBe(0);
    expect(projection.taskIdentity.candidateConfirmed).toBe(false);
    expect(projection.currentTaskBrief).toEqual(legacy.taskBrief);
    expect(projection.suggestions.find(({ field }) => field === 'objective'))
      .toMatchObject({
        suggestedValue: '核对旧任务',
        attribution: 'ai_inference',
        sourceRefIds: [],
      });
    expect(projection.suggestions.find(({ field }) => field === 'expected_artifact'))
      .toMatchObject({ suggestedValue: '', attribution: 'missing' });
    const sourceRefIds = new Set(projection.sourceRefs.map(({ sourceRefId }) => sourceRefId));
    for (const suggestion of projection.suggestions) {
      if (suggestion.attribution !== 'source_fact') continue;
      expect(suggestion.sourceRefIds.length).toBeGreaterThan(0);
      expect(suggestion.sourceRefIds.every((sourceRefId) => sourceRefIds.has(sourceRefId)))
        .toBe(true);
    }
    expect(legacy.candidateUnderstanding).toBeUndefined();
  });
});
