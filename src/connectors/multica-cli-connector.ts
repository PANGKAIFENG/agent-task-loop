import { spawn } from 'node:child_process';
import { z } from 'zod';

export const MULTICA_CLI_DEFAULT_BINARY = '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica';
export const MULTICA_CLI_DEFAULT_SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';

export const MULTICA_METADATA_KEY = 'atl_task_id';

// T3.1 receipt-reference bounds: the notice body is deliberately tighter than
// a comment body because it must fit one metadata row; the serialized value
// carries the JSON quoting overhead on top.
const RELEASE_RECEIPT_ID_MAX = 600;
const RELEASE_RECEIPT_BODY_MAX = 2_000;
const RELEASE_RECEIPT_VALUE_MAX = 4_000;

export function multicaTaskMarker(idempotencyKey: string): string {
  return `[ATL_TASK_ID:${idempotencyKey}]`;
}

export interface MulticaDispatchEnvelope {
  idempotencyKey: string;
  title: string;
  description: string;
}

export interface MulticaIssueRef {
  issueId: string;
  issueIdentifier: string;
}

export interface MulticaActivationReceipt {
  assigneeId: string;
  runId: string;
  runStatus?: string;
  runAgentId?: string;
  runRuntimeId?: string | null;
  recovered: boolean;
  agent?: MulticaVerifiedAgentSnapshot;
}

export interface MulticaVerifiedAgentSnapshot {
  agentId: string;
  workspaceId: string;
  model: string;
  maxConcurrentTasks: number;
  runtimeId: string;
  status: string;
}

export type MulticaAssignmentPolicy =
  | { type: 'squad'; id: string }
  | {
    type: 'agent';
    id: string;
    requiredModel: string;
    requiredMaxConcurrentTasks: number;
  };

export type MulticaEnsureIssueResult =
  | {
    status: 'linked';
    ref: MulticaIssueRef;
    recovered: boolean;
    activation: MulticaActivationReceipt;
  }
  | { status: 'duplicate_conflict'; candidateIssueIds: string[] }
  | { status: 'remote_write_unknown'; reason: string }
  | { status: 'failed'; reason: string };

export interface MulticaIssueSnapshot {
  issueId: string;
  issueIdentifier: string;
  status: string;
  workspaceId: string;
  projectId: string;
  assigneeId?: string | null;
  assigneeType?: string | null;
}

/**
 * T1 dispatch surface of the TECH §4 ExternalExecutionConnector: ensureIssue
 * resolves or creates the single Multica issue for an authorized task, and
 * inspect reads back the remote snapshot for reconciliation. Response
 * append/resume belong to the T2 action-roundtrip contract. The optional
 * deadline carries the caller's remaining round budget (absolute epoch ms);
 * every CLI operation is clipped to it so one task cannot overrun the
 * reconciliation budget (CR fix 3).
 */
export interface MulticaDispatchConnector {
  ensureIssue(
    envelope: MulticaDispatchEnvelope,
    options?: MulticaCallOptions,
  ): Promise<MulticaEnsureIssueResult>;
  inspect(issueId: string, options?: MulticaCallOptions): Promise<MulticaIssueSnapshot>;
}

export interface MulticaCallOptions {
  deadlineAt?: number | undefined;
}

export interface MulticaCommandRequest {
  args: readonly string[];
  stdin?: string | undefined;
  /** Per-call timeout derived from the connector config and remaining budget. */
  timeoutMs?: number | undefined;
}

export interface MulticaCommandResult {
  stdout: string;
  stderr: string;
}

export type MulticaCommandRunner = (
  request: MulticaCommandRequest,
) => Promise<MulticaCommandResult>;

export class MulticaConnectorConfigError extends Error {
  readonly code = 'multica_connector_config_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'MulticaConnectorConfigError';
  }
}

// PAW-GOAL-003 T2 (TECH §5/§6): the action-roundtrip surface of the connector
// — reading comment increments, appending one idempotent response comment, and
// resuming the remote supervisor only when no new run appeared.
export interface MulticaCommentRecord {
  commentId: string;
  parentCommentId: string | null;
  body: string;
  createdAt: string;
  authorType: string | null;
  attachments?: MulticaAttachmentRecord[];
}

export interface MulticaAttachmentRecord {
  attachmentId: string;
  commentId: string;
  issueId: string;
  workspaceId: string;
  /** Server-issued Run identity. Missing means the Work-level attachment is unbound. */
  runId: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  downloadUrl: string;
  markdownUrl: string | null;
  url: string | null;
  uploaderId: string | null;
  uploaderType: string | null;
}

export interface MulticaCommentPage {
  comments: MulticaCommentRecord[];
}

export interface MulticaRunRecord {
  runId: string;
  issueId: string | null;
  agentId: string | null;
  runtimeId: string | null;
  status: string;
  output: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  deliveredCommentIds: string[];
  triggerCommentId: string | null;
}

export interface MulticaListCommentsOptions extends MulticaCallOptions {
  /** RFC3339 lower bound for the overlap re-read window. */
  since?: string | undefined;
  /**
   * Bypass resolved-thread folding (`--full`). Required for marker scans —
   * a folded resolved thread can hide the marker reply being recovered.
   */
  full?: boolean | undefined;
}

export interface MulticaResponseDraft {
  streamEventId: string;
  body: string;
  parentCommentId: string | null;
}

export type MulticaAppendResponseResult =
  | { commentId: string; deduplicated: boolean }
  | { status: 'remote_write_unknown'; reason: string };

export interface MulticaResumeInput extends MulticaCallOptions {
  /** Run ids observed before the response comment; new runs resume the loop. */
  baselineRunIds: readonly string[];
}

export type MulticaResumeResult =
  | { status: 'confirmed'; newRunIds: string[] }
  | { status: 'already_running'; runIds: string[] }
  | { status: 'duplicate_conflict'; runIds: string[] }
  | { status: 'remote_write_unknown'; reason: string };

export interface MulticaRoundtripConnector
  extends MulticaDispatchConnector {
  listComments(
    issueId: string,
    options?: MulticaListCommentsOptions,
  ): Promise<MulticaCommentPage>;
  appendResponse(
    issueId: string,
    response: MulticaResponseDraft,
    options?: MulticaCallOptions,
  ): Promise<MulticaAppendResponseResult>;
  resume(issueId: string, input: MulticaResumeInput): Promise<MulticaResumeResult>;
  /** Newest run ids of one issue — the baseline for the resume diff. */
  runIds(issueId: string, options?: MulticaCallOptions): Promise<string[]>;
}

export interface MulticaResearchConnector extends MulticaDispatchConnector {
  runs(issueId: string, options?: MulticaCallOptions): Promise<MulticaRunRecord[]>;
  listComments(
    issueId: string,
    options?: MulticaListCommentsOptions,
  ): Promise<MulticaCommentPage>;
}

