import { dirname } from 'node:path';

import type { ArtifactIdentity } from '../domain/artifact-identity.js';
import { MarkdownArtifactRepository } from './markdown-artifact-repository.js';
import { FileRemoteArtifactRepository } from './file-remote-artifact-repository.js';

export type PersistedArtifactProductionEvidence =
  | {
      identity: ArtifactIdentity;
      runId: string;
      packId: string;
    }
  | {
      identity: ArtifactIdentity;
      runId: string;
      executionBindingReceiptId: string;
      manifestId: string;
      manifestSha256: string;
      issueId: string;
    };

export interface ArtifactProductionEvidenceReader {
  readProductionEvidence(ref: string): Promise<PersistedArtifactProductionEvidence>;
}

export class FileArtifactProductionEvidenceRepository
implements ArtifactProductionEvidenceReader {
  private readonly local: MarkdownArtifactRepository;
  private readonly remote: FileRemoteArtifactRepository;

  constructor(vaultRoot: string, runtimeRoot: string) {
    this.local = new MarkdownArtifactRepository(vaultRoot);
    this.remote = new FileRemoteArtifactRepository(runtimeRoot);
  }

  static fromRuntimeRoot(runtimeRoot: string): FileArtifactProductionEvidenceRepository {
    return new FileArtifactProductionEvidenceRepository(dirname(runtimeRoot), runtimeRoot);
  }

  readProductionEvidence(ref: string): Promise<PersistedArtifactProductionEvidence> {
    return ref.startsWith('remote-artifact://')
      ? this.remote.readProductionEvidence(ref)
      : this.local.readProductionEvidence(ref);
  }
}
