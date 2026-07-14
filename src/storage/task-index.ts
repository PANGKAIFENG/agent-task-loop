import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import fastGlob from 'fast-glob';

import { priorityRank, type Priority } from '../domain/task.js';
import { parseTaskDocument } from './frontmatter.js';

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

function escapeLinkTarget(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(')', '\\)');
}

async function readIndexEntry(path: string, tasksRoot: string): Promise<IndexEntry> {
  const document = parseTaskDocument(await readFile(path, 'utf8'));
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
  tasksRoot: string,
  generatedAt = new Date().toISOString(),
): Promise<void> {
  const paths = await fastGlob(
    ['Inbox/**/*.md', 'Active/**/*.md', 'Archive/**/*.md'],
    { absolute: true, cwd: tasksRoot, onlyFiles: true },
  );
  const entries = await Promise.all(paths.map((path) => readIndexEntry(path, tasksRoot)));
  entries.sort((left, right) => (
    left.lifecycle - right.lifecycle
    || priorityRank[left.priority] - priorityRank[right.priority]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.path.localeCompare(right.path)
  ));

  const rows = entries.map((entry) => {
    const link = `[${escapeCell(basename(entry.path))}](${escapeLinkTarget(entry.path)})`;
    return `| ${[
      entry.title,
      entry.status,
      entry.reviewState,
      entry.origin,
      entry.sourceDate,
      entry.priority,
      entry.okr,
      entry.dingtalkStatus,
      entry.updatedAt,
      link,
    ].map(escapeCell).join(' | ')} |`;
  });
  const output = `${INDEX_HEADER}${generatedAt}${INDEX_EXPLANATION}${rows.join('\n')}${rows.length > 0 ? '\n' : ''}`;
  const indexPath = join(tasksRoot, '任务索引.md');
  const temporaryPath = `${indexPath}.tmp`;

  await mkdir(tasksRoot, { recursive: true });
  try {
    await writeFile(temporaryPath, output, 'utf8');
    await rename(temporaryPath, indexPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