export interface MulticaResearchContinuationConnector
  extends MulticaRoundtripConnector {
  runs(issueId: string, options?: MulticaCallOptions): Promise<MulticaRunRecord[]>;
  verifyAgent(options?: MulticaCallOptions): Promise<MulticaVerifiedAgentSnapshot | null>;
}

// PAW-GOAL-003 T3.1 (TECH §9): the trusted system receipt channel. The
// Release Receipt is written through Multica issue METADATA — a typed,
// idempotent, run-free channel — never through a member comment. One
// controlled key holds a versioned JSON receipt reference; success requires an
// exact read-back of that value. Ordinary member comments keep their existing
// run semantics.
export const MULTICA_RELEASE_RECEIPT_METADATA_KEY = 'atl_release_receipt';

export interface MulticaReleaseReceiptDraft {
  receiptId: string;
  body: string;
}

export type MulticaReleaseReceiptWriteResult =
  | {
    status: 'written';
    metadataKey: string;
    metadataValue: string;
    deduplicated: boolean;
  }
  | { status: 'receipt_conflict'; reason: string }
  | { status: 'invalid_receipt'; reason: string }
  | { status: 'remote_write_unknown'; reason: string };

export interface MulticaReleaseConnector extends MulticaRoundtripConnector {
  writeReleaseReceipt(
    issueId: string,
    receipt: MulticaReleaseReceiptDraft,
    options?: MulticaCallOptions,
  ): Promise<MulticaReleaseReceiptWriteResult>;
}

/** Deterministic wire form of the receipt reference stored under the key. */
export function multicaReleaseReceiptMetadataValue(
  receipt: MulticaReleaseReceiptDraft,
): string {
  return JSON.stringify({
    schema_version: 1,
    receipt_id: receipt.receiptId,
    body: receipt.body,
  });
}

export class MulticaCallTimedOutError extends Error {
  readonly code = 'multica_call_timed_out';
  readonly uncertain = true;

  constructor(args: readonly string[]) {
    super(`Multica CLI call timed out: ${args.join(' ')}`);
    this.name = 'MulticaCallTimedOutError';
  }
}

export class MulticaCallFailedError extends Error {
  readonly code = 'multica_call_failed';

  constructor(message: string) {
    super(message);
    this.name = 'MulticaCallFailedError';
  }
}

export class MulticaOutputUnparseableError extends Error {
  readonly code = 'multica_output_unparseable';
  readonly uncertain = true;

  constructor(message: string) {
    super(message);
    this.name = 'MulticaOutputUnparseableError';
  }
}

// CR fix 3: the caller's round budget is exhausted; the next CLI operation
// is refused instead of started, so the round cannot overrun its deadline.
export class MulticaBudgetExhaustedError extends Error {
  readonly code = 'multica_budget_exhausted';
  readonly uncertain = true;

  constructor(args: readonly string[]) {
    super(`Multica round budget exhausted before: ${args.join(' ')}`);
    this.name = 'MulticaBudgetExhaustedError';
  }
}

// CR fix 2: the marker/metadata scan hit its page bound without a complete
// pass over the remote issues; recovery cannot be proven complete.
export class MulticaScanIncompleteError extends Error {
  readonly code = 'multica_scan_incomplete';
  readonly uncertain = true;

  constructor(scanBound: number) {
    super(`Multica issue scan exceeded ${scanBound} issues without reaching the end`);
    this.name = 'MulticaScanIncompleteError';
  }
}

export interface MulticaCliConnectorOptions {
  binaryPath: string;
  profile: string;
  workspaceId: string;
  projectId: string;
  assignment?: MulticaAssignmentPolicy;
  /** @deprecated Use assignment: { type: 'squad', id }. */
  squadId?: string;
  callTimeoutMs?: number;
  /** Page size for the marker/metadata recovery scan (default 50). */
  markerScanLimit?: number;
  /** Page bound for the recovery scan; beyond it the scan is incomplete. */
  markerScanMaxPages?: number;
  runner?: MulticaCommandRunner;
  clock?: (() => Date) | undefined;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,100}$/;
const IDEMPOTENCY_KEY_PATTERN = /^atl:[A-Za-z0-9][A-Za-z0-9._-]{0,190}$/;
const ISSUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code >= 0 && code <= 31) || code === 127;
  });
}

const issueRecordSchema = z.object({
  id: z.string().min(1).max(100),
  identifier: z.string().min(1).max(100),
  workspace_id: z.string().min(1).max(100),
  project_id: z.string().min(1).max(100).nullable(),
  description: z.string().max(100_000).nullable(),
  status: z.string().min(1).max(100),
  assignee_id: z.string().min(1).max(100).nullable().optional(),
  assignee_type: z.string().min(1).max(100).nullable().optional(),
}).passthrough();

const issueListSchema = z.object({
  issues: z.array(issueRecordSchema).max(500),
}).passthrough();

// T2 CR fix 1: the real CLI prints `comment list --output json` as a
// TOP-LEVEL ARRAY whose body field is `content` (shape captured from the
// shipped binary). The normalized MulticaCommentRecord keeps the `body` name
// so callers are insulated from the wire field.
const attachmentRecordSchema = z.object({
  id: z.string().min(1).max(200),
  comment_id: z.string().min(1).max(200),
  issue_id: z.string().min(1).max(200),
  workspace_id: z.string().min(1).max(200),
  run_id: z.string().min(1).max(200).nullable().optional(),
  filename: z.string().min(1).max(1_000),
  content_type: z.string().min(1).max(500),
  size_bytes: z.number().int().nonnegative(),
  download_url: z.string().min(1).max(4_000),
  markdown_url: z.string().min(1).max(4_000).nullable().optional(),
  url: z.string().min(1).max(4_000).nullable().optional(),
  uploader_id: z.string().min(1).max(200).nullable().optional(),
  uploader_type: z.string().min(1).max(100).nullable().optional(),
}).passthrough();

const commentRecordSchema = z.object({
  id: z.string().min(1).max(200),
  parent_id: z.string().min(1).max(200).nullable().optional(),
  content: z.string().max(200_000),
  created_at: z.string().min(1).max(100),
  author_type: z.string().min(1).max(100).nullable().optional(),
  attachments: z.array(attachmentRecordSchema).max(100).optional(),
}).passthrough();

// `--since` returns the complete window in one array; the plain list returns
// every (possibly folded) comment. No cursor exists for either mode, so the
// array bound stays the fail-closed overflow guard.
const commentListSchema = z.array(commentRecordSchema).max(1_000);

// `issue runs --output json` is also a top-level array of run records.
const runRecordSchema = z.object({
  id: z.string().min(1).max(200),
  issue_id: z.string().min(1).max(200).nullable().optional(),
  agent_id: z.string().min(1).max(200).nullable().optional(),
  runtime_id: z.string().min(1).max(200).nullable().optional(),
  status: z.string().min(1).max(100),
  result: z.object({
    output: z.string().max(2_000_000).nullable().optional(),
  }).passthrough().nullable().optional(),
  created_at: z.string().min(1).max(100).nullable().optional(),
  started_at: z.string().min(1).max(100).nullable().optional(),
  completed_at: z.string().min(1).max(100).nullable().optional(),
  delivered_comment_ids: z.array(z.string().min(1).max(200)).max(1_000).optional(),
  trigger_comment_id: z.string().min(1).max(200).nullable().optional(),
}).passthrough();

