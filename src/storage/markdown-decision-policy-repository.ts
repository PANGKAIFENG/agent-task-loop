import { basename, dirname, join } from 'node:path';

import {
  LEGAL_POLICY_TRANSITIONS,
  decisionPolicySchema,
  type DecisionDimension,
  type DecisionPolicy,
  type PolicyStatus,
} from '../domain/decision-policy.js';
import { decisionPolicyRefSchema } from '../domain/decision-trace.js';
import {
  parseDecisionDocument,
  renderPolicyBody,
  serializeDecisionDocument,
} from './decision-document.js';
import {
  atomicCreateTextFile,
  atomicReplaceSafeTextFile,
  listSafeRegularFiles,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
  vaultRoot,
  type VaultWriteAuthorization,
} from './task-paths.js';

/** `policy.<id>@vNNN` reference (D9). */
export type PolicyRef = `${string}@${string}`;

export interface DecisionPolicyListFilter {
  dimension?: DecisionDimension;
  status?: PolicyStatus;
}

export interface DecisionPolicyRepository {
  create(policy: unknown): Promise<DecisionPolicy>;
  get(ref: PolicyRef): Promise<DecisionPolicy | null>;
  list(filter?: DecisionPolicyListFilter): Promise<DecisionPolicy[]>;
  listVersions(policyId: string): Promise<DecisionPolicy[]>;
  updateStatus(ref: PolicyRef, target: PolicyStatus): Promise<DecisionPolicy>;
}

export class DecisionPolicyInvalidError extends Error {
  readonly code = 'decision_policy_invalid';

  constructor() {
    super('Invalid decision policy');
    this.name = 'DecisionPolicyInvalidError';
  }
}

export class DecisionPolicyVersionExistsError extends Error {
  readonly code = 'decision_policy_version_exists';

  constructor() {
    super('Decision policy version already exists');
    this.name = 'DecisionPolicyVersionExistsError';
  }
}

export class DecisionPolicyVersionGapError extends Error {
  readonly code = 'decision_policy_version_gap';

  constructor() {
    super('Decision policy version chain has a gap');
    this.name = 'DecisionPolicyVersionGapError';
  }
}

export class DecisionPolicyTransitionInvalidError extends Error {
  readonly code = 'decision_policy_transition_invalid';

  constructor() {
    super('Illegal decision policy status transition');
    this.name = 'DecisionPolicyTransitionInvalidError';
  }
}

export class DecisionPolicyStatusDiffForbiddenError extends Error {
  readonly code = 'decision_policy_status_diff_forbidden';

  constructor() {
    super('Decision policy status update changed forbidden fields');
    this.name = 'DecisionPolicyStatusDiffForbiddenError';
  }
}

export class DecisionPolicyConflictError extends Error {
  readonly code = 'decision_policy_conflict';

  constructor() {
    super('Decision policy content conflict');
    this.name = 'DecisionPolicyConflictError';
  }
}

export class DecisionPolicyRefUnresolvedError extends Error {
  readonly code = 'decision_policy_ref_unresolved';

  constructor() {
    super('Decision policy reference is unresolvable');
    this.name = 'DecisionPolicyRefUnresolvedError';
  }
}

export interface MarkdownDecisionPolicyRepositoryOptions {
  writeAuthorization?: VaultWriteAuthorization;
}

function systemDirectory(root: string): string {
  return join(root, '07_System');
}

/** Governance §2.1 decision logic root: `07_System/Rules/Decision_Logic`. */
function decisionLogicDirectory(root: string): string {
  return join(systemDirectory(root), 'Rules', 'Decision_Logic');
}

function versionNumberOf(version: string): number {
  return Number.parseInt(version.slice(1), 10);
}

function versionNumberFromFileName(fileName: string): number | null {
  // Policy ids cannot contain underscores, so the trailing segment is the version.
  const stem = fileName.replace(/\.md$/u, '');
  const match = /^v(\d{3})$/u.exec(stem.split('_').at(-1) ?? '');
  return match === null ? null : Number.parseInt(match[1] ?? '', 10);
}

function parsePolicyRef(ref: PolicyRef): { policyId: string; version: string } {
  if (!decisionPolicyRefSchema.safeParse(ref).success) {
    throw new DecisionPolicyInvalidError();
  }
  const separatorIndex = ref.lastIndexOf('@');
  const policyId = ref.slice(0, separatorIndex);
  const version = ref.slice(separatorIndex + 1);
  if (!isSafePathSegment(policyId) || !isSafePathSegment(version)) {
    throw new DecisionPolicyInvalidError();
  }
  return { policyId, version };
}

