#!/usr/bin/env node

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { MeetingNoteController, parseDingTalkMeetingSource } from '../src/obsidian-plugin/meeting-note.js';
import {
  buildQianwenMeetingPreviews,
  parseQianwenRecording,
  qianwenEvidence,
  type QianwenRecording,
} from '../src/obsidian-plugin/qianwen-meeting-sync.js';
import { assertVaultWriteAllowed } from '../src/storage/task-paths.js';

const DEFAULT_VAULT_ROOT = '/Users/linctex/Documents/ClawVault';
const DEFAULT_STAGING_ROOT = '/Users/linctex/Documents/Codex/qianwen-staging';
const DEFAULT_REPORT_ROOT = '/Users/linctex/Documents/Codex';

interface Options {
  vaultRoot: string;
  stagingRoot: string;
  reportRoot: string;
  date: string;
  lookbackDays: number;
  write: boolean;
}

interface EventCandidate {
  path: string;
  source: ReturnType<typeof parseDingTalkMeetingSource>;
}

function optionValue(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function isoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && !Number.isNaN(new Date(`${value}T00:00:00+08:00`).getTime());
}

function parseOptions(args: string[]): Options {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1_000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  const date = optionValue(args, '--date', yesterday);
  if (!isoDate(date)) throw new Error('--date 必须是 YYYY-MM-DD');
  const lookbackDays = Number(optionValue(args, '--lookback-days', '3'));
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 7) {
    throw new Error('--lookback-days 必须是 1 到 7 的整数');
  }
  return {
    vaultRoot: resolve(optionValue(args, '--vault-root', DEFAULT_VAULT_ROOT)),
    stagingRoot: resolve(optionValue(args, '--staging-root', DEFAULT_STAGING_ROOT)),
    reportRoot: resolve(optionValue(args, '--report-root', DEFAULT_REPORT_ROOT)),
    date,
    lookbackDays,
    write: hasFlag(args, '--write'),
  };
}

function dateShift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00+08:00`);
  value.setDate(value.getDate() + days);
  return value.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

async function markdownFiles(root: string, subtree: string): Promise<string[]> {
  const base = join(root, subtree);
  try {
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(
        subtree,
        entry.parentPath.slice(base.length + 1),
        entry.name,
      ));
  } catch {
    return [];
  }
}

async function readEventCandidates(
  vaultRoot: string,
  startDate: string,
  endDate: string,
): Promise<EventCandidate[]> {
  const paths = await markdownFiles(vaultRoot, 'TaskNotes/DingTalk');
  const candidates: EventCandidate[] = [];
  for (const path of paths.sort()) {
    try {
      const source = parseDingTalkMeetingSource(path, await readFile(join(vaultRoot, path), 'utf8'));
      if (source.meetingDate >= startDate && source.meetingDate <= endDate) {
        candidates.push({ path, source });
      }
    } catch {
      // Ignore unrelated or malformed mirrors; they are not meeting sources.
    }
  }
  return candidates;
}

async function readQianwenRecordings(stagingRoot: string): Promise<QianwenRecording[]> {
  let entries;
  try {
    entries = await readdir(stagingRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const recordings: QianwenRecording[] = [];
  for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith('.json'))) {
    try {
      recordings.push(parseQianwenRecording(await readFile(join(stagingRoot, entry.name), 'utf8')));
    } catch {
      // Keep the daily run alive; the report shows no match for invalid staging entries.
    }
  }
  return recordings;
}

function reportPath(reportRoot: string, date: string): string {
  return join(reportRoot, `${date}-千问会议听记同步报告.md`);
}

function renderReport(
  options: Options,
  candidates: readonly EventCandidate[],
  previews: readonly ReturnType<typeof buildQianwenMeetingPreviews>[number][],
  writes: readonly string[],
): string {
  const lines = [
    `# ${options.date} 千问会议听记同步报告`,
    '',
    `- 扫描范围：${dateShift(options.date, -options.lookbackDays + 1)} 至 ${options.date}`,
    `- 钉钉日程候选：${candidates.length}`,
    `- 写入模式：${options.write ? '已授权生产写入' : '预览，不写入生产 Vault'}`,
    '',
    '## 匹配结果',
    '',
  ];
  if (previews.length === 0) lines.push('没有找到需要处理的钉钉日程。');
  for (const preview of previews) {
    lines.push(
      `### ${preview.source.title}`,
      '',
      `- 日程：${preview.source.scheduled}`,
      `- 日程镜像：\`${preview.source.eventPath}\``,
      `- 置信度：${preview.confidence}（${preview.score}）`,
      `- 冲突：${preview.conflict ? '是' : '否'}`,
      `- 结果：${preview.reason}`,
      `- 拟写入：\`${preview.plannedNotePath}\``,
    );
    if (preview.recording !== null) {
      lines.push(
        `- 千问：${preview.recording.title}`,
        `- 千问创建时间：${preview.recording.createdAt}`,
        `- 千问时长：${preview.recording.durationSeconds} 秒`,
        `- 千问来源：${preview.recording.sourceUrl}`,
      );
      const best = preview.candidates[0];
      if (best !== undefined) lines.push(`- 证据：${best.evidence.join('；')}`);
    }
    lines.push('');
  }
  lines.push(
    '## 写入结果',
    '',
    writes.length === 0 ? '本次没有写入生产 Vault。' : writes.map((path) => `- ${path}`).join('\n'),
    '',
    '> 待办候选仍保持人工确认状态，不自动排期、领取或执行。',
    '',
  );
  return lines.join('\n');
}

