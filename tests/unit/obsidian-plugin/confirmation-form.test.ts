import { describe, expect, it } from 'vitest';

import {
  validateConfirmationForm,
  type ConfirmationFormInput,
} from '../../../src/obsidian-plugin/confirmation-form.js';

function existingProjectForm(
  overrides: Partial<ConfirmationFormInput> = {},
): ConfirmationFormInput {
  return {
    project: { mode: 'existing', projectId: ' product-research ' },
    objective: ' Compare official product information. ',
    acceptanceCriteria: [' Cite an official source. ', '  '],
    priority: 'high',
    ...overrides,
  };
}

describe('validateConfirmationForm', () => {
  it('normalizes a lightweight task without a project or execution details', () => {
    expect(validateConfirmationForm({
      project: { mode: 'none' },
      objective: ' ',
      acceptanceCriteria: [' ', '\t'],
      priority: 'normal',
    })).toEqual({
      success: true,
      value: {
        project: { mode: 'none' },
        objective: null,
        acceptanceCriteria: [],
        priority: 'normal',
      },
    });
  });

  it('normalizes a complete existing-project form', () => {
    expect(validateConfirmationForm(existingProjectForm())).toEqual({
      success: true,
      value: {
        project: { mode: 'existing', projectId: 'product-research' },
        objective: 'Compare official product information.',
        acceptanceCriteria: ['Cite an official source.'],
        priority: 'high',
      },
    });
  });

  it('returns a field error for an empty existing-project selection', () => {
    expect(validateConfirmationForm(existingProjectForm({
      project: { mode: 'existing', projectId: ' ' },
      objective: ' ',
      acceptanceCriteria: [' ', '\t'],
    }))).toEqual({
      success: false,
      errors: {
        project: '请选择项目',
      },
    });
  });

  it('normalizes a new project and derives a safe project id', () => {
    expect(validateConfirmationForm(existingProjectForm({
      project: {
        mode: 'new',
        name: ' AI 产品雷达 ',
        description: ' 每日产品情报调研 ',
      },
    }))).toEqual({
      success: true,
      value: expect.objectContaining({
        project: {
          mode: 'new',
          projectId: 'ai-产品雷达',
          name: 'AI 产品雷达',
          description: '每日产品情报调研',
        },
      }),
    });
  });
});

describe('validateConfirmationForm development branch (PAW-GOAL-003-V0.5 D1)', () => {
  function developmentForm(
    overrides: Partial<ConfirmationFormInput> = {},
  ): ConfirmationFormInput {
    return {
      project: { mode: 'existing', projectId: 'agent-task-loop' },
      objective: 'Rebuild the Multica binding from the board.',
      acceptanceCriteria: ['The board restores the TEP identifier.'],
      priority: 'high',
      taskKind: 'development',
      contextRefs: [
        ' docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md ',
        'apps/agent-task-loop/src/services/reconcile-multica-dispatch.ts',
      ],
      repoDeliveryAcknowledged: true,
      ...overrides,
    };
  }

  it('normalizes a complete development form with trimmed context refs', () => {
    expect(validateConfirmationForm(developmentForm())).toEqual({
      success: true,
      value: {
        project: { mode: 'existing', projectId: 'agent-task-loop' },
        objective: 'Rebuild the Multica binding from the board.',
        acceptanceCriteria: ['The board restores the TEP identifier.'],
        priority: 'high',
        taskKind: 'development',
        contextRefs: [
          'docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md',
          'apps/agent-task-loop/src/services/reconcile-multica-dispatch.ts',
        ],
      },
    });
  });

  it('requires a project on the development branch', () => {
    const result = validateConfirmationForm(developmentForm({
      project: { mode: 'none' },
    }));
    expect(result).toEqual({
      success: false,
      errors: { project: '开发任务请选择或新建项目' },
    });
  });

  it('requires an objective and at least one acceptance criterion', () => {
    const result = validateConfirmationForm(developmentForm({
      objective: ' ',
      acceptanceCriteria: [' '],
    }));
    expect(result).toMatchObject({
      success: false,
      errors: {
        objective: '请填写任务目标',
        acceptanceCriteria: '至少填写一条验收标准',
      },
    });
  });

  it('reports missing context refs with the shared wording', () => {
    const empty = validateConfirmationForm(developmentForm({ contextRefs: ['', '  '] }));
    expect(empty).toMatchObject({
      success: false,
      errors: { contextRefs: '至少添加一条执行工作区内的仓库相对路径引用' },
    });
    const none = validateConfirmationForm(developmentForm({ contextRefs: [] }));
    expect(none).toMatchObject({
      success: false,
      errors: { contextRefs: '至少添加一条执行工作区内的仓库相对路径引用' },
    });
  });

  it('localizes an absolute path ref to an actionable gap message', () => {
    const result = validateConfirmationForm(developmentForm({
      contextRefs: ['docs/ok.md', '/Users/linctex/private/客户排期.xlsx'],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.contextRefs).toContain('/Users/linctex/private/客户排期.xlsx');
      expect(result.errors.contextRefs).toContain('绝对路径');
    }
  });

  it('localizes a traversal ref to an actionable gap message', () => {
    const result = validateConfirmationForm(developmentForm({
      contextRefs: ['docs/../../secrets.md'],
    }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.contextRefs).toContain('路径穿越段');
      expect(result.errors.contextRefs).toContain('docs/../../secrets.md');
    }
  });

  it('requires the repo_delivery acknowledgement before submit', () => {
    const result = validateConfirmationForm(developmentForm({
      repoDeliveryAcknowledged: false,
    }));
    expect(result).toEqual({
      success: false,
      errors: { repoDeliveryAcknowledged: '请先确认 repo_delivery 权限声明' },
    });
  });

  it('keeps the research output byte-identical when the dev fields are absent', () => {
    const result = validateConfirmationForm({
      project: { mode: 'existing', projectId: 'agent-task-loop' },
      objective: 'Compare official product information.',
      acceptanceCriteria: ['Cite an official source.'],
      priority: 'high',
    });
    expect(result).toEqual({
      success: true,
      value: {
        project: { mode: 'existing', projectId: 'agent-task-loop' },
        objective: 'Compare official product information.',
        acceptanceCriteria: ['Cite an official source.'],
        priority: 'high',
      },
    });
  });

  it('never lets a leftover acknowledgement leak into a research value', () => {
    const result = validateConfirmationForm({
      project: { mode: 'existing', projectId: 'agent-task-loop' },
      objective: 'Compare official product information.',
      acceptanceCriteria: ['Cite an official source.'],
      priority: 'high',
      taskKind: 'research',
      contextRefs: ['docs/irrelevant.md'],
      repoDeliveryAcknowledged: true,
    });
    expect(result).toEqual({
      success: true,
      value: {
        project: { mode: 'existing', projectId: 'agent-task-loop' },
        objective: 'Compare official product information.',
        acceptanceCriteria: ['Cite an official source.'],
        priority: 'high',
      },
    });
  });
});
