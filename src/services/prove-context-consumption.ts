import {
  ContextConsumptionInputError,
  evaluateContextConsumption,
  type ContextConsumptionReport,
  type FeedbackContextRule,
} from '../domain/context-consumption-proof.js';
import {
  isValidContextManifest,
  type ContextManifest,
} from '../domain/context-manifest.js';

export interface PersistedContextConsumptionTask {
  taskId: string;
  taskType: string;
  projectId: string;
  tags: string[];
}

export interface ContextConsumptionEvidenceRepository {
  getManifest(manifestId: string): Promise<ContextManifest | null>;
  getTaskContext(taskId: string): Promise<PersistedContextConsumptionTask | null>;
  getRuntimePackForRun(taskId: string, runId: string): Promise<{
    taskId: string;
    runId: string;
    contextManifestId: string | null;
    contextManifestSha256: string | null;
  } | null>;
  listFeedbackRules(): Promise<FeedbackContextRule[]>;
}

export interface ProveContextConsumptionDependencies {
  repository: ContextConsumptionEvidenceRepository;
}

export class ContextConsumptionEvidenceError extends Error {
  readonly code = 'context_consumption_evidence_invalid';

  constructor() {
    super('Persisted context consumption evidence is missing or invalid');
    this.name = 'ContextConsumptionEvidenceError';
  }
}

export async function proveContextConsumption(
  dependencies: ProveContextConsumptionDependencies,
  manifestId: string,
): Promise<ContextConsumptionReport> {
  if (manifestId.trim() === '') throw new ContextConsumptionEvidenceError();
  const manifest = await dependencies.repository.getManifest(manifestId);
  if (
    manifest === null
    || manifest.manifestId !== manifestId
    || manifest.status !== 'ready'
    || !isValidContextManifest(manifest)
  ) throw new ContextConsumptionEvidenceError();

  const runtimePack = await dependencies.repository.getRuntimePackForRun(
    manifest.taskId,
    manifest.runId,
  );
  if (
    runtimePack === null
    || runtimePack.taskId !== manifest.taskId
    || runtimePack.runId !== manifest.runId
    || runtimePack.contextManifestId !== manifest.manifestId
    || runtimePack.contextManifestSha256 !== manifest.sha256
  ) throw new ContextConsumptionEvidenceError();

  const task = await dependencies.repository.getTaskContext(manifest.taskId);
  if (
    task === null
    || task.taskId !== manifest.taskId
    || task.projectId !== manifest.projectId
    || task.taskType.trim() === ''
    || task.tags.some((tag) => tag.trim() === '')
  ) throw new ContextConsumptionEvidenceError();

  const feedbackEntries = manifest.entries
    .filter(({ category }) => category === 'feedback');
  if (feedbackEntries.some(({ version }) => version === null)) {
    throw new ContextConsumptionEvidenceError();
  }
  try {
    return evaluateContextConsumption({
      task: {
        ...task,
        asOf: manifest.asOf,
      },
      rules: await dependencies.repository.listFeedbackRules(),
      manifestEntries: feedbackEntries.map((entry) => ({
        candidateId: entry.candidateId,
        category: 'feedback',
        sourceRef: entry.sourceRef,
        version: entry.version!,
        sha256: entry.sha256,
        status: entry.status,
      })),
    });
  } catch (error) {
    if (error instanceof ContextConsumptionInputError) {
      throw new ContextConsumptionEvidenceError();
    }
    throw error;
  }
}
