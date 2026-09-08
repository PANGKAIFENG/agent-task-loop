/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskBriefModal } from '../../../src/obsidian-plugin/task-brief-modal.js';
import type { PreparedTaskBrief } from '../../../src/obsidian-plugin/task-brief-controller.js';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.createDiv = function createDiv(options = {}): HTMLDivElement {
    return this.createEl('div', options);
  };
  HTMLElement.prototype.createEl = function createEl<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    options: DomElementInfo | string = {},
    callback?: (element: HTMLElementTagNameMap[K]) => void,
  ): HTMLElementTagNameMap[K] {
    const element = document.createElement(tag);
    const info = typeof options === 'string' ? { text: options } : options;
    if (info.cls !== undefined) {
      element.className = Array.isArray(info.cls) ? info.cls.join(' ') : info.cls;
    }
    if (info.text instanceof DocumentFragment) element.append(info.text);
    else if (info.text !== undefined) element.textContent = info.text;
    this.append(element);
    callback?.(element);
    return element;
  };
});

function button(modal: TaskBriefModal, label: string): HTMLButtonElement {
  return [...modal.contentEl.querySelectorAll('button')].find((candidate) => (
    candidate.textContent?.includes(label) === true
  ))!;
}

function textArea(modal: TaskBriefModal, label: string): HTMLTextAreaElement {
  return modal.contentEl.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function prepared(taskBrief: unknown = null) {
  return {
    task: {
      taskId: 'task-synthetic-brief',
      title: '梳理任务面板字段',
      body: '需要明确一期哪些字段保留。',
      taskBrief,
    },
    project: {
      projectId: 'personal-workbench',
      name: '个人工作台',
      description: '管理个人任务与复盘',
    },
  } as unknown as PreparedTaskBrief;
}

function candidatePrepared() {
  return {
    ...prepared(),
    candidateInspector: {
      taskIdentity: {
        taskId: 'task-synthetic-brief',
        title: '梳理任务面板字段',
        status: 'inbox',
        reviewState: 'candidate',
        updatedAt: '2026-08-22T03:00:00.000Z',
        candidateRevision: 2,
        candidateConfirmed: false,
        autoExecutable: false,
      },
      currentTaskBrief: null,
      suggestions: [
        ['title', '梳理任务面板字段', 'source_fact', ['source-modal'], '标题来自来源事实。'],
        ['objective', '形成可评审字段方案', 'source_fact', ['source-modal'], '目标来自来源事实。'],
        ['next_action', '逐项核对字段', 'ai_inference', [], '这是 AI 推断。'],
        ['expected_artifact', '', 'missing', [], '当前来源无法确认。'],
        ['completion_criteria', '字段均有明确取舍', 'ai_inference', [], '这是 AI 推断。'],
      ].map(([field, suggestedValue, attribution, sourceRefIds, reason]) => ({
        field,
        suggestedValue,
        attribution,
        sourceRefIds,
        reason,
        generationId: 'candidate-modal',
      })),
      sourceRefs: [{
        sourceRefId: 'source-modal',
        sourceType: 'synthetic_fixture',
        sourceKey: 'synthetic:modal',
        sourceNote: 'fixtures/modal.md',
        anchor: 'line:4',
        quote: '梳理任务面板字段并形成可评审字段方案。',
        capturedAt: '2026-08-22T02:00:00.000Z',
        lastVerifiedAt: '2026-08-22T02:30:00.000Z',
        status: 'available',
        failureReason: null,
        parentContext: '批量清单中的单项候选',
        lastVerifiedEvidence: {
          resolvedNote: 'fixtures/modal.md',
          checkedCharacters: 120,
          quoteMatched: true,
          truncated: false,
        },
      }],
      sourceActions: [{
        actionId: 'open_source',
        sourceRefId: 'source-modal',
        intent: 'open',
        label: '打开原始输入并定位',
      }],
      gaps: [{
        gapId: 'gap-modal-artifact',
        field: 'expected_artifact',
        severity: 'blocking',
        reasonCode: 'research_expected_artifact_missing',
        question: '预期输出的调研产物是什么？',
        impact: 'acceptance',
        sourceRefIds: [],
      }],
      admission: {
        verdict: 'needs_completion',
        evaluated_at: '2026-08-22T03:00:00.000Z',
        rule_version: 'agent-admission-v1',
        input_fingerprint: 'a'.repeat(64),
        reasons: [{
          code: 'artifact_missing',
          field_or_gate: 'expected_artifact',
          message: 'Expected Artifact is required',
          recoverable: true,
          next_action: 'Add an Expected Artifact',
        }],
        permission_gate: {
          mode: 'draft',
          external_writes: [],
          requires_authorization: false,
          authorized: false,
        },
      },
      permissionGate: {
        mode: 'draft',
        external_writes: [],
        requires_authorization: false,
        authorized: false,
      },
    },
    candidateUnderstanding: {
      schemaVersion: 1,
      generationId: 'candidate-modal',
      taskType: 'research',
      suggestions: [],
      sourceRefs: [],
      gaps: [],
    },
  } as unknown as PreparedTaskBrief;
}

describe('TaskBriefModal', () => {
  it('renders the shared candidate projection and saves a draft revision through the candidate command', async () => {
    const save = vi.fn(async () => ({} as never));
    const saveCandidate = vi.fn(async () => candidatePrepared().candidateInspector!);
    const modal = new TaskBriefModal(
      {} as never,
      { save, saveCandidate } as never,
      candidatePrepared(),
    );
    modal.open();

    expect(textArea(modal, '任务标题').value).toBe('梳理任务面板字段');
    expect(textArea(modal, '预期 Artifact').value).toBe('');
    expect(modal.contentEl.textContent).toContain('来源事实');
    expect(modal.contentEl.textContent).toContain('AI 推断');
    expect(modal.contentEl.textContent).toContain('信息缺失');
    expect(modal.contentEl.textContent).toContain('fixtures/modal.md');
    expect(modal.contentEl.textContent).toContain('梳理任务面板字段并形成可评审字段方案');
    expect(modal.contentEl.textContent).toContain('预期输出的调研产物是什么？');
    expect(modal.contentEl.textContent).toContain('artifact_missing');
    expect(modal.contentEl.textContent).toContain('确认任务理解不等于 Agent 授权');
    expect(button(modal, '打开原始输入并定位')).toBeDefined();

    textArea(modal, '预期 Artifact').value = '字段取舍清单';
    textArea(modal, '预期 Artifact').dispatchEvent(new Event('input'));
    button(modal, '保存候选草稿').click();

    await vi.waitFor(() => expect(saveCandidate).toHaveBeenCalledWith(
      'task-synthetic-brief',
      {
      understanding: expect.objectContaining({ generationId: 'candidate-modal' }),
      expectedRevision: 2,
      expectedTaskUpdatedAt: '2026-08-22T03:00:00.000Z',
      confirm: false,
      values: expect.objectContaining({ expected_artifact: '字段取舍清单' }),
      },
    ));
    expect(save).not.toHaveBeenCalled();
  });

  it('opens an available source through the controller and keeps a recovery action for failures', async () => {
    const openSource = vi.fn(async () => ({
      actionId: 'open_source' as const,
      outcome: 'located' as const,
      sourceRefId: 'source-modal',
      locator: { sourceNote: 'fixtures/modal.md', anchor: 'line:4' },
    }));
    const modal = new TaskBriefModal(
      {} as never,
      { save: vi.fn(), saveCandidate: vi.fn(), openSource } as never,
      candidatePrepared(),
    );
    modal.open();

    button(modal, '打开原始输入并定位').click();

    await vi.waitFor(() => expect(openSource).toHaveBeenCalledWith(
      'task-synthetic-brief',
      'source-modal',
    ));
    expect(modal.contentEl.textContent).toContain('已打开原始输入并定位');

    const failed = candidatePrepared();
    failed.candidateInspector!.sourceRefs[0]!.status = 'unavailable';
    failed.candidateInspector!.sourceRefs[0]!.failureReason = 'source_not_found';
    failed.candidateInspector!.sourceActions[0]!.intent = 'recover';
    failed.candidateInspector!.sourceActions[0]!.label = '重新定位来源';
    const recoveryModal = new TaskBriefModal(
      {} as never,
      { save: vi.fn(), saveCandidate: vi.fn(), openSource } as never,
      failed,
    );
    recoveryModal.open();
    expect(button(recoveryModal, '重新定位来源')).toBeDefined();
  });

  it('atomically rebuilds source actions when AI regeneration replaces source refs', async () => {
    const prepared = candidatePrepared();
    const current = prepared.candidateInspector!;
    const regeneratedSource = {
      ...current.sourceRefs[0]!,
      sourceRefId: 'source-regenerated',
      sourceNote: 'fixtures/regenerated.md',
      quote: '重新生成后的有限来源引用。',
      lastVerifiedEvidence: {
        ...current.sourceRefs[0]!.lastVerifiedEvidence!,
        resolvedNote: 'fixtures/regenerated.md',
      },
    };
    const regenerated = {
      schemaVersion: 1 as const,
      generationId: 'candidate-regenerated',
      taskType: 'research' as const,
      suggestions: current.suggestions.map((suggestion) => ({
        ...suggestion,
        generationId: 'candidate-regenerated',
        sourceRefIds: suggestion.attribution === 'source_fact'
          ? ['source-regenerated']
          : [],
      })),
      sourceRefs: [regeneratedSource],
      gaps: [],
    };
    const openSource = vi.fn(async () => ({
      actionId: 'open_source' as const,
      outcome: 'located' as const,
      sourceRefId: 'source-regenerated',
      locator: { sourceNote: 'fixtures/regenerated.md', anchor: 'line:4' },
    }));
    const modal = new TaskBriefModal(
      {} as never,
      { save: vi.fn(), saveCandidate: vi.fn(), openSource } as never,
      prepared,
      vi.fn(async () => regenerated),
    );
    modal.open();

    button(modal, '开始智能完善').click();

    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('fixtures/regenerated.md'));
    expect(modal.contentEl.textContent).not.toContain('fixtures/modal.md');
    button(modal, '打开原始输入并定位').click();
    await vi.waitFor(() => expect(openSource).toHaveBeenCalledWith(
      'task-synthetic-brief',
      'source-regenerated',
    ));
    expect(openSource).not.toHaveBeenCalledWith('task-synthetic-brief', 'source-modal');
  });

  it('keeps candidate edits usable after a revision conflict or unavailable AI', async () => {
    const conflict = Object.assign(new Error('private conflict detail'), { code: 'task_conflict' });
    const saveCandidate = vi.fn(async () => Promise.reject(conflict));
    const generate = vi.fn(async () => Promise.reject(new Error('private provider detail')));
    const modal = new TaskBriefModal(
      {} as never,
      { save: vi.fn(), saveCandidate } as never,
      candidatePrepared(),
      generate,
    );
    modal.open();

    textArea(modal, '下一步动作').value = '人工保留的下一步';
    textArea(modal, '下一步动作').dispatchEvent(new Event('input'));
    button(modal, '开始智能完善').click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('AI 暂时无法生成'));
    expect(textArea(modal, '下一步动作').value).toBe('人工保留的下一步');

    button(modal, '保存候选草稿').click();
    await vi.waitFor(() => expect(modal.contentEl.textContent).toContain('任务刚刚被其他操作修改'));
    expect(modal.contentEl.textContent).not.toContain('private conflict detail');
    expect(textArea(modal, '下一步动作').value).toBe('人工保留的下一步');
    expect(textArea(modal, '下一步动作').disabled).toBe(false);
  });

  it('enables per-field undo after an edit and restores the suggested value', () => {
    const modal = new TaskBriefModal(
      {} as never,
      { save: vi.fn(), saveCandidate: vi.fn() } as never,
      candidatePrepared(),
    );
    modal.open();

    const nextAction = textArea(modal, '下一步动作');
    const undo = nextAction.closest('.atl-candidate-field')!
      .querySelector<HTMLButtonElement>('button')!;
    expect(undo.disabled).toBe(true);

    nextAction.value = '人工修改后的下一步';
    nextAction.dispatchEvent(new Event('input'));

    expect(undo.disabled).toBe(false);
    undo.click();
    expect(textArea(modal, '下一步动作').value).toBe('逐项核对字段');
  });

  it('shows existing brief fields and saves without invoking the model or Agent', async () => {
    const save = vi.fn(async () => ({} as never));
    const generate = vi.fn(async () => ({
      objective: '模型目标',
      nextAction: '模型下一步',
      completionCriteria: '模型完成条件',
    }));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared({
        schemaVersion: 1,
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
        updatedAt: '2026-07-26T08:30:00.000Z',
      }),
      generate,
    );

    modal.open();

    expect(modal.contentEl.textContent).toContain('智能完善任务');
    expect(modal.contentEl.textContent).toContain(
      '基于已有信息智能梳理任务上下文，并通过对话与你共同补全目标、行动步骤和完成标准。',
    );
    expect(modal.contentEl.textContent).toContain('智能建议');
    expect(modal.contentEl.textContent).not.toContain('AI 帮我想清楚');
    expect(modal.contentEl.textContent).not.toContain('交给 Agent');
    expect(textArea(modal, '任务目标').value).toBe('已有目标');
    expect(textArea(modal, '下一步动作').value).toBe('已有下一步');
    expect(textArea(modal, '完成条件').value).toBe('已有完成条件');

    expect(button(modal, '开始智能完善')).toBeDefined();
    button(modal, '确认并保存').click();

    await vi.waitFor(() => expect(save).toHaveBeenCalledWith(
      'task-synthetic-brief',
      {
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
      },
      '2026-07-26T08:30:00.000Z',
    ));
    expect(generate).not.toHaveBeenCalled();
  });

  it('locks brief fields while generation or saving is in progress', async () => {
    const generated = deferred<{
      objective: string;
      nextAction: string;
      completionCriteria: string;
    }>();
    const saved = deferred<never>();
    const save = vi.fn(() => saved.promise);
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared(),
      () => generated.promise,
    );
    modal.open();

    button(modal, '开始智能完善').click();

    expect(textArea(modal, '任务目标').disabled).toBe(true);
    expect(textArea(modal, '下一步动作').disabled).toBe(true);
    expect(textArea(modal, '完成条件').disabled).toBe(true);

    generated.resolve({
      objective: '生成目标',
      nextAction: '生成下一步',
      completionCriteria: '生成完成条件',
    });
    await vi.waitFor(() => {
      expect(textArea(modal, '任务目标').value).toBe('生成目标');
    });

    button(modal, '确认并保存').click();

    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(textArea(modal, '任务目标').disabled).toBe(true);
    expect(textArea(modal, '下一步动作').disabled).toBe(true);
    expect(textArea(modal, '完成条件').disabled).toBe(true);

    saved.resolve({} as never);
    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('任务简报已保存');
    });
  });

  it('fills all fields from AI and keeps them editable when generation fails', async () => {
    const save = vi.fn(async () => ({} as never));
    const generate = vi.fn()
      .mockResolvedValueOnce({
        objective: '生成目标',
        nextAction: '生成下一步',
        completionCriteria: '生成完成条件',
      })
      .mockRejectedValueOnce(new Error('private provider detail'));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared(),
      generate,
    );
    modal.open();

    button(modal, '开始智能完善').click();
    await vi.waitFor(() => {
      expect(textArea(modal, '任务目标').value).toBe('生成目标');
    });
    expect(textArea(modal, '下一步动作').value).toBe('生成下一步');
    expect(textArea(modal, '完成条件').value).toBe('生成完成条件');

    textArea(modal, '下一步动作').value = '人工修改后的下一步';
    textArea(modal, '下一步动作').dispatchEvent(new Event('input'));
    button(modal, '开始智能完善').click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('AI 暂时无法生成');
    });
    expect(modal.contentEl.textContent).not.toContain('private provider detail');
    expect(textArea(modal, '下一步动作').value).toBe('人工修改后的下一步');
    expect(button(modal, '确认并保存').disabled).toBe(false);
  });

  it('reports success when the brief was saved but the task index is stale', async () => {
    const staleIndexError = Object.assign(new Error('private index detail'), {
      code: 'task_saved_index_stale',
    });
    const save = vi.fn(async () => Promise.reject(staleIndexError));
    const modal = new TaskBriefModal(
      {} as never,
      { save } as never,
      prepared({
        schemaVersion: 1,
        objective: '已有目标',
        nextAction: '已有下一步',
        completionCriteria: '已有完成条件',
        updatedAt: '2026-07-26T08:30:00.000Z',
      }),
    );
    modal.open();

    button(modal, '确认并保存').click();

    await vi.waitFor(() => {
      expect(modal.contentEl.textContent).toContain('任务简报已保存');
    });
    expect(modal.contentEl.textContent).toContain('任务索引暂未刷新');
    expect(modal.contentEl.textContent).not.toContain('private index detail');
  });
});
