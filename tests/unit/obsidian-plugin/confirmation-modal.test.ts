/* @vitest-environment jsdom */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { TaskConfirmationModal } from '../../../src/obsidian-plugin/confirmation-modal.js';

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.createSpan = function createSpan(options = {}): HTMLSpanElement {
    return this.createEl('span', options);
  };
  HTMLElement.prototype.setText = function setText(value: string): void {
    this.textContent = value;
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
    for (const [name, value] of Object.entries(info.attr ?? {})) {
      if (value !== null) element.setAttribute(name, String(value));
    }
    this.append(element);
    callback?.(element);
    return element;
  };
});

function prepared(status: 'inbox' | 'ready') {
  return {
    task: {
      taskId: `task-${status}`,
      title: '梳理执行上下文',
      body: '补齐目标与验收标准。',
      status,
      reviewState: status === 'inbox' ? 'candidate' : 'ready_for_confirm',
      projectId: null,
      objective: null,
      acceptanceCriteria: [],
      priority: 'normal',
    },
    projects: [],
  } as never;
}

describe('TaskConfirmationModal', () => {
  it.each([
    ['inbox', '移到待办', '项目、目标和完成条件都可以稍后补充。'],
    ['ready', '完善待办', '完整的执行上下文可继续授权给 Agent。'],
  ] as const)('renders the %s action consistently', (status, action, subtitle) => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      prepared(status),
    );

    modal.open();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe(action);
    expect(modal.contentEl.textContent).toContain(subtitle);
    expect([...modal.contentEl.querySelectorAll('button')].some((button) => (
      button.textContent === action
    ))).toBe(true);
  });
});

function developmentPreparedTask() {
  return {
    taskId: 'task-dev-0001',
    title: '支持从看板一键重建 Multica 绑定',
    body: '',
    status: 'inbox',
    reviewState: 'candidate',
    projectId: 'agent-task-loop',
    objective: null,
    acceptanceCriteria: [],
    priority: 'normal',
  };
}

function developmentPrepared() {
  return {
    task: developmentPreparedTask(),
    projects: [{ projectId: 'agent-task-loop', name: 'Agent Task Loop' }],
  } as never;
}