/** Canonical, insertion-ordered frontmatter record (fresh objects, no mutation). */
function policyFrontmatter(policy: DecisionPolicy): Record<string, unknown> {
  return {
    policy_id: policy.policy_id,
    version: policy.version,
    status: policy.status,
    dimension: policy.dimension,
    decision_question: policy.decision_question,
    inputs: policy.inputs.map((input) => ({ name: input.name, source: input.source })),
    sources: [...policy.sources],
    rules: policy.rules.map((rule) => rule.priority === undefined
      ? { statement: rule.statement }
      : { statement: rule.statement, priority: rule.priority }),
    exceptions: [...policy.exceptions],
    outputs: [...policy.outputs],
    rationale: policy.rationale,
    examples: policy.examples.map((example) => ({ input: example.input, output: example.output })),
    counterexamples: policy.counterexamples
      .map((example) => ({ input: example.input, output: example.output })),
    metrics: [...policy.metrics],
    next_review_at: policy.next_review_at,
    created_at: policy.created_at,
    status_history: policy.status_history
      .map((entry) => ({ status: entry.status, at: entry.at })),
  };
}

/** D4 invariant: a status update may only touch `status` and append history. */
function assertStatusOnlyDiff(
  current: DecisionPolicy,
  next: DecisionPolicy,
  target: PolicyStatus,
): void {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'status') {
      if (next.status !== target) {
        throw new DecisionPolicyStatusDiffForbiddenError();
      }
      continue;
    }
    if (key === 'status_history') {
      const appended = next.status_history.length === current.status_history.length + 1
        && JSON.stringify(next.status_history.slice(0, current.status_history.length))
          === JSON.stringify(current.status_history)
        && next.status_history.at(-1)?.status === target;
      if (!appended) {
        throw new DecisionPolicyStatusDiffForbiddenError();
      }
      continue;
    }
    const field = key as keyof DecisionPolicy;
    if (JSON.stringify(current[field]) !== JSON.stringify(next[field])) {
      throw new DecisionPolicyStatusDiffForbiddenError();
    }
  }
}

/**
 * Create-only Markdown policy repository (D4/D6/D9). Files live at
 * `07_System/Rules/Decision_Logic/<dimension>/<policy_id>_vNNN.md`; the
 * frontmatter is the only source of truth. Files that do not parse under the
 * native schema (legacy harness output, foreign notes) are not members of
 * this repository: reads skip them instead of projecting or mutating them.
 */
export class MarkdownDecisionPolicyRepository implements DecisionPolicyRepository {
  readonly root: string;
  private readonly writeAuthorization: VaultWriteAuthorization | undefined;

  constructor(root?: string, options: MarkdownDecisionPolicyRepositoryOptions = {}) {
    this.root = vaultRoot(root);
    this.writeAuthorization = options.writeAuthorization;
  }

