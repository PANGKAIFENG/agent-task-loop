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
    autoExecutable: true,
    ...overrides,
  };
}

describe('validateConfirmationForm', () => {
  it('normalizes a complete existing-project form', () => {
    expect(validateConfirmationForm(existingProjectForm())).toEqual({
      success: true,
      value: {
        project: { mode: 'existing', projectId: 'product-research' },
        objective: 'Compare official product information.',
        acceptanceCriteria: ['Cite an official source.'],
        priority: 'high',
        autoExecutable: true,
      },
    });
  });

  it('returns field errors for missing project, objective and criteria', () => {
    expect(validateConfirmationForm(existingProjectForm({
      project: { mode: 'existing', projectId: ' ' },
      objective: ' ',
      acceptanceCriteria: [' ', '\t'],
    }))).toEqual({
      success: false,
      errors: {
        project: '请选择项目',
        objective: '请填写任务目标',
        acceptanceCriteria: '请至少填写一条验收标准',
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
