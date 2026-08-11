import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  QianwenConnectorStatus,
  QianwenSourceRecordingInput,
  QianwenSourceScanInput,
} from '../obsidian-plugin/qianwen-source-state.js';

const execFileAsync = promisify(execFile);
const QIANWEN_RECORDING_URL = /https?:\/\/(?:www\.)?qianwen\.com\/chat\/([a-z0-9]{16,})(?:\?[^\s]*)?/iu;
const DATE_TIME = /(?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})/u;
const DURATION = /^(?:时长\s*)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/u;
const RECORDING_IDENTIFIER = /(?:audio|recording|transcript|meeting|听记|录音)/iu;
const LIST_ANCHOR = /(?:AI\s*听记|我的听记|最近听记|录音记录)/iu;
const WAITING_TEXT = /(?:正在生成|生成中|转写中|正在转写|请稍后)/u;
const IGNORED_PRESSABLE_TEXT = new Set([
  'AI 纪要',
  'AI纪要',
  '原文',
  '返回',
  '搜索',
  '设置',
  '分享',
]);

export type QianwenAccessibilityStatus =
  | 'ok'
  | 'app_not_running'
  | 'accessibility_denied'
  | 'login_required'
  | 'network_failed'
  | 'incompatible';

export interface QianwenAccessibilityNode {
  depth: number;
  role: string;
  title?: string;
  value?: string;
  description?: string;
  identifier?: string;
  url?: string;
  selected?: boolean;
  hittable?: boolean;
  frame?: { x: number; y: number; width: number; height: number };
  actions: string[];
}

export interface QianwenAccessibilitySnapshot {
  status: QianwenAccessibilityStatus;
  nodes: QianwenAccessibilityNode[];
}

export interface QianwenAccessibilityAdapter {
  snapshot(): Promise<QianwenAccessibilitySnapshot>;
  summarySnapshot?(): Promise<QianwenAccessibilitySnapshot>;
  press(text: string): Promise<{ status: QianwenAccessibilityStatus }>;
}

interface QianwenReadinessOptions {
  attempts: number;
  delayMs: number;
}

function helperPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'qianwen-accessibility-helper');
}

function nativeFailure(): QianwenAccessibilitySnapshot {
  return { status: 'incompatible', nodes: [] };
}

export function createQianwenAccessibilityAdapter(options: {
  executable?: string;
} = {}): QianwenAccessibilityAdapter {
  const executable = options.executable ?? helperPath();
  async function invoke(args: string[]): Promise<QianwenAccessibilitySnapshot> {
    try {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: 30_000,
      });
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return nativeFailure();
      }
      const record = parsed as Record<string, unknown>;
      const status = record.status;
      const nodes = record.nodes;
      if (
        typeof status !== 'string'
        || ![
          'ok',
          'app_not_running',
          'accessibility_denied',
          'login_required',
          'network_failed',
          'incompatible',
        ].includes(status)
        || !Array.isArray(nodes)
      ) {
        return nativeFailure();
      }
      return {
        status: status as QianwenAccessibilityStatus,
        nodes: nodes.filter((node): node is QianwenAccessibilityNode => (
          node !== null
          && typeof node === 'object'
          && !Array.isArray(node)
          && typeof (node as { depth?: unknown }).depth === 'number'
          && typeof (node as { role?: unknown }).role === 'string'
          && Array.isArray((node as { actions?: unknown }).actions)
        )),
      };
    } catch {
      return nativeFailure();
    }
  }
  return {
    snapshot: () => invoke(['snapshot']),
    summarySnapshot: () => invoke(['summary']),
    async press(text) {
      const result = await invoke(['press', text]);
      return { status: result.status };
    },
  };
}

function textValues(node: QianwenAccessibilityNode): string[] {
  return [node.title, node.value, node.description, node.url]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value !== '');
}

function primaryText(node: QianwenAccessibilityNode): string {
  return textValues(node)[0] ?? '';
}

