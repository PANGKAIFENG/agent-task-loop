import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { MarkdownTaskTitleRepairRepository } from '../../../src/storage/markdown-task-title-repair-repository.js';
import { repairLegacyTaskTitles } from '../../../src/services/repair-legacy-task-titles.js';

const roots: string[] = [];

async function createVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'atl-title-repair-'));
  roots.push(root);
  return root;
}

async function writeTask(
  root: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('MarkdownTaskTitleRepairRepository', () => {
  it('previews only explicit tasks with an empty title and a real body H1', async () => {
    const root = await createVault();
    const inbox = '10_Tasks/Inbox/2026-07-26';
    await writeTask(root, `${inbox}/missing.md`, [
      '---',
      'type: task',
      'status: inbox',
      '---',
      '',
      '# Design a synthetic dashboard',
    ].join('\n'));
    await writeTask(root, `${inbox}/empty.md`, [
      '---',
      'type: task',
      'title: ""',
      '---',
      '',
      '# Review a synthetic source',
    ].join('\n'));
    await writeTask(root, `${inbox}/null.md`, [
      '---',
      'type: task',
      'title:',
      '---',
      '',
      '# Organize synthetic notes',
    ].join('\n'));
    await writeTask(root, `${inbox}/existing.md`, [
      '---',
      'type: task',
      'title: Existing title',
      '---',
      '',
      '# A different heading',
    ].join('\n'));
    await writeTask(root, `${inbox}/without-h1.md`, [
      '---',
      'type: task',
      '---',
      '',
      'Body without a heading.',
    ].join('\n'));
    await writeTask(root, `${inbox}/fenced-heading.md`, [
      '---',
      'type: task',
      '---',
      '',
      '```md',
      '# Ignore code example',
      '```',
      '',
      '# Use the first real heading',
    ].join('\n'));
    await writeTask(root, `${inbox}/note.md`, [
      '---',
      'type: note',
      '---',
      '',
      '# Do not repair notes',
    ].join('\n'));
    await writeTask(root, `${inbox}/non-closing-fence.md`, [
      '---',
      'type: task',
      '---',
      '',
      '```md',
      'code',
      '```not-a-closing-fence',
      '# Ignore heading still inside code',
      '```',
      '# Use heading after a valid closing fence',
    ].join('\n'));

    const preview = await new MarkdownTaskTitleRepairRepository(root).scan();

    expect(preview).toMatchObject({ filesScanned: 8, tasksScanned: 7 });
    expect(preview.candidates.map(({ title }) => title)).toEqual([
      'Review a synthetic source',
      'Use the first real heading',
      'Design a synthetic dashboard',
      'Use heading after a valid closing fence',
      'Organize synthetic notes',
    ]);
    expect(preview.candidates.every(({ path }) => path.startsWith('10_Tasks/Inbox/')))
      .toBe(true);
  });

  it('changes only the empty title field and preserves the file path and body', async () => {
    const root = await createVault();
    const relativePath = '10_Tasks/Inbox/2026-07-26/legacy-name.md';
    const original = [
      '---',
      '# keep this comment',
      'type: task',
      'status: inbox',
      'custom_field: keep-me',
      '---',
      '',
      '# Design a synthetic dashboard',
      '',
      'Keep this body byte-for-byte.',
    ].join('\n');
    await writeTask(root, relativePath, original);
    const repository = new MarkdownTaskTitleRepairRepository(root);
    const candidate = (await repository.scan()).candidates[0]!;

    await expect(repository.repair(candidate)).resolves.toBe(true);

    const updated = await readFile(join(root, relativePath), 'utf8');
    expect(updated).toBe([
      '---',
      '# keep this comment',
      'type: task',
      'status: inbox',
      'custom_field: keep-me',
      'title: Design a synthetic dashboard',
      '---',
      '',
      '# Design a synthetic dashboard',
      '',
      'Keep this body byte-for-byte.',
    ].join('\n'));
  });

  it('replaces an explicit empty scalar without duplicating the title key', async () => {
    const root = await createVault();
    const relativePath = '10_Tasks/Active/example/empty-title.md';
    await writeTask(root, relativePath, [
      '---',
      'type: task',
      'title: "" # keep inline comment',
      'status: ready',
      '---',
      '',
      '# Review a synthetic source',
    ].join('\n'));
    const repository = new MarkdownTaskTitleRepairRepository(root);
    const candidate = (await repository.scan()).candidates[0]!;

    await repository.repair(candidate);

    const updated = await readFile(join(root, relativePath), 'utf8');
    expect(updated.match(/^title:/gmu)).toHaveLength(1);
    expect(updated).toContain('title: Review a synthetic source # keep inline comment');
  });

  it('skips a stale preview after the user adds a title', async () => {
    const root = await createVault();
    const relativePath = '10_Tasks/Archive/2026/stale.md';
    const original = [
      '---',
      'type: task',
      '---',
      '',
      '# Derived title',
    ].join('\n');
    await writeTask(root, relativePath, original);
    const repository = new MarkdownTaskTitleRepairRepository(root);
    const candidate = (await repository.scan()).candidates[0]!;
    await writeFile(join(root, relativePath), original.replace(
      'type: task',
      'type: task\ntitle: Manual title',
    ), 'utf8');

    await expect(repository.repair(candidate)).resolves.toBe(false);
    await expect(readFile(join(root, relativePath), 'utf8'))
      .resolves.toContain('title: Manual title');
  });

  it('skips a stale preview when the body changed but the title is still empty', async () => {
    const root = await createVault();
    const relativePath = '10_Tasks/Inbox/2026-07-26/body-edited.md';
    const original = [
      '---',
      'type: task',
      '---',
      '',
      '# Original derived title',
    ].join('\n');
    await writeTask(root, relativePath, original);
    const repository = new MarkdownTaskTitleRepairRepository(root);
    const candidate = (await repository.scan()).candidates[0]!;
    const edited = original.replace('Original derived title', 'User edited heading');
    await writeFile(join(root, relativePath), edited, 'utf8');

    await expect(repository.repair(candidate)).resolves.toBe(false);
    await expect(readFile(join(root, relativePath), 'utf8')).resolves.toBe(edited);
  });

  it('does not scan or repair a lifecycle root symlinked to DingTalk data', async () => {
    const root = await createVault();
    const dingTalkRoot = join(root, '10_Tasks', 'DingTalk');
    const dingTalkPath = join(dingTalkRoot, 'event.md');
    const original = [
      '---',
      'type: task',
      '---',
      '',
      '# Do not rewrite DingTalk data',
    ].join('\n');
    await mkdir(dingTalkRoot, { recursive: true });
    await writeFile(dingTalkPath, original, 'utf8');
    await symlink(dingTalkRoot, join(root, '10_Tasks', 'Inbox'), 'dir');
    const repository = new MarkdownTaskTitleRepairRepository(root);

    await expect(repository.scan()).resolves.toMatchObject({
      filesScanned: 0,
      tasksScanned: 0,
      candidates: [],
    });
    await expect(repository.repair({
      path: '10_Tasks/Inbox/event.md',
      title: 'Do not rewrite DingTalk data',
      revision: 'untrusted-preview',
    })).resolves.toBe(false);
    await expect(readFile(dingTalkPath, 'utf8')).resolves.toBe(original);
  });

  it('does not replace a previewed file through a nested directory symlink', async () => {
    const root = await createVault();
    const inboxRoot = join(root, '10_Tasks', 'Inbox');
    const shownRoot = join(inboxRoot, 'shown');
    const movedRoot = join(inboxRoot, 'moved-after-preview');
    const otherRoot = join(inboxRoot, 'other');
    const original = [
      '---',
      'type: task',
      '---',
      '',
      '# Preserve the previewed physical file',
    ].join('\n');
    await writeTask(root, '10_Tasks/Inbox/shown/task.md', original);
    await writeTask(root, '10_Tasks/Inbox/other/task.md', original);
    const repository = new MarkdownTaskTitleRepairRepository(root);
    const candidate = (await repository.scan()).candidates.find(({ path }) => (
      path === '10_Tasks/Inbox/shown/task.md'
    ))!;
    await rename(shownRoot, movedRoot);
    await symlink(otherRoot, shownRoot, 'dir');

    await expect(repository.repair(candidate)).resolves.toBe(false);
    await expect(readFile(join(movedRoot, 'task.md'), 'utf8')).resolves.toBe(original);
    await expect(readFile(join(otherRoot, 'task.md'), 'utf8')).resolves.toBe(original);
  });

  it('is idempotent and rebuilds the task index only after the first repair', async () => {
    const root = await createVault();
    await writeTask(root, '10_Tasks/Inbox/2026-07-26/idempotent.md', [
      '---',
      'type: task',
      'status: inbox',
      '---',
      '',
      '# Organize a synthetic backlog',
    ].join('\n'));
    const repository = new MarkdownTaskTitleRepairRepository(root);

    await expect(repairLegacyTaskTitles(repository)).resolves.toMatchObject({
      repairable: 1,
      repaired: 1,
    });
    await expect(repairLegacyTaskTitles(repository)).resolves.toMatchObject({
      repairable: 0,
      repaired: 0,
    });
    await expect(readFile(join(root, '10_Tasks/任务索引.md'), 'utf8'))
      .resolves.toContain('Organize a synthetic backlog');
  });
});
