import type { WorkspaceLeaf } from 'obsidian';

import {
  WorkContributionView,
  type WorkContributionViewDependencies,
} from './work-contribution-view.js';
import {
  WeeklyFocusReviewHomeExtension,
  type WeeklyFocusReviewHomeExtensionDependencies,
} from './weekly-focus-review-home-extension.js';

export class WeeklyFocusReviewContributionView extends WorkContributionView {
  private reviewExtension: WeeklyFocusReviewHomeExtension | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    dependencies: WorkContributionViewDependencies,
    private readonly reviewDependencies: WeeklyFocusReviewHomeExtensionDependencies,
  ) {
    super(leaf, dependencies);
  }

  override async onOpen(): Promise<void> {
    await super.onOpen();
    this.reviewExtension = new WeeklyFocusReviewHomeExtension(
      this.contentEl,
      this.reviewDependencies,
    );
    this.reviewExtension.start();
  }

  override async onClose(): Promise<void> {
    this.reviewExtension?.stop();
    this.reviewExtension = null;
    await super.onClose();
  }

  refreshWeeklyFocusReview(): Promise<void> {
    return this.reviewExtension?.refresh() ?? Promise.resolve();
  }
}
