import { describe, expect, it } from 'vitest';

import { parseArtifactReference } from '../../../src/storage/artifact-reference.js';

describe('parseArtifactReference', () => {
  it('accepts only canonical artifact refs for the expected task', () => {
    expect(parseArtifactReference(
      'Artifacts/task-a/attempt-001.md',
      'task-a',
    )).toEqual({ taskId: 'task-a', filename: 'attempt-001.md', attempt: 1 });

    expect(parseArtifactReference('Artifacts/task-b/attempt-001.md', 'task-a')).toBeNull();
    expect(parseArtifactReference('Artifacts/../attempt-001.md', '..')).toBeNull();
    expect(parseArtifactReference('Artifacts/task-a/result.md', 'task-a')).toBeNull();
  });
});
