export interface ArtifactIdentity {
  taskId: string;
  ref: string;
  version: number;
  sha256: string;
}

export function isValidArtifactIdentity(artifact: ArtifactIdentity): boolean {
  return artifact.taskId.trim() !== ''
    && artifact.ref.trim() !== ''
    && Number.isSafeInteger(artifact.version)
    && artifact.version > 0
    && /^[0-9a-f]{64}$/u.test(artifact.sha256);
}

export function artifactIdentityMatches(
  left: ArtifactIdentity,
  right: ArtifactIdentity,
): boolean {
  return left.taskId === right.taskId
    && left.ref === right.ref
    && left.version === right.version
    && left.sha256 === right.sha256;
}

export function artifactNodeId(artifact: ArtifactIdentity): string {
  return `artifact:${artifact.ref}@v${artifact.version}#${artifact.sha256}`;
}
