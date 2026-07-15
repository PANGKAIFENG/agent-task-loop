// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../src/ui/App.js';

type JsonBody = Record<string, unknown>;

const emptyBodies: Record<string, JsonBody> = {
  '/api/inbox': { tasks: [] },
  '/api/review': { tasks: [] },
  '/api/projects': { projects: [] },
};

function jsonResponse(body: JsonBody, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function mockApi(overrides: Record<string, JsonBody> = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const pathname = new URL(String(input)).pathname;
    const body = overrides[pathname]
      ?? emptyBodies[pathname]
      ?? (pathname.startsWith('/api/projects/') ? { tasks: [] } : undefined);
    if (body === undefined) {
      return jsonResponse({ code: 'not_found' }, false);
    }
    return jsonResponse(body);
  });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/inbox');
  globalThis.ATL_RUNTIME_CONFIG = {
    apiBase: 'http://127.0.0.1:43110',
    token: 'test-token',
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('local task board shell', () => {
  it('shows only the task-loop primary navigation', async () => {
    mockApi();
    render(<App />);

    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(navigation.textContent).toContain('收件箱');
    expect(navigation.textContent).toContain('待验收');
    expect(navigation.textContent).toContain('项目');

    for (const forbidden of ['聊天', '自动化', '智能体', 'Skills', '小队', '用量']) {
      expect(navigation.textContent).not.toContain(forbidden);
    }
  });

  it('synchronizes primary navigation with window.location.pathname', async () => {
    mockApi();
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('link', { name: '待验收' }));
    expect(window.location.pathname).toBe('/review');
    expect(await screen.findByRole('heading', { name: '待验收' })).toBeTruthy();

    await user.click(screen.getByRole('link', { name: '项目' }));
    expect(window.location.pathname).toBe('/projects');
    expect(await screen.findByRole('heading', { name: '项目' })).toBeTruthy();

    await user.click(screen.getByRole('link', { name: '收件箱' }));
    expect(window.location.pathname).toBe('/inbox');
    expect(await screen.findByRole('heading', { name: '收件箱' })).toBeTruthy();
  });

  it.each([
    ['/inbox', '收件箱'],
    ['/review', '待验收'],
    ['/projects', '项目'],
    ['/projects/project-alpha', '项目看板'],
  ])('renders %s from pathname and keeps quick capture visible', async (pathname, heading) => {
    window.history.replaceState({}, '', pathname);
    mockApi({
      '/api/projects': {
        projects: [{
          projectId: 'project-alpha',
          name: 'Alpha',
          description: 'Synthetic project',
          resources: [],
          createdAt: '2026-07-14T08:00:00+08:00',
          updatedAt: '2026-07-14T09:00:00+08:00',
        }],
      },
    });
    render(<App />);

    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
    const capture = screen.getByRole('button', { name: '快速记录' });
    expect(capture.getAttribute('aria-disabled')).toBe('true');
  });
});

describe('page data states', () => {
  it('keeps a named loading state in the inbox content region', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    render(<App />);

    expect(screen.getByRole('status').textContent).toContain('正在载入收件箱');
  });

  it('shows the inbox empty state after a successful read', async () => {
    mockApi();
    render(<App />);

    expect(await screen.findByText('收件箱为空')).toBeTruthy();
  });

  it('shows a retryable review error without leaving the page', async () => {
    window.history.replaceState({}, '', '/review');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockResolvedValue(jsonResponse({ tasks: [] }));
    render(<App />);

    expect(await screen.findByText('无法载入待验收')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('暂无待验收任务')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('scans inbox readiness, source, duplicates, priority, and creation time', async () => {
    mockApi({
      '/api/inbox': {
        tasks: [{
          taskId: 'task-inbox-1',
          title: '整理公开资料',
          status: 'inbox',
          reviewState: 'candidate',
          projectId: null,
          taskType: null,
          objective: null,
          acceptanceCriteria: [],
          autoExecutable: false,
          permissionProfile: null,
          origin: 'obsidian_daily',
          sourceDate: '2026-07-14',
          sourceExcerpt: '一段来源摘录',
          possibleDuplicateIds: ['task-earlier'],
          priority: 'high',
          attempts: 0,
          claim: null,
          artifactSummaries: [],
          reviewFeedback: null,
          readyAt: null,
          createdAt: '2026-07-14T08:30:00+08:00',
          updatedAt: '2026-07-14T08:30:00+08:00',
        }],
      },
    });
    render(<App />);

    expect(await screen.findByText('整理公开资料')).toBeTruthy();
    expect(screen.getByText(/obsidian_daily/)).toBeTruthy();
    expect(screen.getByText('缺少 6 项')).toBeTruthy();
    expect(screen.getByText('疑似重复 1')).toBeTruthy();
    expect(screen.getByText('高')).toBeTruthy();
    expect(screen.getByText(/2026\/07\/14/)).toBeTruthy();
  });

  it('shows review summaries, acceptance mapping, evidence count, and attempt', async () => {
    window.history.replaceState({}, '', '/review');
    mockApi({
      '/api/review': {
        tasks: [{
          taskId: 'task-review-1',
          title: '核验竞品公开证据',
          status: 'review',
          reviewState: 'confirmed',
          projectId: 'project-alpha',
          taskType: 'research',
          objective: '完成证据核验',
          acceptanceCriteria: ['引用官方来源', '标注发布日期'],
          autoExecutable: true,
          permissionProfile: 'read_only_research',
          origin: 'local_board',
          sourceDate: '2026-07-14',
          sourceExcerpt: null,
          possibleDuplicateIds: [],
          priority: 'urgent',
          attempts: 2,
          claim: null,
          artifactSummaries: [{ summary: '已核验 3 个官方页面', evidenceCount: 3 }],
          reviewFeedback: null,
          readyAt: '2026-07-14T08:40:00+08:00',
          createdAt: '2026-07-14T08:30:00+08:00',
          updatedAt: '2026-07-14T09:30:00+08:00',
        }],
      },
    });
    render(<App />);

    expect(await screen.findByText('已核验 3 个官方页面')).toBeTruthy();
    expect(screen.getByText('引用官方来源')).toBeTruthy();
    expect(screen.getByText('标注发布日期')).toBeTruthy();
    expect(screen.getByText('3 条证据')).toBeTruthy();
    expect(screen.getByText('第 2 次')).toBeTruthy();
  });

  it('opens a project board with all status columns and read-only filters', async () => {
    window.history.replaceState({}, '', '/projects');
    mockApi({
      '/api/projects': {
        projects: [{
          projectId: 'project-alpha',
          name: 'Alpha 研究',
          description: 'Synthetic project',
          resources: [],
          createdAt: '2026-07-14T08:00:00+08:00',
          updatedAt: '2026-07-14T09:00:00+08:00',
        }],
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('link', { name: /打开 Alpha 研究 看板/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/project-alpha'));
    expect(await screen.findByRole('heading', { name: '项目看板' })).toBeTruthy();

    for (const status of ['待规划', '待办', '进行中', '审核中', '已完成', '已阻塞', '已取消']) {
      expect(screen.getByRole('heading', { name: status })).toBeTruthy();
    }
    for (const filter of ['项目筛选', '状态筛选', '来源筛选', '优先级筛选', '自动执行筛选']) {
      expect(screen.getByLabelText(filter)).toBeTruthy();
    }
  });
});
