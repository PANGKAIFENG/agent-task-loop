import type { AcceptanceObject } from '../domain/acceptance-object.js';
import type { ProgressDraft } from '../domain/progress.js';
import type { PrepareMaterialGapRequestInput } from '../services/prepare-material-gap-request.js';

export type WorkProgressHubTab = 'matches' | 'progress' | 'materials' | 'weekly';

export type WorkProgressSourceStatus =
  | 'never_scanned'
  | 'connected'
  | 'login_required'
  | 'incompatible'
  | 'network_failed';

export interface WorkProgressMatchCandidate {
  eventKeyHash: string;
  eventPath: string;
  title: string;
  scheduled: string;
  score: number;
  support: string[];
  opposition: string[];
  missing: string[];
}

export interface WorkProgressMatchItem {
  recordingId: string;
  title: string;
  createdAt: string | null;
  status: 'waiting' | 'available' | 'failed';
  activeDecision: {
    decisionId: string;
    action: 'confirmed' | 'no_calendar';
    eventKeyHash: string | null;
  } | null;
  progressDrafts: ProgressDraft[];
  candidates: WorkProgressMatchCandidate[];
}

export interface WorkProgressHubSnapshot {
  source: {
    status: WorkProgressSourceStatus;
    scannedAt: string | null;
    lastSuccessfulScanAt: string | null;
    available: number;
    waiting: number;
    failed: number;
  };
  matches: WorkProgressMatchItem[];
  progress: Array<{
    progressId: string;
    version: number;
    topic: string;
    projectId: string | null;
    lifecycleStatus: string;
    path: string;
  }>;
  materialGaps: Array<{
    gapId: string;
    title: string;
    status: string;
    path: string;
  }>;
  weeklyReports: Array<{
    weeklyId: string;
    version: number;
    weekKey: string;
    acceptanceState: 'pending' | 'accepted' | 'rejected' | 'later';
    publicationState: 'not_published' | 'published';
    completeness: 'complete' | 'partial_success';
    pendingCount: number;
    path: string;
  }>;
  acceptanceObjects: AcceptanceObject[];
}

export interface WorkProgressHubState {
  status: 'loading' | 'ready' | 'error';
  activeTab: WorkProgressHubTab;
  snapshot: WorkProgressHubSnapshot | null;
  selectedCandidate: {
    recordingId: string;
    eventKeyHash: string;
  } | null;
  busyAction: string | null;
  errorCode: string | null;
}

export interface WorkProgressHubDependencies {
  loadSnapshot(): Promise<WorkProgressHubSnapshot>;
  confirmMatch(input: {
    recordingId: string;
    eventKeyHash: string;
  }): Promise<unknown>;
  markNoCalendar(input: { recordingId: string }): Promise<unknown>;
  revokeMatch(input: { decisionId: string }): Promise<unknown>;
  acceptWeekly(input: { weeklyId: string; version: number }): Promise<unknown>;
  rejectWeekly(input: {
    weeklyId: string;
    expectedVersion: number;
    feedback: string;
  }): Promise<unknown>;
  deferWeekly(input: { weeklyId: string; version: number }): Promise<unknown>;
  generateWeekly(): Promise<unknown>;
  syncSource(): Promise<unknown>;
  createProgress(input: ProgressDraft): Promise<unknown>;
  createMaterialGap(input: PrepareMaterialGapRequestInput): Promise<unknown>;
}

type StateListener = (state: WorkProgressHubState) => void;

export class MeetingCandidateRequiredError extends Error {
  readonly code = 'meeting_candidate_required';

  constructor() {
    super('请选择一个日程候选');
    this.name = 'MeetingCandidateRequiredError';
  }
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/u.test(error.code)
  ) return error.code;
  return 'work_progress_action_failed';
}

