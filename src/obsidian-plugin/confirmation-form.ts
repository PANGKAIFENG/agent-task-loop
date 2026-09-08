import { PRIORITIES, type Priority } from '../domain/task.js';
import { contextRefGapMessages } from './development-contract.js';

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

export type TaskKind = 'research' | 'development';

export interface ConfirmationFormInput {
  project: ProjectFormInput;
  objective: string;
  acceptanceCriteria: string[];
  priority: Priority;
  /**
   * PAW-GOAL-003-V0.5 D1 (PRD 4.1): the confirmation form branches on the
   * declared task type. `research` is the default and keeps the legacy
   * validation exactly as before; `development` additionally requires the
   * dispatch contract fields.
   */
  taskKind?: TaskKind;
  contextRefs?: string[];
  repoDeliveryAcknowledged?: boolean;
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
  /** Present only for the development branch — research output is unchanged. */
  taskKind?: 'development';
  contextRefs?: string[];
}

export interface ConfirmationFormErrors {
  project?: string;
  objective?: string;
  acceptanceCriteria?: string;
  priority?: string;
  contextRefs?: string;
  repoDeliveryAcknowledged?: string;
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

const EMPTY_CONTEXT_REFS_ERROR = '至少添加一条执行工作区内的仓库相对路径引用';

// Per-entry rules come from contextRefErrors via the contract module (the
// same source the dispatch admission uses); only the wording is localized.
function developmentContextRefError(refs: string[]): string | undefined {
  if (!refs.some((ref) => ref !== '')) {
    return EMPTY_CONTEXT_REFS_ERROR;
  }
  const errors = contextRefGapMessages(refs);
  return errors.length > 0 ? errors.join('；') : undefined;
}

export function validateConfirmationForm(
  input: ConfirmationFormInput,
): ConfirmationFormResult {
  const errors: ConfirmationFormErrors = {};
  const taskKind: TaskKind = input.taskKind ?? 'research';
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

  if (taskKind === 'development') {
    if (project === null || project.mode === 'none') {
      errors.project = '开发任务请选择或新建项目';
    }
    if (objective === null) {
      errors.objective = '请填写任务目标';
    }
    if (acceptanceCriteria.length === 0) {
      errors.acceptanceCriteria = '至少填写一条验收标准';
    }
    const contextRefs = (input.contextRefs ?? []).map((ref) => ref.trim());
    const contextRefsError = developmentContextRefError(contextRefs);
    if (contextRefsError !== undefined) {
      errors.contextRefs = contextRefsError;
    }
    if (input.repoDeliveryAcknowledged !== true) {
      errors.repoDeliveryAcknowledged = '请先确认 repo_delivery 权限声明';
    }
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
      ...(taskKind === 'development'
        ? {
            taskKind: 'development' as const,
            contextRefs: (input.contextRefs ?? []).map((ref) => ref.trim()),
          }
        : {}),
    },
  };
}