function discoverTitles(snapshot: QianwenAccessibilitySnapshot): string[] {
  const titles = snapshot.nodes.flatMap((node) => {
    const text = primaryText(node);
    if (
      text === ''
      || IGNORED_PRESSABLE_TEXT.has(text)
    ) {
      return [];
    }
    if (
      RECORDING_IDENTIFIER.test(node.identifier ?? '')
      || textValues(node).some((value) => QIANWEN_RECORDING_URL.test(value))
      || /^录音纪要：\S/u.test(text)
    ) {
      return [text];
    }
    return [];
  });
  return [...new Set(titles)];
}

function connectorStatus(status: QianwenAccessibilityStatus): QianwenConnectorStatus {
  if (status === 'ok') return 'connected';
  if (status === 'login_required') return 'login_required';
  if (status === 'network_failed') return 'network_failed';
  return 'incompatible';
}

function isoDateTime(value: string, referenceDate: string): string | null {
  const matched = DATE_TIME.exec(value);
  if (matched === null) return null;
  const [, year, month, day, hour, minute] = matched;
  if (
    month === undefined
    || day === undefined
    || hour === undefined
    || minute === undefined
  ) {
    return null;
  }
  const normalizedMonth = month.padStart(2, '0');
  const normalizedDay = day.padStart(2, '0');
  let inferredYear = Number(year ?? referenceDate.slice(0, 4));
  if (year === undefined && `${inferredYear}-${normalizedMonth}-${normalizedDay}` > referenceDate) {
    inferredYear -= 1;
  }
  return `${String(inferredYear)}-${normalizedMonth}-${normalizedDay}T${
    hour.padStart(2, '0')
  }:${minute}:00+08:00`;
}

