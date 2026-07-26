import {
  previewLegacyTaskTitles,
  repairLegacyTaskTitles,
  type LegacyTaskTitlePreview,
  type LegacyTaskTitleRepairRepository,
  type LegacyTaskTitleRepairResult,
} from '../services/repair-legacy-task-titles.js';

export class LegacyTaskTitleRepairController {
  constructor(
    private readonly repository: LegacyTaskTitleRepairRepository,
  ) {}

  preview(): Promise<LegacyTaskTitlePreview> {
    return previewLegacyTaskTitles(this.repository);
  }

  repair(preview?: LegacyTaskTitlePreview): Promise<LegacyTaskTitleRepairResult> {
    return repairLegacyTaskTitles(this.repository, preview);
  }
}