  private readBoundary(): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: systemDirectory(this.root),
      subtree: decisionLogicDirectory(this.root),
    };
  }

  private writeBoundary(dimension: string): StorageReadBoundary {
    return {
      vaultRoot: this.root,
      tasksRoot: decisionLogicDirectory(this.root),
      subtree: join(decisionLogicDirectory(this.root), dimension),
    };
  }

  async create(policy: unknown): Promise<DecisionPolicy> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const parsed = decisionPolicySchema.safeParse(policy);
    if (
      !parsed.success
      || !isSafePathSegment(parsed.data.policy_id)
      || !isSafePathSegment(parsed.data.version)
      || !isSafePathSegment(parsed.data.dimension)
    ) {
      throw new DecisionPolicyInvalidError();
    }
    const valid = parsed.data;
    const requested = versionNumberOf(valid.version);
    const existing = await this.existingVersionNumbers(valid.policy_id);
    if (existing.includes(requested)) {
      throw new DecisionPolicyVersionExistsError();
    }
    if (existing.length === 0) {
      if (requested !== 1) {
        throw new DecisionPolicyVersionGapError();
      }
    } else if (requested !== Math.max(...existing) + 1) {
      throw new DecisionPolicyVersionGapError();
    }

    const created = await atomicCreateTextFile(
      join(
        decisionLogicDirectory(this.root),
        valid.dimension,
        `${valid.policy_id}_${valid.version}.md`,
      ),
      serializeDecisionDocument(policyFrontmatter(valid), renderPolicyBody(valid)),
      this.writeBoundary(valid.dimension),
    );
    if (!created) {
      throw new DecisionPolicyVersionExistsError();
    }
    return valid;
  }

  async get(ref: PolicyRef): Promise<DecisionPolicy | null> {
    const { policyId, version } = parsePolicyRef(ref);
    const path = await this.locatePolicyFile(policyId, version);
    if (path === null) {
      return null;
    }
    return this.readPolicyAt(path);
  }

  async list(filter: DecisionPolicyListFilter = {}): Promise<DecisionPolicy[]> {
    const policies = await this.scanPolicies('*/*.md');
    return policies
      .filter((policy) => (filter.dimension === undefined || policy.dimension === filter.dimension)
        && (filter.status === undefined || policy.status === filter.status))
      .sort((left, right) => {
        if (left.policy_id !== right.policy_id) {
          return left.policy_id.localeCompare(right.policy_id);
        }
        return versionNumberOf(left.version) - versionNumberOf(right.version);
      });
  }

  async listVersions(policyId: string): Promise<DecisionPolicy[]> {
    if (!isSafePathSegment(policyId)) {
      throw new DecisionPolicyInvalidError();
    }
    return (await this.scanPolicies(`*/${policyId}_v*.md`))
      .filter((policy) => policy.policy_id === policyId)
      .sort((left, right) => versionNumberOf(left.version) - versionNumberOf(right.version));
  }

  async updateStatus(ref: PolicyRef, target: PolicyStatus): Promise<DecisionPolicy> {
    assertVaultWriteAllowed(this.root, this.writeAuthorization);
    const { policyId, version } = parsePolicyRef(ref);
    const path = await this.locatePolicyFile(policyId, version);
    if (path === null) {
      throw new DecisionPolicyRefUnresolvedError();
    }
    const dimension = basename(dirname(path));
    if (!isSafePathSegment(dimension)) {
      throw new DecisionPolicyInvalidError();
    }
    const boundary = this.writeBoundary(dimension);
    const raw = await readSafeTextFile(path, boundary);
    if (raw === null) {
      throw new DecisionPolicyRefUnresolvedError();
    }
    let documentData: Record<string, unknown>;
    try {
      documentData = parseDecisionDocument(raw).data;
    } catch {
      throw new DecisionPolicyInvalidError();
    }
    const parsed = decisionPolicySchema.safeParse(documentData);
    if (!parsed.success) {
      throw new DecisionPolicyInvalidError();
    }
    const current = parsed.data;
    if (!LEGAL_POLICY_TRANSITIONS[current.status].includes(target)) {
      throw new DecisionPolicyTransitionInvalidError();
    }
    const next: DecisionPolicy = {
      ...current,
      status: target,
      status_history: [
        ...current.status_history,
        { status: target, at: new Date().toISOString() },
      ],
    };
    assertStatusOnlyDiff(current, next, target);
    const replaced = await atomicReplaceSafeTextFile(
      path,
      raw,
      serializeDecisionDocument(policyFrontmatter(next), renderPolicyBody(next)),
      boundary,
    );
    if (!replaced) {
      throw new DecisionPolicyConflictError();
    }
    return next;
  }

  private async existingVersionNumbers(policyId: string): Promise<number[]> {
    const paths = await listSafeRegularFiles(
      this.readBoundary(),
      `*/${policyId}_v*.md`,
    );
    return paths
      .map((path) => versionNumberFromFileName(basename(path)))
      .filter((value): value is number => value !== null);
  }

  private async locatePolicyFile(policyId: string, version: string): Promise<string | null> {
    const paths = await listSafeRegularFiles(
      this.readBoundary(),
      `*/${policyId}_${version}.md`,
    );
    // Exact filename match; a duplicate across dimension directories is an
    // integrity anomaly the query layer reports, so the first path wins.
    return paths.length === 0 ? null : paths[0] ?? null;
  }

  private async scanPolicies(pattern: string): Promise<DecisionPolicy[]> {
    const paths = await listSafeRegularFiles(this.readBoundary(), pattern);
    const policies: DecisionPolicy[] = [];
    for (const path of paths) {
      const policy = await this.readPolicyAt(path);
      if (policy !== null) {
        policies.push(policy);
      }
    }
    return policies;
  }

  private async readPolicyAt(path: string): Promise<DecisionPolicy | null> {
    const raw = await readSafeTextFile(path, this.readBoundary());
    if (raw === null) {
      return null;
    }
    try {
      const parsed = decisionPolicySchema.safeParse(parseDecisionDocument(raw).data);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
