import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import YAML from 'yaml';

import {
  isValidArtifactSettlementAuthorization,
  type ArtifactSettlementAuthorizationEvidence,
  type ArtifactSettlementPlan,
  type ArtifactSettlementReceipt,
  type SettlementWriteResult,
} from '../domain/artifact-settlement.js';
import { parseArtifactReference } from './artifact-reference.js';
import {
  atomicCreateTextFile,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';
import { parseTaskDocument } from './frontmatter.js';
import {
  assertVaultWriteAllowed,
  isSafePathSegment,
} from './task-paths.js';
import type { ArtifactSettlementSourceResolver } from './remote-artifact-settlement-source-resolver.js';

interface PreparedSettlement {
  targetPath: string;
  targetBoundary: StorageReadBoundary;
  content: string;
}

function failed(): SettlementWriteResult {
  return { status: 'failed', writes: [] };
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseTargetRef(
  vaultRoot: string,
  targetRef: string,
): { targetPath: string; boundary: StorageReadBoundary } | null {
  if (!targetRef.startsWith('vault-file:///')) return null;
  let url: URL;
  try {
    url = new URL(targetRef);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'vault-file:'
    || url.host !== ''
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
  ) return null;

  let segments: string[];
  try {
    segments = url.pathname
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment).normalize('NFKC'));
  } catch {
    return null;
  }
  if (
    segments.length < 3
    || !segments.every(isSafePathSegment)
    || !segments.at(-1)?.endsWith('.md')
  ) return null;

  const targetPath = resolve(vaultRoot, ...segments);
  const topLevelRoot = join(vaultRoot, segments[0]!);
  return {
    targetPath,
    boundary: {
      vaultRoot,
      tasksRoot: topLevelRoot,
      subtree: dirname(targetPath),
    },
  };
}

function renderSettlement(
  plan: ArtifactSettlementPlan,
  sourceContent: string,
): string {
  const frontmatter = YAML.stringify({
    type: 'artifact_settlement',
    schema_version: 1,
    artifact_ref: plan.artifact.ref,
    artifact_sha256: plan.artifact.sha256,
    decision_id: plan.decisionId,
    settlement_plan_id: plan.planId,
  });
  return [
    '---',
    frontmatter.trimEnd(),
    '---',
    '',
    '# Settled Artifact',
    '',
    sourceContent,
  ].join('\n');
}

function verifiedWrite(
  plan: ArtifactSettlementPlan,
  content: string,
): SettlementWriteResult {
  return {
    status: 'completed',
    writes: [{
      targetRef: plan.targetRef!,
      version: null,
      sha256: sha256(content),
      externalId: null,
      readback: 'verified',
      backlink: {
        artifactRef: plan.artifact.ref,
        artifactSha256: plan.artifact.sha256,
        decisionId: plan.decisionId,
      },
    }],
  };
}

function hasExpectedBacklink(
  content: string,
  plan: ArtifactSettlementPlan,
): boolean {
  try {
    const document = parseTaskDocument(content);
    return document.data.type === 'artifact_settlement'
      && document.data.schema_version === 1
      && document.data.artifact_ref === plan.artifact.ref
      && document.data.artifact_sha256 === plan.artifact.sha256
      && document.data.decision_id === plan.decisionId
      && document.data.settlement_plan_id === plan.planId;
  } catch {
    return false;
  }
}

export class AuthorizedVaultArtifactSettlementWriter {
  private readonly root: string;

  constructor(
    vaultRoot: string,
    private readonly sourceResolver?: ArtifactSettlementSourceResolver,
  ) {
    this.root = resolve(vaultRoot);
  }

  async write(
    plan: ArtifactSettlementPlan,
    authorization: ArtifactSettlementAuthorizationEvidence,
  ): Promise<SettlementWriteResult> {
    const prepared = await this.prepare(plan, authorization);
    if (prepared === null) return failed();

    let created: boolean;
    try {
      created = await atomicCreateTextFile(
        prepared.targetPath,
        prepared.content,
        prepared.targetBoundary,
      );
    } catch {
      return failed();
    }
    const readback = await this.readTarget(prepared);
    if (
      readback === null
      || readback !== prepared.content
      || !hasExpectedBacklink(readback, plan)
    ) return failed();
    if (!created && sha256(readback) !== sha256(prepared.content)) return failed();
    return verifiedWrite(plan, readback);
  }

  async recoverUnknown(
    plan: ArtifactSettlementPlan,
    receipt: ArtifactSettlementReceipt,
    authorization: ArtifactSettlementAuthorizationEvidence,
  ): Promise<SettlementWriteResult> {
    if (receipt.planId !== plan.planId || receipt.status !== 'unknown') return failed();
    const prepared = await this.prepare(plan, authorization);
    if (prepared === null) return failed();
    const readback = await this.readTarget(prepared);
    if (readback === null) return this.write(plan, authorization);
    if (readback !== prepared.content || !hasExpectedBacklink(readback, plan)) return failed();
    return verifiedWrite(plan, readback);
  }

  private async prepare(
    plan: ArtifactSettlementPlan,
    authorization: ArtifactSettlementAuthorizationEvidence,
  ): Promise<PreparedSettlement | null> {
    if (!isValidArtifactSettlementAuthorization(authorization, plan)) return null;
    let canonicalRoot: string;
    let canonicalAuthorizedRoot: string;
    try {
      assertVaultWriteAllowed(this.root);
      [canonicalRoot, canonicalAuthorizedRoot] = await Promise.all([
        realpath(this.root),
        realpath(authorization.vaultRoot),
      ]);
    } catch {
      return null;
    }
    if (canonicalRoot !== canonicalAuthorizedRoot) return null;

    const target = plan.targetRef === null
      ? null
      : parseTargetRef(canonicalRoot, plan.targetRef);
    if (target === null) return null;

    let sourceContent: string | null = null;
    const artifact = parseArtifactReference(plan.artifact.ref, plan.artifact.taskId);
    if (artifact !== null) {
      const artifactDirectory = join(
        canonicalRoot,
        '10_Tasks',
        'Artifacts',
        artifact.taskId,
      );
      sourceContent = await readSafeTextFile(
        join(artifactDirectory, artifact.filename),
        {
          vaultRoot: canonicalRoot,
          tasksRoot: join(canonicalRoot, '10_Tasks'),
          subtree: artifactDirectory,
        },
      );
      if (sourceContent === null || sha256(sourceContent) !== plan.artifact.sha256) {
        return null;
      }
    } else if (this.sourceResolver !== undefined) {
      try {
        const resolvedSource = await this.sourceResolver.resolve(plan.artifact);
        if (
          resolvedSource === null
          || resolvedSource.identity.taskId !== plan.artifact.taskId
          || resolvedSource.identity.ref !== plan.artifact.ref
          || resolvedSource.identity.version !== plan.artifact.version
          || resolvedSource.identity.sha256 !== plan.artifact.sha256
        ) return null;
        sourceContent = resolvedSource.content;
      } catch {
        return null;
      }
    }
    if (sourceContent === null) return null;
    return {
      targetPath: target.targetPath,
      targetBoundary: target.boundary,
      content: renderSettlement(plan, sourceContent),
    };
  }

  private async readTarget(prepared: PreparedSettlement): Promise<string | null> {
    try {
      return await readSafeTextFile(prepared.targetPath, prepared.targetBoundary);
    } catch {
      return null;
    }
  }
}
