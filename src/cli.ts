#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

import { Command, CommanderError } from 'commander';

import { loadConfig, assertWriteEnabled, type AtlConfig } from './config.js';
import { TASK_STATUSES, type TaskStatus } from './domain/task.js';
import { captureTask } from './services/capture-task.js';
import { claimTask } from './services/claim-task.js';
import { confirmTask } from './services/confirm-task.js';
import { createProject } from './services/create-project.js';
import { listTasks, peekNextTask } from './services/query-tasks.js';
import { reopenTask } from './services/reopen-task.js';
import { reviewTask, type ReviewTaskInput } from './services/review-task.js';
import { createTaskId, type ServiceContext } from './services/service-context.js';
import { stopTask } from './services/stop-task.js';
import { submitArtifact } from './services/submit-artifact.js';
import { unblockTask } from './services/unblock-task.js';
import { validateStorage } from './services/validate-storage.js';
import { FileAuditLog } from './storage/audit-log.js';
import { MarkdownArtifactRepository } from './storage/markdown-artifact-repository.js';
import { MarkdownProjectRepository } from './storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from './storage/markdown-task-repository.js';
import { ATL_VERSION } from './version.js';

class CliUsageError extends Error {
  readonly code = 'invalid_cli_input';
}

interface OutputOptions {
  json?: boolean;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`${flag} is required`);
  }
  return value;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function createContext(config: AtlConfig): ServiceContext {
  return {
    tasks: new MarkdownTaskRepository(config.vaultRoot),
    artifacts: new MarkdownArtifactRepository(config.vaultRoot),
    projects: new MarkdownProjectRepository(config.vaultRoot),
    audit: new FileAuditLog(config.vaultRoot, { timeZone: 'Asia/Shanghai' }),
    clock: () => new Date(),
    id: () => createTaskId(),
  };
}

function contextForWrite(): { config: AtlConfig; ctx: ServiceContext } {
  const config = loadConfig();
  assertWriteEnabled(config);
  return { config, ctx: createContext(config) };
}

function contextForRead(): { config: AtlConfig; ctx: ServiceContext } {
  const config = loadConfig();
  return { config, ctx: createContext(config) };
}

function humanLine(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'No tasks.'
      : value.map((item) => humanLine(item)).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.taskId === 'string') {
      return `${record.taskId} [${String(record.status)}] ${String(record.title)}`;
    }
    if (typeof record.projectId === 'string') {
      return `${record.projectId}: ${String(record.name)}`;
    }
    if (typeof record.ok === 'boolean') {
      if (record.ok) {
        return 'Storage is healthy.';
      }
      const issues = Array.isArray(record.issues) ? record.issues : [];
      return [
        'Storage issues found:',
        ...issues.map((issue) => {
          if (issue === null || typeof issue !== 'object') {
            return '- Unknown storage issue';
          }
          const item = issue as Record<string, unknown>;
          const expected = typeof item.expectedPath === 'string'
            ? `; expected: ${item.expectedPath}`
            : '';
          return `- [${String(item.code)}] ${String(item.path)}${expected}`;
        }),
      ].join('\n');
    }
  }
  return String(value);
}

function output(value: unknown, options: OutputOptions): void {
  process.stdout.write(options.json
    ? `${JSON.stringify(value)}\n`
    : `${humanLine(value)}\n`);
}

function reviewInput(options: {
  approve?: boolean;
  requestChanges?: boolean;
  block?: boolean;
  cancel?: boolean;
  feedback?: string;
}): ReviewTaskInput {
  const decisions = [
    options.approve ? 'approve' : null,
    options.requestChanges ? 'request_changes' : null,
    options.block ? 'block' : null,
    options.cancel ? 'cancel' : null,
  ].filter((decision): decision is ReviewTaskInput['decision'] => decision !== null);
  if (decisions.length !== 1) {
    throw new CliUsageError('exactly one review decision is required');
  }
  const decision = decisions[0];
  if (decision === undefined) {
    throw new CliUsageError('exactly one review decision is required');
  }
  if (decision === 'approve') {
    if (options.feedback !== undefined) {
      throw new CliUsageError('--feedback is not allowed with --approve');
    }
    return { decision };
  }
  return {
    decision,
    feedback: required(options.feedback, '--feedback'),
  };
}

