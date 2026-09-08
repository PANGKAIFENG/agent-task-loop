/* @vitest-environment jsdom */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type {
  MulticaDispatchConnector,
  MulticaEnsureIssueResult,
} from '../../../src/connectors/multica-cli-connector.js';
import {
  ConfirmationController,
} from '../../../src/obsidian-plugin/confirmation-controller.js';
import {
  isDevelopmentDispatchEligibleMetadata,
} from '../../../src/obsidian-plugin/development-dispatch-plugin-lifecycle.js';
import { TaskConfirmationModal } from '../../../src/obsidian-plugin/confirmation-modal.js';
import { captureTask } from '../../../src/services/capture-task.js';
import {
  authorizeDevelopmentTask,
  type AuthorizeDevelopmentTaskResult,
} from '../../../src/services/authorize-development-task.js';
import {
  confirmTask,
} from '../../../src/services/confirm-task.js';
import { createProject } from '../../../src/services/create-project.js';
import {
  dispatchDevelopmentTask,
  type DispatchDevelopmentTaskDependencies,
} from '../../../src/services/dispatch-development-task.js';
import {
  createTestServiceContext,
  type TestServiceContext,
} from '../../helpers/service-context.js';

const WORKSPACE_ID = '89440e05-518e-4c7e-aa80-0afa2be21196';
const PROJECT_ID = 'b70aeddc-4a32-47ed-a288-571f5475634a';
const ISSUE_ID = '01234567-89ab-4cde-8f01-234567890abc';
const SQUAD_ID = 'acc15624-c025-4fa8-bc61-e74a1a7725c9';

const contexts: TestServiceContext[] = [];