function confirmedDevelopmentTask(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    taskId: 'task-dev-0001',
    title: '支持从看板一键重建 Multica 绑定',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'agent-task-loop',
    taskType: 'development',
    objective: 'Rebuild the binding from the board.',
    acceptanceCriteria: ['The board restores the TEP identifier.'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:modal-dev-1',
    possibleDuplicateIds: [],
    priority: 'high',
    attempts: 0,
    claim: null,
    artifactRefs: [],
    reviewFeedback: null,
    readyAt: '2026-08-22T00:00:00.000Z',
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

function kindButton(modal: TaskConfirmationModal, label: string): HTMLButtonElement | undefined {
  return [...modal.contentEl.querySelectorAll('.atl-task-kind-option')]
    .find((button) => button.textContent === label) as HTMLButtonElement | undefined;
}

function actionButton(modal: TaskConfirmationModal, label: string): HTMLButtonElement | undefined {
  return [...modal.contentEl.querySelectorAll('button')]
    .find((button) => button.textContent === label) as HTMLButtonElement | undefined;
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

type RecordedConfirmCall = [
  string,
  {
    taskKind?: string;
    contextRefs?: string[];
    repoDeliveryAcknowledged?: boolean;
    project?: { mode: string; projectId: string };
  },
];

function confirmCalls(confirm: ReturnType<typeof vi.fn>): RecordedConfirmCall[] {
  return confirm.mock.calls as unknown as RecordedConfirmCall[];
}

describe('TaskConfirmationModal development branch (PAW-GOAL-003-V0.5 D1)', () => {
  it('defaults to the research branch without development-only fields', () => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      developmentPrepared(),
    );
    modal.open();
    const kinds = [...modal.contentEl.querySelectorAll('.atl-task-kind-option')];
    expect(kinds.map((button) => button.textContent)).toEqual(['研究任务', '开发任务']);
    expect(kindButton(modal, '研究任务')?.classList.contains('is-active')).toBe(true);
    expect(modal.contentEl.querySelector('.atl-context-refs-section')).toBeNull();
    expect(modal.contentEl.querySelector('.atl-permission-section')).toBeNull();
    expect(modal.modalEl.classList.contains('atl-task-confirmation-modal--wide')).toBe(false);
  });

  it('reveals the context refs and permission declaration when switching to development', () => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    expect(modal.contentEl.querySelector('.atl-context-refs-section')).not.toBeNull();
    expect(modal.contentEl.querySelector('.atl-permission-section')).not.toBeNull();
    expect(modal.modalEl.classList.contains('atl-task-confirmation-modal--wide')).toBe(true);
    expect(modal.contentEl.querySelector('.atl-context-ref-input')).not.toBeNull();
  });

  it('preserves shared fields across a kind switch and resets the acknowledgement', () => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    const objective = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="例如：梳理产品定位"]',
    );
    setValue(objective!, 'Rebuild the binding.');
    const ref = modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input');
    setValue(ref!, 'docs/TECH/bridge.md');
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-permission-section input[type="checkbox"]',
    );
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));

    kindButton(modal, '研究任务')?.click();
    expect(modal.contentEl.querySelector('.atl-context-refs-section')).toBeNull();

    kindButton(modal, '开发任务')?.click();
    const objectiveAfter = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="例如：梳理产品定位"]',
    );
    const refAfter = modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input');
    const checkboxAfter = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-permission-section input[type="checkbox"]',
    );
    expect(objectiveAfter?.value).toBe('Rebuild the binding.');
    expect(refAfter?.value).toBe('docs/TECH/bridge.md');
    expect(checkboxAfter?.checked).toBe(false);
  });

  it('keeps the research flow single-step: confirm closes without a contract step', async () => {
    const confirm = vi.fn(async () => confirmedDevelopmentTask({ taskType: 'research' }));
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm } as never,
      developmentPrepared(),
    );
    modal.open();
    actionButton(modal, '移到待办')?.click();
    await flushAsync();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirmCalls(confirm)[0]?.[1]).toMatchObject({ taskKind: 'research' });
    expect(modal.contentEl.children).toHaveLength(0);
  });

  it('submits the development contract fields and enters the Contract step', async () => {
    const confirm = vi.fn(async () => confirmedDevelopmentTask());
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder^="例如：梳理产品定位"]',
      )!,
      'Rebuild the binding.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="验收标准 1"]')!,
      'The board restores the TEP identifier.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input')!,
      'docs/TECH/bridge.md',
    );
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-permission-section input[type="checkbox"]',
    );
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));

    actionButton(modal, '确认任务')?.click();
    await flushAsync();

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirmCalls(confirm)[0]?.[1]).toMatchObject({
      taskKind: 'development',
      contextRefs: ['docs/TECH/bridge.md'],
      repoDeliveryAcknowledged: true,
      project: { mode: 'existing', projectId: 'agent-task-loop' },
    });
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    const labels = [...modal.contentEl.querySelectorAll('.atl-task-brief-summary-row dt')]
      .map((element) => element.textContent);
    expect(labels).toEqual(['目标', '验收标准', '项目', '上下文引用', '权限范围', '执行目标']);
    expect(actionButton(modal, '确认并交给 Multica')?.disabled).toBe(false);
  });

  it('keeps the dispatch button disabled and lists gaps for an out-of-bounds persisted ref', async () => {
    const confirm = vi.fn(async () => confirmedDevelopmentTask({
      contextRefs: ['/Users/linctex/private/客户排期.xlsx'],
    }));
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder^="例如：梳理产品定位"]',
      )!,
      'Rebuild the binding.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="验收标准 1"]')!,
      'The board restores the TEP identifier.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input')!,
      'docs/TECH/bridge.md',
    );
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-permission-section input[type="checkbox"]',
    );
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    actionButton(modal, '确认任务')?.click();
    await flushAsync();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    const gaps = [...modal.contentEl.querySelectorAll('.atl-gap-item')]
      .map((item) => item.textContent);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('绝对路径');
    expect(actionButton(modal, '确认并交给 Multica')?.disabled).toBe(true);
  });

  it('disables dispatch for an unacknowledged contract and recovers when checked there', async () => {
    const confirm = vi.fn(async () => confirmedDevelopmentTask());
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder^="例如：梳理产品定位"]',
      )!,
      'Rebuild the binding.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="验收标准 1"]')!,
      'The board restores the TEP identifier.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input')!,
      'docs/TECH/bridge.md',
    );
    actionButton(modal, '确认任务')?.click();
    await flushAsync();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    const gaps = [...modal.contentEl.querySelectorAll('.atl-gap-item')]
      .map((item) => item.textContent);
    expect(gaps).toEqual(['权限声明未确认：请勾选 repo_delivery 授权说明']);
    expect(actionButton(modal, '确认并交给 Multica')?.disabled).toBe(true);

    const contractCheckbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-contract-permission input[type="checkbox"]',
    );
    contractCheckbox!.checked = true;
    contractCheckbox!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(modal.contentEl.querySelector('.atl-gap-list')).toBeNull();
    expect(actionButton(modal, '确认并交给 Multica')?.disabled).toBe(false);
  });

  it('returns from the contract step to the form without losing fields', async () => {
    const confirm = vi.fn(async (_taskId: string, input: { objective: string }) => (
      confirmedDevelopmentTask({ objective: input.objective })
    ));
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm } as never,
      developmentPrepared(),
    );
    modal.open();
    kindButton(modal, '开发任务')?.click();
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder^="例如：梳理产品定位"]',
      )!,
      'Rebuild the binding.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLTextAreaElement>('textarea[aria-label="验收标准 1"]')!,
      'The board restores the TEP identifier.',
    );
    setValue(
      modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input')!,
      'docs/TECH/bridge.md',
    );
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-permission-section input[type="checkbox"]',
    );
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
    actionButton(modal, '确认任务')?.click();
    await flushAsync();

    actionButton(modal, '返回修改')?.click();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('确认任务');
    const reopenedObjective = modal.contentEl.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder^="例如：梳理产品定位"]',
    );
    expect(reopenedObjective?.value).toBe('Rebuild the binding.');
    expect(actionButton(modal, '确认并交给 Multica')).toBeUndefined();

    // The amendment loop must close: editing after 返回修改 re-saves the
    // declaration (amendable while no dispatch intent exists) and returns
    // to an updated Contract.
    setValue(reopenedObjective!, 'Rebuild the binding, revised.');
    actionButton(modal, '确认任务')?.click();
    await flushAsync();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    expect(modal.contentEl.textContent).toContain('Rebuild the binding, revised.');
  });
});