function buildProgram(): Command {
  const program = new Command()
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .name('atl')
    .description('Agent Task Loop CLI')
    .version(ATL_VERSION);

  const project = program.command('project');
  project
    .command('create')
    .option('--project-id <id>')
    .option('--name <name>')
    .option('--description <description>')
    .option('--json')
    .action(async (options: {
      projectId?: string;
      name?: string;
      description?: string;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const result = await createProject(ctx, {
        projectId: required(options.projectId, '--project-id'),
        name: required(options.name, '--name'),
        description: required(options.description, '--description'),
        resources: [],
      });
      output(result, options);
    });

  const task = program.command('task');
  task
    .command('capture')
    .option('--title <title>')
    .option('--body <body>')
    .option('--origin <origin>')
    .option('--source-date <date>')
    .option('--source-note <path>')
    .option('--source-quote <quote>')
    .option('--source-key <key>')
    .option('--priority <priority>', 'Task priority', 'normal')
    .option('--json')
    .action(async (options: {
      title?: string;
      body?: string;
      origin?: string;
      sourceDate?: string;
      sourceNote?: string;
      sourceQuote?: string;
      sourceKey?: string;
      priority: 'urgent' | 'high' | 'normal' | 'low';
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const result = await captureTask(ctx, {
        title: required(options.title, '--title'),
        body: required(options.body, '--body'),
        origin: required(options.origin, '--origin'),
        sourceDate: options.sourceDate ?? null,
        sourceNote: options.sourceNote ?? null,
        sourceQuote: options.sourceQuote ?? null,
        sourceKey: required(options.sourceKey, '--source-key'),
        priority: options.priority,
      });
      output(result, options);
    });

  task
    .command('list')
    .option('--status <status>')
    .option('--json')
    .action(async (options: { status?: string; json?: boolean }) => {
      const { ctx } = contextForRead();
      if (
        options.status !== undefined
        && !TASK_STATUSES.includes(options.status as (typeof TASK_STATUSES)[number])
      ) {
        throw new CliUsageError('invalid --status');
      }
      output(await listTasks(ctx, options.status as TaskStatus | undefined), options);
    });

  task
    .command('confirm')
    .option('--task-id <id>')
    .option('--project-id <id>')
    .option('--objective <objective>')
    .option(
      '--acceptance-criterion <criterion>',
      'Repeat for each criterion',
      collect,
      [],
    )
    .option('--priority <priority>', 'Task priority', 'normal')
    .option('--auto-executable')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      projectId?: string;
      objective?: string;
      acceptanceCriterion: string[];
      priority: 'urgent' | 'high' | 'normal' | 'low';
      autoExecutable?: boolean;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const result = await confirmTask(ctx, required(options.taskId, '--task-id'), {
        projectId: required(options.projectId, '--project-id'),
        taskType: 'research',
        objective: required(options.objective, '--objective'),
        acceptanceCriteria: options.acceptanceCriterion,
        permissionProfile: 'read_only_research',
        priority: options.priority,
        autoExecutable: options.autoExecutable === true,
      });
      output(result, options);
    });

  task
    .command('next')
    .option('--claim')
    .option('--task-id <id>')
    .option('--agent <agent>', 'Supervised agent label', 'manual')
    .option('--run-id <id>')
    .option('--json')
    .action(async (options: {
      claim?: boolean;
      taskId?: string;
      agent: string;
      runId?: string;
      json?: boolean;
    }) => {
      if (options.claim !== true) {
        const { ctx } = contextForRead();
        output(await peekNextTask(ctx), options);
        return;
      }
      if (options.taskId === undefined || options.taskId.trim() === '') {
        throw new CliUsageError('--task-id is required with --claim');
      }
      const { config, ctx } = contextForWrite();
      const result = await claimTask(ctx, options.taskId, {
        mode: 'manual',
        agent: options.agent,
        runId: required(options.runId, '--run-id'),
        leaseMinutes: config.leaseMinutes,
        dailyLimit: config.dailyLimit,
      });
      output(result, options);
    });

  task
    .command('submit')
    .option('--task-id <id>')
    .option('--run-id <id>')
    .option('--result <path>')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      runId?: string;
      result?: string;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const resultPath = required(options.result, '--result');
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(resultPath, 'utf8'));
      } catch {
        throw new CliUsageError('result file must contain valid JSON');
      }
      const result = await submitArtifact(
        ctx,
        required(options.taskId, '--task-id'),
        {
          runId: required(options.runId, '--run-id'),
          result: parsed as Parameters<typeof submitArtifact>[2]['result'],
        },
      );
      output(result, options);
    });

  task
    .command('review')
    .option('--task-id <id>')
    .option('--approve')
    .option('--request-changes')
    .option('--block')
    .option('--cancel')
    .option('--feedback <text>')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      approve?: boolean;
      requestChanges?: boolean;
      block?: boolean;
      cancel?: boolean;
      feedback?: string;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const result = await reviewTask(
        ctx,
        required(options.taskId, '--task-id'),
        reviewInput(options),
      );
      output(result, options);
    });

  task
    .command('stop')
    .option('--task-id <id>')
    .option('--json')
    .action(async (options: { taskId?: string; json?: boolean }) => {
      const { ctx } = contextForWrite();
      output(await stopTask(ctx, required(options.taskId, '--task-id')), options);
    });

  task
    .command('unblock')
    .option('--task-id <id>')
    .option('--feedback <text>')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      feedback?: string;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      output(await unblockTask(ctx, required(options.taskId, '--task-id'), {
        recoveryNote: required(options.feedback, '--feedback'),
      }), options);
    });

  task
    .command('reopen')
    .option('--task-id <id>')
    .option('--feedback <text>')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      feedback?: string;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      output(await reopenTask(ctx, required(options.taskId, '--task-id'), {
        reason: required(options.feedback, '--feedback'),
      }), options);
    });

  program
    .command('doctor')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      const config = loadConfig();
      const report = await validateStorage(config.vaultRoot);
      output(report, options);
      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  return program;
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof CommanderError) {
    return {
      code: 'invalid_cli_input',
      message: error.message.replace(/^error:\s*/, ''),
    };
  }
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unexpected_error';
    return { code, message: error.message };
  }
  return { code: 'unexpected_error', message: 'Unexpected error' };
}

export async function main(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

try {
  await main();
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    process.exitCode = 0;
  } else {
    const details = errorDetails(error);
    if (process.argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: details })}\n`);
    } else {
      process.stderr.write(`Error: ${details.message}\n`);
    }
    process.exitCode = 1;
  }
}