beforeAll(() => {
  HTMLElement.prototype.empty = function empty(): void {
    this.replaceChildren();
  };
  HTMLElement.prototype.addClass = function addClass(...classes: string[]): void {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.setText = function setText(value: string): void {
    this.textContent = value;
  };
  HTMLElement.prototype.createSpan = function createSpan(options = {}): HTMLSpanElement {
    return this.createEl('span', options);
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

async function makeContext(): Promise<TestServiceContext> {
  const context = await createTestServiceContext();
  contexts.push(context);
  return context;
}

function trackingConnector(
  result: 'linked' | 'remote_write_unknown',
): MulticaDispatchConnector & { ensureIssueCalls: () => number } {
  let calls = 0;
  return {
    ensureIssueCalls: () => calls,
    ensureIssue: async () => {
      calls += 1;
      if (result === 'linked') {
        return {
          status: 'linked' as const,
          ref: { issueId: ISSUE_ID, issueIdentifier: 'TEP-42' },
          recovered: false,
          activation: { assigneeId: SQUAD_ID, runId: 'run-initial', recovered: false },
        };
      }
      return {
        status: 'remote_write_unknown' as const,
        reason: 'dispatch result could not be written back',
      };
    },
    inspect: async () => {
      throw new Error('inspect is not used by this flow');
    },
  };
}

async function confirmedDevelopmentTaskInVault(context: TestServiceContext) {
  await createProject(context.ctx, {
    projectId: 'project-agent-task-loop',
    name: 'Agent Task Loop',
    description: 'Synthetic fixture project.',
    resources: [],
  });
  const task = await captureTask(context.ctx, {
    title: 'One-click Multica dispatch entry',
    body: 'Synthetic body.',
    origin: 'synthetic_test',
    sourceDate: '2026-08-22',
    sourceNote: '/synthetic/source.md',
    sourceQuote: 'Synthetic quote.',
    sourceKey: 'synthetic:dispatch-flow-1',
    priority: 'high',
  });
  await confirmTask(context.ctx, task.taskId, {
    projectId: 'project-agent-task-loop',
    taskType: 'development',
    objective: 'Dispatch a development task from Obsidian.',
    acceptanceCriteria: ['Exactly one Multica issue per confirmation.'],
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    priority: 'high',
  });
  return context.ctx.tasks.get(task.taskId);
}

function pluginStyleDispatcher(
  context: TestServiceContext,
  dependencies: DispatchDevelopmentTaskDependencies,
): (taskId: string) => Promise<AuthorizeDevelopmentTaskResult> {
  // Mirrors main.ts createDevelopmentDispatcher: ready tasks authorize,
  // authorized tasks re-dispatch through the same service surface.
  return async (taskId: string) => {
    const task = await context.ctx.tasks.get(taskId);
    if (task.status === 'ready') {
      return authorizeDevelopmentTask(context.ctx, dependencies, taskId);
    }
    const dispatch = await dispatchDevelopmentTask(context.ctx, dependencies, taskId);
    return { task: await context.ctx.tasks.get(taskId), dispatch };
  };
}

async function openDispatchModal(
  context: TestServiceContext,
  dependencies: DispatchDevelopmentTaskDependencies,
) {
  const controller = new ConfirmationController(context.ctx);
  const prepared = await controller.prepare('task-20260714-00000001');
  const modal = new TaskConfirmationModal(
    {} as never,
    controller,
    prepared,
    undefined,
    {
      initialStep: 'contract',
      dispatch: pluginStyleDispatcher(context, dependencies),
    },
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
    [...modal.contentEl.querySelectorAll('button')]
      .find((button) => button.textContent === '确认并交给 Multica')?.click();
  };
  return { modal, acknowledge, clickDispatch };
}

async function untilHeading(modal: TaskConfirmationModal, heading: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (
    modal.contentEl.querySelector('h2')?.textContent !== heading
    && Date.now() < deadline
  ) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await predicate()) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(({ cleanup }) => cleanup()));
});

describe('UI authorization drives the existing services (PAW-GOAL-003-V0.5 D2)', () => {
  it('one click authorizes, dispatches once, and projects the bound TEP', async () => {
    const context = await makeContext();
    const task = await confirmedDevelopmentTaskInVault(context);
    const connector = trackingConnector('linked');
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };

    const { modal, acknowledge, clickDispatch } = await openDispatchModal(context, dependencies);
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    acknowledge();
    clickDispatch();
    await untilHeading(modal, '已交给 Multica');

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('已交给 Multica');
    expect(modal.contentEl.textContent).toContain('TEP-42');
    expect(connector.ensureIssueCalls()).toBe(1);

    const persisted = await context.ctx.tasks.get(task.taskId);
    expect(persisted.status).toBe('agent_executable');
    expect(persisted.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueId: ISSUE_ID,
      issueIdentifier: 'TEP-42',
    });
  });

  it('a second dispatch of the bound task resolves already_linked without a remote call', async () => {
    const context = await makeContext();
    const task = await confirmedDevelopmentTaskInVault(context);
    const connector = trackingConnector('linked');
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };
    await authorizeDevelopmentTask(context.ctx, dependencies, task.taskId);
    expect(connector.ensureIssueCalls()).toBe(1);

    const outcome = await dispatchDevelopmentTask(context.ctx, dependencies, task.taskId);
    expect(outcome).toMatchObject({ status: 'already_linked', issueIdentifier: 'TEP-42' });
    expect(connector.ensureIssueCalls()).toBe(1);
  });

  it('projects reconciling on a remote write unknown and blocks the re-dispatch entry', async () => {
    const context = await makeContext();
    const task = await confirmedDevelopmentTaskInVault(context);
    const connector = trackingConnector('remote_write_unknown');
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };

    const { modal, acknowledge, clickDispatch } = await openDispatchModal(context, dependencies);
    acknowledge();
    clickDispatch();
    await untilHeading(modal, '对账中');

    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('对账中');
    expect(modal.contentEl.textContent).not.toContain('TEP-');
    const persisted = await context.ctx.tasks.get(task.taskId);
    expect(persisted.status).toBe('agent_executable');
    expect(persisted.executionLink).toMatchObject({ dispatchState: 'remote_write_unknown' });
    expect(connector.ensureIssueCalls()).toBe(1);
    expect(isDevelopmentDispatchEligibleMetadata({
      status: 'agent_executable',
      review_state: 'confirmed',
      project_id: 'project-agent-task-loop',
      task_type: 'development',
      objective: 'Dispatch a development task from Obsidian.',
      acceptance_criteria: ['Exactly one Multica issue per confirmation.'],
      permission_profile: 'repo_delivery',
      execution_target: 'multica',
      context_refs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
      execution_link: { dispatch_state: 'remote_write_unknown' },
    })).toBe(false);
  });

  it('fail-closes a competing dispatch while the single-flight lease is live', async () => {
    const context = await makeContext();
    const task = await confirmedDevelopmentTaskInVault(context);
    const ensureIssue = Promise.withResolvers<MulticaEnsureIssueResult>();
    let calls = 0;
    const connector: MulticaDispatchConnector = {
      ensureIssue: async () => {
        calls += 1;
        return ensureIssue.promise;
      },
      inspect: async () => {
        throw new Error('inspect is not used by this flow');
      },
    };
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };

    const { modal, acknowledge, clickDispatch } = await openDispatchModal(context, dependencies);
    acknowledge();
    clickDispatch();
    await until(async () => (
      (await context.ctx.tasks.get(task.taskId)).executionLink?.dispatchState
        === 'resolving_remote'
    ));
    await until(async () => calls === 1);
    expect(calls).toBe(1);
    const leased = await context.ctx.tasks.get(task.taskId);
    expect(leased.executionLink).toMatchObject({ dispatchState: 'resolving_remote' });

    // Duplicate-dispatch protection: the fresh lease fail-closes the second
    // entry with an in_flight outcome and never touches the remote again.
    const second = await dispatchDevelopmentTask(context.ctx, dependencies, task.taskId);
    expect(second).toMatchObject({ status: 'in_flight' });
    expect(calls).toBe(1);

    ensureIssue.resolve({
      status: 'remote_write_unknown',
      reason: 'dispatch result could not be written back',
    });
    await untilHeading(modal, '对账中');
  });

  it('performs no remote write before the dispatch click', async () => {
    const context = await makeContext();
    await confirmedDevelopmentTaskInVault(context);
    const connector = trackingConnector('linked');
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };

    const { modal } = await openDispatchModal(context, dependencies);
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    expect(connector.ensureIssueCalls()).toBe(0);
  });
});