function durationSeconds(values: string[]): number | null {
  for (const value of values) {
    const matched = DURATION.exec(value);
    if (matched === null || DATE_TIME.test(value)) continue;
    const hours = Number(matched[1] ?? 0);
    const minutes = Number(matched[2]);
    const seconds = Number(matched[3]);
    if (minutes < 60 && seconds < 60) return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

function section(
  nodes: QianwenAccessibilityNode[],
  startPattern: RegExp,
  endPattern?: RegExp,
): string {
  const texts = nodes.map(primaryText);
  const start = texts.findIndex((text) => startPattern.test(text));
  if (start === -1) return '';
  const after = texts.slice(start + 1);
  const end = endPattern === undefined
    ? -1
    : after.findIndex((text) => endPattern.test(text));
  return (end === -1 ? after : after.slice(0, end))
    .filter((text) => (
      text !== ''
      && !QIANWEN_RECORDING_URL.test(text)
      && !DATE_TIME.test(text)
      && !DURATION.test(text)
    ))
    .join('\n')
    .trim();
}

function selectedTabIndex(
  nodes: QianwenAccessibilityNode[],
  pattern: RegExp,
): number {
  return nodes.findIndex((node) => (
    node.selected === true
    && pattern.test(primaryText(node))
  ));
}

function transcriptNodeIndexes(nodes: QianwenAccessibilityNode[]): Set<number> {
  const indexes = new Set<number>();
  for (let index = 0; index < nodes.length; index += 1) {
    const speaker = primaryText(nodes[index] ?? { depth: 0, role: '', actions: [] });
    const timestamp = primaryText(nodes[index + 1] ?? { depth: 0, role: '', actions: [] });
    const content = primaryText(nodes[index + 2] ?? { depth: 0, role: '', actions: [] });
    if (
      /^发言人\S*$/u.test(speaker)
      && /^\d{2}:\d{2}(?::\d{2})?$/u.test(timestamp)
      && content !== ''
    ) {
      indexes.add(index);
      indexes.add(index + 1);
      indexes.add(index + 2);
      index += 2;
    }
  }
  return indexes;
}

function selectedSummary(
  nodes: QianwenAccessibilityNode[],
  recordingTitle: string,
): string {
  const transcriptIndexes = transcriptNodeIndexes(nodes);
  const explicitlySelected = selectedTabIndex(nodes, /^AI\s*纪要$/u);
  const hasOriginalSpeakerStructure = nodes.some((node) => /^发言人\S*$/u.test(primaryText(node)));
  const inferredSelected = explicitlySelected === -1 && !hasOriginalSpeakerStructure
    ? nodes.findIndex((node) => /^AI\s*纪要$/u.test(primaryText(node)))
    : -1;
  const start = explicitlySelected === -1 ? inferredSelected : explicitlySelected;
  if (start === -1) return '';
  const lines: string[] = [];
  for (let index = start + 1; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    if (node.role === 'AXTextArea' || node.role === 'AXTextField') break;
    const text = primaryText(node);
    if (
      text === ''
      || transcriptIndexes.has(index)
      || ['AXButton', 'AXPopUpButton', 'AXImage'].includes(node.role)
      || /^(?:原文|AI\s*纪要|笔记|复制|分享|下载|关闭)$/u.test(text)
      || text === recordingTitle
      || QIANWEN_RECORDING_URL.test(text)
      || DATE_TIME.test(text)
      || DURATION.test(text)
      || /^\[?\d{2}:\d{2}(?::\d{2})?\]?\s*发言人/u.test(text)
    ) {
      continue;
    }
    if (lines.at(-1) !== text) lines.push(text);
  }
  return lines.join('\n').trim();
}

function summaryText(
  nodes: QianwenAccessibilityNode[],
  recordingTitle: string,
): string {
  const ocrLines = nodes
    .filter((node) => node.role === 'OCRStaticText' && node.hittable !== false)
    .map(primaryText)
    .filter((text) => (
      text !== ''
      && text !== recordingTitle
      && !/^(?:原文|AI\s*纪要|笔记|复制|分享|下载|关闭)$/u.test(text)
      && !QIANWEN_RECORDING_URL.test(text)
      && !DATE_TIME.test(text)
      && !DURATION.test(text)
    ));
  if (ocrLines.length > 0) return [...new Set(ocrLines)].join('\n').trim();
  const legacy = section(nodes, /^AI\s*纪要$/u, /^原文$/u);
  const aiIndex = nodes.findIndex((node) => /^AI\s*纪要$/u.test(primaryText(node)));
  const originalAfterAi = nodes.findIndex((node, index) => (
    index > aiIndex && /^原文$/u.test(primaryText(node))
  ));
  if (aiIndex !== -1 && originalAfterAi !== -1 && legacy !== '') return legacy;
  return selectedSummary(nodes, recordingTitle);
}

function speakerTranscript(nodes: QianwenAccessibilityNode[]): string {
  const texts = nodes.map(primaryText).filter((text) => text !== '');
  const lines: string[] = [];
  for (let index = 0; index < texts.length; index += 1) {
    const speaker = texts[index];
    if (speaker === undefined || !/^发言人\S*$/u.test(speaker)) continue;
    const timestamp = texts[index + 1];
    const content = texts[index + 2];
    if (
      timestamp === undefined
      || content === undefined
      || !/^\d{2}:\d{2}(?::\d{2})?$/u.test(timestamp)
      || content.trim() === ''
    ) {
      continue;
    }
    lines.push(`[${timestamp}] ${speaker}：${content}`);
    index += 2;
  }
  return lines.join('\n');
}

interface QianwenDetailMetadata {
  id: string;
  title: string;
  createdAt: string;
  durationSeconds: number;
  sourceUrl: string;
}

function parseMetadata(
  snapshot: QianwenAccessibilitySnapshot,
  referenceDate: string,
): QianwenDetailMetadata | null {
  const values = snapshot.nodes.flatMap(textValues);
  const sourceUrl = values.map((value) => QIANWEN_RECORDING_URL.exec(value)?.[0])
    .find((value): value is string => value !== undefined);
  const id = sourceUrl === undefined ? undefined : QIANWEN_RECORDING_URL.exec(sourceUrl)?.[1];
  const createdAt = values
    .map((value) => isoDateTime(value, referenceDate))
    .find((value): value is string => value !== null);
  const duration = durationSeconds(values);
  const title = snapshot.nodes
    .filter((node) => node.role === 'AXHeading')
    .map(primaryText)
    .find((text) => text !== '' && !/(?:AI\s*纪要|原文)/u.test(text));
  if (
    sourceUrl === undefined
    || id === undefined
    || createdAt === undefined
    || duration === null
    || title === undefined
  ) {
    return null;
  }
  return {
    id,
    title,
    createdAt,
    durationSeconds: duration,
    sourceUrl,
  };
}

function parseDetail(
  metadataSnapshot: QianwenAccessibilitySnapshot,
  referenceDate: string,
  transcriptSnapshot = metadataSnapshot,
  summarySnapshot = metadataSnapshot,
): QianwenSourceRecordingInput | null {
  const metadata = parseMetadata(metadataSnapshot, referenceDate);
  if (metadata === null) return null;
  const values = metadataSnapshot.nodes.flatMap(textValues);
  const waiting = values.some((value) => WAITING_TEXT.test(value));
  const summary = waiting
    ? ''
    : summaryText(summarySnapshot.nodes, metadata.title);
  const transcript = waiting
    ? ''
    : speakerTranscript(transcriptSnapshot.nodes) || section(transcriptSnapshot.nodes, /^原文$/u);
  return {
    ...metadata,
    transcript,
    summary,
    transcriptComplete: !waiting && transcript !== '',
    ...(!waiting && transcript === '' ? { transcriptionError: '听记原文结构无法识别' } : {}),
  };
}

function dateInRange(createdAt: string, startDate: string, endDate: string): boolean {
  const date = createdAt.slice(0, 10);
  return date >= startDate && date <= endDate;
}

function conversationReady(
  snapshot: QianwenAccessibilitySnapshot,
  title: string,
): boolean {
  const values = snapshot.nodes.flatMap(textValues);
  return values.some((value) => QIANWEN_RECORDING_URL.test(value))
    && values.some((value) => value === title);
}

function transcriptReady(snapshot: QianwenAccessibilitySnapshot): boolean {
  return speakerTranscript(snapshot.nodes) !== ''
    || section(snapshot.nodes, /^原文$/u) !== ''
    || snapshot.nodes.flatMap(textValues).some((value) => WAITING_TEXT.test(value));
}

function summaryReady(snapshot: QianwenAccessibilitySnapshot): boolean {
  const metadataTitle = snapshot.nodes
    .filter((node) => node.role === 'AXHeading')
    .map(primaryText)
    .find((text) => text !== '' && !/(?:AI\s*纪要|原文)/u.test(text)) ?? '';
  return summaryText(snapshot.nodes, metadataTitle) !== ''
    || snapshot.nodes.flatMap(textValues).some((value) => WAITING_TEXT.test(value));
}

export class QianwenDesktopConnector {
  private readonly accessibility: QianwenAccessibilityAdapter;
  private readonly clock: () => Date;
  private readonly readiness: QianwenReadinessOptions;

  constructor(options: {
    accessibility?: QianwenAccessibilityAdapter;
    clock?: () => Date;
    readiness?: Partial<QianwenReadinessOptions>;
  } = {}) {
    this.accessibility = options.accessibility ?? createQianwenAccessibilityAdapter();
    this.clock = options.clock ?? (() => new Date());
    this.readiness = {
      attempts: Math.max(1, options.readiness?.attempts ?? 5),
      delayMs: Math.max(0, options.readiness?.delayMs ?? 500),
    };
  }

  private async waitForSnapshot(
    ready: (snapshot: QianwenAccessibilitySnapshot) => boolean,
  ): Promise<QianwenAccessibilitySnapshot> {
    let snapshot = nativeFailure();
    for (let attempt = 0; attempt < this.readiness.attempts; attempt += 1) {
      snapshot = await this.accessibility.snapshot();
      if (snapshot.status !== 'ok' || ready(snapshot)) return snapshot;
      if (attempt + 1 < this.readiness.attempts && this.readiness.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.readiness.delayMs));
      }
    }
    return snapshot;
  }

  private async waitForSummarySnapshot(): Promise<QianwenAccessibilitySnapshot> {
    if (this.accessibility.summarySnapshot === undefined) {
      return this.waitForSnapshot(summaryReady);
    }
    let snapshot = nativeFailure();
    for (let attempt = 0; attempt < this.readiness.attempts; attempt += 1) {
      snapshot = await this.accessibility.summarySnapshot();
      if (snapshot.status !== 'ok' || summaryReady(snapshot)) return snapshot;
      if (attempt + 1 < this.readiness.attempts && this.readiness.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.readiness.delayMs));
      }
    }
    return snapshot;
  }

  async scan(range: { startDate: string; endDate: string }): Promise<QianwenSourceScanInput> {
    const scannedAt = this.clock().toISOString();
    const list = await this.accessibility.snapshot();
    if (list.status !== 'ok') {
      return {
        connectorStatus: connectorStatus(list.status),
        scannedAt,
        range,
        recordings: [],
      };
    }
    const titles = discoverTitles(list);
    if (titles.length === 0) {
      const recognizedEmptyList = list.nodes.some((node) => (
        textValues(node).some((value) => LIST_ANCHOR.test(value))
      ));
      return {
        connectorStatus: recognizedEmptyList ? 'connected' : 'incompatible',
        scannedAt,
        range,
        recordings: [],
      };
    }

    const recordings: QianwenSourceRecordingInput[] = [];
    let incompatibleDetail = false;
    for (const title of titles) {
      const pressed = await this.accessibility.press(title);
      if (pressed.status !== 'ok') {
        incompatibleDetail = true;
        continue;
      }
      const cardTitle = title.startsWith('录音纪要：')
        ? title.slice('录音纪要：'.length).trim()
        : title;
      let detail = await this.waitForSnapshot((snapshot) => (
        parseMetadata(snapshot, range.endDate) !== null
        || (title.startsWith('录音纪要：') && conversationReady(snapshot, cardTitle))
      ));
      if (detail.status !== 'ok') {
        incompatibleDetail = true;
        continue;
      }
      if (parseMetadata(detail, range.endDate) === null && title.startsWith('录音纪要：')) {
        const opened = await this.accessibility.press(cardTitle);
        if (opened.status !== 'ok') {
          incompatibleDetail = true;
          continue;
        }
        detail = await this.waitForSnapshot((snapshot) => (
          parseMetadata(snapshot, range.endDate) !== null
        ));
        if (detail.status !== 'ok') {
          incompatibleDetail = true;
          continue;
        }
      }
      let recording = parseDetail(detail, range.endDate);
      if (
        recording !== null
        && recording.transcriptionError !== undefined
        && !detail.nodes.flatMap(textValues).some((value) => WAITING_TEXT.test(value))
      ) {
        const originalPressed = await this.accessibility.press('原文');
        const original = originalPressed.status === 'ok'
          ? await this.waitForSnapshot(transcriptReady)
          : nativeFailure();
        const summaryPressed = await this.accessibility.press('AI纪要');
        const summary = summaryPressed.status === 'ok'
          ? await this.waitForSummarySnapshot()
          : nativeFailure();
        if (original.status === 'ok' && summary.status === 'ok') {
          recording = parseDetail(detail, range.endDate, original, summary);
        }
      }
      if (recording === null) {
        incompatibleDetail = true;
        continue;
      }
      if (dateInRange(recording.createdAt ?? '', range.startDate, range.endDate)) {
        recordings.push(recording);
      }
    }
    return {
      connectorStatus: recordings.length === 0 && incompatibleDetail
        ? 'incompatible'
        : 'connected',
      scannedAt,
      range,
      recordings,
    };
  }
}
