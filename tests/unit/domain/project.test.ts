import { describe, expect, it } from 'vitest';

import {
  projectResourceSchema,
  projectSchema,
  type Project,
} from '../../../src/domain/project.js';

const makeProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  name: 'Research project',
  description: 'A synthetic test project',
  resources: [
    {
      kind: 'url',
      value: 'https://example.com',
      label: 'Example',
    },
  ],
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
  ...overrides,
});

describe('projectSchema', () => {
  it('rejects unknown top-level keys', () => {
    const project = { ...makeProject(), unexpected: true };

    expect(projectSchema.safeParse(project).success).toBe(false);
  });

  it('rejects unknown keys in nested resources', () => {
    const project = {
      ...makeProject(),
      resources: [
        {
          kind: 'url',
          value: 'https://example.com',
          label: 'Example',
          unexpected: true,
        },
      ],
    };

    expect(projectSchema.safeParse(project).success).toBe(false);
  });
});

describe('projectResourceSchema', () => {
  it('rejects unknown keys', () => {
    const resource = {
      kind: 'local_path',
      value: '/tmp/research',
      label: 'Research fixture',
      unexpected: true,
    };

    expect(projectResourceSchema.safeParse(resource).success).toBe(false);
  });
});
