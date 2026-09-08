export type TaskStatus = string;

export type Priority = 'urgent' | 'high' | 'normal' | 'low';

// PAW-GOAL-003 T2: the pending human action projected onto the original task.
export interface ActionRequestDto {
  actionId: string;
  eventId: string;
  type: 'needs_decision' | 'blocked' | 'failed' | 'release_candidate_ready';
  status: 'pending' | 'handled' | 'superseded';
  title: string;
  summary: string;
  allowedActions: string[];
  multicaIssue: string;
  githubPr: string | null;
  headSha: string | null;
  notificationId: string | null;
}

export interface ExecutionLinkDto {
  issueIdentifier: string | null;
  remoteState: string | null;
  dispatchState: string;
  lastSyncedAt: string | null;
}

export interface TaskDto {
  taskId: string;
  title: string;
  status: TaskStatus;
  reviewState: 'candidate' | 'ready_for_confirm' | 'confirmed';
  projectId: string | null;
  taskType: 'research' | 'development' | null;
  objective: string | null;
  acceptanceCriteria: string[];
  autoExecutable: boolean;
  permissionProfile: 'read_only_research' | null;
  actionRequest?: ActionRequestDto | null;
  executionLink?: ExecutionLinkDto | null;
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

export type DashboardFactKind = 'fact' | 'inference' | 'missing' | 'human_confirmation';
export type DashboardDataState = 'empty' | 'complete' | 'partial' | 'stale' | 'integrity';

export interface DashboardFactDto {
  kind: DashboardFactKind;
  label: string;
}

export interface DashboardCardDto {
  cardId: string;
  taskId: string;
  title: string;
  reason: DashboardFactDto;
  source: DashboardFactDto;
  goalImpact: DashboardFactDto;
  timeliness: {
    observedAt: string | null;
    state: 'current' | 'stale' | 'unknown';
    label: string;
  };
  status: { code: string; label: string };
  ruleRef: string;
  traceRef: string | null;
  action: { label: string; href: string };
}

export interface WorkbenchDashboardDto {
  observedAt: string;
  dataState: DashboardDataState;
  stateReasons: string[];
  summary: {
    weeklyResults: number;
    candidateTasks: number;
    agentQueue: { raw: number; admitted: number; quarantined: number };
    needsUser: number;
    activeTasks: number;
  };
  integrity: {
    unknownStatusTaskIds: string[];
    invalidClaimLeaseTaskIds: string[];
    expiredClaimTaskIds: string[];
  };
  views: Array<{
    id: 'requires_user' | 'agent_attention' | 'intake' | 'important_not_urgent' | 'weekly_insights';
    label: string;
    description: string;
    cards: DashboardCardDto[];
  }>;
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

export class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`API request failed: ${status}`);
    this.name = 'ApiRequestError';
  }
}

