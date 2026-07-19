export type TaskStatus = string;

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

export interface TaskDto {
  taskId: string;
  title: string;
  status: TaskStatus;
  reviewState: 'candidate' | 'ready_for_confirm' | 'confirmed';
  projectId: string | null;
  taskType: 'research' | null;
  objective: string | null;
  acceptanceCriteria: string[];
  autoExecutable: boolean;
  permissionProfile: 'read_only_research' | null;
  origin: string;
  sourceDate: string | null;
  sourceExcerpt: string | null;
  possibleDuplicateIds: string[];
  priority: Priority;
  attempts: number;
  claim: {
    runId: string;
    agent: string;
    claimedAt: string;
    leaseExpiresAt: string;
  } | null;
  artifactSummaries: Array<{ summary: string; evidenceCount: number }>;
  reviewFeedback: string | null;
  readyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDto {
  projectId: string;
  name: string;
  description: string;
  resources: Array<{
    kind: 'url' | 'local_path' | 'github_repo';
    value: string;
    label: string;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeConfig {
  apiBase: string;
  token: string;
}

declare global {
  var ATL_RUNTIME_CONFIG: RuntimeConfig | undefined;
}

async function readJson<T>(path: string): Promise<T> {
  const base = globalThis.ATL_RUNTIME_CONFIG?.apiBase ?? window.location.origin;
  const response = await fetch(new URL(path, base));
  if (!response.ok) {
    throw new Error(`API read failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function readInbox(): Promise<TaskDto[]> {
  return (await readJson<{ tasks: TaskDto[] }>('/api/inbox')).tasks;
}

export async function readReview(): Promise<TaskDto[]> {
  return (await readJson<{ tasks: TaskDto[] }>('/api/review')).tasks;
}

export async function readProjects(): Promise<ProjectDto[]> {
  return (await readJson<{ projects: ProjectDto[] }>('/api/projects')).projects;
}

export async function readProjectTasks(projectId: string): Promise<TaskDto[]> {
  const id = encodeURIComponent(projectId);
  return (await readJson<{ tasks: TaskDto[] }>(`/api/projects/${id}/tasks`)).tasks;
}
