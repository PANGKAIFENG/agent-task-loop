// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../../src/ui/App.js';

type JsonBody = Record<string, unknown>;

const emptyBodies: Record<string, JsonBody> = {
  '/api/dashboard': {
    observedAt: '2026-08-22T02:00:00.000Z',
    dataState: 'empty',
    stateReasons: [],
    summary: {
      weeklyResults: 0,
      candidateTasks: 0,
      agentQueue: { raw: 0, admitted: 0, quarantined: 0 },
      needsUser: 0,
      activeTasks: 0,
    },
    integrity: {
      unknownStatusTaskIds: [],
      invalidClaimLeaseTaskIds: [],
      expiredClaimTaskIds: [],
    },
    views: [
      { id: 'requires_user', label: '需要我决策', description: 'Synthetic empty view', cards: [] },
      { id: 'agent_attention', label: 'AI 阻塞与异常', description: 'Synthetic empty view', cards: [] },
      { id: 'intake', label: '等待摄入与梳理', description: 'Synthetic empty view', cards: [] },
      { id: 'important_not_urgent', label: '重要不紧急', description: 'Synthetic empty view', cards: [] },
      { id: 'weekly_insights', label: '本周结果与近期洞察', description: 'Synthetic empty view', cards: [] },
    ],
  },
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
  it('opens the dynamic dashboard at the web root without removing existing navigation', async () => {
    window.history.replaceState({}, '', '/');
    mockApi();
    render(<App />);

    expect(await screen.findByRole('heading', { name: '决策驾驶舱' })).toBeTruthy();
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    for (const label of ['驾驶舱', '收件箱', '待验收', '项目']) {
      expect(navigation.textContent).toContain(label);
    }
  });

  it('keeps candidate tasks distinct from the shared Agent queue summary', async () => {
    window.history.replaceState({}, '', '/');
    mockApi({
      '/api/dashboard': {
        ...emptyBodies['/api/dashboard']!,
        dataState: 'complete',
        summary: {
          weeklyResults: 2,
          candidateTasks: 3,
          agentQueue: { raw: 4, admitted: 2, quarantined: 2 },
          needsUser: 1,
          activeTasks: 5,
        },
      },
    });
    render(<App />);

    expect(await screen.findByText('候选任务')).toBeTruthy();
    expect(screen.getByText('3 项待人工确认')).toBeTruthy();
    expect(screen.getByText('Agent 队列')).toBeTruthy();
    expect(screen.getByText('原始 4 · 准入 2 · 隔离 2')).toBeTruthy();
  });

  it('keeps all five decision views visible when the dashboard is empty', async () => {
    window.history.replaceState({}, '', '/');
    mockApi();
    render(<App />);

    expect(await screen.findByText('当前没有需要显示的决策事项')).toBeTruthy();
    expect(screen.getAllByText('当前无事项')).toHaveLength(5);
    for (const label of ['需要我决策', 'AI 阻塞与异常', '等待摄入与梳理', '重要不紧急', '本周结果与近期洞察']) {
      expect(screen.getByRole('heading', { name: label })).toBeTruthy();
    }
  });

  it.each([
    ['partial', '数据部分缺失'],
    ['stale', '数据可能过期'],
    ['integrity', '数据完整性异常'],
  ])('surfaces the %s dashboard quality state with its reasons', async (dataState, label) => {
    window.history.replaceState({}, '', '/');
    mockApi({
      '/api/dashboard': {
        ...emptyBodies['/api/dashboard']!,
        dataState,
        stateReasons: [`Synthetic ${dataState} reason`],
      },
    });
    render(<App />);

    const state = await screen.findByLabelText('驾驶舱数据状态');
    expect(state.textContent).toContain(label);
    expect(state.textContent).toContain(`Synthetic ${dataState} reason`);
  });

  it('renders five stable decision views with explainable cards and a fact-entry action', async () => {
    window.history.replaceState({}, '', '/');
    const card = {
      cardId: 'requires_user:decision-1',
      taskId: 'decision-1',
      title: '确认合成研究结论',
      reason: { kind: 'human_confirmation', label: '候选结果等待验收' },
      source: { kind: 'fact', label: 'synthetic_fixture · 2026-08-22' },
      goalImpact: { kind: 'inference', label: 'Synthetic workstream' },
      timeliness: { observedAt: '2026-08-22T01:30:00.000Z', state: 'current', label: '24 小时内更新' },
      status: { code: 'review', label: '待验收' },
      ruleRef: 'dashboard.requires-user.review@v001',
      traceRef: 'event:synthetic-event-001',
      action: { label: '查看项目事实', href: '/projects/project-alpha' },
    };
    const views = (emptyBodies['/api/dashboard']!.views as Array<Record<string, unknown>>)
      .map((view, index) => ({ ...view, cards: index === 0 ? [card] : [] }));
    mockApi({
      '/api/dashboard': {
        ...emptyBodies['/api/dashboard']!,
        dataState: 'complete',
        views,
      },
      '/api/projects': {
        projects: [{
          projectId: 'project-alpha',
          name: 'Alpha',
          description: 'Synthetic project',
          resources: [],
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T01:00:00.000Z',
        }],
      },
    });
    render(<App />);

    for (const label of ['需要我决策', 'AI 阻塞与异常', '等待摄入与梳理', '重要不紧急', '本周结果与近期洞察']) {
      expect(await screen.findByRole('heading', { name: label })).toBeTruthy();
    }
    const decisionCard = screen.getByText('确认合成研究结论').closest('article');
    expect(decisionCard).not.toBeNull();
    const cardContent = within(decisionCard!);
    // 首屏紧凑态：只保留标题与一行轻摘要，审计元信息不可见
    const summaryButton = cardContent.getByRole('button', { name: /含待人工确认项/ });
    expect(summaryButton.getAttribute('aria-expanded')).toBe('false');
    expect(cardContent.getByText('待验收 · synthetic_fixture · 2026-08-22 · 24 小时内更新')).toBeTruthy();
    for (const hidden of ['候选结果等待验收', 'Synthetic workstream', 'dashboard.requires-user.review@v001', 'event:synthetic-event-001']) {
      expect(cardContent.queryByText(hidden)).toBeNull();
    }
    await userEvent.setup().click(summaryButton);
    expect(summaryButton.getAttribute('aria-expanded')).toBe('true');
    for (const value of [
      '候选结果等待验收',
      'synthetic_fixture · 2026-08-22',
      'Synthetic workstream',
      'dashboard.requires-user.review@v001',
      'event:synthetic-event-001',
      '待人工确认',
      '事实',
      '推断',
    ]) {
      expect(cardContent.getByText(value)).toBeTruthy();
    }
    await userEvent.setup().click(screen.getByRole('link', { name: '查看项目事实' }));
    expect(window.location.pathname).toBe('/projects/project-alpha');
    expect(await screen.findByRole('heading', { name: '项目看板' })).toBeTruthy();
  });

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
  it('shows a retryable dashboard error without leaving the page', async () => {
    window.history.replaceState({}, '', '/');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('synthetic dashboard failure'))
      .mockResolvedValue(jsonResponse(emptyBodies['/api/dashboard']!));
    render(<App />);

    expect(await screen.findByText('无法载入决策事实')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('当前没有需要显示的决策事项')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a named loading state in the dashboard content region', () => {
    window.history.replaceState({}, '', '/');
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => undefined));
    render(<App />);

    expect(screen.getByRole('status').textContent).toContain('正在汇总决策事实');
  });

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
    expect(screen.getByText('待理解')).toBeTruthy();
    expect(screen.getByText('疑似重复 1')).toBeTruthy();
    expect(screen.getByText('高')).toBeTruthy();
    expect(screen.getByText(/2026\/07\/14/)).toBeTruthy();
  });

  it('opens the shared candidate inspector from a selectable inbox row', async () => {
    mockApi({
      '/api/inbox': {
        tasks: [{
          taskId: 'task-inbox-inspector',
          title: '打开候选 inspector',
          status: 'inbox',
          reviewState: 'candidate',
          projectId: null,
          taskType: null,
          objective: null,
          acceptanceCriteria: [],
          autoExecutable: false,
          permissionProfile: null,
          origin: 'synthetic_fixture',
          sourceDate: null,
          sourceExcerpt: null,
          possibleDuplicateIds: [],
          priority: 'normal',
          attempts: 0,
          claim: null,
          artifactSummaries: [],
          reviewFeedback: null,
          readyAt: null,
          createdAt: '2026-08-22T03:00:00.000Z',
          updatedAt: '2026-08-22T03:00:00.000Z',
        }],
      },
      '/api/tasks/task-inbox-inspector/candidate-inspector': {
        taskIdentity: {
          taskId: 'task-inbox-inspector',
          title: '打开候选 inspector',
          status: 'inbox',
          reviewState: 'candidate',
          updatedAt: '2026-08-22T03:00:00.000Z',
          candidateRevision: 0,
          candidateConfirmed: false,
          autoExecutable: false,
        },
        currentTaskBrief: null,
        suggestions: [],
        sourceRefs: [],
        gaps: [],
        admission: {
          verdict: 'needs_completion',
          evaluated_at: '2026-08-22T03:00:00.000Z',
          rule_version: 'agent-admission-v1',
          input_fingerprint: 'a'.repeat(64),
          reasons: [],
          permission_gate: {
            mode: null,
            external_writes: [],
            requires_authorization: false,
            authorized: false,
          },
        },
        permissionGate: {
          mode: null,
          external_writes: [],
          requires_authorization: false,
          authorized: false,
        },
      },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /打开候选 inspector/ }));

    expect(await screen.findByRole('heading', { name: '打开候选 inspector' })).toBeTruthy();
    expect(screen.getByText(/确认任务理解不等于 Agent 授权/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '返回候选列表' }));
    expect(screen.queryByText('准入与权限')).toBeNull();
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
      '/api/projects/project-alpha/tasks': {
        tasks: [{
          taskId: 'task-custom-status',
          title: '等待外部团队回复',
          status: 'waiting_external',
          reviewState: 'confirmed',
          projectId: 'project-alpha',
          taskType: null,
          objective: null,
          acceptanceCriteria: [],
          autoExecutable: false,
          permissionProfile: null,
          origin: 'manual',
          sourceDate: null,
          sourceExcerpt: null,
          possibleDuplicateIds: [],
          priority: 'normal',
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
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('link', { name: /打开 Alpha 研究 看板/ }));
    await waitFor(() => expect(window.location.pathname).toBe('/projects/project-alpha'));
    expect(await screen.findByRole('heading', { name: '项目看板' })).toBeTruthy();

    for (const status of [
      '待规划',
      '待办',
      'Agent 待执行',
      '进行中',
      '审核中',
      '已完成',
      '已阻塞',
      '已取消',
    ]) {
      expect(screen.getByRole('heading', { name: status })).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: 'waiting_external' })).toBeTruthy();
    expect(screen.getByText('等待外部团队回复')).toBeTruthy();
    for (const filter of ['项目筛选', '状态筛选', '来源筛选', '优先级筛选']) {
      expect(screen.getByLabelText(filter)).toBeTruthy();
    }
    expect(screen.queryByLabelText('自动执行筛选')).toBeNull();
  });
});