async function writeReadyNotes(
  vaultRoot: string,
  candidates: readonly EventCandidate[],
  previews: readonly ReturnType<typeof buildQianwenMeetingPreviews>[number][],
): Promise<string[]> {
  assertVaultWriteAllowed(vaultRoot);
  const fileSystem = {
    exists: async (path: string) => readFile(join(vaultRoot, path)).then(() => true, () => false),
    read: async (path: string) => readFile(join(vaultRoot, path), 'utf8'),
    ensureDirectory: async (path: string): Promise<void> => {
      await mkdir(join(vaultRoot, path), { recursive: true });
    },
    create: async (path: string, content: string) => writeFile(
      join(vaultRoot, path),
      content,
      { encoding: 'utf8', flag: 'wx' },
    ),
    removeIfContentMatches: async (path: string, expected: string) => {
      const fullPath = join(vaultRoot, path);
      const current = await readFile(fullPath, 'utf8').catch(() => null);
      if (current !== expected) return false;
      await rm(fullPath);
      return true;
    },
    process: async (path: string, transform: (content: string) => string) => {
      const filePath = join(vaultRoot, path);
      const updated = transform(await readFile(filePath, 'utf8'));
      await writeFile(filePath, updated, 'utf8');
      return updated;
    },
    listMarkdownFiles: async (path: string) => markdownFiles(vaultRoot, path),
  };
  const controller = new MeetingNoteController(fileSystem);
  const writes: string[] = [];
  for (const candidate of candidates) {
    const preview = previews.find((item) => item.source.eventPath === candidate.path);
    if (preview?.readyToWrite !== true || preview.recording === null) continue;
    const result = await controller.create({
      eventPath: candidate.path,
      meetingType: 'discussion',
      participants: [],
      transcript: preview.recording.transcript,
      qianwen: qianwenEvidence(preview.recording),
    });
    if (result.created) writes.push(result.path);
  }
  return writes;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const startDate = dateShift(options.date, -options.lookbackDays + 1);
  const candidates = await readEventCandidates(options.vaultRoot, startDate, options.date);
  const recordings = await readQianwenRecordings(options.stagingRoot);
  const previews = buildQianwenMeetingPreviews(
    candidates.map(({ source }) => source),
    recordings,
  );
  const writes = options.write
    ? await writeReadyNotes(options.vaultRoot, candidates, previews)
    : [];
  const outputPath = reportPath(options.reportRoot, options.date);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, renderReport(options, candidates, previews, writes), 'utf8');
  const confidence = {
    high: previews.filter((preview) => preview.confidence === 'high').length,
    medium: previews.filter((preview) => preview.confidence === 'medium').length,
    low: previews.filter((preview) => preview.confidence === 'low').length,
  };
  process.stdout.write(JSON.stringify({
    reportPath: outputPath,
    candidates: candidates.length,
    matched: confidence.high + confidence.medium,
    confidence,
    pendingRescan: previews.filter((preview) => preview.reason.includes('补扫队列')).length,
    readyToWrite: previews.filter((preview) => preview.readyToWrite).length,
    writes,
  }) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
