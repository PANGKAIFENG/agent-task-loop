import { join } from 'node:path';

import {
  artifactDecisionId,
  isValidArtifactDecisionBinding,
  type ArtifactDecisionBinding,
} from '../domain/artifact-decision.js';
import {
  artifactIdentityMatches,
} from '../domain/artifact-identity.js';
import {
  atomicCreateTextFile,
  readSafeTextFile,
  type StorageReadBoundary,
} from './file-io.js';

export class ArtifactDecisionEvidenceError extends Error {
  readonly code = 'artifact_decision_evidence_invalid';

  constructor() {
    super('Persisted Artifact Decision evidence is missing or invalid');
    this.name = 'ArtifactDecisionEvidenceError';
  }
}

export class ArtifactDecisionConflictError extends Error {
  readonly code = 'artifact_decision_conflict';

  constructor() {
    super('Artifact Decision identity conflicts with persisted evidence');
    this.name = 'ArtifactDecisionConflictError';
  }
}

function boundary(runtimeRoot: string): StorageReadBoundary {
  const directory = join(runtimeRoot, 'artifact-decisions');
  return {
    vaultRoot: join(runtimeRoot, '..'),
    tasksRoot: runtimeRoot,
    subtree: directory,
  };
}

function parse(raw: string): ArtifactDecisionBinding {
  try {
    const binding = JSON.parse(raw) as ArtifactDecisionBinding;
    if (!isValidArtifactDecisionBinding(binding)) {
      throw new ArtifactDecisionEvidenceError();
    }
    return binding;
  } catch (error) {
    if (error instanceof ArtifactDecisionEvidenceError) throw error;
    throw new ArtifactDecisionEvidenceError();
  }
}

function sameIdentity(
  left: ArtifactDecisionBinding,
  right: ArtifactDecisionBinding,
): boolean {
  return left.decisionId === right.decisionId
    && left.traceId === right.traceId
    && artifactIdentityMatches(left.artifact, right.artifact);
}

export class FileArtifactDecisionRepository {
  constructor(private readonly runtimeRoot: string) {}

  async createOrGet(
    binding: ArtifactDecisionBinding,
  ): Promise<{ binding: ArtifactDecisionBinding; created: boolean }> {
    if (!isValidArtifactDecisionBinding(binding)) {
      throw new ArtifactDecisionEvidenceError();
    }
    const storage = boundary(this.runtimeRoot);
    const path = join(storage.subtree, `${binding.decisionId}.json`);
    const content = `${JSON.stringify(binding, null, 2)}\n`;
    const created = await atomicCreateTextFile(path, content, storage);
    if (created) return { binding, created: true };
    const raw = await readSafeTextFile(path, storage);
    if (raw === null) throw new ArtifactDecisionEvidenceError();
    const existing = parse(raw);
    if (!sameIdentity(existing, binding)) throw new ArtifactDecisionConflictError();
    return { binding: existing, created: false };
  }

  async get(decisionId: string): Promise<ArtifactDecisionBinding | null> {
    if (!/^ad_[0-9a-f]{24}$/u.test(decisionId)) {
      throw new ArtifactDecisionEvidenceError();
    }
    const storage = boundary(this.runtimeRoot);
    const raw = await readSafeTextFile(
      join(storage.subtree, `${decisionId}.json`),
      storage,
    );
    if (raw === null) return null;
    const binding = parse(raw);
    if (
      binding.decisionId !== decisionId
      || artifactDecisionId(binding) !== decisionId
    ) throw new ArtifactDecisionEvidenceError();
    return binding;
  }
}
