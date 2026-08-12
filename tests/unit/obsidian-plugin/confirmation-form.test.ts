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
