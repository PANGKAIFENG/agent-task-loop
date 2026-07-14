import { z } from 'zod';

export interface ProjectResource {
  kind: 'url' | 'local_path' | 'github_repo';
  value: string;
  label: string;
}

export interface Project {
  projectId: string;
  name: string;
  description: string;
  resources: ProjectResource[];
  createdAt: string;
  updatedAt: string;
}

export const projectResourceSchema: z.ZodType<ProjectResource> = z.object({
  kind: z.enum(['url', 'local_path', 'github_repo']),
  value: z.string(),
  label: z.string(),
});

export const projectSchema: z.ZodType<Project> = z.object({
  projectId: z.string(),
  name: z.string(),
  description: z.string(),
  resources: z.array(projectResourceSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