async function writeJson<T>(path: string, body: unknown): Promise<T> {
  const base = globalThis.ATL_RUNTIME_CONFIG?.apiBase ?? window.location.origin;
  const token = globalThis.ATL_RUNTIME_CONFIG?.token ?? '';
  const response = await fetch(new URL(path, base), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-atl-token': token,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new ApiRequestError(response.status);
  return response.json() as Promise<T>;
}

export type CandidateField =
  | 'title'
  | 'objective'
  | 'next_action'
  | 'expected_artifact'
  | 'completion_criteria';

export interface CandidateInspectorDto {
  taskIdentity: {
    taskId: string;
    title: string;
    status: string;
    reviewState: 'candidate' | 'ready_for_confirm' | 'confirmed';
    updatedAt: string;
    candidateRevision: number;
    candidateConfirmed: boolean;
    autoExecutable: boolean;
  };
  understandingIdentity: {
    schemaVersion: 1;
    generationId: string;
    taskType: 'research' | 'code_change' | 'unknown';
  };
  currentTaskBrief: {
    schemaVersion: 1;
    objective: string;
    nextAction: string;
    completionCriteria: string;
    updatedAt: string;
  } | null;
  suggestions: Array<{
    field: CandidateField;
    suggestedValue: string;
    attribution: 'source_fact' | 'ai_inference' | 'missing';
    sourceRefIds: string[];
    reason: string;
    generationId: string;
  }>;
  sourceRefs: Array<{
    sourceRefId: string;
    sourceType: string;
    sourceKey: string;
    sourceNote: string | null;
    anchor: string | null;
    quote: string;
    capturedAt: string;
    lastVerifiedAt: string | null;
    status: 'available' | 'moved' | 'changed' | 'unavailable' | 'missing';
    failureReason: string | null;
    parentContext: string | null;
    lastVerifiedEvidence: {
      resolvedNote: string | null;
      checkedCharacters: number;
      quoteMatched: boolean;
      truncated: boolean;
    } | null;
  }>;
  sourceActions: Array<{
    actionId: 'open_source';
    sourceRefId: string;
    intent: 'open' | 'recover';
    label: '打开原始输入并定位' | '重新定位来源';
  }>;
  gaps: Array<{
    gapId: string;
    field: string;
    severity: 'blocking' | 'optional';
    reasonCode: string;
    question: string;
    impact: 'confirmation' | 'admission' | 'permission' | 'acceptance';
    sourceRefIds: string[];
  }>;
  admission: {
    verdict: 'rejected' | 'needs_completion' | 'needs_authorization' | 'admittable';
    evaluated_at: string;
    rule_version: string;
    input_fingerprint: string;
    reasons: Array<{
      code: string;
      field_or_gate: string;
      message: string;
      recoverable: boolean;
      next_action: string;
    }>;
    permission_gate: CandidateInspectorDto['permissionGate'];
  };
  permissionGate: {
    mode: 'readonly' | 'draft' | 'external_write' | null;
    external_writes: Array<{
      action: string;
      target: string;
      readBackExpectation: string;
    }>;
    requires_authorization: boolean;
    authorized: boolean;
  };
}

export type OpenCandidateSourceDto = {
  actionId: 'open_source';
  outcome: 'located';
  sourceRefId: string;
  locator: { sourceNote: string; anchor: string | null };
} | {
  actionId: 'open_source';
  outcome: 'recovery_required';
  sourceRefId: string;
  locator: null;
  status: 'available' | 'moved' | 'changed' | 'unavailable' | 'missing';
  failureReason: string;
};

export interface SaveCandidateUnderstandingCommand {
  understanding: {
    schemaVersion: 1;
    generationId: string;
    taskType: 'research' | 'code_change' | 'unknown';
    suggestions: CandidateInspectorDto['suggestions'];
    sourceRefs: CandidateInspectorDto['sourceRefs'];
    gaps: CandidateInspectorDto['gaps'];
  };
  expectedRevision: number;
  expectedTaskUpdatedAt: string;
  confirm: boolean;
  values: Partial<Record<CandidateField, string>>;
}

export async function readCandidateInspector(taskId: string): Promise<CandidateInspectorDto> {
  return readJson(`/api/tasks/${encodeURIComponent(taskId)}/candidate-inspector`);
}

export async function openCandidateSource(
  taskId: string,
  sourceRefId: string,
): Promise<OpenCandidateSourceDto> {
  return readJson(
    `/api/tasks/${encodeURIComponent(taskId)}/candidate-sources/${encodeURIComponent(sourceRefId)}/open`,
  );
}

export async function saveCandidateUnderstanding(
  taskId: string,
  command: SaveCandidateUnderstandingCommand,
): Promise<CandidateInspectorDto> {
  return writeJson(
    `/api/tasks/${encodeURIComponent(taskId)}/candidate-understanding`,
    command,
  );
}

export async function readInbox(): Promise<TaskDto[]> {
  return (await readJson<{ tasks: TaskDto[] }>('/api/inbox')).tasks;
}

export async function readDashboard(): Promise<WorkbenchDashboardDto> {
  return readJson<WorkbenchDashboardDto>('/api/dashboard');
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
