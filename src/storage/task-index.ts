import { basename, join } from 'node:path';

import { priorityRank, type Priority } from '../domain/task.js';
import {
  atomicWriteTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
} from './file-io.js';
import { parseTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  taskStorageRoot,
} from './task-paths.js';

interface IndexEntry {
  path: string;
  lifecycle: number;
  title: string;
  status: string;
  reviewState: string;
  origin: string;
  sourceDate: string;
  priority: Priority;
  okr: string;
  dingtalkStatus: string;
  updatedAt: string;
}

const INDEX_HEADER = `# 任务索引

> 自动生成时间：`;

const INDEX_EXPLANATION = `
> 说明：索引只读使用；状态修改必须回写候选任务文件本身。

| 任务标题 | 状态 | 确认状态 | 来源类型 | 来源日期 | 优先级 | OKR | 钉钉状态 | 最近更新 | 候选文件 |
|---|---|---|---|---|---|---|---|---|---|
`;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function priority(value: unknown): Priority {
  return value === 'urgent' || value === 'high' || value === 'low'
    ? value
    : 'normal';
}

function escapeCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ');
}

function escapeLinkText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('|', '\\|');
}

function encodeLinkDestination(value: string): string {
  return value.split('/').map((segment) => (
    encodeURIComponent(segment).replaceAll(/[!'()*]/g, (character) => (
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    ))
  )).join('/');
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

async function readIndexEntry(
  path: string,
  subtree: string,
  tasksRoot: string,
): Promise<IndexEntry | null> {
  const raw = await readSafeTextFile(path, subtree);
  if (raw === null) {
    return null;
  }
  const document = parseTaskDocument(raw);
  const data = document.data;
  return {
    path,
    lifecycle: path.startsWith(join(tasksRoot, 'Archive')) ? 1 : 0,
    title: text(data.title, basename(path, '.md')),
    status: text(data.status),
    reviewState: text(data.review_state),
    origin: text(data.origin),
    sourceDate: text(data.source_date),
    priority: priority(data.priority),
    okr: text(data.okr),
    dingtalkStatus: text(data.dingtalk_status),
    updatedAt: text(data.updated_at),
  };
}

export async function rebuildTaskIndex(
  root: string,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  assertVaultWriteAllowed(root);
  const tasksRoot = taskStorageRoot(root);
  const candidates = (await Promise.all(
    ['Inbox', 'Active', 'Archive'].map(async (directory) => {
      const subtree = join(tasksRoot, directory);
      const paths = await listSafeRegularFiles(subtree, '**/*.md');
      return paths.map((path) => ({ path, subtree }));
    }),
  )).flat();
  const scanned = await Promise.all(candidates.map(({ path, subtree }) => (
    readIndexEntry(path, subtree, tasksRoot)
  )));
  const entries = scanned.filter((entry): entry is IndexEntry => entry !== null);
  entries.sort((left, right) => (
    left.lifecycle - right.lifecycle
    || priorityRank[left.priority] - priorityRank[right.priority]
    || timestamp(right.updatedAt) - timestamp(left.updatedAt)
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
  ));

  const rows = entries.map((entry) => {
    const link = `[${escapeLinkText(basename(entry.path))}](<${encodeLinkDestination(entry.path)}>)`;
    const cells = [
      entry.title,
      entry.status,
      entry.reviewState,
      entry.origin,
      entry.sourceDate,
      entry.priority,
      entry.okr,
      entry.dingtalkStatus,
      entry.updatedAt,
    ].map(escapeCell);
    return `| ${[...cells, link].join(' | ')} |`;
  });
  const output = `${INDEX_HEADER}${generatedAt}${INDEX_EXPLANATION}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
  await atomicWriteTextFile(join(tasksRoot, '任务索引.md'), output);
}
