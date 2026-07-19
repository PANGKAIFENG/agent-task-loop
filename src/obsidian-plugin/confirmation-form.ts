import { PRIORITIES, type Priority } from '../domain/task.js';

export type ProjectFormInput = {
  mode: 'none';
} | {
  mode: 'existing';
  projectId: string;
} | {
  mode: 'new';
  name: string;
  description: string;
};

export interface ConfirmationFormInput {
  project: ProjectFormInput;
  objective: string;
  acceptanceCriteria: string[];
  priority: Priority;
  autoExecutable: boolean;
}

export type NormalizedProjectForm = {
  mode: 'none';
} | {
  mode: 'existing';
  projectId: string;
} | {
  mode: 'new';
  projectId: string;
  name: string;
  description: string;
};

export interface NormalizedConfirmationForm {
  project: NormalizedProjectForm;
  objective: string | null;
  acceptanceCriteria: string[];
  priority: Priority;
  autoExecutable: boolean;
}

export interface ConfirmationFormErrors {
  project?: string;
  objective?: string;
  acceptanceCriteria?: string;
  priority?: string;
}

export type ConfirmationFormResult = {
  success: true;
  value: NormalizedConfirmationForm;
} | {
  success: false;
  errors: ConfirmationFormErrors;
};

export function projectIdFromName(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/gu, '-')
    .replace(/^[-_]+|[-_]+$/gu, '');
}

export function validateConfirmationForm(
  input: ConfirmationFormInput,
): ConfirmationFormResult {
  const errors: ConfirmationFormErrors = {};
  let project: NormalizedProjectForm | null = null;

  if (input.project.mode === 'none') {
    project = { mode: 'none' };
  } else if (input.project.mode === 'existing') {
    const projectId = input.project.projectId.trim();
    if (projectId === '') {
      errors.project = '请选择项目';
    } else {
      project = { mode: 'existing', projectId };
    }
  } else {
    const name = input.project.name.trim();
    const description = input.project.description.trim();
    const projectId = projectIdFromName(name);
    if (name === '' || description === '' || projectId === '') {
      errors.project = '请填写项目名称和说明';
    } else {
      project = { mode: 'new', projectId, name, description };
    }
  }

  const objective = input.objective.trim() || null;

  const acceptanceCriteria = input.acceptanceCriteria
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion !== '');
  if (!PRIORITIES.includes(input.priority)) {
    errors.priority = '请选择优先级';
  }

  if (Object.keys(errors).length > 0 || project === null) {
    return { success: false, errors };
  }
  return {
    success: true,
    value: {
      project,
      objective,
      acceptanceCriteria,
      priority: input.priority,
      autoExecutable: input.autoExecutable,
    },
  };
}
