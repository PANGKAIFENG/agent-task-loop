import { isValidDingTalkProfile } from '../dingtalk-profile.js';
import type { MaterialSearchStatus } from '../domain/material-gap.js';
import type {
  ExternalMaterialSearchOutcome,
  MaterialContactCandidate,
} from '../services/prepare-material-gap-request.js';
import {
  runDwsCommand,
  type DwsCommandResult,
  type DwsCommandRunner,
} from './dws-self-acceptance-delivery.js';

const MAX_RESULTS_PER_SOURCE = 10;
const MAX_DOCUMENT_READS = 3;
const MAX_CONTACT_LOOKUPS = 3;
const MAX_AITABLE_BASES = 3;
const MAX_AITABLE_TABLES_PER_BASE = 5;
const MAX_EVIDENCE_CHARACTERS = 100_000;

type UnresolvedSearchStatus = Exclude<MaterialSearchStatus, 'found'>;

interface SearchInput {
  query: string;
  occurredAt: string;
  projectId: string | null;
}

interface MaterialEvidence {
  sourceRef: string;
  content: string;
}

interface CommandSuccess {
  status: 'ok';
  value: Record<string, unknown>;
}

interface CommandFailure {
  status: 'permission_denied' | 'failed';
}

type CommandOutcome = CommandSuccess | CommandFailure;

interface MessageEvidence extends MaterialEvidence {
  sender: string | null;
  senderOpenDingTalkId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x08
      || codePoint === 0x0b
      || codePoint === 0x0c
      || (codePoint >= 0x0e && codePoint <= 0x1f)
      || codePoint === 0x7f;
  });
}

function stringValue(value: unknown, maximum = 20_000): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (
    normalized === ''
    || normalized.length > maximum
    || hasUnsafeControlCharacter(normalized)
  ) return null;
  return normalized;
}

function permissionFailure(value: Record<string, unknown>): boolean {
  const text = JSON.stringify({
    errorCode: value.errorCode,
    errorMsg: value.errorMsg,
    error: value.error,
    message: value.message,
  });
  return /(?:403|forbidden|permission|无权限|未授权|拒绝访问)/iu.test(text);
}

function commandOutcome(result: DwsCommandResult): CommandOutcome {
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    return { status: 'failed' };
  }
  if (!isRecord(value)) return { status: 'failed' };
  if (result.exitCode !== 0) {
    return { status: permissionFailure(value) ? 'permission_denied' : 'failed' };
  }
  if (value.success === true && value.complete !== false) {
    return { status: 'ok', value };
  }
  return { status: permissionFailure(value) ? 'permission_denied' : 'failed' };
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const child = value[key];
  return isRecord(child) ? child : null;
}