const runListSchema = z.array(runRecordSchema).max(1_000);

const agentRecordSchema = z.object({
  id: z.string().min(1).max(200),
  workspace_id: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  max_concurrent_tasks: z.number().int().positive(),
  runtime_id: z.string().min(1).max(200),
  status: z.string().min(1).max(100),
}).passthrough();

// T3.1 real wire capture: `issue metadata list --output json` prints a bare
// top-level object map whose values are the raw `--value` strings — a JSON
// receipt reference survives byte-exact, quoting included.
const metadataListSchema = z.record(z.string(), z.unknown());

// The versioned receipt reference stored under MULTICA_RELEASE_RECEIPT_METADATA_KEY.
const receiptReferenceSchema = z.object({
  schema_version: z.number(),
  receipt_id: z.string(),
  body: z.string(),
}).passthrough();

const commentCreatedSchema = z.object({
  id: z.string().min(1).max(200),
}).passthrough();

const genericOkSchema = z.object({
  ok: z.boolean().optional(),
  success: z.boolean().optional(),
}).passthrough();

export function assertSafeCliString(value: string, field: string, maxLength: number): void {
  if (value === '' || value.length > maxLength || containsControlCharacters(value)) {
    throw new MulticaConnectorConfigError(`Unsafe Multica CLI ${field}`);
  }
}

// The response body travels over stdin, not argv, so line breaks are legal
// comment formatting; every other control character stays forbidden.
function assertSafeCommentBody(body: string): void {
  const unsafe = Array.from(body).some((character) => {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 13 || code === 9) return false;
    return code < 32 || code === 127;
  });
  if (body === '' || body.length > 20_000 || unsafe) {
    throw new MulticaConnectorConfigError('Unsafe Multica CLI response body');
  }
}

// The receipt notice body becomes one metadata VALUE string: line breaks and
// tabs survive as JSON escapes, every other control character stays
// forbidden, and the body must fit the metadata row bound.
function assertSafeReceiptBody(body: string): void {
  const unsafe = Array.from(body).some((character) => {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 13 || code === 9) return false;
    return code < 32 || code === 127;
  });
  if (body === '' || body.length > RELEASE_RECEIPT_BODY_MAX || unsafe) {
    throw new MulticaConnectorConfigError('Unsafe Multica CLI release receipt body');
  }
}

function childProcessRunner(
  binaryPath: string,
  defaultCallTimeoutMs: number,
): MulticaCommandRunner {
  return async ({ args, stdin, timeoutMs }) => {
    const callTimeoutMs = timeoutMs ?? defaultCallTimeoutMs;
    const child = spawn(binaryPath, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', () => {
      // The child may exit before consuming stdin; the exit code decides.
    });
    child.stdin.end(stdin ?? '', 'utf8');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, callTimeoutMs);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? -1));
      });
      if (timedOut) {
        throw new MulticaCallTimedOutError(args);
      }
      if (exitCode !== 0) {
        throw new MulticaCallFailedError(
          `Multica CLI exited with ${exitCode}: ${stderr.slice(0, 500)}`,
        );
      }
      return { stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  };
}

interface RemoteIssue {
  issueId: string;
  issueIdentifier: string;
  workspaceId: string;
  projectId: string | null;
  description: string | null;
  status: string;
  assigneeId: string | null;
  assigneeType: string | null;
}

function toRemoteIssue(record: z.infer<typeof issueRecordSchema>): RemoteIssue {
  return {
    issueId: record.id,
    issueIdentifier: record.identifier,
    workspaceId: record.workspace_id,
    projectId: record.project_id,
    description: record.description,
    status: record.status,
    assigneeId: record.assignee_id ?? null,
    assigneeType: record.assignee_type ?? null,
  };
}

function toRunRecord(record: z.infer<typeof runRecordSchema>): MulticaRunRecord {
  return {
    runId: record.id,
    issueId: record.issue_id ?? null,
    agentId: record.agent_id ?? null,
    runtimeId: record.runtime_id ?? null,
    status: record.status,
    output: record.result?.output ?? null,
    createdAt: record.created_at ?? null,
    startedAt: record.started_at ?? null,
    completedAt: record.completed_at ?? null,
    deliveredCommentIds: record.delivered_comment_ids ?? [],
    triggerCommentId: record.trigger_comment_id ?? null,
  };
}

type MulticaEnsureFailure = Extract<
  MulticaEnsureIssueResult,
  { status: 'failed' | 'remote_write_unknown' }
>;

function ensureFailure(error: unknown, operation: string): MulticaEnsureFailure {
  const result = uncertain(error, operation);
  return result.status === 'failed' || result.status === 'remote_write_unknown'
    ? result
    : { status: 'remote_write_unknown', reason: `${operation}: unexpected result` };
}

export class MulticaCliConnector implements MulticaDispatchConnector {
  private readonly binaryPath: string;
  private readonly profile: string;
  private readonly workspaceId: string;
  private readonly projectId: string;
  private readonly assignment: MulticaAssignmentPolicy;
  private readonly callTimeoutMs: number;
  private readonly markerScanLimit: number;
  private readonly markerScanMaxPages: number;
  private readonly runner: MulticaCommandRunner;
  private readonly clock: () => Date;

  constructor(options: MulticaCliConnectorOptions) {
    if (!options.binaryPath.startsWith('/')) {
      throw new MulticaConnectorConfigError('binaryPath must be absolute');
    }
    if (!UUID_PATTERN.test(options.workspaceId)) {
      throw new MulticaConnectorConfigError('workspaceId must be a UUID');
    }
    if (!UUID_PATTERN.test(options.projectId)) {
      throw new MulticaConnectorConfigError('projectId must be a UUID');
    }
    if (options.assignment !== undefined && options.squadId !== undefined) {
      throw new MulticaConnectorConfigError('assignment and squadId cannot both be set');
    }
    const assignment = options.assignment ?? {
      type: 'squad' as const,
      id: options.squadId ?? MULTICA_CLI_DEFAULT_SQUAD_ID,
    };
    if (!UUID_PATTERN.test(assignment.id)) {
      throw new MulticaConnectorConfigError(`${assignment.type}Id must be a UUID`);
    }
    if (assignment.type === 'agent' && (
      assignment.requiredModel.trim() === ''
      || !Number.isSafeInteger(assignment.requiredMaxConcurrentTasks)
      || assignment.requiredMaxConcurrentTasks <= 0
    )) {
      throw new MulticaConnectorConfigError('agent assignment requirements are invalid');
    }
    if (!PROFILE_PATTERN.test(options.profile)) {
      throw new MulticaConnectorConfigError('profile is invalid');
    }
    this.binaryPath = options.binaryPath;
    this.profile = options.profile;
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
    this.assignment = assignment;
    this.callTimeoutMs = options.callTimeoutMs ?? 20_000;
    this.markerScanLimit = options.markerScanLimit ?? 50;
    this.markerScanMaxPages = options.markerScanMaxPages ?? 20;
    this.clock = options.clock ?? (() => new Date());
    this.runner = options.runner ?? childProcessRunner(this.binaryPath, this.callTimeoutMs);
  }

