import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

import {
  codexAcceptanceReceiptSchema,
  codexVisibleFeedbackOutcomeSchema,
  codexVisibleFeedbackSampleSchema,
  type CodexAcceptanceReceipt,
  type CodexVisibleFeedbackOutcome,
  type CodexVisibleFeedbackSample,
} from '../domain/codex-feedback.js';
import {
  parseDecisionDocument,
  serializeDecisionDocument,
} from './decision-document.js';
import {
  atomicCreateTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import {
  assertVaultWriteAllowed,
  vaultRoot,
  type VaultWriteAuthorization,
} from './task-paths.js';

type VisibleCodexRecord =
  | CodexVisibleFeedbackSample
  | CodexAcceptanceReceipt
  | CodexVisibleFeedbackOutcome;

export interface PersistedCodexRecord<T extends VisibleCodexRecord> {
  record: T;
  ref: string;
  path: string;
  sha256: string;
  created: boolean;
}

export type CodexVisibleMessageClaim =
  | PersistedCodexRecord<CodexVisibleFeedbackSample>
  | PersistedCodexRecord<CodexAcceptanceReceipt>;

export class CodexFeedbackVisibleRecordConflictError extends Error {
  readonly code = 'codex_feedback_visible_record_conflict';

  constructor() {
    super('Codex feedback visible record already exists with different content');
    this.name = 'CodexFeedbackVisibleRecordConflictError';
  }
}

export class CodexFeedbackVisibleRecordInvalidError extends Error {
  readonly code = 'codex_feedback_visible_record_invalid';

  constructor() {
    super('Codex feedback visible record is missing or invalid');
    this.name = 'CodexFeedbackVisibleRecordInvalidError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function yearMonth(timestamp: string): { year: string; month: string } {
  const match = /^(\d{4})-(\d{2})-/u.exec(timestamp);
  if (match === null) throw new CodexFeedbackVisibleRecordInvalidError();
  return { year: match[1]!, month: match[2]! };
}

function recordBody(record: VisibleCodexRecord): string {
  if ('feedbackId' in record) {
    return [
      '',
      `# Feedback ${record.feedbackId}`,
      '',
      '## Correction',
      '',
      record.summary,
      '',
      '## Reusable guidance',
      '',
      record.guidance ?? 'No additional guidance.',
      '',
      `Source: ${record.sourceRef}`,
      `Artifact: ${record.artifactRef} (version ${record.artifactVersion})`,
      '',
    ].join('\n');
  }
  if ('acceptanceId' in record) {
    return [
      '',
      `# Acceptance ${record.acceptanceId}`,
      '',
      record.summary,
      '',
      `Source: ${record.sourceRef}`,
      `Artifact: ${record.artifactRef} (version ${record.artifactVersion})`,
      '',
    ].join('\n');
  }
  return [
    '',
    `# Feedback outcome ${record.outcomeId}`,
    '',
    `Outcome: ${record.outcome}`,
    '',
    record.evidenceSummary,
    '',
    `Selection: ${record.selectionId}`,
    `Target binding: ${record.targetBindingId}`,
    '',
  ].join('\n');
}

function frontmatter(record: VisibleCodexRecord): Record<string, unknown> {
  if ('feedbackId' in record) {
    return {
      schema_version: record.schemaVersion,
      feedback_id: record.feedbackId,
      status: record.status,
      binding_id: record.bindingId,
      thread_id: record.threadId,
      task_id: record.taskId,
      source_ref: record.sourceRef,
      artifact_ref: record.artifactRef,
      artifact_version: record.artifactVersion,
      artifact_sha256: record.artifactSha256,
      message_id: record.messageId,
      message_sha256: record.messageSha256,
      summary: record.summary,
      applicability_labels: record.applicabilityLabels,
      guidance: record.guidance,
      capture_mode: record.captureMode,
      created_at: record.createdAt,
    };
  }
  if ('acceptanceId' in record) {
    return {
      schema_version: record.schemaVersion,
      acceptance_id: record.acceptanceId,
      binding_id: record.bindingId,
      thread_id: record.threadId,
      task_id: record.taskId,
      source_ref: record.sourceRef,
      artifact_ref: record.artifactRef,
      artifact_version: record.artifactVersion,
      artifact_sha256: record.artifactSha256,
      message_id: record.messageId,
      message_sha256: record.messageSha256,
      summary: record.summary,
      capture_mode: record.captureMode,
      accepted_at: record.acceptedAt,
    };
  }
  return {
    schema_version: record.schemaVersion,
    outcome_id: record.outcomeId,
    selection_id: record.selectionId,
    target_binding_id: record.targetBindingId,
    selected_feedback_ids: record.selectedFeedbackIds,
    outcome: record.outcome,
    evidence_summary: record.evidenceSummary,
    artifact_ref: record.artifactRef,
    recorded_at: record.recordedAt,
  };
}

function parseFeedback(raw: string): CodexVisibleFeedbackSample | null {
  try {
    const data = parseDecisionDocument(raw).data;
    const parsed = codexVisibleFeedbackSampleSchema.safeParse({
      schemaVersion: data.schema_version,
      feedbackId: data.feedback_id,
      status: data.status,
      bindingId: data.binding_id,
      threadId: data.thread_id,
      taskId: data.task_id,
      sourceRef: data.source_ref,
      artifactRef: data.artifact_ref,
      artifactVersion: data.artifact_version,
      artifactSha256: data.artifact_sha256,
      messageId: data.message_id,
      messageSha256: data.message_sha256,
      summary: data.summary,
      applicabilityLabels: data.applicability_labels,
      guidance: data.guidance,
      captureMode: data.capture_mode,
      createdAt: data.created_at,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseAcceptance(raw: string): CodexAcceptanceReceipt | null {
  try {
    const data = parseDecisionDocument(raw).data;
    const parsed = codexAcceptanceReceiptSchema.safeParse({
      schemaVersion: data.schema_version,
      acceptanceId: data.acceptance_id,
      bindingId: data.binding_id,
      threadId: data.thread_id,
      taskId: data.task_id,
      sourceRef: data.source_ref,
      artifactRef: data.artifact_ref,
      artifactVersion: data.artifact_version,
      artifactSha256: data.artifact_sha256,
      messageId: data.message_id,
      messageSha256: data.message_sha256,
      summary: data.summary,
      captureMode: data.capture_mode,
      acceptedAt: data.accepted_at,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseOutcome(raw: string): CodexVisibleFeedbackOutcome | null {
  try {
    const data = parseDecisionDocument(raw).data;
    const parsed = codexVisibleFeedbackOutcomeSchema.safeParse({
      schemaVersion: data.schema_version,
      outcomeId: data.outcome_id,
      selectionId: data.selection_id,
      targetBindingId: data.target_binding_id,
      selectedFeedbackIds: data.selected_feedback_ids,
      outcome: data.outcome,
      evidenceSummary: data.evidence_summary,
      artifactRef: data.artifact_ref,
      recordedAt: data.recorded_at,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function withoutTimestamp(record: VisibleCodexRecord): Record<string, unknown> {
  const copy = { ...record } as Record<string, unknown>;
  delete copy.createdAt;
  delete copy.acceptedAt;
  delete copy.recordedAt;
  return copy;
}

function parseCanonicalRecord<T extends VisibleCodexRecord>(
  raw: string,
  parse: (value: string) => T | null,
): T | null {
  const record = parse(raw);
  if (record === null) return null;
  const canonical = serializeDecisionDocument(frontmatter(record), recordBody(record));
  return canonical === raw ? record : null;
}

function visibleRecordId(record: VisibleCodexRecord): string {
  if ('feedbackId' in record) return record.feedbackId;
  if ('acceptanceId' in record) return record.acceptanceId;
  return record.outcomeId;
}

export class MarkdownCodexFeedbackRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(
    root?: string,
    options: { writeAuthorization?: VaultWriteAuthorization } = {},
  ) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  async createFeedbackOrGet(
    input: CodexVisibleFeedbackSample,
  ): Promise<PersistedCodexRecord<CodexVisibleFeedbackSample>> {
    const parsed = codexVisibleFeedbackSampleSchema.parse(input);
    return this.createOrGet(
      parsed,
      'Feedback',
      parsed.feedbackId,
      parsed.createdAt,
      parseFeedback,
    );
  }

  async listFeedback(): Promise<Array<PersistedCodexRecord<CodexVisibleFeedbackSample>>> {
    const subtree = join(this.root, '07_System', 'Task_Intake', 'Feedback');
    const boundary = this.boundary(subtree);
    const files = await listSafeRegularFiles(boundary, '**/*.md', { includeDotFiles: true });
    const records: Array<PersistedCodexRecord<CodexVisibleFeedbackSample>> = [];
    const ids = new Set<string>();
    for (const path of files) {
      const raw = await readSafeTextFile(path, boundary);
      const record = raw === null ? null : parseCanonicalRecord(raw, parseFeedback);
      if (raw === null || record === null) {
        throw new CodexFeedbackVisibleRecordInvalidError();
      }
      if (ids.has(record.feedbackId)) {
        throw new CodexFeedbackVisibleRecordConflictError();
      }
      ids.add(record.feedbackId);
      records.push({
        record,
        ref: relative(this.root, path),
        path,
        sha256: sha256(raw),
        created: false,
      });
    }
    return records.sort((left, right) => left.record.feedbackId.localeCompare(
      right.record.feedbackId,
    ));
  }

  async createAcceptanceOrGet(
    input: CodexAcceptanceReceipt,
  ): Promise<PersistedCodexRecord<CodexAcceptanceReceipt>> {
    const parsed = codexAcceptanceReceiptSchema.parse(input);
    return this.createOrGet(
      parsed,
      'Acceptance',
      parsed.acceptanceId,
      parsed.acceptedAt,
      parseAcceptance,
    );
  }

  async findMessageClaims(messageId: string): Promise<CodexVisibleMessageClaim[]> {
    const claims = await Promise.all([
      this.findRecords(
        'Feedback',
        parseFeedback,
        (record) => record.messageId === messageId,
      ),
      this.findRecords(
        'Acceptance',
        parseAcceptance,
        (record) => record.messageId === messageId,
      ),
    ]);
    return claims.flat();
  }

  async readFeedback(
    ref: string,
    expectedSha256: string,
  ): Promise<PersistedCodexRecord<CodexVisibleFeedbackSample>> {
    return this.readByRef(ref, expectedSha256, 'Feedback', parseFeedback);
  }

  async readAcceptance(
    ref: string,
    expectedSha256: string,
  ): Promise<PersistedCodexRecord<CodexAcceptanceReceipt>> {
    return this.readByRef(ref, expectedSha256, 'Acceptance', parseAcceptance);
  }

  async readOutcome(
    ref: string,
    expectedSha256: string,
  ): Promise<PersistedCodexRecord<CodexVisibleFeedbackOutcome>> {
    return this.readByRef(ref, expectedSha256, 'Feedback_Outcomes', parseOutcome);
  }

  async createOutcomeOrGet(
    input: CodexVisibleFeedbackOutcome,
  ): Promise<PersistedCodexRecord<CodexVisibleFeedbackOutcome>> {
    const parsed = codexVisibleFeedbackOutcomeSchema.parse(input);
    return this.createOrGet(
      parsed,
      'Feedback_Outcomes',
      parsed.outcomeId,
      parsed.recordedAt,
      parseOutcome,
    );
  }

  private async createOrGet<T extends VisibleCodexRecord>(
    record: T,
    subtreeName: 'Feedback' | 'Acceptance' | 'Feedback_Outcomes',
    id: string,
    timestamp: string,
    parse: (raw: string) => T | null,
  ): Promise<PersistedCodexRecord<T>> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const existing = await this.findExisting(record, subtreeName, id, parse);
    if (existing !== null) return existing;
    const { year, month } = yearMonth(timestamp);
    const subtree = join(
      this.root,
      '07_System',
      'Task_Intake',
      subtreeName,
      year,
      month,
    );
    const path = join(subtree, `${id}.md`);
    const content = serializeDecisionDocument(frontmatter(record), recordBody(record));
    const boundary = this.boundary(subtree);
    const created = await atomicCreateTextFile(path, content, boundary);
    let finalRecord = record;
    let finalContent = content;
    if (!created) {
      const existingRaw = await readSafeTextFile(path, boundary);
      const existing = existingRaw === null
        ? null
        : parseCanonicalRecord(existingRaw, parse);
      if (
        existingRaw === null
        || existing === null
        || JSON.stringify(withoutTimestamp(existing))
          !== JSON.stringify(withoutTimestamp(record))
      ) {
        throw new CodexFeedbackVisibleRecordConflictError();
      }
      finalRecord = existing;
      finalContent = existingRaw;
    }
    const readBack = await readSafeTextFile(path, boundary);
    if (readBack !== finalContent) throw new CodexFeedbackVisibleRecordInvalidError();
    return {
      record: finalRecord,
      ref: relative(this.root, path),
      path,
      sha256: sha256(readBack),
      created,
    };
  }

  private async findExisting<T extends VisibleCodexRecord>(
    record: T,
    subtreeName: 'Feedback' | 'Acceptance' | 'Feedback_Outcomes',
    id: string,
    parse: (raw: string) => T | null,
  ): Promise<PersistedCodexRecord<T> | null> {
    const matches = await this.findRecords(
      subtreeName,
      parse,
      (candidate) => visibleRecordId(candidate) === id,
    );
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new CodexFeedbackVisibleRecordConflictError();
    const existing = matches[0]!;
    if (JSON.stringify(withoutTimestamp(existing.record))
      !== JSON.stringify(withoutTimestamp(record))) {
      throw new CodexFeedbackVisibleRecordConflictError();
    }
    return existing;
  }

  private async findRecords<T extends VisibleCodexRecord>(
    subtreeName: 'Feedback' | 'Acceptance' | 'Feedback_Outcomes',
    parse: (raw: string) => T | null,
    predicate: (record: T) => boolean,
  ): Promise<Array<PersistedCodexRecord<T>>> {
    const subtree = join(
      this.root,
      '07_System',
      'Task_Intake',
      subtreeName,
    );
    const boundary = this.boundary(subtree);
    const files = await listSafeRegularFiles(boundary, '**/*.md', { includeDotFiles: true });
    const matches: Array<PersistedCodexRecord<T>> = [];
    for (const path of files) {
      const raw = await readSafeTextFile(path, boundary);
      const record = raw === null ? null : parseCanonicalRecord(raw, parse);
      if (raw === null || record === null) {
        throw new CodexFeedbackVisibleRecordConflictError();
      }
      const readBack = await readSafeTextFile(path, boundary);
      if (readBack !== raw) throw new CodexFeedbackVisibleRecordInvalidError();
      if (predicate(record)) {
        matches.push({
          record,
          ref: relative(this.root, path),
          path,
          sha256: sha256(readBack),
          created: false,
        });
      }
    }
    return matches;
  }

  private async readByRef<T extends VisibleCodexRecord>(
    ref: string,
    expectedSha256: string,
    subtreeName: 'Feedback' | 'Acceptance' | 'Feedback_Outcomes',
    parse: (raw: string) => T | null,
  ): Promise<PersistedCodexRecord<T>> {
    const subtree = join(this.root, '07_System', 'Task_Intake', subtreeName);
    const boundary = this.boundary(subtree);
    const path = resolve(this.root, ref);
    const raw = await readSafeTextFile(path, boundary);
    const record = raw === null ? null : parseCanonicalRecord(raw, parse);
    if (
      raw === null
      || record === null
      || relative(this.root, path) !== ref
      || !/^[0-9a-f]{64}$/u.test(expectedSha256)
      || sha256(raw) !== expectedSha256
    ) throw new CodexFeedbackVisibleRecordInvalidError();
    const readBack = await readSafeTextFile(path, boundary);
    if (readBack !== raw) throw new CodexFeedbackVisibleRecordInvalidError();
    return {
      record,
      ref,
      path,
      sha256: expectedSha256,
      created: false,
    };
  }

  private boundary(subtree: string): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: join(this.root, '07_System'),
      subtree,
    };
  }
}
