import { join } from 'node:path';

import type { Command } from 'commander';

import { loadConfig, assertWriteEnabled } from '../config.js';
import { FileCodexFeedbackStateRepository } from '../storage/file-codex-feedback-state-repository.js';
import { MarkdownCodexFeedbackRepository } from '../storage/markdown-codex-feedback-repository.js';
import { createVaultWriteAuthorization } from '../storage/task-paths.js';
import { bindCodexTask } from './bind-codex-task.js';
import { recordCodexFeedbackOutcome } from './record-codex-feedback-outcome.js';
import {
  queryCodexFeedbackCandidates,
  resolveCodexFeedbackActiveSelection,
  selectCodexFeedbackContext,
} from './select-codex-feedback-context.js';
import { settleCodexFeedback } from './settle-codex-feedback.js';
import { snapshotCodexArtifact } from './snapshot-codex-artifact.js';

const MAX_PRIVATE_INPUT_BYTES = 1024 * 1024;

class CodexFeedbackCliUsageError extends Error {
  readonly code = 'invalid_cli_input';

  constructor(message: string) {
    super(message);
    this.name = 'CodexFeedbackCliUsageError';
  }
}

interface OutputOptions {
  json?: boolean;
}

function output(value: unknown, options: OutputOptions): void {
  process.stdout.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
}

async function readPrivateJsonInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PRIVATE_INPUT_BYTES) {
      throw new CodexFeedbackCliUsageError('stdin JSON exceeds the 1 MiB limit');
    }
    chunks.push(buffer);
  }
  if (bytes === 0) throw new CodexFeedbackCliUsageError('stdin JSON is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CodexFeedbackCliUsageError('stdin must contain valid JSON');
  }
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CodexFeedbackCliUsageError(`${flag} must be a positive integer`);
  }
  return parsed;
}

function repositories(write: boolean): {
  stateRepository: FileCodexFeedbackStateRepository;
  visibleRepository: MarkdownCodexFeedbackRepository;
} {
  const config = loadConfig();
  if (!write) {
    return {
      stateRepository: new FileCodexFeedbackStateRepository(
        join(config.vaultRoot, '.atl-runtime', 'codex-feedback'),
        { vaultRoot: config.vaultRoot },
      ),
      visibleRepository: new MarkdownCodexFeedbackRepository(config.vaultRoot),
    };
  }
  assertWriteEnabled(config);
  const writeAuthorization = createVaultWriteAuthorization(config.vaultRoot);
  return {
    stateRepository: new FileCodexFeedbackStateRepository(
      join(config.vaultRoot, '.atl-runtime', 'codex-feedback'),
      { vaultRoot: config.vaultRoot, writeAuthorization },
    ),
    visibleRepository: new MarkdownCodexFeedbackRepository(config.vaultRoot, {
      writeAuthorization,
    }),
  };
}

export function registerCodexFeedbackCommands(program: Command): void {
  const command = program
    .command('codex-feedback')
    .description('Codex task binding, feedback settlement, and migration evidence');

  command
    .command('bind')
    .requiredOption('--stdin-json', 'read the binding JSON object from stdin')
    .option('--json')
    .action(async (options: OutputOptions) => {
      const services = repositories(true);
      output(await bindCodexTask({
        repository: services.stateRepository,
        clock: () => new Date(),
      }, await readPrivateJsonInput() as never), options);
    });

  command
    .command('snapshot')
    .requiredOption('--binding-id <id>')
    .requiredOption('--artifact-version <number>')
    .option('--json')
    .action(async (options: {
      bindingId: string;
      artifactVersion: string;
      json?: boolean;
    }) => {
      const services = repositories(true);
      output(await snapshotCodexArtifact({
        repository: services.stateRepository,
        clock: () => new Date(),
      }, {
        bindingId: options.bindingId,
        artifactVersion: positiveInteger(options.artifactVersion, '--artifact-version'),
      }), options);
    });

  command
    .command('settle')
    .requiredOption(
      '--private-input-stdin-json',
      'read message content and the model judgment from private stdin JSON',
    )
    .option('--json')
    .action(async (options: OutputOptions) => {
      const services = repositories(true);
      output(await settleCodexFeedback({
        ...services,
        clock: () => new Date(),
      }, await readPrivateJsonInput() as never), options);
    });

  command
    .command('context-candidates')
    .requiredOption('--target-binding-id <id>')
    .option('--json')
    .action(async (options: { targetBindingId: string; json?: boolean }) => {
      const services = repositories(false);
      output(await queryCodexFeedbackCandidates(services, {
        targetBindingId: options.targetBindingId,
      }), options);
    });

  command
    .command('select-context')
    .requiredOption('--stdin-json', 'read the complete candidate decision set from stdin')
    .option('--json')
    .action(async (options: OutputOptions) => {
      const services = repositories(true);
      output(await selectCodexFeedbackContext({
        ...services,
        clock: () => new Date(),
      }, await readPrivateJsonInput() as never), options);
    });

  command
    .command('record-outcome')
    .requiredOption('--stdin-json', 'read the migration outcome from stdin')
    .option('--json')
    .action(async (options: OutputOptions) => {
      const services = repositories(true);
      output(await recordCodexFeedbackOutcome({
        ...services,
        clock: () => new Date(),
      }, await readPrivateJsonInput() as never), options);
    });

  command
    .command('inspect')
    .option('--thread-id <id>')
    .option('--task-id <id>')
    .option('--json')
    .action(async (options: {
      threadId?: string;
      taskId?: string;
      json?: boolean;
    }) => {
      if ((options.threadId === undefined) === (options.taskId === undefined)) {
        throw new CodexFeedbackCliUsageError(
          'exactly one of --thread-id or --task-id is required',
        );
      }
      const { stateRepository } = repositories(false);
      const state = await stateRepository.read();
      const binding = state.bindings.find((candidate) => (
        options.threadId === undefined
          ? candidate.taskId === options.taskId
          : candidate.threadId === options.threadId
      ));
      if (binding === undefined) {
        throw new CodexFeedbackCliUsageError('Codex task binding was not found');
      }
      const contextSelections = state.contextSelections.filter((selection) => (
        selection.targetBindingId === binding.bindingId
      ));
      const activeSelection = resolveCodexFeedbackActiveSelection(state, binding.bindingId);
      output({
        binding,
        artifactSnapshots: state.artifactSnapshots.filter((snapshot) => (
          snapshot.bindingId === binding.bindingId
        )),
        settlements: state.settlements.filter((settlement) => (
          settlement.bindingId === binding.bindingId
        )),
        contextSelections,
        activeSelectionId: activeSelection.receipt?.selectionId ?? null,
        activeSelectionState: activeSelection.status,
        activeContextSelection: activeSelection.receipt,
        activeOutcomes: state.outcomes.filter((outcome) => (
          activeSelection.receipt?.selectionId === outcome.selectionId
        )),
        outcomes: state.outcomes.filter((outcome) => contextSelections.some(
          (selection) => selection.selectionId === outcome.selectionId,
        )),
      }, options);
    });
}
