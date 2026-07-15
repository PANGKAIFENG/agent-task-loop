import { z } from 'zod';

import {
  projectResourceSchema,
  projectSchema,
  type Project,
  type ProjectResource,
} from '../domain/project.js';
import { ProjectCreateConflictError } from '../storage/contracts.js';
import type { ServiceContext } from './service-context.js';

export interface CreateProjectInput {
  projectId: string;
  name: string;
  description: string;
  resources: ProjectResource[];
}

export class InvalidCreateProjectInputError extends Error {
  readonly code = 'invalid_create_project_input';

  constructor() {
    super('Invalid create project input');
    this.name = 'InvalidCreateProjectInputError';
  }
}

export class ProjectAlreadyExistsError extends Error {
  readonly code = 'project_already_exists';

  constructor(projectId: string) {
    super(`Project already exists: ${projectId}`);
    this.name = 'ProjectAlreadyExistsError';
  }
}

const nonEmptyString = z.string().refine((value) => value.trim() !== '');
const createProjectInputSchema: z.ZodType<CreateProjectInput> = z
  .object({
    projectId: nonEmptyString,
    name: nonEmptyString,
    description: nonEmptyString,
    resources: z.array(projectResourceSchema.refine((resource) => (
      resource.value.trim() !== '' && resource.label.trim() !== ''
    ))),
  })
  .strict();

export async function createProject(
  ctx: ServiceContext,
  input: CreateProjectInput,
): Promise<Project> {
  const parsed = createProjectInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidCreateProjectInputError();
  }
  const validInput = parsed.data;
  const timestamp = ctx.clock().toISOString();
  const project = projectSchema.parse({
    ...validInput,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  let saved: Project;
  try {
    saved = await ctx.projects.create(project);
  } catch (error) {
    if (error instanceof ProjectCreateConflictError) {
      throw new ProjectAlreadyExistsError(validInput.projectId);
    }
    throw error;
  }
  await ctx.audit.append({
    event: 'project.created',
    at: timestamp,
    projectId: saved.projectId,
    details: { resourceCount: saved.resources.length },
  });
  return saved;
}
