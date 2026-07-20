import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { z } from 'zod';

export interface DailyTokenUsage {
  date: string;
  normalized: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tools: string[];
}

export interface OpenTokenSnapshot {
  version: string;
  updatedAt: string;
  since: string;
  days: DailyTokenUsage[];
}

export type OpenTokenErrorCode =
  | 'missing'
  | 'timeout'
  | 'invalid_output'
  | 'process_failed';

export class OpenTokenAdapterError extends Error {
  readonly code: OpenTokenErrorCode;

  constructor(code: OpenTokenErrorCode) {
    super(`OpenToken ${code}`);
    this.name = 'OpenTokenAdapterError';
    this.code = code;
  }
}

export interface OpenTokenExecuteOptions {
  shell: false;
  timeout: number;
  maxBuffer: number;
}

export type OpenTokenExecute = (
  executable: string,
  args: string[],
  options: OpenTokenExecuteOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface OpenTokenAdapterDependencies {
  homeDirectory: string;
  pathExists: (path: string) => Promise<boolean>;
  resolveOnPath: () => Promise<string | null>;
  execute: OpenTokenExecute;
  now: () => Date;
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;
const EXECUTE_OPTIONS: OpenTokenExecuteOptions = {
  shell: false,
  timeout: 30_000,
  maxBuffer: MAX_OUTPUT_BYTES,
};

const tokenNumber = z.number()
  .finite()
  .nonnegative()
  .refine(Number.isSafeInteger);

const usageRowSchema = z.object({
  date: z.string(),
  tool: z.string().min(1).max(100),
  model: z.string().max(200),
  input: tokenNumber,
  output: tokenNumber,
  cache_read: tokenNumber,
  cache_write: tokenNumber,
  normalized: tokenNumber,
}).strict();

const previewSchema = z.object({
  rows: z.array(usageRowSchema),
  sessions: z.array(z.unknown()),
}).strict();

function validDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function parseVersion(stdout: string): string {
  const version = /^opentoken\s+([^\s]+)\s*$/m.exec(stdout.trim())?.[1];
  if (version === undefined || !/^[A-Za-z0-9._-]{1,64}$/.test(version)) {
    throw new OpenTokenAdapterError('invalid_output');
  }
  return version;
}

function mapExecutionError(error: unknown): OpenTokenAdapterError {
  if (typeof error === 'object' && error !== null && 'timedOut' in error
    && (error as { timedOut?: unknown }).timedOut === true) {
    return new OpenTokenAdapterError('timeout');
  }
  return new OpenTokenAdapterError('process_failed');
}

export class OpenTokenAdapter {
  private readonly dependencies: OpenTokenAdapterDependencies;

  constructor(dependencies: OpenTokenAdapterDependencies) {
    this.dependencies = dependencies;
  }

  async preview(since: string): Promise<OpenTokenSnapshot> {
    if (!validDate(since)) throw new OpenTokenAdapterError('invalid_output');
    const executable = await this.findExecutable();
    if (executable === null) throw new OpenTokenAdapterError('missing');

    let versionOutput: { stdout: string; stderr: string };
    let previewOutput: { stdout: string; stderr: string };
    try {
      versionOutput = await this.dependencies.execute(
        executable,
        ['--version'],
        EXECUTE_OPTIONS,
      );
      previewOutput = await this.dependencies.execute(
        executable,
        ['preview', '--since', since, '--json'],
        EXECUTE_OPTIONS,
      );
    } catch (error) {
      throw mapExecutionError(error);
    }

    const version = parseVersion(versionOutput.stdout);
    let parsed: z.infer<typeof previewSchema>;
    try {
      parsed = previewSchema.parse(JSON.parse(previewOutput.stdout) as unknown);
      if (parsed.rows.some((row) => !validDate(row.date))) {
        throw new Error('invalid date');
      }
    } catch {
      throw new OpenTokenAdapterError('invalid_output');
    }
    const days = new Map<string, {
      normalized: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      tools: Set<string>;
    }>();
    for (const row of parsed.rows) {
      const day = days.get(row.date) ?? {
        normalized: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tools: new Set<string>(),
      };
      day.normalized += row.normalized;
      day.input += row.input;
      day.output += row.output;
      day.cacheRead += row.cache_read;
      day.cacheWrite += row.cache_write;
      if (row.input + row.output + row.cache_read + row.cache_write > 0) {
        day.tools.add(row.tool);
      }
      days.set(row.date, day);
    }
    return {
      version,
      updatedAt: this.dependencies.now().toISOString(),
      since,
      days: [...days.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, value]) => ({
          date,
          normalized: value.normalized,
          input: value.input,
          output: value.output,
          cacheRead: value.cacheRead,
          cacheWrite: value.cacheWrite,
          tools: [...value.tools].sort(),
        })),
    };
  }

  private async findExecutable(): Promise<string | null> {
    const candidates = [
      join(this.dependencies.homeDirectory, '.local', 'bin', 'opentoken'),
      '/opt/homebrew/bin/opentoken',
      '/usr/local/bin/opentoken',
    ];
    for (const candidate of candidates) {
      if (await this.dependencies.pathExists(candidate)) return candidate;
    }
    const resolved = await this.dependencies.resolveOnPath();
    return resolved !== null && resolved.startsWith('/') ? resolved : null;
  }
}

export function createOpenTokenAdapter(
  homeDirectory: string,
): OpenTokenAdapter {
  const executeFile = (
    executable: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    execFile(executable, args, {
      shell: false,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
  return new OpenTokenAdapter({
    homeDirectory,
    pathExists: async (path) => {
      try {
        const { access } = await import('node:fs/promises');
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    resolveOnPath: async () => {
      try {
        const result = await executeFile('/usr/bin/which', ['opentoken'], {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
        const path = result.stdout.trim();
        return path.startsWith('/') ? path : null;
      } catch {
        return null;
      }
    },
    execute: async (executable, args, options) => {
      return executeFile(executable, args, options);
    },
    now: () => new Date(),
  });
}