export class WorkProgressHubController {
  private readonly listeners = new Set<StateListener>();
  private state: WorkProgressHubState = {
    status: 'loading',
    activeTab: 'matches',
    snapshot: null,
    selectedCandidate: null,
    busyAction: null,
    errorCode: null,
  };
  private refreshOperation: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly dependencies: WorkProgressHubDependencies) {}

  getState(): WorkProgressHubState {
    return this.state;
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<void> {
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshOperation !== null) return this.refreshOperation;
    this.patch({ status: 'loading', errorCode: null });
    const operation = this.load().finally(() => {
      if (this.refreshOperation === operation) this.refreshOperation = null;
    });
    this.refreshOperation = operation;
    return operation;
  }

  setActiveTab(activeTab: WorkProgressHubTab): void {
    if (this.disposed || this.state.activeTab === activeTab) return;
    this.patch({ activeTab });
  }

  selectCandidate(recordingId: string, eventKeyHash: string): void {
    if (this.disposed) return;
    this.patch({ selectedCandidate: { recordingId, eventKeyHash } });
  }

  async confirmSelectedMatch(): Promise<void> {
    const selected = this.state.selectedCandidate;
    if (selected === null) throw new MeetingCandidateRequiredError();
    await this.runAction('confirm-match', () => this.dependencies.confirmMatch(selected));
    this.patch({ selectedCandidate: null });
  }

  markSelectedRecordingWithoutCalendar(recordingId: string): Promise<void> {
    return this.runAction(
      `no-calendar:${recordingId}`,
      () => this.dependencies.markNoCalendar({ recordingId }),
    );
  }

  revokeDecision(decisionId: string): Promise<void> {
    return this.runAction(
      `revoke:${decisionId}`,
      () => this.dependencies.revokeMatch({ decisionId }),
    );
  }

  acceptWeeklyReport(weeklyId: string, version: number): Promise<void> {
    return this.runAction(
      `accept:${weeklyId}:${version}`,
      () => this.dependencies.acceptWeekly({ weeklyId, version }),
    );
  }

  rejectWeeklyReport(weeklyId: string, expectedVersion: number, feedback: string): Promise<void> {
    return this.runAction(
      `reject:${weeklyId}:${expectedVersion}`,
      () => this.dependencies.rejectWeekly({ weeklyId, expectedVersion, feedback }),
    );
  }

  deferWeeklyReport(weeklyId: string, version: number): Promise<void> {
    return this.runAction(
      `defer:${weeklyId}:${version}`,
      () => this.dependencies.deferWeekly({ weeklyId, version }),
    );
  }

  generateCurrentWeeklyReport(): Promise<void> {
    return this.runAction('generate-weekly', () => this.dependencies.generateWeekly());
  }

  retrySource(): Promise<void> {
    return this.runAction('sync-source', () => this.dependencies.syncSource());
  }

  createProgressVersion(input: ProgressDraft): Promise<void> {
    return this.runAction('create-progress', () => this.dependencies.createProgress(input));
  }

  registerMaterialGap(input: PrepareMaterialGapRequestInput): Promise<void> {
    return this.runAction(
      'create-material-gap',
      () => this.dependencies.createMaterialGap(input),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    try {
      const snapshot = await this.dependencies.loadSnapshot();
      if (!this.disposed) this.patch({ status: 'ready', snapshot, errorCode: null });
    } catch (error) {
      if (!this.disposed) {
        this.patch({ status: 'error', errorCode: safeErrorCode(error) });
      }
    }
  }

  private async runAction(key: string, action: () => Promise<unknown>): Promise<void> {
    if (this.disposed || this.state.busyAction !== null) return;
    this.patch({ busyAction: key, errorCode: null });
    try {
      await action();
      await this.refresh();
    } catch (error) {
      if (!this.disposed) this.patch({ errorCode: safeErrorCode(error) });
      throw error;
    } finally {
      if (!this.disposed) this.patch({ busyAction: null });
    }
  }

  private patch(patch: Partial<WorkProgressHubState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
