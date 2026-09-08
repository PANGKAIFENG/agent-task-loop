import { readFile } from 'node:fs/promises';

import type { Command } from 'commander';

import { loadConfig, assertWriteEnabled } from '../config.js';
import {
  DECISION_DIMENSIONS,
  POLICY_STATUSES,
  type DecisionDimension,
  type PolicyStatus,
} from '../domain/decision-policy.js';
import { FEEDBACK_KINDS, FEEDBACK_STABILITY } from '../domain/decision-feedback.js';
import { createVaultWriteAuthorization } from '../storage/task-paths.js';
import type { PolicyRef } from '../storage/markdown-decision-policy-repository.js';
import { createDecisionServices, type DecisionServices } from './service-context.js';

/**
 * `atl decision ...` command group (TEP27-G4 Task 7). Every handler is a thin
 * mapper: parse arguments, read JSON input files, call one service from the
 * final assembly, and print the service's return value. Business rules and
 * error codes live in the repositories and services; this module invents no
 * codes and holds no domain logic.
 */

const NO_IDEMPOTENCY_KEY_NOTICE
  = '不传 `--idempotency-key` 时，每次提交都会创建一条新的反馈样本'
    + '（视为一次新的反馈事件）；需要去重/幂等语义时必须显式传 key。';

const DECISION_QUERY_SORTS = ['created_desc', 'created_asc'];
const DECISION_TRACE_STATUSES = ['recorded', 'feedback_recorded', 'closed'];
const DECISION_INTEGRITY_STATUSES = ['valid', 'legacy_compatible', 'warning', 'broken'];
const DECISION_SOURCES = ['native', 'legacy'];

interface DecisionCommandOptions {
  json?: boolean;
}

class DecisionCliUsageError extends Error {
  readonly code = 'invalid_cli_input';

  constructor(message: string) {
    super(message);
    this.name = 'DecisionCliUsageError';
  }
}

/** Read services for one invocation; no write gate applies. */
function decisionServicesForRead(): DecisionServices {
  return createDecisionServices(loadConfig().vaultRoot);
}

/**
 * Write-path services: decision writes follow the CLI-wide rule that vaults
 * outside the OS temporary directory require ATL_ALLOW_REAL_WRITES=1. The
 * explicit token then reaches every write gate, including the migration
 * preflight and ledger append that bypass the repositories.
 */
function decisionServicesForWrite(): DecisionServices {
  const config = loadConfig();
  assertWriteEnabled(config);
  return createDecisionServices(config.vaultRoot, {
    writeAuthorization: createVaultWriteAuthorization(config.vaultRoot),
  });
}

async function readJsonInput(path: string, flag: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new DecisionCliUsageError(`${flag} must point to a readable JSON file`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new DecisionCliUsageError(`${flag} must contain valid JSON`);
  }
}

