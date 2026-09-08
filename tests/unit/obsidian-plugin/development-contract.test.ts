import { describe, expect, it } from 'vitest';

import type { Task } from '../../../src/domain/task.js';
import {
  contractGaps,
  contextRefGapMessages,
  isContractDispatchable,
  REPO_DELIVERY_GAP,
} from '../../../src/obsidian-plugin/development-contract.js';

function confirmedDevelopmentTask(overrides: Partial<Task> = {}): Task {
  return {
    schemaVersion: 1,
    taskId: 'task-20260822-dev00001',
    title: 'One-click Multica dispatch entry',
    body: '',
    status: 'ready',
    reviewState: 'confirmed',
    projectId: 'project-agent-task-loop',
    taskType: 'development',
    objective: 'Dispatch a development task from Obsidian',
    acceptanceCriteria: ['Exactly one Multica issue per confirmation'],
    autoExecutable: false,
    permissionProfile: 'repo_delivery',
    executionTarget: 'multica',
    contextRefs: ['docs/TECH/PAW-GOAL-003-multica-execution-bridge-v0.4.md'],
    origin: 'test',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: null,
    sourceKey: 'test:contract-gaps-1',
    possibleDuplicateIds: [],
    priority: 'normal',
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

describe('contractGaps (PAW-GOAL-003-V0.5 D1)', () => {
  it('is empty for a complete, acknowledged development task', () => {
    expect(contractGaps(confirmedDevelopmentTask(), true)).toEqual([]);
    expect(isContractDispatchable(confirmedDevelopmentTask(), true)).toBe(true);
  });

  it('adds the permission gap when the declaration is unacknowledged', () => {
    const gaps = contractGaps(confirmedDevelopmentTask(), false);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      source: REPO_DELIVERY_GAP,
      message: '权限声明未确认：请勾选 repo_delivery 授权说明',
    });
    expect(isContractDispatchable(confirmedDevelopmentTask(), false)).toBe(false);
  });

  it('maps service admission gaps to specific actionable messages', () => {
    const gaps = contractGaps(confirmedDevelopmentTask({
      objective: null,
      contextRefs: [],
    }), true);
    expect(gaps.map(({ message }) => message)).toEqual([
      '请填写任务目标',
      '至少添加一条执行工作区内的仓库相对路径引用',
    ]);
  });

  it('keeps service gaps visible instead of hiding them', () => {
    const gaps = contractGaps(confirmedDevelopmentTask({
      executionTarget: null,
    }), true);
    expect(gaps).toEqual([
      { source: 'executionTarget must be multica', message: '执行目标必须是 Multica' },
    ]);
  });

  it('localizes absolute-path refs with the offending entry', () => {
    const messages = contextRefGapMessages(['/private/notes.md']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('/private/notes.md');
    expect(messages[0]).toContain('绝对路径');
  });
});
