import {
  parseTaskDocument,
  serializeTaskDocument,
  type TaskDocument,
} from '../storage/frontmatter.js';
import type { DingTalkCalendarOccurrence } from './dingtalk-calendar-parser.js';
import { mergeDingTalkOccurrence } from './dingtalk-calendar-merge.js';
import type { DingTalkEventLedgerEntry } from './dingtalk-calendar-types.js';

const IMPORT_DIRECTORY = 'TaskNotes/DingTalk';

export interface DingTalkCalendarFileSystem {
  exists(path: string): Promise<boolean>;
  ensureDirectory(path: string): Promise<void>;
  listMarkdownFiles(): Promise<string[]>;
  read(path: string): Promise<string>;
  create(path: string, content: string): Promise<void>;
  modify(path: string, content: string): Promise<void>;
}

export type DingTalkCalendarWriteAction =
  | 'added'
  | 'updated'
  | 'skipped'
  | 'tombstoned';

export interface DingTalkCalendarWriteResult {
  action: DingTalkCalendarWriteAction;
  entry: DingTalkEventLedgerEntry;
  conflicts: number;
}

export interface DingTalkCalendarWriterOptions {
  fileSystem: DingTalkCalendarFileSystem;
  clock?: () => Date;
}

function createLedgerEntry(
  occurrence: DingTalkCalendarOccurrence,
  taskPath: string | null,
  now: string,
  cancelledBySync: boolean,
): DingTalkEventLedgerEntry {
  return {
    eventKeyHash: occurrence.eventKeyHash,
    remoteUid: occurrence.remoteUid,
    recurrenceId: occurrence.recurrenceId,
    href: occurrence.href,
    etag: occurrence.etag,
    taskPath,
    remoteSnapshotHash: occurrence.snapshotHash,
    remoteSnapshot: occurrence.snapshot,
    lastSeenAt: now,
    locallyDeletedAt: null,
    cancelledBySync,
  };
}

function addDingTalkIdentity(
  document: TaskDocument,
  occurrence: DingTalkCalendarOccurrence,
): TaskDocument {
  return {
    data: {
      ...document.data,
      dingtalk_event_key_hash: occurrence.eventKeyHash,
      dingtalk_calendar_id: 'primary',
    },
    body: document.body,
  };
}

function hasEventIdentity(document: TaskDocument, eventKeyHash: string): boolean {
  return document.data.dingtalk_event_key_hash === eventKeyHash;
}

export class DingTalkCalendarWriter {
  private readonly fileSystem: DingTalkCalendarFileSystem;
  private readonly clock: () => Date;

  constructor(options: DingTalkCalendarWriterOptions) {
    this.fileSystem = options.fileSystem;
    this.clock = options.clock ?? (() => new Date());
  }

  async apply(
    occurrence: DingTalkCalendarOccurrence,
    previous: DingTalkEventLedgerEntry | undefined,
  ): Promise<DingTalkCalendarWriteResult> {
    const now = this.clock().toISOString();
    if (previous?.locallyDeletedAt !== null && previous?.locallyDeletedAt !== undefined) {
      return {
        action: 'tombstoned',
        entry: {
          ...previous,
          href: occurrence.href,
          etag: occurrence.etag,
          lastSeenAt: now,
        },
        conflicts: 0,
      };
    }

    const taskPath = await this.findTaskPath(occurrence.eventKeyHash, previous?.taskPath);
    if (previous !== undefined && taskPath === null) {
      return {
        action: 'tombstoned',
        entry: {
          ...previous,
          href: occurrence.href,
          etag: occurrence.etag,
          taskPath: null,
          lastSeenAt: now,
          locallyDeletedAt: now,
        },
        conflicts: 0,
      };
    }

    if (taskPath === null) {
      const path = `${IMPORT_DIRECTORY}/${occurrence.eventKeyHash}.md`;
      const merged = mergeDingTalkOccurrence({
        current: null,
        previousRemote: null,
        nextRemote: occurrence.snapshot,
        cancelledBySync: false,
      });
      const document = addDingTalkIdentity(merged.document, occurrence);
      await this.fileSystem.ensureDirectory(IMPORT_DIRECTORY);
      await this.fileSystem.create(path, serializeTaskDocument(document.data, document.body));
      return {
        action: 'added',
        entry: createLedgerEntry(
          occurrence,
          path,
          now,
          merged.cancelledBySync,
        ),
        conflicts: 0,
      };
    }

    const current = parseTaskDocument(await this.fileSystem.read(taskPath));
    const merged = mergeDingTalkOccurrence({
      current,
      previousRemote: previous?.remoteSnapshot ?? null,
      nextRemote: occurrence.snapshot,
      cancelledBySync: previous?.cancelledBySync ?? false,
    });
    if (merged.changed) {
      const document = addDingTalkIdentity(merged.document, occurrence);
      await this.fileSystem.modify(
        taskPath,
        serializeTaskDocument(document.data, document.body),
      );
    }

    return {
      action: merged.changed ? 'updated' : 'skipped',
      entry: createLedgerEntry(
        occurrence,
        taskPath,
        now,
        merged.cancelledBySync,
      ),
      conflicts: merged.overriddenLocalFields.length,
    };
  }

  private async findTaskPath(
    eventKeyHash: string,
    recordedPath: string | null | undefined,
  ): Promise<string | null> {
    if (recordedPath !== null && recordedPath !== undefined) {
      if (await this.fileSystem.exists(recordedPath)) return recordedPath;
    }

    const paths = await this.fileSystem.listMarkdownFiles();
    for (const path of paths) {
      try {
        const document = parseTaskDocument(await this.fileSystem.read(path));
        if (hasEventIdentity(document, eventKeyHash)) return path;
      } catch {
        // Unrelated Markdown files may not contain valid task frontmatter.
      }
    }
    return null;
  }
}