function oneOf(
  allowed: readonly string[],
  value: string,
  flag: string,
): string {
  if (!allowed.includes(value)) {
    throw new DecisionCliUsageError(`${flag} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function integerOption(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new DecisionCliUsageError(`${flag} must be an integer`);
  }
  return parsed;
}

function output(value: unknown, options: DecisionCommandOptions): void {
  process.stdout.write(`${JSON.stringify(value, null, options.json ? 0 : 2)}\n`);
}

/**
 * Registers the six decision command groups on the `atl` program: policy,
 * trace, feedback, query, check-consistency, and migrate-legacy. All
 * commands support `--json`; failures exit nonzero with the service error
 * code passed through untouched.
 */
export function registerDecisionCommands(program: Command): void {
  const decision = program.command('decision').description('Decision domain commands');

  registerPolicyCommands(decision);
  registerTraceCommands(decision);
  registerFeedbackCommands(decision);
  registerQueryCommand(decision);
  registerConsistencyCommand(decision);
  registerMigrationCommand(decision);
}

function registerPolicyCommands(decision: Command): void {
  const policy = decision.command('policy').description('Decision policy versions');

  policy
    .command('create')
    .description('Create a policy version from a JSON input file')
    .requiredOption('--input <file>', 'JSON file with the policy document (kept outside the vault)')
    .option('--json')
    .action(async (options: { input: string; json?: boolean }) => {
      const services = decisionServicesForWrite();
      output(await services.policies.create(await readJsonInput(options.input, '--input')), options);
    });

  policy
    .command('get')
    .description('Read one policy version by its <policy_id>@<version> ref')
    .argument('<policyRef>')
    .option('--json')
    .action(async (policyRef: string, options: DecisionCommandOptions) => {
      const services = decisionServicesForRead();
      output(await services.policies.get(policyRef as PolicyRef), options);
    });

  policy
    .command('list')
    .description('List policy versions, optionally filtered by dimension and status')
    .option('--dimension <dimension>', `one of: ${DECISION_DIMENSIONS.join(', ')}`)
    .option('--status <status>', `one of: ${POLICY_STATUSES.join(', ')}`)
    .option('--json')
    .action(async (options: {
      dimension?: string;
      status?: string;
      json?: boolean;
    }) => {
      const dimension = options.dimension === undefined
        ? undefined
        : oneOf(DECISION_DIMENSIONS, options.dimension, '--dimension') as DecisionDimension;
      const status = options.status === undefined
        ? undefined
        : oneOf(POLICY_STATUSES, options.status, '--status') as PolicyStatus;
      const services = decisionServicesForRead();
      output(await services.policies.list({
        ...(dimension === undefined ? {} : { dimension }),
        ...(status === undefined ? {} : { status }),
      }), options);
    });

  policy
    .command('list-versions')
    .description('List every version of one policy, oldest first')
    .argument('<policyId>')
    .option('--json')
    .action(async (policyId: string, options: DecisionCommandOptions) => {
      const services = decisionServicesForRead();
      output(await services.policies.listVersions(policyId), options);
    });

  policy
    .command('update-status')
    .description('Move a policy version through a frozen legal transition')
    .argument('<policyRef>')
    .requiredOption('--to <status>', `one of: ${POLICY_STATUSES.join(', ')}`)
    .option('--json')
    .action(async (policyRef: string, options: { to: string; json?: boolean }) => {
      const to = oneOf(POLICY_STATUSES, options.to, '--to') as PolicyStatus;
      const services = decisionServicesForWrite();
      output(await services.policies.updateStatus(policyRef as PolicyRef, to), options);
    });
}

function registerTraceCommands(decision: Command): void {
  const trace = decision.command('trace').description('Decision traces');

  trace
    .command('create')
    .description('Create a decision trace from a JSON input file')
    .requiredOption('--input <file>', 'JSON file with the trace document (kept outside the vault)')
    .option('--json')
    .action(async (options: { input: string; json?: boolean }) => {
      const services = decisionServicesForWrite();
      output(await services.traces.create(await readJsonInput(options.input, '--input'), {
        policyResolver: services.resolvePolicy,
      }), options);
    });

  trace
    .command('get')
    .description('Read one trace by id')
    .argument('<traceId>')
    .option('--json')
    .action(async (traceId: string, options: DecisionCommandOptions) => {
      const services = decisionServicesForRead();
      output(await services.traces.get(traceId), options);
    });

  trace
    .command('list')
    .description('List traces referencing one policy ref')
    .requiredOption('--policy-ref <ref>')
    .option('--json')
    .action(async (options: { policyRef: string; json?: boolean }) => {
      const services = decisionServicesForRead();
      output(await services.traces.listByPolicyRef(options.policyRef), options);
    });

  trace
    .command('close')
    .description('Close a trace through the audited explicit action')
    .argument('<traceId>')
    .requiredOption('--actor <actor>')
    .option('--json')
    .action(async (traceId: string, options: { actor: string; json?: boolean }) => {
      const services = decisionServicesForWrite();
      output(await services.traces.close(traceId, options.actor), options);
    });

  trace
    .command('reopen')
    .description('Reopen a closed trace through the audited explicit action')
    .argument('<traceId>')
    .requiredOption('--actor <actor>')
    .option('--json')
    .action(async (traceId: string, options: { actor: string; json?: boolean }) => {
      const services = decisionServicesForWrite();
      output(await services.traces.reopen(traceId, options.actor), options);
    });
}

function registerFeedbackCommands(decision: Command): void {
  const feedback = decision.command('feedback').description('Decision feedback samples');

  feedback
    .command('record')
    .description(
      'Record one feedback sample against a native trace and rebuild its summary. '
      + `${NO_IDEMPOTENCY_KEY_NOTICE}`,
    )
    .requiredOption('--trace <id>')
    .requiredOption('--kind <kind>', `one of: ${FEEDBACK_KINDS.join(', ')}`)
    .requiredOption('--source-ref <ref>')
    .option(
      '--idempotency-key <key>',
      `deduplicate replays by key. ${NO_IDEMPOTENCY_KEY_NOTICE}`,
    )
    .option('--correction-summary <text>', 'required when --kind corrected')
    .option('--stability <stability>', `one of: ${FEEDBACK_STABILITY.join(', ')}`)
    .option('--json')
    .action(async (options: {
      trace: string;
      kind: string;
      sourceRef: string;
      idempotencyKey?: string;
      correctionSummary?: string;
      stability?: string;
      json?: boolean;
    }) => {
      const services = decisionServicesForWrite();
      output(await services.recordFeedback({
        trace_id: options.trace,
        kind: options.kind,
        source_ref: options.sourceRef,
        ...(options.idempotencyKey === undefined
          ? {}
          : { idempotency_key: options.idempotencyKey }),
        ...(options.correctionSummary === undefined
          ? {}
          : { correction_summary: options.correctionSummary }),
        ...(options.stability === undefined ? {} : { stability: options.stability }),
      }), options);
    });
}

function registerQueryCommand(decision: Command): void {
  decision
    .command('query')
    .description('Run the unified read-only decision query (native and legacy projections)')
    .option('--dimension <dimension>', `one of: ${DECISION_DIMENSIONS.join(', ')}`)
    .option('--policy-id <id>')
    .option('--policy-version <version>')
    .option('--policy-status <status>', `one of: ${POLICY_STATUSES.join(', ')}`)
    .option('--trace-status <status>', `one of: ${DECISION_TRACE_STATUSES.join(', ')}`)
    .option('--feedback-kind <kind>', `one of: ${FEEDBACK_KINDS.join(', ')}`)
    .option('--stability <stability>', `one of: ${FEEDBACK_STABILITY.join(', ')}`)
    .option('--created-from <iso>', 'inclusive ISO8601 lower bound on created_at')
    .option('--created-to <iso>', 'inclusive ISO8601 upper bound on created_at')
    .option('--ref <ref>', 'input ref filter; repeatable', collectRef, [])
    .option('--integrity-status <status>', `one of: ${DECISION_INTEGRITY_STATUSES.join(', ')}`)
    .option('--source <source>', `one of: ${DECISION_SOURCES.join(', ')}`)
    .option('--limit <n>', 'page size (1-200)', (value: string) => integerOption(value, '--limit'))
    .option('--cursor <cursor>')
    .option('--sort <sort>', `one of: ${DECISION_QUERY_SORTS.join(', ')}`)
    .option('--json')
    .action(async (options: Record<string, unknown>) => {
      const services = decisionServicesForRead();
      output(await services.query(queryFromOptions(options)), options);
    });
}

function collectRef(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Maps commander's camelCase option bag onto the service query keys. */
function queryFromOptions(options: Record<string, unknown>): Record<string, unknown> {
  const provided = Object.entries(options).filter(([key, value]) => {
    if (key === 'json' || value === undefined) {
      return false;
    }
    // `--ref` defaults to an empty collector array; only a real repeatable
    // filter reaches the service, whose schema requires at least one ref.
    return !(Array.isArray(value) && value.length === 0);
  });
  return Object.fromEntries(
    provided.map(([key, value]) => [key === 'ref' ? 'refs' : key, value]),
  );
}

function registerConsistencyCommand(decision: Command): void {
  decision
    .command('check-consistency')
    .description('Check feedback samples against trace summaries; rebuild summaries only with --repair')
    .option('--repair', 'rebuild derived summaries instead of only reporting drift')
    .option('--json')
    .action(async (options: { repair?: boolean; json?: boolean }) => {
      const repair = options.repair === true;
      const services = repair ? decisionServicesForWrite() : decisionServicesForRead();
      output(await services.checkConsistency(repair ? { repair } : {}), options);
    });
}

function registerMigrationCommand(decision: Command): void {
  decision
    .command('migrate-legacy')
    .description('Migrate legacy decision documents into native objects and write a reconciliation report')
    .requiredOption('--source <dir>', 'root of the legacy vault to scan')
    .requiredOption('--report <path>', 'where the JSON reconciliation report is written')
    .option('--json')
    .action(async (options: { source: string; report: string; json?: boolean }) => {
      const services = decisionServicesForWrite();
      const report = await services.migrateLegacy({
        sourceDir: options.source,
        reportPath: options.report,
      });
      output(report, options);
      if (report.failed > 0) {
        process.exitCode = 1;
      }
    });
}
