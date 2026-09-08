import type { ContextManifest } from '../domain/context-manifest.js';
import {
  readContextManifestById,
} from '../runner/context-manifest-runtime.js';
import {
  readRuntimePackById,
  readRuntimePackForRun,
  type PersistedRuntimePackEvidence,
} from '../runner/runtime-pack.js';

/**
 * Read-only production adapter for the Artifact Chain evidence that Phase 0
 * itself persists under `.atl-runtime`. Higher-level Decision, Feedback,
 * Trigger, and settlement repositories remain independently composable.
 */
export class FileArtifactChainRuntimeEvidenceRepository {
  constructor(private readonly runtimeRoot: string) {}

  getRuntimePack(packId: string): Promise<PersistedRuntimePackEvidence | null> {
    return readRuntimePackById(this.runtimeRoot, packId);
  }

  getRuntimePackForRun(
    taskId: string,
    runId: string,
  ): Promise<PersistedRuntimePackEvidence | null> {
    return readRuntimePackForRun(this.runtimeRoot, taskId, runId);
  }

  getContextManifest(manifestId: string): Promise<ContextManifest | null> {
    return readContextManifestById(this.runtimeRoot, manifestId);
  }
}
