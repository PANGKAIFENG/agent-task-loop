// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectBoardPage } from '../../../src/ui/pages/ProjectBoardPage.js';

const PROJECT_ID = 'project-alpha';

interface BoardTask {
  taskId: string;
  title: string;
  status: string;
  origin: string;
  priority: 'urgent' | 'high' | 'normal' | 'low';
  actionRequest?: {
    actionId: string;
    eventId: string;
    type: 'needs_decision' | 'blocked' | 'failed' | 'release_candidate_ready';
    status: 'pending' | 'handled' | 'superseded';
    title: string;
    summary: string;
    allowedActions: string[];
    multicaIssue: string;
    githubPr: string | null;
    headSha: string | null;
    notificationId: string | null;
  } | null;
}

function boardTask(overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    taskId: 'task-1',
    title: 'Ship the action roundtrip',
    status: 'waiting_for_decision',
    origin: 'test',
    priority: 'normal',
    actionRequest: null,
    ...overrides,
  };
}

function pendingRequest(
  type: NonNullable<BoardTask['actionRequest']>['type'],
): NonNullable<BoardTask['actionRequest']> {
  const eventId = `evt-${type}`;
  return {
    actionId: `action:task-1:${eventId}`,
    eventId,
    type,
    status: 'pending',
    title: '需要处理',
    summary: '安全摘要',
    allowedActions: type === 'release_candidate_ready'
      ? ['approve', 'rework', 'block', 'cancel']
      : ['rework', 'block', 'cancel'],
    multicaIssue: 'TEP-42',
    githubPr: null,
    headSha: null,
    notificationId: null,
  };
}

function mockBoardApi(tasks: BoardTask[]) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === '/api/projects') {
      return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ projects: [{ projectId: PROJECT_ID, name: '个人工作台' }] }),
      } as unknown as Response;
    }
    if (pathname.startsWith('/api/projects/')) {
      return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ tasks }),
      } as unknown as Response;
    }
    return { ok: false, status: 404, json: vi.fn() } as unknown as Response;
  });
}

function renderBoard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ProjectBoardPage projectId={PROJECT_ID} navigate={() => undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', `/projects/${PROJECT_ID}`);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('project board action signals (PAW-GOAL-003 T2)', () => {
  it('renders the waiting_for_decision column with the decision signal and issue', async () => {
    mockBoardApi([boardTask({ actionRequest: pendingRequest('needs_decision') })]);
    renderBoard();

    expect(await screen.findByRole('heading', { name: '待决策' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('需要决策')).toBeTruthy();
    });
    expect(screen.getByText('TEP-42')).toBeTruthy();
    expect(screen.getByText('Ship the action roundtrip')).toBeTruthy();
  });

  it.each([
    ['blocked', '需要处理·阻塞'],
    ['failed', '需要处理·失败'],
    ['release_candidate_ready', 'RC 待验收'],
  ] as const)('renders the %s action signal on the card', async (type, label) => {
    const status = type === 'release_candidate_ready' ? 'review' : 'blocked';
    mockBoardApi([boardTask({ status, actionRequest: pendingRequest(type) })]);
    renderBoard();

    await waitFor(() => {
      expect(screen.getByText(label)).toBeTruthy();
    });
    expect(screen.getByText('TEP-42')).toBeTruthy();
  });

  it('keeps ordinary tasks signal-free and hides handled action requests', async () => {
    mockBoardApi([
      boardTask({ taskId: 'task-plain', title: '普通开发任务', status: 'agent_executable', actionRequest: null }),
      boardTask({
        taskId: 'task-handled',
        title: '已处理的决策任务',
        status: 'waiting_for_decision',
        actionRequest: { ...pendingRequest('needs_decision'), status: 'handled' },
      }),
    ]);
    renderBoard();

    await waitFor(() => {
      expect(screen.getByText('普通开发任务')).toBeTruthy();
      expect(screen.getByText('已处理的决策任务')).toBeTruthy();
    });
    // A handled action_request no longer surfaces a "needs me" signal.
    await waitFor(() => {
      expect(screen.queryByText('需要决策')).toBeNull();
    });
  });
});