class FakeAdmissionError extends Error {
  readonly code: string;
  readonly errors: string[];

  constructor(errors: string[]) {
    super('not admitted');
    this.name = 'FakeAdmissionError';
    this.code = 'task_development_authorization_not_ready';
    this.errors = errors;
  }
}

function dispatchPrepared(overrides: Record<string, unknown> = {}) {
  return {
    task: confirmedDevelopmentTask({ status: 'ready', ...overrides }),
    projects: [{ projectId: 'agent-task-loop', name: 'Agent Task Loop' }],
  } as never;
}

function openDispatchModal(
  dispatch: (taskId: string) => Promise<{ task: unknown; dispatch: unknown }>,
  prepared?: unknown,
) {
  const modal = new TaskConfirmationModal(
    {} as never,
    { confirm: vi.fn(async () => ({})) } as never,
    (prepared ?? dispatchPrepared()) as never,
    undefined,
    { initialStep: 'contract', dispatch: dispatch as never },
  );
  modal.open();
  const acknowledge = () => {
    const checkbox = modal.contentEl.querySelector<HTMLInputElement>(
      '.atl-contract-permission input[type="checkbox"]',
    );
    checkbox!.checked = true;
    checkbox!.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const clickDispatch = () => {
    actionButton(modal, '确认并交给 Multica')?.click();
  };
  return { modal, acknowledge, clickDispatch };
}

describe('TaskConfirmationModal dispatch flow (PAW-GOAL-003-V0.5 D2)', () => {
  it('locks during dispatch and projects the linked TEP outcome', async () => {
    const pending = Promise.withResolvers<{ task: unknown; dispatch: unknown }>();
    const { modal, acknowledge, clickDispatch } = openDispatchModal(
      () => pending.promise,
    );
    acknowledge();
    clickDispatch();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('正在交给 Multica…');
    expect(modal.modalEl.classList.contains('atl-modal-locked')).toBe(true);
    expect(modal.contentEl.textContent).toContain('最长约 2 分钟');
    expect(actionButton(modal, '确认并交给 Multica')).toBeUndefined();

    modal.close();
    expect(modal.contentEl.children.length).toBeGreaterThan(0);

    pending.resolve({
      task: confirmedDevelopmentTask({ status: 'agent_executable' }),
      dispatch: {
        status: 'linked',
        taskId: 'task-dev-0001',
        issueId: '01234567-89ab-4cde-8f01-234567890abc',
        issueIdentifier: 'TEP-152',
        recovered: false,
      },
    });
    await flushAsync();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('已交给 Multica');
    expect(modal.contentEl.textContent).toContain('TEP-152');
    expect(modal.modalEl.classList.contains('atl-modal-locked')).toBe(false);
    expect(actionButton(modal, '完成')?.disabled).toBe(false);
  });

  it('ignores repeated clicks while a dispatch is in flight', async () => {
    const dispatch = vi.fn(() => new Promise<{ task: unknown; dispatch: unknown }>(() => {}));
    const { modal, acknowledge, clickDispatch } = openDispatchModal(dispatch);
    acknowledge();
    clickDispatch();
    clickDispatch();
    clickDispatch();
    await flushAsync();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('正在交给 Multica…');
  });

  it('routes admission gaps back to the gated contract step', async () => {
    const { modal, acknowledge, clickDispatch } = openDispatchModal(
      () => Promise.reject(new FakeAdmissionError(['objective is required'])),
    );
    acknowledge();
    clickDispatch();
    await flushAsync();

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    const gaps = [...modal.contentEl.querySelectorAll('.atl-gap-item')]
      .map((item) => item.textContent);
    expect(gaps).toEqual(['请填写任务目标']);
    expect(actionButton(modal, '确认并交给 Multica')?.disabled).toBe(true);
  });

  it.each([
    [
      {
        status: 'remote_write_unknown',
        taskId: 'task-dev-0001',
        reason: 'dispatch result could not be written back',
      },
      '对账中',
    ],
    [
      {
        status: 'in_flight',
        taskId: 'task-dev-0001',
        reason: 'dispatch already in flight',
      },
      '对账中',
    ],
  ] as const)('renders reconciling for an undecided remote fact', async (outcome, title) => {
    const { modal, acknowledge, clickDispatch } = openDispatchModal(
      () => Promise.resolve({ task: {}, dispatch: outcome }),
    );
    acknowledge();
    clickDispatch();
    await flushAsync();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe(title);
    expect(actionButton(modal, '再次投递')?.disabled).toBe(true);
    expect(modal.contentEl.textContent).not.toContain('TEP-');
  });

  it('renders the conflict state with candidates when the remote matches twice', async () => {
    const { modal, acknowledge, clickDispatch } = openDispatchModal(
      () => Promise.resolve({
        task: {},
        dispatch: {
          status: 'duplicate_conflict',
          taskId: 'task-dev-0001',
          candidateIssueIds: ['TEP-151', 'TEP-149'],
        },
      }),
    );
    acknowledge();
    clickDispatch();
    await flushAsync();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('需要人工处理');
    expect(modal.contentEl.textContent).toContain('TEP-151');
    expect(modal.contentEl.textContent).toContain('TEP-149');
    expect(actionButton(modal, '再次投递')).toBeUndefined();
  });

  it('renders the concrete failure reason with re-dispatch guidance', async () => {
    const { modal, acknowledge, clickDispatch } = openDispatchModal(
      () => Promise.resolve({
        task: {},
        dispatch: { status: 'failed', taskId: 'task-dev-0001', reason: 'multica_unreachable' },
      }),
    );
    acknowledge();
    clickDispatch();
    await flushAsync();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('投递失败');
    expect(modal.contentEl.textContent).toContain('multica_unreachable');
    expect(actionButton(modal, '稍后从命令面板重投')).toBeDefined();
  });

  it('opens the 补投 entry directly on the read-back state of a bound task', () => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      dispatchPrepared({
        status: 'agent_executable',
        executionLink: {
          schemaVersion: 1,
          provider: 'multica',
          idempotencyKey: 'atl:task-dev-0001',
          workspaceId: '89440e05-518e-4c7e-aa80-0afa2be21196',
          projectId: 'b70aeddc-4a32-47ed-a288-571f5475634a',
          issueId: '01234567-89ab-4cde-8f01-234567890abc',
          issueIdentifier: 'TEP-152',
          dispatchState: 'linked',
          remoteState: 'active',
          lastCommentId: null,
          lastEventId: null,
          summary: null,
          artifactRefs: [],
          lastAttemptAt: null,
          lastSyncedAt: '2026-08-22T15:40:00.000Z',
          activationAssigneeId: 'acc15624-c025-4fa8-bc61-e74a1a7725c9',
          activationRunId: 'run-1',
        },
      }),
      undefined,
      { initialStep: 'contract', dispatch: vi.fn() as never },
    );
    modal.open();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('已交给 Multica');
    expect(modal.contentEl.textContent).toContain('TEP-152');
  });

  it('hides 返回修改 on the contract of an already authorized task', async () => {
    const { modal } = openDispatchModal(
      () => Promise.resolve({ task: {}, dispatch: { status: 'failed', taskId: 't', reason: 'x' } }),
      dispatchPrepared({ status: 'agent_executable' }),
    );
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    expect(actionButton(modal, '返回修改')).toBeUndefined();
    expect(actionButton(modal, '稍后再投')).toBeDefined();
  });
});

describe('TaskConfirmationModal 补投 hydration (Fresh CR P2)', () => {
  it('shows the persisted context refs when returning to the form', () => {
    const modal = new TaskConfirmationModal(
      {} as never,
      { confirm: vi.fn(async () => ({})) } as never,
      dispatchPrepared({
        contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
      }),
      undefined,
      { initialStep: 'contract', dispatch: vi.fn() as never },
    );
    modal.open();
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    actionButton(modal, '返回修改')?.click();
    const ref = modal.contentEl.querySelector<HTMLInputElement>('.atl-context-ref-input');
    expect(ref?.value).toBe('docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md');
    const researchOption = kindButton(modal, '研究任务');
    expect(researchOption?.disabled).toBe(true);
    expect(kindButton(modal, '开发任务')?.disabled).toBe(false);
  });
});
