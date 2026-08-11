export interface LegacyTaskTitleCandidate {
  path: string;
  title: string;
  revision: string;
}

export interface LegacyTaskTitlePreview {
  filesScanned: number;
  tasksScanned: number;
  candidates: LegacyTaskTitleCandidate[];
}

export interface LegacyTaskTitleRepairRepository {
  scan(): Promise<LegacyTaskTitlePreview>;
  repair(candidate: LegacyTaskTitleCandidate): Promise<boolean>;
  rebuildIndex(): Promise<void>;
}

export interface LegacyTaskTitleRepairResult {
  filesScanned: number;
  tasksScanned: number;
  repairable: number;
  repaired: number;
  skipped: number;
  failed: number;
  indexUpdated: boolean;
}

export function previewLegacyTaskTitles(
  repository: LegacyTaskTitleRepairRepository,
): Promise<LegacyTaskTitlePreview> {
  return repository.scan();
}

export async function repairLegacyTaskTitles(
  repository: LegacyTaskTitleRepairRepository,
  preview?: LegacyTaskTitlePreview,
): Promise<LegacyTaskTitleRepairResult> {
  const repairPreview = preview ?? await repository.scan();
  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of repairPreview.candidates) {
    try {
      if (await repository.repair(candidate)) repaired += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }

  let indexUpdated = true;
  if (repaired > 0) {
    try {
      await repository.rebuildIndex();
    } catch {
      indexUpdated = false;
    }
  }

  return {
    filesScanned: repairPreview.filesScanned,
    tasksScanned: repairPreview.tasksScanned,
    repairable: repairPreview.candidates.length,
    repaired,
    skipped,
    failed,
    indexUpdated,
  };
}
