import { createHash } from 'node:crypto';

import {
  isValidArtifactIdentity,
  type ArtifactIdentity,
} from './artifact-identity.js';

export interface ArtifactDecisionBinding {
  schemaVersion: 1;
  decisionId: string;
  traceId: string;
  artifact: ArtifactIdentity;
  createdAt: string;
  bindingSha256: string;
}

export interface CreateArtifactDecisionBindingInput {
  traceId: string;
  artifact: ArtifactIdentity;
  createdAt: string;
}

function decisionIdentity(input: Pick<ArtifactDecisionBinding, 'traceId' | 'artifact'>): string {
  return createHash('sha256').update(JSON.stringify({
    traceId: input.traceId,
    artifact: input.artifact,
  })).digest('hex');
}

function bindingIdentity(
  input: Pick<ArtifactDecisionBinding, 'schemaVersion' | 'decisionId' | 'traceId' | 'artifact' | 'createdAt'>,
): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: input.schemaVersion,
    decisionId: input.decisionId,
    traceId: input.traceId,
    artifact: input.artifact,
    createdAt: input.createdAt,
  })).digest('hex');
}

export function artifactDecisionId(
  input: Pick<ArtifactDecisionBinding, 'traceId' | 'artifact'>,
): string {
  return `ad_${decisionIdentity(input).slice(0, 24)}`;
}

export function createArtifactDecisionBinding(
  input: CreateArtifactDecisionBindingInput,
): ArtifactDecisionBinding {
  const unsigned: Omit<ArtifactDecisionBinding, 'bindingSha256'> = {
    schemaVersion: 1,
    decisionId: artifactDecisionId(input),
    traceId: input.traceId,
    artifact: input.artifact,
    createdAt: input.createdAt,
  };
  const binding: ArtifactDecisionBinding = {
    ...unsigned,
    bindingSha256: bindingIdentity(unsigned),
  };
  if (!isValidArtifactDecisionBinding(binding)) {
    throw new Error('Invalid Artifact Decision binding');
  }
  return binding;
}

export function isValidArtifactDecisionBinding(
  value: unknown,
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const binding = value as ArtifactDecisionBinding;
  if (
    Object.keys(binding).sort().join(',') !== [
      'artifact',
      'bindingSha256',
      'createdAt',
      'decisionId',
      'schemaVersion',
      'traceId',
    ].sort().join(',')
    || typeof binding.artifact !== 'object'
    || binding.artifact === null
    || Array.isArray(binding.artifact)
    || Object.keys(binding.artifact).sort().join(',') !== [
      'ref',
      'sha256',
      'taskId',
      'version',
    ].sort().join(',')
  ) return false;
  return binding.schemaVersion === 1
    && /^ad_[0-9a-f]{24}$/u.test(binding.decisionId)
    && binding.decisionId === artifactDecisionId(binding)
    && /^dt_([0-9A-HJKMNP-TV-Z]{26}|[0-9a-z]{20})$/u.test(binding.traceId)
    && isValidArtifactIdentity(binding.artifact)
    && Number.isFinite(Date.parse(binding.createdAt))
    && /^[0-9a-f]{64}$/u.test(binding.bindingSha256)
    && binding.bindingSha256 === bindingIdentity(binding);
}
