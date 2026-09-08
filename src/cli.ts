#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';

import { Command, CommanderError } from 'commander';

import { QianwenDesktopConnector } from './connectors/qianwen-desktop-connector.js';
import { MulticaCliConnector } from './connectors/multica-cli-connector.js';
import { loadConfig, assertWriteEnabled, type AtlConfig } from './config.js';
import {
  PRIORITIES,
  taskStatusSchema,
  type Priority,
  type TaskStatus,
} from './domain/task.js';
import {
  CLAUDE_RESEARCH_TIMEOUT_MS,
  createClaudeResearchDriver,
} from './runner/claude-driver.js';
import { createArtifactChainContextPlanner } from './runner/artifact-chain-runtime.js';
import { runHourlyCycle } from './runner/hourly-cycle.js';
import {
  createRunnerController,
  getRunnerStatus,
} from './runner/runner-controller.js';
import {
  inspectDingTalkStreamLaunchAgent,
  inspectLaunchAgent,
  installDingTalkStreamLaunchAgent,
  installLaunchAgent,
  uninstallDingTalkStreamLaunchAgent,
  uninstallLaunchAgent,
} from './scheduler/launch-agent.js';
import {
  captureTask,
  type CaptureTaskInput,
} from './services/capture-task.js';
import { createAcceptanceNotifier } from './services/acceptance-notifier-factory.js';
import { createDecisionNotifier } from './services/decision-notifier-factory.js';
import { registerDecisionCommands } from './services/decision-commands.js';
import { registerCodexFeedbackCommands } from './services/codex-feedback-commands.js';
import { authorizeDevelopmentTask } from './services/authorize-development-task.js';
import { authorizeLegacyResearchExecution } from './services/authorize-agent-execution.js';
import { authorizeResearchTask } from './services/authorize-research-task.js';
import { claimTask } from './services/claim-task.js';
import { confirmTask } from './services/confirm-task.js';
import { createProject } from './services/create-project.js';
import { generateWeeklyReport } from './services/generate-weekly-report.js';
import { rebuildArtifactLineage } from './services/rebuild-artifact-lineage.js';
import { bindArtifactDecision } from './services/bind-artifact-decision.js';
import { startPersistedArtifactContinuation } from './services/start-persisted-artifact-continuation.js';
import { executeArtifactSettlement } from './services/execute-artifact-settlement.js';
import { queryEvalSamples } from './services/query-eval-samples.js';
import {
  buildMulticaDispatchDependencies,
  buildResearchMulticaContinuationConnector,
  buildResearchMulticaDispatchDependencies,
} from './services/build-multica-dispatch-dependencies.js';
import type { DispatchDevelopmentTaskDependencies } from './services/dispatch-development-task.js';
import { dispatchMulticaTask } from './services/dispatch-multica-task.js';
import {
  readResearchArtifacts,
  readResearchArtifactsIfCompleted,
} from './services/read-research-artifacts.js';
import {
  MULTICA_RECONCILE_MAX_TASKS,
  parseReconcileMaxTasks,
  reconcileMulticaDispatch,
  type ReconcileMulticaDependencies,
} from './services/reconcile-multica-dispatch.js';
import { ingestMulticaEvents } from './services/ingest-multica-events.js';
import {
  continueMulticaResponses,
  processMulticaReply,
} from './services/process-multica-reply.js';
import { notifyMulticaAction } from './services/notify-multica-action.js';
import { recoverMulticaActionNotification } from './services/recover-multica-action-notification.js';
import {
  completeRelease,
  parsePostDeploymentCompletionEvidence,
} from './services/complete-release.js';
import { runReleaseOperator } from './services/release-operator.js';
import {
  createSpawnVerificationRunner,
} from './services/release-verification.js';
import {
  liveVerificationReceiptSchema,
  mergeReadBackSchema,
} from './domain/release-receipt.js';
import { parseMulticaEventComment } from './domain/multica-event.js';
import { FileMulticaActionNotificationLedger } from './storage/file-multica-action-notification-ledger.js';
import { FileMulticaResponseLedger } from './storage/file-multica-response-ledger.js';
import {
  FileReleaseCompletionIntentLedger,
  FileReleasePhaseEvidenceLedger,
  FileReleaseReceiptLedger,
} from './storage/file-release-receipt-ledger.js';
import {
  dingTalkDeliveryReceiptId,
  DwsSelfAcceptanceDelivery,
} from './connectors/dws-self-acceptance-delivery.js';
import { listTasks, peekNextTask } from './services/query-tasks.js';
import { reopenTask } from './services/reopen-task.js';
import { reviewTask, type ReviewTaskInput } from './services/review-task.js';
import {
  reviewArtifactFromExternalReply,
  type ExternalArtifactReviewInput,
} from './services/review-artifact-from-external-reply.js';
import { createTaskId, type ServiceContext } from './services/service-context.js';
import { stopTask } from './services/stop-task.js';
import { submitArtifact } from './services/submit-artifact.js';
import { syncQianwenSource } from './services/sync-qianwen-source.js';
import { unblockTask } from './services/unblock-task.js';
import { validateStorage } from './services/validate-storage.js';
import { FileAuditLog } from './storage/audit-log.js';
import { MarkdownArtifactRepository } from './storage/markdown-artifact-repository.js';
import { MarkdownProjectRepository } from './storage/markdown-project-repository.js';
import { MarkdownProgressRepository } from './storage/markdown-progress-repository.js';
import { MarkdownTaskRepository } from './storage/markdown-task-repository.js';
import { MarkdownWeeklyReportRepository } from './storage/markdown-weekly-report-repository.js';
import { FileQianwenSourceStateRepository } from './storage/qianwen-source-state-repository.js';
import { FileBackedArtifactLineageEvidenceRepository } from './storage/file-backed-artifact-lineage-evidence-repository.js';
import { FileArtifactDecisionRepository } from './storage/file-artifact-decision-repository.js';
import { FileArtifactTriggerRepository } from './storage/file-artifact-trigger-repository.js';
import { FileArtifactSettlementRepository } from './storage/file-artifact-settlement-repository.js';
import { FileArtifactProductionEvidenceRepository } from './storage/file-artifact-production-evidence-repository.js';
import { AuthorizedVaultArtifactSettlementWriter } from './storage/authorized-vault-artifact-settlement-writer.js';
import { RemoteArtifactSettlementSourceResolver } from './storage/remote-artifact-settlement-source-resolver.js';
import { MarkdownDecisionTraceRepository } from './storage/markdown-decision-trace-repository.js';
import {
  createVaultWriteAuthorization,
  lifecycleDirectory,
  taskStorageRoot,
} from './storage/task-paths.js';
import { qianwenRuntimeRoot } from './qianwen-runtime-root.js';
import { ATL_VERSION } from './version.js';

