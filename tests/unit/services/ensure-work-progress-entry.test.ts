import { describe, expect, it, vi } from 'vitest';

import {
  WORK_PROGRESS_README_PATH,
  ensureWorkProgressEntry,
} from '../../../src/services/ensure-work-progress-entry.js';

function setup(existing?: string) {
  const files = new Map<string, string>();
  if (existing !== undefined) files.set(WORK_PROGRESS_README_PATH, existing);
  const ensureDirectory = vi.fn(async () => undefined);
  const create = vi.fn(async (path: string, content: string) => {
    if (files.has(path)) throw new Error('already exists');
    files.set(path, content);
  });
  return {
    files,
    ensureDirectory,
    create,
    fileSystem: {
      exists: async (path: string) => files.has(path),
      ensureDirectory,
      create,
    },
  };
}

describe('ensureWorkProgressEntry', () => {
  it('creates one discoverable README with the persisted object locations', async () => {
    const { files, ensureDirectory, fileSystem } = setup();

    const result = await ensureWorkProgressEntry(fileSystem);

    expect(result).toEqual({ created: true, path: WORK_PROGRESS_README_PATH });
    expect(ensureDirectory).toHaveBeenCalledWith('09_Progress');
    expect(files.get(WORK_PROGRESS_README_PATH)).toContain('# 工作沉淀');
    expect(files.get(WORK_PROGRESS_README_PATH)).toContain('[[09_Progress/Items|工作进展]]');
    expect(files.get(WORK_PROGRESS_README_PATH)).toContain('[[09_Progress/Weekly|周报验收]]');
    expect(files.get(WORK_PROGRESS_README_PATH)).toContain('[[09_Progress/Requests|待补材料]]');
  });

  it('preserves an existing README byte for byte', async () => {
    const original = '# 我的工作沉淀\n\n不要覆盖。\n';
    const { files, create, fileSystem } = setup(original);

    const result = await ensureWorkProgressEntry(fileSystem);

    expect(result).toEqual({ created: false, path: WORK_PROGRESS_README_PATH });
    expect(create).not.toHaveBeenCalled();
    expect(files.get(WORK_PROGRESS_README_PATH)).toBe(original);
  });
});