  async inspect(
    issueId: string,
    options: MulticaCallOptions = {},
  ): Promise<MulticaIssueSnapshot> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    const issue = await this.getIssue(issueId, options);
    return {
      issueId: issue.issueId,
      issueIdentifier: issue.issueIdentifier,
      status: issue.status,
      workspaceId: issue.workspaceId,
      projectId: issue.projectId ?? '',
      assigneeId: issue.assigneeId,
      assigneeType: issue.assigneeType,
    };
  }

  async ensureIssue(
    envelope: MulticaDispatchEnvelope,
    options: MulticaCallOptions = {},
  ): Promise<MulticaEnsureIssueResult> {
    try {
      assertSafeCliString(envelope.idempotencyKey, 'idempotencyKey', 200);
      assertSafeCliString(envelope.title, 'title', 300);
      if (envelope.description.length > 20_000) {
        throw new MulticaConnectorConfigError('Unsafe Multica CLI description');
      }
      if (!IDEMPOTENCY_KEY_PATTERN.test(envelope.idempotencyKey)) {
        throw new MulticaConnectorConfigError('idempotencyKey must look like atl:<task_id>');
      }
    } catch (error) {
      if (error instanceof MulticaConnectorConfigError) {
        return { status: 'failed', reason: error.message };
      }
      throw error;
    }
    let verifiedAgent: MulticaVerifiedAgentSnapshot | null = null;
    if (this.assignment.type === 'agent') {
      const agentValidation = await this.validateAgentAssignment(options);
      if (!agentValidation.ok) return agentValidation.result;
      verifiedAgent = agentValidation.snapshot;
    }
    const marker = multicaTaskMarker(envelope.idempotencyKey);

    // Step 1: metadata search is the primary deterministic recovery key. The
    // scan pages through every remote issue so a match is never missed to a
    // page boundary (CR fix 2).
    let metadataMatches: RemoteIssue[];
    try {
      metadataMatches = await this.scanIssues([
        '--metadata',
        `${MULTICA_METADATA_KEY}=${envelope.idempotencyKey}`,
      ], options);
    } catch (error) {
      return uncertain(error, 'metadata search');
    }
    if (metadataMatches.length > 1) {
      return {
        status: 'duplicate_conflict',
        candidateIssueIds: metadataMatches.map((issue) => issue.issueId),
      };
    }
    if (metadataMatches.length === 1) {
      const candidate = metadataMatches[0];
      if (candidate === undefined) {
        return { status: 'remote_write_unknown', reason: 'metadata search returned an unreadable candidate' };
      }
      const validation = validateCandidate(
        candidate,
        this.workspaceId,
        this.projectId,
        marker,
        envelope.description,
      );
      if (validation !== null) {
        return { status: 'failed', reason: validation };
      }
      return this.bindAndActivateIssue(
        candidate,
        envelope.idempotencyKey,
        options,
        verifiedAgent,
        envelope.description,
      );
    }

    // Step 2: description-marker scan recovers creates whose metadata write
    // was interrupted. An unscannable result forbids create (TECH §4.1).
    let markerMatches: RemoteIssue[];
    try {
      const scanned = await this.scanIssues([], options);
      markerMatches = scanned.filter((issue) => hasCanonicalTaskMarker(issue.description, marker));
    } catch (error) {
      return uncertain(error, 'description marker scan');
    }
    if (markerMatches.length > 1) {
      return {
        status: 'duplicate_conflict',
        candidateIssueIds: markerMatches.map((issue) => issue.issueId),
      };
    }
    if (markerMatches.length === 1) {
      const candidate = markerMatches[0];
      if (candidate === undefined) {
        return { status: 'remote_write_unknown', reason: 'marker scan returned an unreadable candidate' };
      }
      const validation = validateCandidate(
        candidate,
        this.workspaceId,
        this.projectId,
        marker,
        envelope.description,
      );
      if (validation !== null) {
        return { status: 'failed', reason: validation };
      }
      return this.bindAndActivateIssue(
        candidate,
        envelope.idempotencyKey,
        options,
        verifiedAgent,
        envelope.description,
      );
    }

    // Step 3: exactly zero remote matches — safe to create without assignee
    // and without auto-start.
    let created: RemoteIssue;
    try {
      created = await this.createIssue(envelope, options);
    } catch (error) {
      return uncertain(error, 'issue create');
    }
    return this.bindAndActivateIssue(
      created,
      envelope.idempotencyKey,
      options,
      verifiedAgent,
      envelope.description,
    );
  }

  /**
   * T2 (TECH §5): reads the comment increment for one issue. The caller passes
   * the overlap window lower bound (`since`); comment-id dedup happens above
   * the connector. The real CLI contract (captured, CR fix 1): `--since` is
   * the supported window flag, the JSON response is a top-level array, and
   * these modes carry no pagination cursor — the window is complete per call,
   * so the persisted watermark plus overlap re-read is the only resume
   * mechanism the caller needs.
   */
  async listComments(
    issueId: string,
    options: MulticaListCommentsOptions = {},
  ): Promise<MulticaCommentPage> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    const args = ['issue', 'comment', 'list', issueId];
    if (options.since !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})$/u.test(options.since)) {
        throw new MulticaConnectorConfigError('since must be an RFC3339 timestamp');
      }
      args.push('--since', options.since);
    }
    if (options.full === true) {
      args.push('--full');
    }
    args.push('--output', 'json');
    const { stdout } = await this.runRaw(args, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new MulticaOutputUnparseableError('Multica CLI emitted invalid JSON for: comment list');
    }
    const result = commentListSchema.safeParse(parsed);
    if (!result.success) {
      throw new MulticaOutputUnparseableError('Multica CLI comment list did not match the expected shape');
    }
    return {
      comments: result.data.map((record) => ({
        commentId: record.id,
        parentCommentId: record.parent_id ?? null,
        body: record.content,
        createdAt: record.created_at,
        authorType: record.author_type ?? null,
        ...(record.attachments === undefined || record.attachments.length === 0
          ? {}
          : {
              attachments: record.attachments.map((attachment) => ({
                attachmentId: attachment.id,
                commentId: attachment.comment_id,
                issueId: attachment.issue_id,
                workspaceId: attachment.workspace_id,
                runId: attachment.run_id ?? null,
                filename: attachment.filename,
                contentType: attachment.content_type,
                sizeBytes: attachment.size_bytes,
                downloadUrl: attachment.download_url,
                markdownUrl: attachment.markdown_url ?? null,
                url: attachment.url ?? null,
                uploaderId: attachment.uploader_id ?? null,
                uploaderType: attachment.uploader_type ?? null,
              })),
            }),
      })),
    };
  }

  /**
   * T2 (TECH §6.3): appends exactly one response comment per trusted reply.
   * The `[ATL_RESPONSE:<stream_event_id>]` marker is checked first; a crash
   * between add and read-back heals through the same marker scan, and any
   * uncertain outcome is surfaced as remote_write_unknown — never as success.
   */
  async appendResponse(
    issueId: string,
    response: MulticaResponseDraft,
    options: MulticaCallOptions = {},
  ): Promise<MulticaAppendResponseResult> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    try {
      assertSafeCliString(response.streamEventId, 'streamEventId', 200);
      assertSafeCommentBody(response.body);
      if (response.parentCommentId !== null) {
        assertSafeCliString(response.parentCommentId, 'parentCommentId', 200);
      }
    } catch (error) {
      if (error instanceof MulticaConnectorConfigError) {
        return { status: 'remote_write_unknown', reason: error.message };
      }
      throw error;
    }
    return this.appendMarkerGuardedComment(
      issueId,
      `[ATL_RESPONSE:${response.streamEventId}]`,
      response.body,
      response.parentCommentId,
      options,
    );
  }

  /**
   * T3.1 (TECH §9): writes the Release Receipt through one controlled
   * metadata key — a typed, idempotent system channel that creates no Agent
   * run and no comment. The value is a versioned JSON receipt reference;
   * success requires reading the exact value back, and an unknown write is
   * healed through the stable key before any uncertainty is reported. A
   * pre-existing value under the key is either byte-equal (dedup), a
   * reference to an EARLIER receipt (superseded by this release), or a
   * conflict that fails closed.
   */
  async writeReleaseReceipt(
    issueId: string,
    receipt: MulticaReleaseReceiptDraft,
    options: MulticaCallOptions = {},
  ): Promise<MulticaReleaseReceiptWriteResult> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    try {
      assertSafeCliString(receipt.receiptId, 'receiptId', RELEASE_RECEIPT_ID_MAX);
      assertSafeReceiptBody(receipt.body);
    } catch (error) {
      if (error instanceof MulticaConnectorConfigError) {
        return { status: 'invalid_receipt', reason: error.message };
      }
      throw error;
    }
    const value = multicaReleaseReceiptMetadataValue(receipt);
    // JSON serialization escapes every control character; the bound still
    // fails closed on absurd receipts before they reach argv.
    if (containsControlCharacters(value) || value.length > RELEASE_RECEIPT_VALUE_MAX) {
      return {
        status: 'invalid_receipt',
        reason: 'Serialized release receipt value exceeds the metadata bounds',
      };
    }

    const existing = await this.readReceiptMetadataValue(issueId, options);
    if (!existing.ok) {
      return {
        status: 'remote_write_unknown',
        reason: 'metadata pre-read: the existing release receipt could not be confirmed',
      };
    }
    if (existing.value !== null && existing.value === value) {
      return this.receiptWritten(value, true);
    }
    if (existing.value !== null) {
      const conflict = releaseReceiptConflict(existing.value, receipt.receiptId);
      if (conflict !== null) {
        return { status: 'receipt_conflict', reason: conflict };
      }
      // A reference to an earlier receipt: the new release supersedes it.
    }
    try {
      await this.runJson([
        'issue', 'metadata', 'set', issueId,
        '--key', MULTICA_RELEASE_RECEIPT_METADATA_KEY,
        '--value', value,
        '--type', 'string',
        '--output', 'json',
      ], z.unknown(), options);
    } catch (error) {
      // The set may have landed before the failure — heal through the stable
      // key before declaring the outcome uncertain.
      const healed = await this.readReceiptMetadataValue(issueId, options);
      if (healed.ok && healed.value === value) {
        return this.receiptWritten(value, true);
      }
      return {
        status: 'remote_write_unknown',
        reason: `metadata set: ${errorCodeOf(error)}`,
      };
    }
    const readBack = await this.readReceiptMetadataValue(issueId, options);
    if (readBack.ok && readBack.value === value) {
      return this.receiptWritten(value, false);
    }
    return {
      status: 'remote_write_unknown',
      reason: 'metadata read-back: the release receipt value did not match exactly',
    };
  }

  private receiptWritten(
    value: string,
    deduplicated: boolean,
  ): MulticaReleaseReceiptWriteResult {
    return {
      status: 'written',
      metadataKey: MULTICA_RELEASE_RECEIPT_METADATA_KEY,
      metadataValue: value,
      deduplicated,
    };
  }

  /**
   * Reads the receipt key through the stable metadata surface. `null` means
   * the key is absent; an unreadable or non-object wire is `ok: false` — the
   * caller treats an unavailable pre-read as an unknown remote outcome and
   * does not risk an unconditional overwrite.
   */
  private async readReceiptMetadataValue(
    issueId: string,
    options: MulticaCallOptions,
  ): Promise<{ ok: true; value: string | null } | { ok: false }> {
    try {
      const parsed = await this.runJson(
        ['issue', 'metadata', 'list', issueId, '--output', 'json'],
        metadataListSchema,
        options,
      );
      const value = parsed[MULTICA_RELEASE_RECEIPT_METADATA_KEY];
      if (value === undefined) {
        return { ok: true, value: null };
      }
      return {
        ok: true,
        value: typeof value === 'string' ? value : String(value),
      };
    } catch {
      return { ok: false };
    }
  }

  private async appendMarkerGuardedComment(
    issueId: string,
    marker: string,
    body: string,
    parentCommentId: string | null,
    options: MulticaCallOptions,
  ): Promise<MulticaAppendResponseResult> {
    const commentBody = `${marker}\n\n${body}`;
    const existing = await this.scanCanonicalComment(issueId, marker, commentBody, options);
    if (existing.status === 'exact') {
      return { commentId: existing.commentId, deduplicated: true };
    }
    if (existing.status === 'conflict') {
      return { status: 'remote_write_unknown', reason: existing.reason };
    }

    try {
      const created = await this.runJson([
        'issue', 'comment', 'add', issueId,
        '--content-stdin',
        ...(parentCommentId === null
          ? []
          : ['--parent', parentCommentId]),
        '--output', 'json',
      ], commentCreatedSchema, { ...options, stdin: commentBody });
      return { commentId: created.id, deduplicated: false };
    } catch (error) {
      // The add may have landed before the failure — heal through the marker
      // scan before declaring the outcome uncertain.
      const healed = await this.scanCanonicalComment(
        issueId,
        marker,
        commentBody,
        options,
      ).catch(() => ({ status: 'absent' as const }));
      if (healed.status === 'exact') {
        return { commentId: healed.commentId, deduplicated: true };
      }
      if (healed.status === 'conflict') {
        return { status: 'remote_write_unknown', reason: healed.reason };
      }
      return {
        status: 'remote_write_unknown',
        reason: `comment add: ${errorCodeOf(error)}`,
      };
    }
  }

  /**
   * T2 (TECH §6.4): resumes the remote supervisor only when no new run has
   * appeared since the response comment. The rerun trigger is a run-starting
   * status change (`issue status <id> in_progress` without `--no-start`); the
   * run-id diff before and after is the confirmation, and more than one new
   * run is a duplicate_conflict that stops automation.
   */
  async resume(issueId: string, input: MulticaResumeInput): Promise<MulticaResumeResult> {
    const { baselineRunIds, ...options } = input;
    const before = await this.listRunIds(issueId, options);
    const baseline = new Set(baselineRunIds);
    const alreadyNew = before.filter((runId) => !baseline.has(runId));
    if (alreadyNew.length > 0) {
      return { status: 'already_running', runIds: before };
    }
    try {
      await this.runJson([
        'issue', 'status', issueId, 'in_progress', '--output', 'json',
      ], genericOkSchema, options);
    } catch (error) {
      return {
        status: 'remote_write_unknown',
        reason: `rerun trigger: ${errorCodeOf(error)}`,
      };
    }
    const after = await this.listRunIds(issueId, options);
    const newRuns = after.filter((runId) => !baseline.has(runId));
    if (newRuns.length === 1) {
      return { status: 'confirmed', newRunIds: newRuns };
    }
    if (newRuns.length > 1) {
      return { status: 'duplicate_conflict', runIds: after };
    }
    return {
      status: 'remote_write_unknown',
      reason: 'no new run observed after the rerun trigger',
    };
  }

  private async scanCanonicalComment(
    issueId: string,
    marker: string,
    expectedBody: string,
    options: MulticaCallOptions,
  ): Promise<
    | { status: 'absent' }
    | { status: 'exact'; commentId: string }
    | { status: 'conflict'; reason: string }
  > {
    // `--full`: the marker reply can live inside a thread the default read
    // would fold away once resolved, which would hide the recovery evidence.
    const page = await this.listComments(issueId, { ...options, since: undefined, full: true });
    const markerComments = page.comments.filter((comment) => (
      comment.body === marker || comment.body.startsWith(`${marker}\n`)
    ));
    const exact = markerComments.filter((comment) => comment.body === expectedBody);
    if (exact.length === 1 && markerComments.length === 1) {
      return { status: 'exact', commentId: exact[0]!.commentId };
    }
    if (exact.length > 1) {
      return {
        status: 'conflict',
        reason: 'multiple exact canonical response comments exist for the same marker',
      };
    }
    if (markerComments.length > 0) {
      return {
        status: 'conflict',
        reason: 'response marker conflict: existing comment body does not match exactly',
      };
    }
    return { status: 'absent' };
  }

  private async listRunIds(
    issueId: string,
    options: MulticaCallOptions,
  ): Promise<string[]> {
    return (await this.listRuns(issueId, options)).map((run) => run.runId);
  }

  private async listRuns(
    issueId: string,
    options: MulticaCallOptions,
  ): Promise<MulticaRunRecord[]> {
    const parsed = await this.runJson(
      ['issue', 'runs', issueId, '--output', 'json'],
      runListSchema,
      options,
    );
    // The CLI exposes no cursor or completeness marker. Keep the entire
    // schema-bounded response: truncating locally can hide a conflicting Run
    // and turn ambiguous remote state into a false unique match.
    return parsed.map((record) => {
      const run = toRunRecord(record);
      return run.issueId === null ? { ...run, issueId } : run;
    });
  }

  async runIds(
    issueId: string,
    options: MulticaCallOptions = {},
  ): Promise<string[]> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    return this.listRunIds(issueId, options);
  }

  async runs(
    issueId: string,
    options: MulticaCallOptions = {},
  ): Promise<MulticaRunRecord[]> {
    if (!ISSUE_ID_PATTERN.test(issueId)) {
      throw new MulticaConnectorConfigError('issueId must be a UUID');
    }
    return this.listRuns(issueId, options);
  }

  async verifyAgent(
    options: MulticaCallOptions = {},
  ): Promise<MulticaVerifiedAgentSnapshot | null> {
    if (this.assignment.type !== 'agent') return null;
    const validation = await this.validateAgentAssignment(options);
    return validation.ok ? validation.snapshot : null;
  }

  private async bindAndActivateIssue(
    issue: RemoteIssue,
    idempotencyKey: string,
    options: MulticaCallOptions = {},
    verifiedAgent: MulticaVerifiedAgentSnapshot | null = null,
    expectedDescription?: string,
  ): Promise<MulticaEnsureIssueResult> {
    const marker = multicaTaskMarker(idempotencyKey);
    // Metadata is not a unique constraint; write it, then confirm via issue
    // read-back so the local link only ever binds a verified remote state.
    try {
      await this.runJson([
        'issue', 'metadata', 'set', issue.issueId,
        '--key', MULTICA_METADATA_KEY,
        '--value', idempotencyKey,
        '--type', 'string',
        '--output', 'json',
      ], z.unknown(), options);
    } catch (error) {
      return uncertain(error, 'metadata set');
    }
    let readBack: RemoteIssue;
    try {
      readBack = await this.getIssue(issue.issueId, options);
    } catch (error) {
      return uncertain(error, 'issue read-back');
    }
    const validation = validateCandidate(
      readBack,
      this.workspaceId,
      this.projectId,
      marker,
      expectedDescription,
    );
    if (validation !== null) {
      return { status: 'failed', reason: validation };
    }
    return this.activateBoundIssue(readBack, options, verifiedAgent);
  }

  /**
   * TECH §4.1 step 8: a dispatch is not linked until the governed squad owns
   * the issue and at least one Supervisor run is read back. Every recovery
   * starts by reconciling existing runs; uncertain writes are never replayed
   * blindly.
   */
  private async activateBoundIssue(
    issue: RemoteIssue,
    options: MulticaCallOptions,
    verifiedAgent: MulticaVerifiedAgentSnapshot | null,
  ): Promise<MulticaEnsureIssueResult> {
    let baselineRuns: MulticaRunRecord[];
    try {
      baselineRuns = await this.listRuns(issue.issueId, options);
    } catch (error) {
      return uncertain(error, 'runs before assign');
    }
    const baselineRunIds = baselineRuns.map((run) => run.runId);

    if (issue.assigneeId !== null && issue.assigneeId !== this.assignment.id) {
      return {
        status: 'failed',
        reason: `remote issue ${issue.issueIdentifier} is assigned outside the governed ${this.assignment.type}`,
      };
    }
    if (issue.assigneeId === this.assignment.id && issue.assigneeType !== this.assignment.type) {
      return {
        status: 'failed',
        reason: `remote issue ${issue.issueIdentifier} has an unexpected assignee type`,
      };
    }

    if (issue.assigneeId === this.assignment.id && baselineRuns.length > 0) {
      if (baselineRuns.length === 1) {
        return this.linkedActivation(issue, baselineRuns[0], true, options);
      }
      const eligibleRuns = baselineRuns.filter((run) => {
        if (run.issueId !== issue.issueId) return false;
        if (this.assignment.type !== 'agent') return true;
        return verifiedAgent !== null
          && run.agentId === this.assignment.id
          && run.runtimeId === verifiedAgent.runtimeId;
      });
      if (eligibleRuns.length > 1) {
        return {
          status: 'duplicate_conflict',
          candidateIssueIds: [issue.issueId],
        };
      }
      if (eligibleRuns.length === 1) {
        return this.linkedActivation(issue, eligibleRuns[0], true, options);
      }
      return {
        status: 'remote_write_unknown',
        reason: 'activation reconcile: no unique eligible run matches the governed assignment',
      };
    }
    if (
      issue.assigneeId === this.assignment.id
      && issue.status === 'in_progress'
      && baselineRunIds.length === 0
    ) {
      return {
        status: 'remote_write_unknown',
        reason: 'activation reconcile: issue is in_progress without a confirmed run',
      };
    }

    if (issue.assigneeId === null) {
      try {
        await this.runJson([
          'issue', 'assign', issue.issueId,
          '--to-id', this.assignment.id,
          '--no-start',
          '--output', 'json',
        ], z.unknown(), options);
      } catch (error) {
        // The assignment may have landed before a timeout or malformed
        // response. Read it back once; only the exact governed squad heals the
        // ambiguity. A later reconciliation repeats this same read-first path.
        try {
          const healed = await this.getIssue(issue.issueId, options);
          if (
            healed.assigneeId !== this.assignment.id
            || healed.assigneeType !== this.assignment.type
          ) {
            return uncertain(error, 'issue assign');
          }
          issue = healed;
        } catch {
          return uncertain(error, 'issue assign');
        }
      }

      try {
        issue = await this.getIssue(issue.issueId, options);
      } catch (error) {
        return uncertain(error, 'assignee read-back');
      }
      if (
        issue.assigneeId !== this.assignment.id
        || issue.assigneeType !== this.assignment.type
      ) {
        return {
          status: 'failed',
          reason: `remote issue ${issue.issueIdentifier} was not assigned to the governed ${this.assignment.type}`,
        };
      }

      const afterAssign = await this.activationRunDiff(
        issue,
        baselineRunIds,
        options,
        'runs after assign',
      );
      if (afterAssign !== null) {
        return afterAssign;
      }
    }

    try {
      await this.runJson([
        'issue', 'status', issue.issueId, 'in_progress', '--output', 'json',
      ], z.unknown(), options);
    } catch (error) {
      const healed = await this.activationRunDiff(
        issue,
        baselineRunIds,
        options,
        'runs after start failure',
      ).catch(() => null);
      if (healed !== null) {
        return healed;
      }
      return uncertain(error, 'supervisor start');
    }

    const afterStart = await this.activationRunDiff(
      issue,
      baselineRunIds,
      options,
      'runs after start',
    );
    return afterStart ?? {
      status: 'remote_write_unknown',
      reason: 'supervisor start: no new run observed',
    };
  }

  private async activationRunDiff(
    issue: RemoteIssue,
    baselineRunIds: readonly string[],
    options: MulticaCallOptions,
    stage: string,
  ): Promise<MulticaEnsureIssueResult | null> {
    let currentRuns: MulticaRunRecord[];
    try {
      currentRuns = await this.listRuns(issue.issueId, options);
    } catch (error) {
      return uncertain(error, stage);
    }
    const baseline = new Set(baselineRunIds);
    const newRuns = currentRuns.filter((run) => !baseline.has(run.runId));
    if (newRuns.length === 1) {
      return this.linkedActivation(issue, newRuns[0], false, options);
    }
    if (newRuns.length > 1) {
      return {
        status: 'duplicate_conflict',
        candidateIssueIds: [issue.issueId],
      };
    }
    return null;
  }

  private async linkedActivation(
    issue: RemoteIssue,
    run: MulticaRunRecord | undefined,
    recovered: boolean,
    options: MulticaCallOptions,
  ): Promise<MulticaEnsureIssueResult> {
    if (run === undefined || run.runId.trim() === '') {
      return { status: 'remote_write_unknown', reason: 'activation run read-back is empty' };
    }
    let verifiedAgent: MulticaVerifiedAgentSnapshot | null = null;
    if (this.assignment.type === 'agent') {
      const finalValidation = await this.validateAgentAssignment(options);
      if (!finalValidation.ok) return finalValidation.result;
      verifiedAgent = finalValidation.snapshot;
      if (run.issueId !== issue.issueId) {
        return {
          status: 'failed',
          reason: `Run ${run.runId} does not belong to Work ${issue.issueId}`,
        };
      }
      if (run.agentId !== this.assignment.id) {
        return {
          status: 'failed',
          reason: `Run ${run.runId} is not owned by Research Agent ${this.assignment.id}`,
        };
      }
      if (verifiedAgent === null || run.runtimeId !== verifiedAgent.runtimeId) {
        return {
          status: 'failed',
          reason: `Run ${run.runId} runtime does not match the verified Research Agent`,
        };
      }
    }
    return {
      status: 'linked',
      ref: { issueId: issue.issueId, issueIdentifier: issue.issueIdentifier },
      recovered,
      activation: {
        assigneeId: this.assignment.id,
        runId: run.runId,
        ...(verifiedAgent === null ? {} : {
          runStatus: run.status,
          ...(run.agentId === null ? {} : { runAgentId: run.agentId }),
          runRuntimeId: run.runtimeId,
        }),
        recovered,
        ...(verifiedAgent === null ? {} : { agent: verifiedAgent }),
      },
    };
  }

  private async validateAgentAssignment(
    options: MulticaCallOptions,
  ): Promise<
    | { ok: true; snapshot: MulticaVerifiedAgentSnapshot }
    | {
      ok: false;
      result: MulticaEnsureFailure;
    }
  > {
    if (this.assignment.type !== 'agent') {
      throw new MulticaConnectorConfigError('Agent validation requires an agent assignment');
    }
    let agent: z.infer<typeof agentRecordSchema>;
    try {
      agent = await this.runJson(
        ['agent', 'get', this.assignment.id, '--output', 'json'],
        agentRecordSchema,
        options,
      );
    } catch (error) {
      return { ok: false, result: ensureFailure(error, 'Research Agent read-back') };
    }
    if (agent.id !== this.assignment.id || agent.workspace_id !== this.workspaceId) {
      return {
        ok: false,
        result: { status: 'failed', reason: 'Research Agent identity or workspace mismatch' },
      };
    }
    if (agent.model !== this.assignment.requiredModel) {
      return { ok: false, result: {
        status: 'failed',
        reason: `Research Agent model mismatch: expected ${this.assignment.requiredModel}, received ${agent.model}`,
      } };
    }
    if (agent.max_concurrent_tasks !== this.assignment.requiredMaxConcurrentTasks) {
      return { ok: false, result: {
        status: 'failed',
        reason: `Research Agent concurrency mismatch: expected ${this.assignment.requiredMaxConcurrentTasks}, received ${agent.max_concurrent_tasks}`,
      } };
    }
    return { ok: true, snapshot: {
      agentId: agent.id,
      workspaceId: agent.workspace_id,
      model: agent.model,
      maxConcurrentTasks: agent.max_concurrent_tasks,
      runtimeId: agent.runtime_id,
      status: agent.status,
    } };
  }

  /**
   * Pages through the project issues (board order, `--offset`) until a short
   * page proves the scan is complete. A scan that hits the page bound without
   * a complete pass is uncertain — the caller must treat it as
   * remote_write_unknown instead of creating blind. Pages are deduplicated by
   * issue id so board movement between fetches cannot fabricate duplicates.
   */
  private async scanIssues(
    extraArgs: readonly string[],
    options: MulticaCallOptions = {},
  ): Promise<RemoteIssue[]> {
    const pageSize = this.markerScanLimit;
    const seen = new Map<string, RemoteIssue>();
    for (let page = 0; page < this.markerScanMaxPages; page += 1) {
      const batch = await this.listIssuesPage(extraArgs, page * pageSize, pageSize, options);
      for (const issue of batch) {
        if (!seen.has(issue.issueId)) {
          seen.set(issue.issueId, issue);
        }
      }
      if (batch.length < pageSize) {
        return [...seen.values()];
      }
    }
    throw new MulticaScanIncompleteError(this.markerScanMaxPages * pageSize);
  }

  private async listIssuesPage(
    extraArgs: readonly string[],
    offset: number,
    limit: number,
    options: MulticaCallOptions = {},
  ): Promise<RemoteIssue[]> {
    const parsed = await this.runJson([
      'issue', 'list',
      '--project', this.projectId,
      '--limit', String(limit),
      '--offset', String(offset),
      ...extraArgs,
      '--output', 'json',
    ], issueListSchema, options);
    return parsed.issues.map(toRemoteIssue);
  }

  private async getIssue(
    issueId: string,
    options: MulticaCallOptions = {},
  ): Promise<RemoteIssue> {
    const parsed = await this.runJson(
      ['issue', 'get', issueId, '--output', 'json'],
      issueRecordSchema,
      options,
    );
    return toRemoteIssue(parsed);
  }

  private async createIssue(
    envelope: MulticaDispatchEnvelope,
    options: MulticaCallOptions = {},
  ): Promise<RemoteIssue> {
    const parsed = await this.runJson(
      [
        'issue', 'create',
        '--title', envelope.title,
        '--status', 'backlog',
        '--project', this.projectId,
        '--description-stdin',
        '--output', 'json',
      ],
      issueRecordSchema,
      { ...options, stdin: envelope.description },
    );
    return toRemoteIssue(parsed);
  }

  private async runJson<T extends z.ZodTypeAny>(
    args: readonly string[],
    schema: T,
    options: MulticaCallOptions & { stdin?: string | undefined } = {},
  ): Promise<z.infer<T>> {
    const { stdout } = await this.runRaw(args, options);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new MulticaOutputUnparseableError(`Multica CLI emitted invalid JSON for: ${args.join(' ')}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new MulticaOutputUnparseableError(`Multica CLI JSON did not match the expected shape for: ${args.join(' ')}`);
    }
    return result.data;
  }

  private async runRaw(
    args: readonly string[],
    options: MulticaCallOptions & { stdin?: string | undefined } = {},
  ): Promise<MulticaCommandResult> {
    const fullArgs = [
      '--profile', this.profile,
      '--workspace-id', this.workspaceId,
      ...args,
    ];
    return this.runner({
      args: fullArgs,
      stdin: options.stdin,
      timeoutMs: this.callTimeoutFor(options.deadlineAt, args),
    });
  }

  /**
   * Per-call timeout: never more than the connector cap, and never more than
   * the caller's remaining round budget. No budget left means the operation
   * is refused outright — it must not start and delay the round.
   */
  private callTimeoutFor(
    deadlineAt: number | undefined,
    args: readonly string[],
  ): number {
    if (deadlineAt === undefined) {
      return this.callTimeoutMs;
    }
    const remainingMs = deadlineAt - this.clock().getTime();
    if (remainingMs <= 0) {
      throw new MulticaBudgetExhaustedError(args);
    }
    return Math.max(1, Math.min(this.callTimeoutMs, remainingMs));
  }
}

/**
 * Classifies a pre-existing value under the receipt key. `null` means the
 * value references an EARLIER receipt and this release may supersede it;
 * any other provenance fails closed as a conflict — including the same
 * receipt id recorded with different bytes, which is tampering, and values
 * that are not versioned receipt references at all.
 */
function releaseReceiptConflict(existing: string, receiptId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return `existing ${MULTICA_RELEASE_RECEIPT_METADATA_KEY} value is not a versioned receipt reference`;
  }
  const reference = receiptReferenceSchema.safeParse(parsed);
  if (!reference.success) {
    return `existing ${MULTICA_RELEASE_RECEIPT_METADATA_KEY} value is not a versioned receipt reference`;
  }
  if (reference.data.receipt_id === receiptId) {
    return `issue already records a different value for receipt ${receiptId}`;
  }
  return null;
}

function validateCandidate(
  issue: RemoteIssue,
  workspaceId: string,
  projectId: string,
  marker: string,
  expectedDescription?: string,
): string | null {
  if (issue.workspaceId !== workspaceId) {
    return `remote issue ${issue.issueIdentifier} belongs to another workspace`;
  }
  if (issue.projectId !== projectId) {
    return `remote issue ${issue.issueIdentifier} belongs to another project`;
  }
  if (!hasCanonicalTaskMarker(issue.description, marker)) {
    return `remote issue ${issue.issueIdentifier} is missing the ATL dispatch marker`;
  }
  if (
    expectedDescription !== undefined
    && issue.description !== expectedDescription
  ) {
    return `remote issue ${issue.issueIdentifier} dispatch envelope does not match the current request`;
  }
  return null;
}

function hasCanonicalTaskMarker(description: string | null, marker: string): boolean {
  return description?.split('\n', 1)[0] === marker;
}

function errorCodeOf(error: unknown): string {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'unexpected_connector_error';
}

function uncertain(error: unknown, stage: string): MulticaEnsureIssueResult {
  if (
    error instanceof MulticaCallTimedOutError
    || error instanceof MulticaOutputUnparseableError
    || error instanceof MulticaBudgetExhaustedError
    || error instanceof MulticaScanIncompleteError
  ) {
    return {
      status: 'remote_write_unknown',
      reason: `${stage}: ${error.code}`,
    };
  }
  if (error instanceof MulticaCallFailedError) {
    return {
      status: 'failed',
      reason: `${stage}: ${error.message.slice(0, 300)}`,
    };
  }
  return {
    status: 'remote_write_unknown',
    reason: `${stage}: unexpected connector error`,
  };
}
