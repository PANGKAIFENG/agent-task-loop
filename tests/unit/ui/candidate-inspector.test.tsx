// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CandidateInspector } from '../../../src/ui/components/CandidateInspector.js';

function projection(overrides: Record<string, unknown> = {}) {
  return {
    taskIdentity: {
      taskId: 'task-inspector-ui',
      title: '核对候选理解',
      status: 'inbox',
      reviewState: 'candidate',
      updatedAt: '2026-08-22T03:00:00.000Z',
      candidateRevision: 2,
      candidateConfirmed: false,
      autoExecutable: false,
    },
    understandingIdentity: {
      schemaVersion: 1,
      generationId: 'candidate-ui',
      taskType: 'research',
    },
    currentTaskBrief: null,
    suggestions: [
      ['title', '核对候选理解', 'source_fact', ['source-ui'], '标题来自来源事实。'],
      ['objective', '形成可评审结论', 'source_fact', ['source-ui'], '目标来自来源事实。'],
      ['next_action', '逐项核对字段', 'ai_inference', [], '这是 AI 推断。'],
      ['expected_artifact', '', 'missing', [], '当前来源无法确认。'],
      ['completion_criteria', '字段均有说明', 'ai_inference', [], '这是 AI 推断。'],
    ].map(([field, suggestedValue, attribution, sourceRefIds, reason]) => ({
      field,
      suggestedValue,
      attribution,
      sourceRefIds,
      reason,
      generationId: 'candidate-ui',
    })),
    sourceRefs: [{
      sourceRefId: 'source-ui',
      sourceType: 'synthetic_fixture',
      sourceKey: 'synthetic:ui',
      sourceNote: 'fixtures/ui.md',
      anchor: '#candidate',
      quote: '核对候选理解，形成可评审结论。',
      capturedAt: '2026-08-22T02:00:00.000Z',
      lastVerifiedAt: '2026-08-22T02:30:00.000Z',
      status: 'available',
      failureReason: null,
      parentContext: null,
      lastVerifiedEvidence: {
        resolvedNote: 'fixtures/ui.md',
        checkedCharacters: 80,
        quoteMatched: true,
        truncated: false,
      },
    }],
    sourceActions: [{
      actionId: 'open_source',
      sourceRefId: 'source-ui',
      intent: 'open',
      label: '打开原始输入并定位',
    }],
    gaps: [{
      gapId: 'gap-artifact',
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
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function renderInspector(onBack = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CandidateInspector taskId="task-inspector-ui" onBack={onBack} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.ATL_RUNTIME_CONFIG = {
    apiBase: 'http://127.0.0.1:4173',
    token: 'candidate-ui-token',
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CandidateInspector', () => {
  it('shows editable attribution, exact source evidence, gaps, and #6 admission reasons', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(projection()));
    renderInspector();

    expect(await screen.findByRole('heading', { name: '核对候选理解' })).toBeTruthy();
    expect((screen.getByLabelText('任务标题') as HTMLTextAreaElement).value)
      .toBe('核对候选理解');
    expect((screen.getByLabelText('任务目标') as HTMLTextAreaElement).value)
      .toBe('形成可评审结论');
    expect((screen.getByLabelText('预期 Artifact') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getAllByText('来源事实').length).toBeGreaterThan(0);
    expect(screen.getAllByText('AI 推断').length).toBeGreaterThan(0);
    expect(screen.getByText('信息缺失')).toBeTruthy();
    expect(screen.getByText('fixtures/ui.md')).toBeTruthy();
    expect(screen.getByText(/核对候选理解，形成可评审结论/)).toBeTruthy();
    expect(screen.getByText('预期输出的调研产物是什么？')).toBeTruthy();
    expect(screen.getByText('artifact_missing')).toBeTruthy();
    expect(screen.getByText(/确认任务理解不等于 Agent 授权/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开原始输入并定位' })).toBeTruthy();
  });

  it('locates an available source through the bounded source action', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(projection()))
      .mockResolvedValueOnce(response({
        actionId: 'open_source',
        outcome: 'located',
        sourceRefId: 'source-ui',
        locator: { sourceNote: 'fixtures/ui.md', anchor: '#candidate' },
      }));
    const user = userEvent.setup();
    renderInspector();

    await user.click(await screen.findByRole('button', { name: '打开原始输入并定位' }));

    expect(fetchMock).toHaveBeenLastCalledWith(expect.objectContaining({
      pathname: '/api/tasks/task-inspector-ui/candidate-sources/source-ui/open',
    }));
    expect(await screen.findByText(/已安全定位 fixtures\/ui\.md/)).toBeTruthy();
  });

  it('clears source recovery feedback when navigation loads a different task', async () => {
    const changedProjection = projection({
      taskIdentity: {
        ...projection().taskIdentity,
        taskId: 'task-source-changed',
        title: '来源已变化任务',
      },
      sourceRefs: [{
        ...projection().sourceRefs[0],
        sourceRefId: 'source-changed',
        status: 'changed',
        failureReason: 'source_quote_changed',
      }],
      sourceActions: [{
        actionId: 'open_source',
        sourceRefId: 'source-changed',
        intent: 'recover',
        label: '重新定位来源',
      }],
    });
    const availableProjection = projection({
      taskIdentity: {
        ...projection().taskIdentity,
        taskId: 'task-source-available',
        title: '来源可用任务',
      },
    });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(changedProjection))
      .mockResolvedValueOnce(response({
        actionId: 'open_source',
        outcome: 'recovery_required',
        sourceRefId: 'source-changed',
        locator: null,
        status: 'changed',
        failureReason: 'source_quote_changed',
      }))
      .mockResolvedValueOnce(response(availableProjection));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const user = userEvent.setup();
    const view = render(
      <QueryClientProvider client={client}>
        <CandidateInspector taskId="task-source-changed" onBack={vi.fn()} />
      </QueryClientProvider>,
    );

    await user.click(await screen.findByRole('button', { name: '重新定位来源' }));
    await waitFor(() => expect(
      document.querySelector('.source-action-message')?.textContent,
    ).toContain('source_quote_changed'));

    view.rerender(
      <QueryClientProvider client={client}>
        <CandidateInspector taskId="task-source-available" onBack={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: '来源可用任务' })).toBeTruthy();
    expect(document.querySelector('.source-action-message')).toBeNull();
  });

  it('edits and restores one field, then saves through the protected revision command', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(projection()))
      .mockResolvedValueOnce(response(projection({
        taskIdentity: {
          ...projection().taskIdentity,
          candidateRevision: 3,
          updatedAt: '2026-08-22T03:01:00.000Z',
        },
      })));
    const user = userEvent.setup();
    renderInspector();
    const nextAction = await screen.findByLabelText('下一步动作');

    await user.clear(nextAction);
    await user.type(nextAction, '人工改写动作');
    await user.click(screen.getByRole('button', { name: '撤销 下一步动作 修改' }));
    expect((nextAction as HTMLTextAreaElement).value).toBe('逐项核对字段');
    await user.clear(nextAction);
    await user.type(nextAction, '人工改写动作');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1]!;
    expect(init).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'x-atl-token': 'candidate-ui-token',
      }),
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      understanding: {
        schemaVersion: 1,
        generationId: 'candidate-ui',
        taskType: 'research',
        suggestions: projection().suggestions,
        sourceRefs: projection().sourceRefs,
        gaps: projection().gaps,
      },
      expectedRevision: 2,
      expectedTaskUpdatedAt: '2026-08-22T03:00:00.000Z',
      confirm: false,
      values: expect.objectContaining({ next_action: '人工改写动作' }),
    });
    expect(await screen.findByText('候选草稿已保存')).toBeTruthy();
  });

  it('keeps manual fields usable and asks for reload after a revision conflict', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(projection()))
      .mockResolvedValueOnce(response({
        code: 'task_conflict',
        message: 'Task conflict',
        details: null,
      }, 409));
    const user = userEvent.setup();
    renderInspector();
    const artifact = await screen.findByLabelText('预期 Artifact');

    await user.type(artifact, '人工填写的证据表');
    await user.click(screen.getByRole('button', { name: '保存草稿' }));

    expect(await screen.findByText(/候选已在其他位置更新/)).toBeTruthy();
    expect((artifact as HTMLTextAreaElement).disabled).toBe(false);
    expect((artifact as HTMLTextAreaElement).value).toBe('人工填写的证据表');
  });

  it('keeps long titles readable and explains moved, changed, unavailable, and missing sources', async () => {
    const longTitle = '核对这个包含详细背景、限定范围和预期交付的超长合成候选任务标题';
    const sourceRefs = (['moved', 'changed', 'unavailable', 'missing'] as const)
      .map((status, index) => ({
        ...projection().sourceRefs[0],
        sourceRefId: `source-${status}`,
        sourceNote: status === 'missing' ? null : `fixtures/${status}.md`,
        status,
        quote: status === 'missing' ? '' : `保留的有限引用 ${index + 1}`,
        failureReason: `source_${status}`,
        parentContext: status === 'moved' ? '批量清单的共同意图' : null,
      }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(projection({
      taskIdentity: { ...projection().taskIdentity, title: longTitle },
      sourceRefs,
      sourceActions: sourceRefs.map((source) => ({
        actionId: 'open_source',
        sourceRefId: source.sourceRefId,
        intent: source.status === 'moved' ? 'open' : 'recover',
        label: source.status === 'moved' ? '打开原始输入并定位' : '重新定位来源',
      })),
    })));
    renderInspector();

    expect(await screen.findByRole('heading', { name: longTitle })).toBeTruthy();
    for (const label of ['已移动', '内容已变化', '暂不可用', '缺失']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: '打开原始输入并定位' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '重新定位来源' })).toHaveLength(3);
    expect(screen.getByText('未保留可显示引用')).toBeTruthy();
    expect(screen.getByText(/上层上下文：批量清单的共同意图/)).toBeTruthy();
    expect(screen.getByText(/失效原因：source_changed/)).toBeTruthy();
    expect(screen.getAllByText(/最近验证：/)).toHaveLength(4);
  });

  it('shows an AI-unavailable fallback for an ungenerated candidate and keeps manual editing usable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(projection({
      taskIdentity: {
        ...projection().taskIdentity,
        candidateRevision: 0,
      },
      sourceRefs: [],
    })));
    const user = userEvent.setup();
    renderInspector();

    expect(await screen.findByText(/AI 建议当前不可用/)).toBeTruthy();
    expect(screen.getByText('当前没有有限来源引用。')).toBeTruthy();
    const artifact = screen.getByLabelText('预期 Artifact');
    await user.type(artifact, '人工填写的评审清单');
    expect((artifact as HTMLTextAreaElement).value).toBe('人工填写的评审清单');
  });
});