class CliUsageError extends Error {
  readonly code = 'invalid_cli_input';
}

const MAX_STDIN_JSON_BYTES = 1024 * 1024;

interface OutputOptions {
  json?: boolean;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new CliUsageError(`${flag} is required`);
  }
  return value;
}

function isoDate(value: string | undefined, flag: string): string {
  const candidate = required(value, flag);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(candidate);
  if (match === null) throw new CliUsageError(`${flag} must use YYYY-MM-DD`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new CliUsageError(`${flag} must be a valid date`);
  }
  return candidate;
}

function weekKey(value: string | undefined): string {
  const candidate = required(value, '--week-key');
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u.test(candidate)) {
    throw new CliUsageError('--week-key must use YYYY-Www');
  }
  return candidate;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliUsageError('stdin must contain a JSON object');
  }
  return value as Record<string, unknown>;
}

function requiredJsonString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliUsageError(`stdin JSON field ${field} is required`);
  }
  return value;
}

function nullableJsonString(
  record: Record<string, unknown>,
  field: string,
): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new CliUsageError(`stdin JSON field ${field} must be a string or null`);
  }
  return value;
}

function jsonPriority(record: Record<string, unknown>): Priority {
  const value = record.priority ?? 'normal';
  if (!PRIORITIES.includes(value as Priority)) {
    throw new CliUsageError('stdin JSON field priority is invalid');
  }
  return value as Priority;
}

function captureInputFromJson(value: unknown): CaptureTaskInput {
  const record = jsonRecord(value);
  const allowed = new Set([
    'title',
    'body',
    'origin',
    'sourceDate',
    'sourceNote',
    'sourceQuote',
    'sourceKey',
    'priority',
  ]);
  if (Object.keys(record).some((field) => !allowed.has(field))) {
    throw new CliUsageError('stdin JSON contains unsupported fields');
  }
  return {
    title: requiredJsonString(record, 'title'),
    body: requiredJsonString(record, 'body'),
    origin: requiredJsonString(record, 'origin'),
    sourceDate: nullableJsonString(record, 'sourceDate'),
    sourceNote: nullableJsonString(record, 'sourceNote'),
    sourceQuote: nullableJsonString(record, 'sourceQuote'),
    sourceKey: requiredJsonString(record, 'sourceKey'),
    priority: jsonPriority(record),
  };
}

async function readBoundedJsonInput(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      throw new CliUsageError('stdin JSON exceeds the 1 MiB limit');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new CliUsageError('stdin must contain valid JSON');
  }
}

