#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildQianwenRecording,
  type QianwenRecordingStageInput,
} from '../src/obsidian-plugin/qianwen-recording-staging.js';

const DEFAULT_STAGING_ROOT = '/Users/linctex/Documents/Codex/qianwen-staging';

function optionValue(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1] ?? fallback;
}

function requiredOption(args: string[], flag: string): string {
  const value = optionValue(args, flag);
  if (value === undefined || value.trim() === '') throw new Error(`${flag} 不能为空`);
  return value;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正整数`);
  return parsed;
}

function safeRecordingId(value: string): string {
  if (!/^[a-zA-Z0-9._:-]+$/u.test(value)) throw new Error('--id 包含不安全字符');
  return value;
}

function parseOptions(args: string[]): {
  stagingRoot: string;
  input: Omit<QianwenRecordingStageInput, 'transcript' | 'summary'>;
  transcriptFile: string;
  summaryFile?: string;
  incomplete: boolean;
} {
  const id = safeRecordingId(requiredOption(args, '--id'));
  const title = requiredOption(args, '--title');
  const createdAt = requiredOption(args, '--created-at');
  const durationSeconds = positiveInteger(requiredOption(args, '--duration-seconds'), '--duration-seconds');
  const sourceUrl = requiredOption(args, '--source-url');
  const transcriptFile = resolve(requiredOption(args, '--transcript-file'));
  const summaryFileValue = optionValue(args, '--summary-file');
  return {
    stagingRoot: resolve(optionValue(args, '--staging-root', DEFAULT_STAGING_ROOT) ?? DEFAULT_STAGING_ROOT),
    input: {
      id,
      title,
      createdAt,
      durationSeconds,
      sourceUrl,
    },
    transcriptFile,
    ...(summaryFileValue === undefined ? {} : { summaryFile: resolve(summaryFileValue) }),
    incomplete: hasFlag(args, '--incomplete'),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const transcript = await readFile(options.transcriptFile, 'utf8');
  const summary = options.summaryFile === undefined
    ? ''
    : await readFile(options.summaryFile, 'utf8');
  const recording = buildQianwenRecording({
    ...options.input,
    transcript,
    summary,
    transcriptComplete: !options.incomplete,
  });
  await mkdir(options.stagingRoot, { recursive: true });
  const outputPath = join(options.stagingRoot, `${recording.id}.json`);
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, outputPath);
  process.stdout.write(JSON.stringify({
    outputPath,
    recordingId: recording.id,
    transcriptComplete: recording.transcriptComplete,
  }) + '\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
