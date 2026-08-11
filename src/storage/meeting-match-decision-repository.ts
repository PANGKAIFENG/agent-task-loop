import { join } from 'node:path';

import {
  meetingMatchDecisionSchema,
  type MeetingMatchDecision,
} from '../domain/meeting-match-decision.js';
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

export interface MeetingMatchDecisionRepository {
  create(decision: MeetingMatchDecision): Promise<MeetingMatchDecision>;
  list(): Promise<MeetingMatchDecision[]>;
  listActive(): Promise<MeetingMatchDecision[]>;
}

export class InvalidMeetingMatchDecisionError extends Error {
  readonly code = 'invalid_meeting_match_decision';

  constructor() {
    super('Invalid meeting match decision');
    this.name = 'InvalidMeetingMatchDecisionError';
  }
}

function progressRoot(root: string): string {
  return join(root, '09_Progress');
}

function decisionsRoot(root: string): string {
  return join(progressRoot(root), 'Decisions', 'MeetingMatches');
}

export function activeMeetingMatchDecisions(
  decisions: readonly MeetingMatchDecision[],
): MeetingMatchDecision[] {
  const activeByRecording = new Map<string, MeetingMatchDecision>();
  const byId = new Map<string, MeetingMatchDecision>();
  for (const decision of [...decisions].sort((left, right) => (
    left.decidedAt.localeCompare(right.decidedAt)
    || left.decisionId.localeCompare(right.decisionId)
  ))) {
    byId.set(decision.decisionId, decision);
    if (decision.action === 'revoked') {
      const superseded = decision.supersedesDecisionId === null
        ? undefined
        : byId.get(decision.supersedesDecisionId);
      if (
        superseded !== undefined
        && activeByRecording.get(superseded.recordingId)?.decisionId === superseded.decisionId
      ) {
        activeByRecording.delete(superseded.recordingId);
      }
      continue;
    }
    activeByRecording.set(decision.recordingId, decision);
  }
  return [...activeByRecording.values()].sort((left, right) => (
    left.decidedAt.localeCompare(right.decidedAt)
    || left.decisionId.localeCompare(right.decisionId)
  ));
}

export class FileMeetingMatchDecisionRepository
implements MeetingMatchDecisionRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: { writeAuthorization?: VaultWriteAuthorization } = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async create(decision: MeetingMatchDecision): Promise<MeetingMatchDecision> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = meetingMatchDecisionSchema.safeParse(decision);
    if (!parsed.success || !isSafePathSegment(parsed.data.decisionId)) {
      throw new InvalidMeetingMatchDecisionError();
    }
    const created = await atomicCreateTextFile(
      join(decisionsRoot(this.root), `${parsed.data.decisionId}.json`),
      `${JSON.stringify(parsed.data, null, 2)}\n`,
      {
        vaultRoot: this.root,
        tasksRoot: progressRoot(this.root),
        subtree: decisionsRoot(this.root),
      },
    );
    if (!created) throw new InvalidMeetingMatchDecisionError();
    return parsed.data;
  }

  async list(): Promise<MeetingMatchDecision[]> {
    const boundary = {
      vaultRoot: this.root,
      tasksRoot: progressRoot(this.root),
      subtree: decisionsRoot(this.root),
    };
    const paths = await listSafeRegularFiles(boundary, '*.json');
    const decisions: MeetingMatchDecision[] = [];
    for (const path of paths) {
      const raw = await readSafeTextFile(path, boundary);
      if (raw === null) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        throw new InvalidMeetingMatchDecisionError();
      }
      const parsed = meetingMatchDecisionSchema.safeParse(value);
      if (!parsed.success) throw new InvalidMeetingMatchDecisionError();
      decisions.push(parsed.data);
    }
    return decisions.sort((left, right) => (
      left.decidedAt.localeCompare(right.decidedAt)
      || left.decisionId.localeCompare(right.decisionId)
    ));
  }

  async listActive(): Promise<MeetingMatchDecision[]> {
    return activeMeetingMatchDecisions(await this.list());
  }
}