function getArray(value: Record<string, unknown>, key: string): unknown[] {
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function optionalArray(value: Record<string, unknown>, key: string): unknown[] | null {
  const child = value[key];
  return Array.isArray(child) ? child : null;
}

function boundedContent(value: string): string {
  return value.slice(0, MAX_EVIDENCE_CHARACTERS);
}

function searchWindow(occurredAt: string): { start: string; end: string } {
  const occurred = new Date(occurredAt);
  if (Number.isNaN(occurred.getTime())) {
    const now = new Date();
    return {
      start: new Date(now.getTime() - (14 * 86_400_000)).toISOString(),
      end: new Date(now.getTime() + (3 * 86_400_000)).toISOString(),
    };
  }
  return {
    start: new Date(occurred.getTime() - (14 * 86_400_000)).toISOString(),
    end: new Date(occurred.getTime() + (3 * 86_400_000)).toISOString(),
  };
}

function unresolvedOutcome(
  source: ExternalMaterialSearchOutcome['source'],
  target: string,
  status: UnresolvedSearchStatus,
  materials: readonly MaterialEvidence[] = [],
  contacts: readonly MaterialContactCandidate[] = [],
): ExternalMaterialSearchOutcome {
  return { source, target, status, materials, contacts };
}

export class DwsMaterialSearchConnector {
  private readonly profile: string | null;
  private readonly runner: DwsCommandRunner;

  constructor(options: { profile: string | null; runner?: DwsCommandRunner }) {
    if (options.profile !== null && !isValidDingTalkProfile(options.profile)) {
      throw new Error('DingTalk profile is invalid');
    }
    this.profile = options.profile;
    this.runner = options.runner ?? ((args) => runDwsCommand(args));
  }

  async search(input: SearchInput): Promise<ExternalMaterialSearchOutcome[]> {
    const query = input.query.trim().slice(0, 256);
    if (query === '') throw new Error('Material search query is required');
    const target = `query:${query}`;
    const yunxiaoTarget = `project:${input.projectId?.trim() || 'unassigned'}`;
    if (this.profile === null) {
      return [
        unresolvedOutcome('dingtalk_message', target, 'not_connected'),
        unresolvedOutcome('dingtalk_doc', target, 'not_connected'),
        unresolvedOutcome('dingtalk_aitable', target, 'not_connected'),
        unresolvedOutcome('dingtalk_drive', target, 'not_connected'),
        unresolvedOutcome('yunxiao', yunxiaoTarget, 'not_connected'),
      ];
    }

    const { start, end } = searchWindow(input.occurredAt);
    const [message, drive, aitable] = await Promise.all([
      this.run([
        'chat', 'message', 'search',
        '--query', query,
        '--start', start,
        '--end', end,
        '--limit', String(MAX_RESULTS_PER_SOURCE),
      ]),
      this.run([
        'drive', 'search',
        '--query', query,
        '--limit', String(MAX_RESULTS_PER_SOURCE),
      ]),
      this.run(['aitable', 'base', 'search', '--query', query]),
    ]);

    const messageOutcome = await this.messageOutcome(target, message);
    const { documentOutcome, driveOutcome } = await this.driveOutcomes(target, drive);
    return [
      messageOutcome,
      documentOutcome,
      await this.aitableOutcome(target, query, aitable),
      driveOutcome,
      unresolvedOutcome('yunxiao', yunxiaoTarget, 'not_connected'),
    ];
  }

  private async run(args: string[]): Promise<CommandOutcome> {
    if (this.profile === null) return { status: 'failed' };
    try {
      return commandOutcome(await this.runner([
        '--profile', this.profile,
        '--format', 'json',
        ...args,
      ]));
    } catch {
      return { status: 'failed' };
    }
  }

  private async messageOutcome(
    target: string,
    outcome: CommandOutcome,
  ): Promise<ExternalMaterialSearchOutcome> {
    if (outcome.status !== 'ok') {
      return unresolvedOutcome('dingtalk_message', target, outcome.status);
    }
    const result = getRecord(outcome.value, 'result');
    const conversations = optionalArray(outcome.value, 'result')
      ?? (result === null ? [] : getArray(result, 'conversationMessagesList'));
    const messages: MessageEvidence[] = [];
    for (const conversation of conversations.slice(0, MAX_RESULTS_PER_SOURCE)) {
      if (!isRecord(conversation)) continue;
      for (const rawMessage of getArray(conversation, 'messages')) {
        if (!isRecord(rawMessage) || messages.length >= MAX_RESULTS_PER_SOURCE) break;
        const content = stringValue(rawMessage.content, MAX_EVIDENCE_CHARACTERS);
        const messageId = stringValue(rawMessage.openMessageId, 1_024);
        if (content === null || messageId === null) continue;
        messages.push({
          content: boundedContent(content),
          sourceRef: `dingtalk-message:${messageId}`,
          sender: stringValue(rawMessage.sender, 256),
          senderOpenDingTalkId: stringValue(rawMessage.senderOpenDingTalkId, 512),
        });
      }
      if (messages.length >= MAX_RESULTS_PER_SOURCE) break;
    }
    const contacts = await this.resolveMessageContacts(messages);
    return unresolvedOutcome(
      'dingtalk_message',
      target,
      'not_found',
      messages.map(({ sourceRef, content }) => ({ sourceRef, content })),
      contacts,
    );
  }

  private async resolveMessageContacts(
    messages: readonly MessageEvidence[],
  ): Promise<MaterialContactCandidate[]> {
    const contacts: MaterialContactCandidate[] = [];
    const seenSenders = new Set<string>();
    let lookups = 0;
    for (const message of messages) {
      if (
        lookups >= MAX_CONTACT_LOOKUPS
        || message.sender === null
        || message.senderOpenDingTalkId === null
        || seenSenders.has(message.senderOpenDingTalkId)
      ) continue;
      seenSenders.add(message.senderOpenDingTalkId);
      lookups += 1;
      const lookup = await this.run([
        'aisearch', 'person',
        '--keyword', message.sender,
        '--dimension', 'name',
      ]);
      if (lookup.status !== 'ok') continue;
      const matches = getArray(lookup.value, 'result').filter((entry): entry is Record<string, unknown> => (
        isRecord(entry)
        && stringValue(entry.title, 256) === message.sender
        && stringValue(entry.openDingTalkId, 512) === message.senderOpenDingTalkId
        && stringValue(entry.sourceType, 64) === 'person'
        && stringValue(entry.userId, 512) !== null
      ));
      if (matches.length !== 1) continue;
      const userId = stringValue(matches[0]?.userId, 512);
      if (userId === null) continue;
      contacts.push({
        userId,
        displayName: message.sender,
        reason: '相关钉钉消息发送人',
        sourceRef: message.sourceRef,
        priority: 30,
      });
    }
    return contacts;
  }

  private async driveOutcomes(
    target: string,
    outcome: CommandOutcome,
  ): Promise<{
    documentOutcome: ExternalMaterialSearchOutcome;
    driveOutcome: ExternalMaterialSearchOutcome;
  }> {
    if (outcome.status !== 'ok') {
      return {
        documentOutcome: unresolvedOutcome('dingtalk_doc', target, outcome.status),
        driveOutcome: unresolvedOutcome('dingtalk_drive', target, outcome.status),
      };
    }
    const result = getRecord(outcome.value, 'result');
    const docResults = result === null ? null : getRecord(result, 'doc_results');
    const docContent = docResults === null ? null : getRecord(docResults, 'content');
    const documents = docContent === null
      ? []
      : optionalArray(docContent, 'result') ?? getArray(docContent, 'documents');
    const materials: MaterialEvidence[] = [];
    const readFailures: Array<'permission_denied' | 'failed'> = [];
    for (const document of documents.slice(0, MAX_DOCUMENT_READS)) {
      if (!isRecord(document)) continue;
      const nodeId = stringValue(document.nodeId, 1_024);
      if (nodeId === null) continue;
      const read = await this.run([
        'doc', 'read',
        '--node', nodeId,
        '--content-format', 'markdown',
      ]);
      if (read.status !== 'ok') {
        readFailures.push(read.status);
        continue;
      }
      const readResult = getRecord(read.value, 'result');
      const markdown = stringValue(
        readResult?.markdown ?? read.value.markdown,
        MAX_EVIDENCE_CHARACTERS,
      );
      if (markdown === null) continue;
      materials.push({
        sourceRef: stringValue(document.docUrl, 20_000) ?? `dingtalk-doc:${nodeId}`,
        content: boundedContent(markdown),
      });
    }
    const documentStatus: UnresolvedSearchStatus = materials.length > 0 || documents.length === 0
      ? 'not_found'
      : readFailures.length > 0
        && readFailures.every((status) => status === 'permission_denied')
        ? 'permission_denied'
        : 'failed';

    const driveResults = result === null ? null : getRecord(result, 'drive_results');
    const driveContent = driveResults === null ? null : getRecord(driveResults, 'content');
    const items = driveContent === null
      ? []
      : optionalArray(driveContent, 'result') ?? getArray(driveContent, 'items');
    const driveMaterials = items.slice(0, MAX_RESULTS_PER_SOURCE).flatMap((item) => {
      if (!isRecord(item)) return [];
      const name = stringValue(item.name, 2_000);
      const fileId = stringValue(item.fileId, 1_024);
      if (name === null || fileId === null) return [];
      return [{
        sourceRef: stringValue(item.docUrl, 20_000) ?? `dingtalk-drive:${fileId}`,
        content: name,
      }];
    });

    return {
      documentOutcome: unresolvedOutcome(
        'dingtalk_doc', target, documentStatus, materials,
      ),
      driveOutcome: unresolvedOutcome(
        'dingtalk_drive', target, 'not_found', driveMaterials,
      ),
    };
  }

  private async aitableOutcome(
    target: string,
    query: string,
    outcome: CommandOutcome,
  ): Promise<ExternalMaterialSearchOutcome> {
    if (outcome.status !== 'ok') {
      return unresolvedOutcome('dingtalk_aitable', target, outcome.status);
    }
    const data = getRecord(outcome.value, 'data');
    const bases = optionalArray(outcome.value, 'result')
      ?? (data === null ? [] : getArray(data, 'bases'));
    const materials: MaterialEvidence[] = [];
    const failures: Array<'permission_denied' | 'failed'> = [];
    for (const base of bases.slice(0, MAX_AITABLE_BASES)) {
      if (!isRecord(base)) continue;
      const name = stringValue(base.baseName, 2_000)
        ?? stringValue(base.name, 2_000)
        ?? stringValue(base.title, 2_000);
      const baseId = stringValue(base.baseId, 1_024) ?? stringValue(base.id, 1_024);
      if (name === null || baseId === null) continue;
      const tableCatalog = await this.run([
        'aitable', 'table', 'get', '--base-id', baseId,
      ]);
      if (tableCatalog.status !== 'ok') {
        failures.push(tableCatalog.status);
        continue;
      }
      const tableData = getRecord(tableCatalog.value, 'data');
      const tables = optionalArray(tableCatalog.value, 'result')
        ?? (tableData === null ? [] : getArray(tableData, 'tables'));
      for (const table of tables.slice(0, MAX_AITABLE_TABLES_PER_BASE)) {
        if (!isRecord(table) || materials.length >= MAX_RESULTS_PER_SOURCE) break;
        const tableId = stringValue(table.tableId, 1_024)
          ?? stringValue(table.id, 1_024);
        const tableName = stringValue(table.tableName, 2_000)
          ?? stringValue(table.name, 2_000);
        if (tableId === null || tableName === null) continue;
        const recordSearch = await this.run([
          'aitable', 'record', 'query',
          '--base-id', baseId,
          '--table-id', tableId,
          '--query', query,
          '--limit', String(MAX_RESULTS_PER_SOURCE - materials.length),
        ]);
        if (recordSearch.status !== 'ok') {
          failures.push(recordSearch.status);
          continue;
        }
        const recordData = getRecord(recordSearch.value, 'data');
        const resultRecord = getRecord(recordSearch.value, 'result');
        const records = optionalArray(recordSearch.value, 'result')
          ?? (resultRecord === null
            ? recordData === null ? [] : getArray(recordData, 'records')
            : getArray(resultRecord, 'records'));
        for (const record of records) {
          if (!isRecord(record) || materials.length >= MAX_RESULTS_PER_SOURCE) break;
          const recordId = stringValue(record.recordId, 1_024)
            ?? stringValue(record.id, 1_024);
          const cells = getRecord(record, 'cells');
          if (recordId === null || cells === null) continue;
          const serializedCells = JSON.stringify(cells);
          if (serializedCells.length > MAX_EVIDENCE_CHARACTERS) continue;
          materials.push({
            sourceRef: `dingtalk-aitable:${baseId}/${tableId}/${recordId}`,
            content: boundedContent([
              `Base：${name}`,
              `数据表：${tableName}`,
              `记录：${serializedCells}`,
            ].join('\n')),
          });
        }
      }
    }
    if (materials.length === 0 && failures.length > 0) {
      return unresolvedOutcome(
        'dingtalk_aitable',
        target,
        failures.every((status) => status === 'permission_denied')
          ? 'permission_denied'
          : 'failed',
      );
    }
    return unresolvedOutcome('dingtalk_aitable', target, 'not_found', materials);
  }
}
