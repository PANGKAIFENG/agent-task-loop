import { join } from 'node:path';

import {
  weeklyReviewDecisionSchema,
  type WeeklyReviewDecision,
} from '../domain/weekly-review.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
} from './file-io.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  type VaultWriteAuthorization,
  vaultRoot,
} from './task-paths.js';

export interface WeeklyReviewDecisionRepository {
  create(decision: WeeklyReviewDecision): Promise<WeeklyReviewDecision>;
  listForWeekly(weeklyId: string): Promise<WeeklyReviewDecision[]>;
}

export class InvalidWeeklyReviewDecisionError extends Error {
  readonly code = 'invalid_weekly_review_decision';

  constructor() {
    super('Invalid weekly review decision');
    this.name = 'InvalidWeeklyReviewDecisionError';
  }
}

function progressRoot(root: string): string {
  return join(root, '09_Progress');
}

function decisionsRoot(root: string): string {
  return join(progressRoot(root), 'Weekly', 'Decisions');
}

export class FileWeeklyReviewDecisionRepository
implements WeeklyReviewDecisionRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: {
    writeAuthorization?: VaultWriteAuthorization;
  } = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async create(decision: WeeklyReviewDecision): Promise<WeeklyReviewDecision> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = weeklyReviewDecisionSchema.safeParse(decision);
    if (
      !parsed.success
      || !isSafePathSegment(parsed.data.eventId)
      || !isSafePathSegment(parsed.data.weeklyId)
    ) {
      throw new InvalidWeeklyReviewDecisionError();
    }
    const validDecision = parsed.data;
    const created = await atomicCreateTextFile(
      join(decisionsRoot(this.root), `${validDecision.eventId}.json`),
      `${JSON.stringify(validDecision, null, 2)}\n`,
      {
        vaultRoot: this.root,
        tasksRoot: progressRoot(this.root),
        subtree: decisionsRoot(this.root),
      },
    );
    if (!created) throw new InvalidWeeklyReviewDecisionError();
    return validDecision;
  }

  async listForWeekly(weeklyId: string): Promise<WeeklyReviewDecision[]> {
    if (!isSafePathSegment(weeklyId)) throw new InvalidWeeklyReviewDecisionError();
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: decisionsRoot(this.root),
    };
    const paths = await listSafeRegularFiles(boundary, '*.json');
    const decisions: WeeklyReviewDecision[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new InvalidWeeklyReviewDecisionError();
      }
      const parsed = weeklyReviewDecisionSchema.safeParse(value);
      if (!parsed.success) throw new InvalidWeeklyReviewDecisionError();
      if (parsed.data.weeklyId === weeklyId) decisions.push(parsed.data);
    }
    return decisions.sort((left, right) => left.decidedAt.localeCompare(right.decidedAt));
  }
}