describe('UI re-dispatch of an authorized task whose dispatch failed (PRD 4.5)', () => {
  it('re-dispatches through dispatchDevelopmentTask without re-authorizing', async () => {
    const context = await makeContext();
    const confirmed = await confirmedDevelopmentTaskInVault(context);
    const failedOnce: typeof confirmed = {
      ...confirmed,
      status: 'agent_executable',
      autoExecutable: true,
      executionLink: {
        schemaVersion: 1,
        provider: 'multica',
        idempotencyKey: `atl:${confirmed.taskId}`,
        workspaceId: WORKSPACE_ID,
        projectId: PROJECT_ID,
        issueId: null,
        issueIdentifier: null,
        dispatchState: 'failed',
        remoteState: null,
        lastCommentId: null,
        lastEventId: null,
        summary: null,
        artifactRefs: [],
        lastAttemptAt: '2026-07-13T00:00:00.000Z',
        lastSyncedAt: null,
      },
    };
    await context.ctx.tasks.save(failedOnce);

    const connector = trackingConnector('linked');
    const dependencies: DispatchDevelopmentTaskDependencies = {
      connector,
      target: { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
    };
    const { modal, acknowledge, clickDispatch } = await openDispatchModal(context, dependencies);
    expect(modal.contentEl.querySelector('h2')?.textContent).toBe('Task Contract');
    acknowledge();
    clickDispatch();
    await untilHeading(modal, '已交给 Multica');

    // If this branch wrongly went through authorizeDevelopmentTask, the
    // ready-only state guard would have surfaced 投递失败/任务状态已变化.
    expect(modal.contentEl.textContent).toContain('TEP-42');
    expect(connector.ensureIssueCalls()).toBe(1);
    const persisted = await context.ctx.tasks.get(confirmed.taskId);
    expect(persisted.executionLink).toMatchObject({
      dispatchState: 'linked',
      issueIdentifier: 'TEP-42',
    });
  });
});