async function privateJsonString(options: {
  enabled: boolean | undefined;
  publicValue: string | undefined;
  field: string;
  publicFlag: string;
}): Promise<string | undefined> {
  if (options.enabled !== true) return options.publicValue;
  if (options.publicValue !== undefined) {
    throw new CliUsageError(
      `--private-input-stdin-json cannot be combined with ${options.publicFlag}`,
    );
  }
  const record = jsonRecord(await readBoundedJsonInput(
    process.stdin,
    MAX_STDIN_JSON_BYTES,
  ));
  if (
    Object.keys(record).length !== 1
    || !(options.field in record)
  ) {
    throw new CliUsageError('private stdin JSON contains unsupported fields');
  }
  return requiredJsonString(record, options.field);
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function createContext(config: AtlConfig): ServiceContext {
  const notifyAcceptance = createAcceptanceNotifier({
    vaultRoot: config.vaultRoot,
    profile: config.dingtalkProfile,
    robotCode: config.dingtalkRobotCode,
  });
  const notifyDecision = createDecisionNotifier({
    vaultRoot: config.vaultRoot,
    profile: config.dingtalkProfile,
    robotCode: config.dingtalkRobotCode,
  });
  return {
    tasks: new MarkdownTaskRepository(config.vaultRoot),
    artifacts: new MarkdownArtifactRepository(config.vaultRoot),
    projects: new MarkdownProjectRepository(config.vaultRoot),
    audit: new FileAuditLog(config.vaultRoot, { timeZone: 'Asia/Shanghai' }),
    clock: () => new Date(),
    id: () => createTaskId(),
    ...(notifyAcceptance === undefined ? {} : { notifyAcceptance }),
    ...(notifyDecision === undefined ? {} : { notifyDecision }),
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

function allowedLocalRoots(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const configured = environment.ATL_ALLOWED_LOCAL_ROOTS;
  if (configured === undefined || configured.trim() === '') {
    return [];
  }
  const roots = configured.split(delimiter).filter((root) => root !== '');
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) {
    throw new CliUsageError('ATL_ALLOWED_LOCAL_ROOTS must contain absolute paths');
  }
  return roots;
}

function multicaDependencies(config: AtlConfig): DispatchDevelopmentTaskDependencies {
  // PAW-GOAL-003-V0.5 D2: shared with the Obsidian plugin so both entry
  // points dispatch through an identical connector + target surface.
  return buildMulticaDispatchDependencies(config, allowedLocalRoots());
}

function researchMulticaDependencies(config: AtlConfig) {
  return buildResearchMulticaDispatchDependencies(config, allowedLocalRoots());
}

// PAW-GOAL-003 T2: the full action-roundtrip surface — dispatch connector plus
// the comment/run roundtrip, the stable-key DingTalk notifier and the
// response-ledger continuation. The DingTalk side is wired only when the
// self-bot profile and trusted-reply identities are configured; notifications
// then go to that bot alone.
function multicaRoundtripConnector(config: AtlConfig): MulticaCliConnector {
  return new MulticaCliConnector({
    binaryPath: config.multicaDispatch.binaryPath,
    profile: config.multicaDispatch.profile,
    workspaceId: config.multicaDispatch.workspaceId,
    projectId: config.multicaDispatch.projectId,
    squadId: config.multicaDispatch.squadId,
    callTimeoutMs: config.multicaDispatch.callTimeoutMs,
  });
}

function multicaRoundtripDependencies(
  config: AtlConfig,
  ctx: ServiceContext,
): ReconcileMulticaDependencies {
  const connector = multicaRoundtripConnector(config);
  const research = researchMulticaDependencies(config);
  const runtimeRoot = join(config.vaultRoot, '.atl-runtime');
  const notificationLedger = new FileMulticaActionNotificationLedger(runtimeRoot);
  const responseLedger = new FileMulticaResponseLedger(runtimeRoot);
  const delivery = config.dingtalkProfile !== null && config.dingtalkRobotCode !== null
    ? new DwsSelfAcceptanceDelivery({
      profile: config.dingtalkProfile,
      robotCode: config.dingtalkRobotCode,
    })
    : undefined;
  const notify = delivery === undefined
    ? undefined
    : (input: Parameters<typeof notifyMulticaAction>[1]) => notifyMulticaAction({
      ledger: notificationLedger,
      delivery,
      clock: () => new Date(),
    }, input).then((record) => ({ messageId: record.messageId }));
  const trustedSenderUserId = trustedDingTalkSenderUserId();
  const trustedConversationId = optionalEnvironment('ATL_DINGTALK_TRUSTED_CONVERSATION_ID');
  const responseContinuation = trustedSenderUserId !== null && trustedConversationId !== null
    ? () => continueMulticaResponses(ctx, {
      ledger: responseLedger,
      connector,
      trustPolicy: { trustedSenderUserId, trustedConversationId },
    })
    : undefined;
  return {
    connector,
    target: {
      workspaceId: config.multicaDispatch.workspaceId,
      projectId: config.multicaDispatch.projectId,
    },
    allowedContextRoots: allowedLocalRoots(),
    roundtrip: connector,
    readResearchArtifacts: (taskId, options) => readResearchArtifactsIfCompleted(ctx, {
      connector: research.connector,
      runtimeRoot: research.runtimeRoot,
    }, taskId, options),
    ...(notify === undefined ? {} : { notify }),
    ...(responseContinuation === undefined ? {} : { continueResponses: responseContinuation }),
  };
}

function optionalEnvironment(key: string): string | null {
  const value = process.env[key];
  return value === undefined || value.trim() === '' ? null : value.trim();
}

function trustedDingTalkSenderUserId(): string | null {
  const cliName = optionalEnvironment('ATL_DINGTALK_TRUSTED_SENDER_ID');
  const streamName = optionalEnvironment('ATL_DINGTALK_TRUSTED_SENDER_USER_ID');
  if (cliName !== null && streamName !== null && cliName !== streamName) {
    throw new CliUsageError('DingTalk trusted sender environment values conflict');
  }
  return cliName ?? streamName;
}

// PAW-GOAL-003 T3 helpers for `multica release`: the CURRENT release event is
// re-read from the remote as a wire JSON file and parsed through the same
// versioned event schema ingestion uses, so a hand-edited or stale-schema
// payload can never reach the release operator.
async function parseCurrentEventFile(path: string) {
  const raw = await readFile(path, 'utf8');
  const parsed = parseMulticaEventComment(
    'release-current-event',
    `\`\`\`json\n${raw}\n\`\`\``,
  );
  if (parsed.rejections.length > 0 || parsed.events.length !== 1) {
    throw new CliUsageError(
      `current event file must contain exactly one valid versioned event (${parsed.rejections.map((rejection) => rejection.reason).join(', ')})`,
    );
  }
  return parsed.events[0]!;
}

// Merge and live-canary evidence from the authorized release step — read-back
// files only; this command performs no GitHub/Multica discovery of its own.
async function parseReleaseEvidenceFile(path: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new CliUsageError('evidence file must be a single JSON object');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError('evidence file must be a single JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const github = mergeReadBackSchema.safeParse(record.github);
  const live = liveVerificationReceiptSchema.safeParse(record.live);
  if (!github.success || !live.success) {
    throw new CliUsageError('evidence file requires github and live read-back blocks');
  }
  return { github: github.data, live: live.data };
}

async function parsePostDeploymentEvidenceFile(path: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new CliUsageError('post-deployment evidence file must be a single JSON object');
  }
  try {
    return parsePostDeploymentCompletionEvidence(parsed);
  } catch {
    throw new CliUsageError('post-deployment evidence file is invalid or incomplete');
  }
}

// DingTalk release-notice boundary: synthetic runs stub the delivery with a
// deterministic message id; real runs go to the configured self-bot; nothing
// else may send.
function releaseNoticeDelivery(config: AtlConfig) {
  return async (input: { message: string }): Promise<{ messageId: string }> => {
    if (process.env.ATL_RELEASE_DINGTALK_STUB === '1') {
      const digest = createHash('sha256').update(input.message, 'utf8').digest('hex');
      return { messageId: `release-notice-stub-${digest.slice(0, 16)}` };
    }
    if (config.dingtalkProfile !== null && config.dingtalkRobotCode !== null) {
      const delivery = new DwsSelfAcceptanceDelivery({
        profile: config.dingtalkProfile,
        robotCode: config.dingtalkRobotCode,
      });
      const sent = await delivery.send({
        uuid: `release-${Date.now()}`,
        title: 'ATL 发布完成',
        text: input.message,
      });
      const receiptId = dingTalkDeliveryReceiptId(sent);
      if (receiptId === null) {
        throw new CliUsageError('DingTalk release notice returned no message id');
      }
      return { messageId: receiptId };
    }
    throw new CliUsageError(
      'release notice requires ATL_RELEASE_DINGTALK_STUB=1 or a configured DingTalk profile',
    );
  };
}

async function runnerController(driverName: string) {
  if (driverName !== 'claude') {
    throw new CliUsageError('--driver must be claude');
  }
  const { config, ctx } = contextForWrite();
  const driver = await createClaudeResearchDriver();
  const controller = createRunnerController({
    ctx,
    driver,
    runtimeRoot: join(config.vaultRoot, '.atl-runtime'),
    allowedLocalRoots: allowedLocalRoots(),
    leaseMinutes: config.leaseMinutes,
    timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    agent: driver.name,
    runId: () => `run-${createTaskId()}`,
    artifactChainContextPlanner: createArtifactChainContextPlanner({
      vaultRoot: config.vaultRoot,
    }),
  }, { production: true });
  return {
    controller,
    retryAcceptanceNotifications: async () => {
      if (ctx.notifyAcceptance?.retryFailed === undefined) {
        return { attempted: 0, sent: 0 };
      }
      const records = await ctx.notifyAcceptance.retryFailed();
      return {
        attempted: records.length,
        sent: records.filter((record) => record.status === 'sent').length,
      };
    },
  };
}

async function synchronizeQianwen(mode: 'scheduled' | 'manual') {
  const runtimeRoot = qianwenRuntimeRoot({ cwd: process.cwd() });
  return syncQianwenSource({
    repository: new FileQianwenSourceStateRepository(runtimeRoot, {
      writeAuthorization: createVaultWriteAuthorization(runtimeRoot),
    }),
    connector: new QianwenDesktopConnector(),
    now: new Date(),
    timeZone: 'Asia/Shanghai',
    mode,
  });
}

function humanLine(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'No tasks.'
      : value.map((item) => humanLine(item)).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (
      typeof record.installed === 'boolean'
      && typeof record.managed === 'boolean'
      && typeof record.path === 'string'
    ) {
      if (!record.installed) {
        return `Scheduler is not installed: ${record.path}`;
      }
      return record.managed
        ? `Scheduler is installed: ${record.path}`
        : `Scheduler file is not managed: ${record.path}`;
    }
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

function schedulerHome(): { homeDirectory?: string } {
  return process.env.HOME === undefined
    ? {}
    : { homeDirectory: process.env.HOME };
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
    .option('--stdin-json')
    .option('--title <title>')
    .option('--body <body>')
    .option('--origin <origin>')
    .option('--source-date <date>')
    .option('--source-note <path>')
    .option('--source-quote <quote>')
    .option('--source-key <key>')
    .option('--priority <priority>', 'Task priority')
    .option('--json')
    .action(async (options: {
      title?: string;
      body?: string;
      origin?: string;
      sourceDate?: string;
      sourceNote?: string;
      sourceQuote?: string;
      sourceKey?: string;
      priority?: 'urgent' | 'high' | 'normal' | 'low';
      stdinJson?: boolean;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const fieldFlagsUsed = [
        options.title,
        options.body,
        options.origin,
        options.sourceDate,
        options.sourceNote,
        options.sourceQuote,
        options.sourceKey,
        options.priority,
      ].some((value) => value !== undefined);
      if (options.stdinJson === true && fieldFlagsUsed) {
        throw new CliUsageError(
          '--stdin-json cannot be combined with task field options',
        );
      }
      const input = options.stdinJson === true
        ? captureInputFromJson(await readBoundedJsonInput(
          process.stdin,
          MAX_STDIN_JSON_BYTES,
        ))
        : {
          title: required(options.title, '--title'),
          body: required(options.body, '--body'),
          origin: required(options.origin, '--origin'),
          sourceDate: options.sourceDate ?? null,
          sourceNote: options.sourceNote ?? null,
          sourceQuote: options.sourceQuote ?? null,
          sourceKey: required(options.sourceKey, '--source-key'),
          priority: options.priority ?? 'normal',
        };
      const result = await captureTask(ctx, input);
      output(result, options);
    });

  task
    .command('list')
    .option('--status <status>')
    .option('--json')
    .action(async (options: { status?: string; json?: boolean }) => {
      const { ctx } = contextForRead();
      const status = options.status === undefined
        ? undefined
        : taskStatusSchema.safeParse(options.status);
      if (
        status !== undefined
        && (!status.success || options.status?.startsWith('-') === true)
      ) {
        throw new CliUsageError('invalid --status');
      }
      output(await listTasks(
        ctx,
        status?.data as TaskStatus | undefined,
      ), options);
    });

  const artifact = program.command('artifact');
  const artifactDecision = artifact.command('decision');
  artifactDecision
    .command('bind')
    .description('Persist an immutable link from a DecisionTrace to the current Artifact')
    .requiredOption('--task-id <id>')
    .requiredOption('--artifact-ref <ref>')
    .requiredOption('--trace-id <id>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      artifactRef: string;
      traceId: string;
      json?: boolean;
    }) => {
      const { config, ctx } = contextForWrite();
      const runtimeRoot = join(config.vaultRoot, '.atl-runtime');
      const result = await bindArtifactDecision({
        tasks: ctx.tasks,
        artifacts: new FileArtifactProductionEvidenceRepository(config.vaultRoot, runtimeRoot),
        traces: new MarkdownDecisionTraceRepository(config.vaultRoot),
        decisions: new FileArtifactDecisionRepository(runtimeRoot),
        clock: ctx.clock,
      }, {
        taskId: required(options.taskId, '--task-id'),
        artifactRef: required(options.artifactRef, '--artifact-ref'),
        traceId: required(options.traceId, '--trace-id'),
      });
      output({
        ...result.binding,
        created: result.created,
      }, options);
    });

  artifact
    .command('lineage')
    .description('Rebuild one Artifact lineage from persisted Phase 0 evidence')
    .requiredOption('--task-id <id>')
    .requiredOption('--artifact-ref <ref>')
    .requiredOption('--decision-id <id>', 'Artifact-bound DecisionTrace id')
    .option('--json')
    .action(async (options: {
      taskId: string;
      artifactRef: string;
      decisionId: string;
      json?: boolean;
    }) => {
      const { config } = contextForRead();
      output(await rebuildArtifactLineage({
        repository: new FileBackedArtifactLineageEvidenceRepository(
          config.vaultRoot,
          join(config.vaultRoot, '.atl-runtime'),
        ),
      }, {
        taskId: required(options.taskId, '--task-id'),
        artifactRef: required(options.artifactRef, '--artifact-ref'),
        decisionId: required(options.decisionId, '--decision-id'),
      }), options);
    });

  const artifactTrigger = artifact.command('trigger');
  artifactTrigger
    .command('start')
    .description('Start one evidence-bound continuation from a persisted Artifact')
    .requiredOption('--task-id <id>')
    .requiredOption('--artifact-ref <ref>')
    .requiredOption('--decision-id <id>')
    .requiredOption('--driver <driver>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      artifactRef: string;
      decisionId: string;
      driver: string;
      json?: boolean;
    }) => {
      if (options.driver !== 'claude') {
        throw new CliUsageError('--driver must be claude');
      }
      const { config, ctx } = contextForWrite();
      const runtimeRoot = join(config.vaultRoot, '.atl-runtime');
      output(await startPersistedArtifactContinuation({
        ctx,
        runtimeRoot,
        triggers: new FileArtifactTriggerRepository(runtimeRoot),
        traces: new MarkdownDecisionTraceRepository(config.vaultRoot),
        connector: buildResearchMulticaContinuationConnector(config),
        createRunner: async (runId) => {
          const driver = await createClaudeResearchDriver();
          return createRunnerController({
            ctx,
            driver,
            runtimeRoot,
            allowedLocalRoots: allowedLocalRoots(),
            leaseMinutes: config.leaseMinutes,
            timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
            agent: driver.name,
            runId: () => runId,
            artifactChainContextPlanner: createArtifactChainContextPlanner({
              vaultRoot: config.vaultRoot,
            }),
          }, { production: true });
        },
      }, {
        taskId: required(options.taskId, '--task-id'),
        artifactRef: required(options.artifactRef, '--artifact-ref'),
        decisionId: required(options.decisionId, '--decision-id'),
      }), options);
    });

  const artifactSettlement = artifact.command('settlement');
  artifactSettlement
    .command('execute')
    .description('Execute one previously authorized Artifact settlement plan')
    .requiredOption('--plan-id <id>')
    .option('--json')
    .action(async (options: { planId: string; json?: boolean }) => {
      const { config } = contextForWrite();
      const runtimeRoot = join(config.vaultRoot, '.atl-runtime');
      const writer = new AuthorizedVaultArtifactSettlementWriter(
        config.vaultRoot,
        new RemoteArtifactSettlementSourceResolver(runtimeRoot),
      );
      output(await executeArtifactSettlement(
        required(options.planId, '--plan-id'),
        {
          repository: new FileArtifactSettlementRepository(runtimeRoot),
          writer: (plan, authorization) => writer.write(plan, authorization),
          recoverUnknown: (plan, receipt, authorization) => (
            writer.recoverUnknown(plan, receipt, authorization)
          ),
        },
      ), options);
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
    .option('--legacy-local', 'Use the legacy local synthetic execution path')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      projectId?: string;
      objective?: string;
      acceptanceCriterion: string[];
      priority: 'urgent' | 'high' | 'normal' | 'low';
      legacyLocal?: boolean;
      json?: boolean;
    }) => {
      const { ctx } = contextForWrite();
      const result = await confirmTask(ctx, required(options.taskId, '--task-id'), {
        projectId: required(options.projectId, '--project-id'),
        taskType: 'research',
        objective: required(options.objective, '--objective'),
        acceptanceCriteria: options.acceptanceCriterion,
        permissionProfile: 'read_only_research',
        ...(options.legacyLocal === true ? {} : { executionTarget: 'multica' as const }),
        priority: options.priority,
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
      });
      output(result, options);
    });

  task
    .command('authorize-agent')
    .option('--task-id <id>')
    .option('--legacy-local', 'Use the legacy local synthetic execution path')
    .option('--json')
    .action(async (options: { taskId?: string; legacyLocal?: boolean; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      const taskId = required(options.taskId, '--task-id');
      output(options.legacyLocal === true
        ? await authorizeLegacyResearchExecution(ctx, taskId)
        : await authorizeResearchTask(ctx, researchMulticaDependencies(config), taskId), options);
    });

  task
    .command('authorize-development')
    .option('--task-id <id>')
    .option('--json')
    .action(async (options: { taskId?: string; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      output(await authorizeDevelopmentTask(
        ctx,
        multicaDependencies(config),
        required(options.taskId, '--task-id'),
      ), options);
    });

  task
    .command('notify-decision')
    .option('--task-id <id>')
    .option('--json')
    .action(async (options: { taskId?: string; json?: boolean }) => {
      const { ctx } = contextForWrite();
      if (ctx.notifyDecision === undefined) {
        throw new CliUsageError('DingTalk decision notifications are not configured');
      }
      const taskId = required(options.taskId, '--task-id');
      output(await ctx.notifyDecision(await ctx.tasks.get(taskId)), options);
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
    .command('review-external')
    .option('--task-id <id>')
    .option('--artifact-version <version>')
    .option('--response-event-id <id>')
    .option('--sender-user-id <id>')
    .option('--conversation-id <id>')
    .option('--approve')
    .option('--request-changes')
    .option('--block')
    .option('--cancel')
    .option('--feedback <text>')
    .option('--private-input-stdin-json')
    .option('--json')
    .action(async (options: {
      taskId?: string;
      artifactVersion?: string;
      responseEventId?: string;
      senderUserId?: string;
      conversationId?: string;
      approve?: boolean;
      requestChanges?: boolean;
      block?: boolean;
      cancel?: boolean;
      feedback?: string;
      privateInputStdinJson?: boolean;
      json?: boolean;
    }) => {
      const decisions = [
        options.approve ? 'approve' : null,
        options.requestChanges ? 'request_changes' : null,
        options.block ? 'block' : null,
        options.cancel ? 'cancel' : null,
      ].filter((decision): decision is ExternalArtifactReviewInput['decision'] => decision !== null);
      if (decisions.length !== 1) {
        throw new CliUsageError('exactly one external review decision is required');
      }
      const decision = decisions[0];
      if (decision === undefined) {
        throw new CliUsageError('exactly one external review decision is required');
      }
      const feedback = await privateJsonString({
        enabled: options.privateInputStdinJson,
        publicValue: options.feedback,
        field: 'feedback',
        publicFlag: '--feedback',
      });
      if (decision === 'approve' && feedback !== undefined) {
        throw new CliUsageError('--feedback is not allowed with --approve');
      }
      const version = Number(options.artifactVersion);
      if (!Number.isInteger(version) || version <= 0) {
        throw new CliUsageError('--artifact-version must be a positive integer');
      }
      const { ctx } = contextForWrite();
      const input: ExternalArtifactReviewInput = decision === 'approve'
        ? {
            artifactVersion: version,
            responseEventId: required(options.responseEventId, '--response-event-id'),
            senderUserId: required(options.senderUserId, '--sender-user-id'),
            conversationId: required(options.conversationId, '--conversation-id'),
            decision,
          }
        : {
            artifactVersion: version,
            responseEventId: required(options.responseEventId, '--response-event-id'),
            senderUserId: required(options.senderUserId, '--sender-user-id'),
            conversationId: required(options.conversationId, '--conversation-id'),
            decision,
            feedback: required(feedback, '--feedback'),
          };
      output(await reviewArtifactFromExternalReply(
        ctx,
        required(options.taskId, '--task-id'),
        input,
      ), options);
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

  const multica = program.command('multica');
  multica
    .command('dispatch')
    .requiredOption('--task-id <id>')
    .option('--json')
    .action(async (options: { taskId: string; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      output(await dispatchMulticaTask(ctx, {
        development: multicaDependencies(config),
        research: researchMulticaDependencies(config),
      }, required(options.taskId, '--task-id')), options);
    });

  multica
    .command('read-artifacts')
    .description('Read and persist the Artifact receipt for one bound Research run')
    .requiredOption('--task-id <id>')
    .option('--json')
    .action(async (options: { taskId: string; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      const dependencies = researchMulticaDependencies(config);
      output(await readResearchArtifacts(ctx, {
        connector: dependencies.connector,
        runtimeRoot: dependencies.runtimeRoot,
      }, required(options.taskId, '--task-id')), options);
    });

  multica
    .command('reconcile')
    .option('--max-tasks <count>', `Maximum tasks per cycle (1-${MULTICA_RECONCILE_MAX_TASKS})`)
    .option('--json')
    .action(async (options: { maxTasks?: string; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      output(await reconcileMulticaDispatch(
        ctx,
        multicaRoundtripDependencies(config, ctx),
        options.maxTasks === undefined ? {} : { maxTasks: parseReconcileMaxTasks(options.maxTasks) },
      ), options);
    });

  // PAW-GOAL-003 T2: manual ingestion of one task's comment events — the same
  // path the 15-minute reconciliation runs for every linked task.
  multica
    .command('ingest')
    .requiredOption('--task-id <id>')
    .option('--full', 'Re-read the complete comment history for parser-upgrade recovery')
    .option('--json')
    .action(async (options: { taskId: string; full?: boolean; json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      const roundtripDependencies = multicaRoundtripDependencies(config, ctx);
      output(await ingestMulticaEvents(ctx, {
        connector: multicaRoundtripConnector(config),
        ...(roundtripDependencies.notify === undefined
          ? {}
          : { notify: roundtripDependencies.notify }),
      }, required(options.taskId, '--task-id'), { fullScan: options.full === true }), options);
    });

  // PAW-GOAL-003 T2: DingTalk reply entry for the stream bridge. Input is the
  // trusted stream event JSON on stdin (eventId/senderStaffId/conversationId/
  // text); the four-step response ledger drives everything after admission.
  multica
    .command('reply')
    .requiredOption('--stdin-json')
    .option('--json')
    .action(async (options: { stdinJson?: boolean; json?: boolean }) => {
      if (!options.stdinJson) {
        throw new CliUsageError('--stdin-json is required');
      }
      const raw = await readFile('/dev/stdin', 'utf8').catch(() => '');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new CliUsageError('reply input must be a single JSON object on stdin');
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new CliUsageError('reply input must be a single JSON object on stdin');
      }
      const event = parsed as Record<string, unknown>;
      const streamEventId = typeof event.eventId === 'string' ? event.eventId : '';
      const senderUserId = typeof event.senderUserId === 'string' ? event.senderUserId : '';
      const conversationId = typeof event.conversationId === 'string' ? event.conversationId : '';
      const message = typeof event.message === 'string' ? event.message : '';
      if (
        streamEventId.trim() === '' || senderUserId.trim() === ''
        || conversationId.trim() === '' || message.trim() === ''
      ) {
        throw new CliUsageError('reply input requires eventId, senderUserId, conversationId and message');
      }
      const trustedSenderUserId = trustedDingTalkSenderUserId();
      const trustedConversationId = optionalEnvironment('ATL_DINGTALK_TRUSTED_CONVERSATION_ID');
      if (trustedSenderUserId === null || trustedConversationId === null) {
        throw new CliUsageError(
          'ATL_DINGTALK_TRUSTED_SENDER_ID (or ATL_DINGTALK_TRUSTED_SENDER_USER_ID) '
          + 'and ATL_DINGTALK_TRUSTED_CONVERSATION_ID are required',
        );
      }
      const { ctx, config } = contextForWrite();
      output(await processMulticaReply(ctx, {
        ledger: new FileMulticaResponseLedger(join(config.vaultRoot, '.atl-runtime')),
        connector: multicaRoundtripConnector(config),
        trustPolicy: { trustedSenderUserId, trustedConversationId },
      }, {
        streamEventId,
        senderUserId,
        conversationId,
        message,
      }), options);
    });

  multica
    .command('responses')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      const { ctx, config } = contextForWrite();
      const trustedSenderUserId = trustedDingTalkSenderUserId();
      const trustedConversationId = optionalEnvironment('ATL_DINGTALK_TRUSTED_CONVERSATION_ID');
      if (trustedSenderUserId === null || trustedConversationId === null) {
        throw new CliUsageError(
          'ATL_DINGTALK_TRUSTED_SENDER_ID (or ATL_DINGTALK_TRUSTED_SENDER_USER_ID) '
          + 'and ATL_DINGTALK_TRUSTED_CONVERSATION_ID are required',
        );
      }
      output(await continueMulticaResponses(ctx, {
        ledger: new FileMulticaResponseLedger(join(config.vaultRoot, '.atl-runtime')),
        connector: multicaRoundtripConnector(config),
        trustPolicy: { trustedSenderUserId, trustedConversationId },
      }), options);
    });

  multica
    .command('recover-notification')
    .requiredOption('--stdin-json')
    .option('--json')
    .action(async (options: { stdinJson?: boolean; json?: boolean }) => {
      if (!options.stdinJson) {
        throw new CliUsageError('--stdin-json is required');
      }
      const input = jsonRecord(await readBoundedJsonInput(process.stdin, MAX_STDIN_JSON_BYTES));
      const allowed = new Set(['taskId', 'eventId', 'receiptId']);
      if (Object.keys(input).some((field) => !allowed.has(field))) {
        throw new CliUsageError('notification recovery input contains unsupported fields');
      }
      const { ctx, config } = contextForWrite();
      output(await recoverMulticaActionNotification(ctx, {
        ledger: new FileMulticaActionNotificationLedger(join(config.vaultRoot, '.atl-runtime')),
      }, {
        taskId: requiredJsonString(input, 'taskId'),
        eventId: requiredJsonString(input, 'eventId'),
        receiptId: requiredJsonString(input, 'receiptId'),
      }), options);
    });

  // PAW-GOAL-003 T3: the Release Operator entry. It consumes one handled RC
  // approve, re-validates the acceptance against the CURRENT event/head SHA,
  // runs the fixed verification from the immutable candidate worktree, then
  // executes the four fixed release actions behind the controlled boundary.
  // External evidence (merge read-back, live canary) arrives as files from
  // the authorized release step — this command performs no GitHub or
  // DingTalk-side discovery of its own.
  multica
    .command('complete-release')
    .description('Complete an already-published release from immutable read-back evidence')
    .requiredOption('--task-id <id>')
    .requiredOption('--evidence-file <path>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      evidenceFile: string;
      json?: boolean;
    }) => {
      const taskId = required(options.taskId, '--task-id');
      const evidence = await parsePostDeploymentEvidenceFile(options.evidenceFile);
      if (evidence.acceptance.atlTaskId !== taskId) {
        throw new CliUsageError('--task-id differs from the post-deployment evidence binding');
      }
      const { ctx, config } = contextForWrite();
      const outcome = await completeRelease(ctx, {
        ledger: new FileReleaseReceiptLedger(join(config.vaultRoot, '.atl-runtime')),
        completionIntents: new FileReleaseCompletionIntentLedger(join(config.vaultRoot, '.atl-runtime')),
        phaseEvidence: new FileReleasePhaseEvidenceLedger(join(config.vaultRoot, '.atl-runtime')),
        notifications: new FileMulticaActionNotificationLedger(join(config.vaultRoot, '.atl-runtime')),
        responses: new FileMulticaResponseLedger(join(config.vaultRoot, '.atl-runtime')),
        atlReadBack: (task) => ({
          taskId: task.taskId,
          taskStatus: task.status,
          frontmatterPath: join(
            lifecycleDirectory(taskStorageRoot(config.vaultRoot), task),
            `${task.taskId}.md`,
          ),
          finalSummary: evidence.receipt.readBack?.atl.finalSummary
            ?? evidence.completedEvent.summary,
        }),
      }, evidence);
      output(outcome, options);
      if (outcome.status === 'rejected') process.exitCode = 1;
    });

  multica
    .command('release')
    .requiredOption('--task-id <id>')
    .requiredOption('--current-event-file <path>')
    .requiredOption('--fresh-review-ref <ref>')
    .requiredOption('--evidence-file <path>')
    .requiredOption('--workdir <path>')
    .option('--plugin-dir <path>')
    .option('--backup-root <path>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      currentEventFile: string;
      freshReviewRef: string;
      evidenceFile: string;
      workdir: string;
      pluginDir?: string;
      backupRoot?: string;
      json?: boolean;
    }) => {
      const { ctx, config } = contextForWrite();
      const currentEvent = await parseCurrentEventFile(options.currentEventFile);
      const evidence = await parseReleaseEvidenceFile(options.evidenceFile);
      const pluginDir = options.pluginDir
        ?? optionalEnvironment('ATL_PLUGIN_DIR')
        ?? join(config.vaultRoot, '.obsidian', 'plugins', 'agent-task-loop');
      const backupRoot = options.backupRoot
        ?? optionalEnvironment('ATL_PLUGIN_BACKUP_ROOT')
        ?? join(config.vaultRoot, '.obsidian', 'plugins', '.atl-backups');
      output(await runReleaseOperator(ctx, {
        ledger: new FileReleasePhaseEvidenceLedger(join(config.vaultRoot, '.atl-runtime')),
        connector: multicaRoundtripConnector(config),
        ports: {
          verificationRunner: createSpawnVerificationRunner(),
          nodeVersion: process.version,
          workDir: options.workdir,
          mergeAcceptedPr: async () => evidence.github,
          liveVerification: async () => evidence.live,
          notifyDingTalk: releaseNoticeDelivery(config),
        },
      }, {
        taskId: required(options.taskId, '--task-id'),
        currentEvent,
        freshReviewRef: required(options.freshReviewRef, '--fresh-review-ref'),
        vaultRoot: config.vaultRoot,
        plugin: { pluginDir, backupRoot },
      }), options);
    });

  const runner = program.command('runner');
  runner
    .command('run-once')
    .requiredOption('--driver <driver>')
    .option('--json')
    .action(async (options: { driver: string; json?: boolean }) => {
      const { controller, retryAcceptanceNotifications } = await runnerController(options.driver);
      const { ctx, config } = contextForWrite();
      const multicaReconcile = async () => reconcileMulticaDispatch(
        ctx,
        multicaRoundtripDependencies(config, ctx),
      );
      output(await runHourlyCycle({
        retryAcceptanceNotifications,
        reconcileMultica: multicaReconcile,
        syncQianwen: () => synchronizeQianwen('scheduled'),
        runTask: () => controller.runAndWait({ mode: 'automatic' }),
      }), options);
    });

  runner
    .command('run-task')
    .requiredOption('--task-id <id>')
    .requiredOption('--driver <driver>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      driver: string;
      json?: boolean;
    }) => {
      const { controller } = await runnerController(options.driver);
      output(await controller.runAndWait({
        mode: 'manual',
        taskId: required(options.taskId, '--task-id'),
      }), options);
    });

  runner
    .command('continue-decision')
    .requiredOption('--task-id <id>')
    .requiredOption('--decision-request-id <id>')
    .requiredOption('--response-event-id <id>')
    .requiredOption('--sender-user-id <id>')
    .requiredOption('--conversation-id <id>')
    .requiredOption('--selected-option-id <id>')
    .option('--response-text <text>')
    .option('--private-input-stdin-json')
    .requiredOption('--driver <driver>')
    .option('--json')
    .action(async (options: {
      taskId: string;
      decisionRequestId: string;
      responseEventId: string;
      senderUserId: string;
      conversationId: string;
      selectedOptionId: string;
      responseText?: string;
      privateInputStdinJson?: boolean;
      driver: string;
      json?: boolean;
    }) => {
      const responseText = await privateJsonString({
        enabled: options.privateInputStdinJson,
        publicValue: options.responseText,
        field: 'responseText',
        publicFlag: '--response-text',
      });
      const { controller } = await runnerController(options.driver);
      output(await controller.continueAfterDecision({
        taskId: required(options.taskId, '--task-id'),
        decisionRequestId: required(options.decisionRequestId, '--decision-request-id'),
        responseEventId: required(options.responseEventId, '--response-event-id'),
        senderUserId: required(options.senderUserId, '--sender-user-id'),
        conversationId: required(options.conversationId, '--conversation-id'),
        selectedOptionId: required(options.selectedOptionId, '--selected-option-id'),
        ...(responseText === undefined ? {} : { responseText }),
      }), options);
    });

  runner
    .command('status')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      const { ctx } = contextForRead();
      output(await getRunnerStatus(ctx), options);
    });

  const evalCommand = program.command('eval');
  evalCommand
    .command('list')
    .description('List pending capability Eval samples and regression candidates')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      const { ctx } = contextForRead();
      output(await queryEvalSamples(ctx), options);
    });

  const qianwen = program.command('qianwen');
  qianwen
    .command('sync')
    .description('Synchronize Qianwen recordings now')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      contextForWrite();
      output(await synchronizeQianwen('manual'), options);
    });

  const weekly = program.command('weekly');
  weekly
    .command('generate')
    .description('Generate an immutable weekly progress snapshot')
    .requiredOption('--week-key <key>')
    .requiredOption('--start-date <date>')
    .requiredOption('--end-date <date>')
    .option('--json')
    .action(async (options: {
      weekKey: string;
      startDate: string;
      endDate: string;
      json?: boolean;
    }) => {
      const { config } = contextForWrite();
      const startDate = isoDate(options.startDate, '--start-date');
      const endDate = isoDate(options.endDate, '--end-date');
      if (startDate > endDate) {
        throw new CliUsageError('--start-date must not be after --end-date');
      }
      const notifyAcceptance = createAcceptanceNotifier({
        vaultRoot: config.vaultRoot,
        profile: config.dingtalkProfile,
        robotCode: config.dingtalkRobotCode,
      });
      output(await generateWeeklyReport({
        progressRepository: new MarkdownProgressRepository(config.vaultRoot),
        weeklyRepository: new MarkdownWeeklyReportRepository(config.vaultRoot),
        clock: () => new Date(),
        ...(notifyAcceptance === undefined ? {} : { notifyAcceptance }),
      }, {
        weekKey: weekKey(options.weekKey),
        week: { startDate, endDate },
      }), options);
    });

  const scheduler = program.command('scheduler');
  scheduler
    .command('install')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await installLaunchAgent({
        ...schedulerHome(),
      }), options);
    });

  scheduler
    .command('status')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await inspectLaunchAgent(schedulerHome()), options);
    });

  scheduler
    .command('uninstall')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await uninstallLaunchAgent(schedulerHome()), options);
    });

  scheduler
    .command('install-dingtalk-stream')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await installDingTalkStreamLaunchAgent({
        ...schedulerHome(),
      }), options);
    });

  scheduler
    .command('status-dingtalk-stream')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await inspectDingTalkStreamLaunchAgent(schedulerHome()), options);
    });

  scheduler
    .command('uninstall-dingtalk-stream')
    .option('--json')
    .action(async (options: { json?: boolean }) => {
      output(await uninstallDingTalkStreamLaunchAgent(schedulerHome()), options);
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

  registerDecisionCommands(program);
  registerCodexFeedbackCommands(program);

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
