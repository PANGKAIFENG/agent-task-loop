/* @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';

import { LegacyTaskTitleRepairModal } from '../../../src/obsidian-plugin/legacy-task-title-repair-modal.js';
import type {
  LegacyTaskTitlePreview,
  LegacyTaskTitleRepairResult,
} from '../../../src/services/repair-legacy-task-titles.js';

const preview: LegacyTaskTitlePreview = {
  filesScanned: 5,
  tasksScanned: 4,
  candidates: [{
    path: '10_Tasks/Inbox/example.md',
    title: 'Review synthetic source',
    revision: 'revision',
  }],
};

const result: LegacyTaskTitleRepairResult = {
  filesScanned: 5,
  tasksScanned: 4,
  repairable: 1,
  repaired: 1,
  skipped: 0,
  failed: 0,
  indexUpdated: true,
};

function repairButton(modal: LegacyTaskTitleRepairModal): HTMLButtonElement {
  return [...modal.contentEl.querySelectorAll('button')].find((button) => (
    button.textContent?.includes('修复 1 个标题') === true
  ))!;
}

describe('LegacyTaskTitleRepairModal', () => {
  it('shows the preview counts, derived title and path before writing', () => {
    const onSubmit = vi.fn(async () => result);
    const modal = new LegacyTaskTitleRepairModal({} as never, preview, onSubmit);

    modal.open();

    expect(modal.contentEl.textContent).toContain('修复旧任务标题');
    expect(modal.contentEl.textContent).toContain('扫描 5 个 Markdown 文件');
    expect(modal.contentEl.textContent).toContain('识别 4 个任务');
    expect(modal.contentEl.textContent).toContain('发现 1 个可修复标题');
    expect(modal.contentEl.textContent).toContain('Review synthetic source');
    expect(modal.contentEl.textContent).toContain('10_Tasks/Inbox/example.md');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('blocks duplicate submission and shows the final counts', async () => {
    let resolve!: (value: LegacyTaskTitleRepairResult) => void;
    const pending = new Promise<LegacyTaskTitleRepairResult>((done) => { resolve = done; });
    const onSubmit = vi.fn(async () => pending);
    const modal = new LegacyTaskTitleRepairModal({} as never, preview, onSubmit);
    modal.open();

    repairButton(modal).click();
    repairButton(modal).click();
    expect(onSubmit).toHaveBeenCalledOnce();

    resolve(result);
    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('旧任务标题修复完成');
    });
    expect(modal.contentEl.textContent).toContain('成功 1 个');
    expect(modal.contentEl.textContent).toContain('跳过 0 个');
    expect(modal.contentEl.textContent).toContain('失败 0 个');
  });

  it('rechecks Vault management permission immediately before repair', () => {
    let allowed = true;
    const onSubmit = vi.fn(async () => result);
    const modal = new LegacyTaskTitleRepairModal(
      {} as never,
      preview,
      onSubmit,
      () => allowed,
    );
    modal.open();

    allowed = false;
    repairButton(modal).click();

    expect(onSubmit).not.toHaveBeenCalled();
    expect(modal.contentEl.textContent).toContain('Vault 管理权限已关闭');
  });

  it('shows a generic retry message and keeps the preview after failure', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('sensitive storage detail');
    });
    const modal = new LegacyTaskTitleRepairModal({} as never, preview, onSubmit);
    modal.open();

    repairButton(modal).click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('修复失败，请重试');
    });
    expect(modal.contentEl.textContent).not.toContain('sensitive storage detail');
    expect(modal.contentEl.textContent).toContain('Review synthetic source');
  });

  it('warns when repaired titles could not refresh the task index', async () => {
    const onSubmit = vi.fn(async () => ({ ...result, indexUpdated: false }));
    const modal = new LegacyTaskTitleRepairModal({} as never, preview, onSubmit);
    modal.open();

    repairButton(modal).click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('任务索引未能刷新');
    });
  });
});
