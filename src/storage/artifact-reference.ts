import { isSafePathSegment } from './task-paths.js';

export interface ArtifactReferenceParts {
  taskId: string;
  filename: string;
  attempt: number;
}

export function parseArtifactReference(
  ref: string,
  expectedTaskId?: string,
): ArtifactReferenceParts | null {
  const match = /^Artifacts\/([^/]+)\/(attempt-(\d{3,})\.md)$/u.exec(ref);
  const taskId = match?.[1];
  const filename = match?.[2];
  const attempt = Number(match?.[3]);
  if (
    taskId === undefined
    || filename === undefined
    || !isSafePathSegment(taskId)
    || (expectedTaskId !== undefined && taskId !== expectedTaskId)
    || !Number.isSafeInteger(attempt)
    || attempt <= 0
  ) {
    return null;
  }
  return { taskId, filename, attempt };
}
