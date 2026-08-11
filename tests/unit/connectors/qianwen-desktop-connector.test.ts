import { describe, expect, it, vi } from 'vitest';

import {
  QianwenDesktopConnector,
  type QianwenAccessibilityAdapter,
  type QianwenAccessibilitySnapshot,
} from '../../../src/connectors/qianwen-desktop-connector.js';

function node(
  value: string,
  overrides: Partial<QianwenAccessibilitySnapshot['nodes'][number]> = {},
) {
  return {
    depth: 1,
    role: 'AXStaticText',
    value,
    actions: [],
    ...overrides,
  };
}

function snapshot(
  nodes: QianwenAccessibilitySnapshot['nodes'],
): QianwenAccessibilitySnapshot {
  return { status: 'ok', nodes };
}

function listSnapshot(): QianwenAccessibilitySnapshot {
  return snapshot([
    node('团队目标设定与AI产品能力建设讨论', {
      role: 'AXButton',
      identifier: 'audio-recording-row',
      actions: ['AXPress'],
    }),
    node('过期听记', {
      role: 'AXButton',
      identifier: 'audio-recording-row',
      actions: ['AXPress'],
    }),
  ]);
}

function recordingSnapshot(overrides: {
  title?: string;
  createdAt?: string;
  body?: QianwenAccessibilitySnapshot['nodes'];
} = {}): QianwenAccessibilitySnapshot {
  const title = overrides.title ?? '团队目标设定与AI产品能力建设讨论';
  const createdAt = overrides.createdAt ?? '2026-08-10 19:56';
  return snapshot([
    node(title, { role: 'AXHeading' }),
    node(`创建时间 ${createdAt}`),
    node('时长 11:41'),
    node(`https://qianwen.com/chat/${
      title === '过期听记' ? 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' : '263f970d557740e89b97e9ef9e7c3122'
    }?entry=audio_qianwen`, { role: 'AXLink' }),
    ...(overrides.body ?? [
      node('AI 纪要', { role: 'AXHeading' }),
      node('会议明确了两个月 OKR，需要写目标、指标描述和衡量标准。'),
      node('原文', { role: 'AXHeading' }),
      node('[00:01] 发言人1：先确认目标。'),
      node('[00:12] 发言人2：衡量标准需要量化。'),
    ]),
  ]);
}

function adapter(
  snapshots: QianwenAccessibilitySnapshot[],
): QianwenAccessibilityAdapter & {
  press: ReturnType<typeof vi.fn<QianwenAccessibilityAdapter['press']>>;
} {
  const queued = [...snapshots];
  return {
    snapshot: vi.fn(async () => queued.shift() ?? snapshot([])),
    press: vi.fn<QianwenAccessibilityAdapter['press']>().mockResolvedValue({ status: 'ok' }),
  };
}

describe('Qianwen desktop connector', () => {
  it('waits for each Qianwen navigation step to expose a readable page', async () => {
    const list = snapshot([
      node('录音纪要：产品评审周会', {
        actions: ['AXShowMenu', 'AXScrollToVisible'],
      }),
    ]);
    const conversation = snapshot([
      node('录音纪要：产品评审周会', {
        role: 'AXWebArea',
        url: 'https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen',
      }),
      node('产品评审周会'),
      node('创建于 '),
      node('08-10 19:56'),
    ]);
    const detail = snapshot([
      node('录音纪要：产品评审周会', {
        role: 'AXWebArea',
        url: 'https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen',
      }),
      node('产品评审周会', { role: 'AXHeading' }),
      node('创建于 '),
      node('08-10 19:56'),
      node('11:41'),
    ]);
    const original = snapshot([
      node('产品评审周会', { role: 'AXHeading' }),
      node('发言人1'),
      node('00:01'),
      node('确认本周交付。'),
    ]);
    const summary = snapshot([
      node('AI纪要', { role: 'AXButton', selected: true }),
      node('会议确认本周交付。'),
    ]);
    const accessibility = adapter([
      list,
      list,
      conversation,
      conversation,
      detail,
      detail,
      original,
      original,
      summary,
    ]);

    const result = await new QianwenDesktopConnector({
      accessibility,
      clock: () => new Date('2026-08-11T22:00:00+08:00'),
      readiness: { attempts: 3, delayMs: 0 },
    }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });

    expect(result.recordings).toEqual([expect.objectContaining({
      id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      transcript: '[00:01] 发言人1：确认本周交付。',
      summary: '会议确认本周交付。',
      transcriptComplete: true,
    })]);
  });

  it('supports the native Qianwen list prefix, split date, and separate content tabs', async () => {
    const accessibility = adapter([
      snapshot([
        node('录音纪要：产品评审周会', {
          actions: ['AXShowMenu', 'AXScrollToVisible'],
        }),
      ]),
      snapshot([
        node('录音纪要：产品评审周会', {
          role: 'AXWebArea',
          url: 'https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen',
        }),
        node('产品评审周会'),
        node('创建于 '),
        node('08-10 19:56'),
      ]),
      snapshot([
        node('录音纪要：产品评审周会', {
          role: 'AXWebArea',
          url: 'https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen',
        }),
        node('产品评审周会', { role: 'AXHeading' }),
        node('创建于 '),
        node('08-10 19:56'),
        node('11:41'),
      ]),
      snapshot([
        node('产品评审周会', { role: 'AXHeading' }),
        node('发言人1'),
        node('00:01'),
        node('确认本周交付。'),
        node('发言人2'),
        node('00:12'),
        node('验收材料已经补齐。'),
      ]),
      snapshot([
        node('AI纪要', { role: 'AXButton', selected: false }),
        node('会议确认本周交付并补齐验收材料。'),
      ]),
    ]);

    const result = await new QianwenDesktopConnector({
      accessibility,
      clock: () => new Date('2026-08-11T22:00:00+08:00'),
    }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });

    expect(result).toMatchObject({
      connectorStatus: 'connected',
      recordings: [{
        id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        title: '产品评审周会',
        createdAt: '2026-08-10T19:56:00+08:00',
        durationSeconds: 701,
        transcript: '[00:01] 发言人1：确认本周交付。\n[00:12] 发言人2：验收材料已经补齐。',
        summary: '会议确认本周交付并补齐验收材料。',
        transcriptComplete: true,
      }],
    });
    expect(accessibility.press.mock.calls.map(([title]) => title)).toEqual([
      '录音纪要：产品评审周会',
      '产品评审周会',
      '原文',
      'AI纪要',
    ]);
  });

  it('does not treat tab controls, toolbar text, or hidden transcript nodes as the AI summary', async () => {
    const detail = snapshot([
      node('产品评审周会', { role: 'AXHeading' }),
      node('创建于 08-10 19:56'),
      node('11:41'),
      node('https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen', {
        role: 'AXLink',
      }),
    ]);
    const accessibility = Object.assign(adapter([
      snapshot([node('录音纪要：产品评审周会', {
        actions: ['AXShowMenu', 'AXScrollToVisible'],
      })]),
      snapshot([
        node('录音纪要：产品评审周会', {
          role: 'AXWebArea',
          url: 'https://www.qianwen.com/chat/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?entry=audio_qianwen',
        }),
        node('产品评审周会'),
      ]),
      detail,
      snapshot([
        node('原文', { role: 'AXButton' }),
        node('发言人1'),
        node('00:01'),
        node('确认本周交付。'),
      ]),
      snapshot([
        node('原文', { role: 'AXButton' }),
        node('AI纪要', { role: 'AXButton', selected: false }),
        node('笔记', { role: 'AXButton' }),
        node('复制', { role: 'AXButton' }),
        node('会议确认本周交付并补齐验收材料。', { identifier: 'summary-content' }),
        node('发言人1', { identifier: 'hidden-original-content' }),
        node('00:01', { identifier: 'hidden-original-content' }),
        node('这段原文不能进入摘要。', { identifier: 'hidden-original-content' }),
        node('给千问发消息', { role: 'AXTextArea' }),
      ]),
    ]), {
      summarySnapshot: vi.fn(async () => snapshot([
        node('会议确认本周交付并补齐验收材料。', {
          role: 'OCRStaticText',
          hittable: true,
        }),
      ])),
    });

    const result = await new QianwenDesktopConnector({
      accessibility,
      clock: () => new Date('2026-08-11T22:00:00+08:00'),
    }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });

    expect(result.recordings).toEqual([expect.objectContaining({
      summary: '会议确认本周交付并补齐验收材料。',
    })]);
  });

  it('reads complete recording content and returns only the requested date range', async () => {
    const accessibility = adapter([
      listSnapshot(),
      recordingSnapshot(),
      recordingSnapshot({ title: '过期听记', createdAt: '2026-07-30 09:00' }),
    ]);
    const connector = new QianwenDesktopConnector({
      accessibility,
      clock: () => new Date('2026-08-11T22:00:00+08:00'),
    });

    const result = await connector.scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });

    expect(result.connectorStatus).toBe('connected');
    expect(result.recordings).toEqual([{
      id: '263f970d557740e89b97e9ef9e7c3122',
      title: '团队目标设定与AI产品能力建设讨论',
      createdAt: '2026-08-10T19:56:00+08:00',
      durationSeconds: 701,
      sourceUrl: 'https://qianwen.com/chat/263f970d557740e89b97e9ef9e7c3122?entry=audio_qianwen',
      transcript: '[00:01] 发言人1：先确认目标。\n[00:12] 发言人2：衡量标准需要量化。',
      summary: '会议明确了两个月 OKR，需要写目标、指标描述和衡量标准。',
      transcriptComplete: true,
    }]);
    expect(accessibility.press.mock.calls.map(([title]) => title)).toEqual([
      '团队目标设定与AI产品能力建设讨论',
      '过期听记',
    ]);
  });

  it('keeps an unfinished recording as waiting instead of manufacturing content', async () => {
    const accessibility = adapter([
      snapshot([node('展会物料讨论', {
        role: 'AXButton',
        identifier: 'audio-recording-row',
        actions: ['AXPress'],
      })]),
      recordingSnapshot({
        title: '展会物料讨论',
        body: [node('AI 正在生成中，请稍后查看')],
      }),
    ]);

    const result = await new QianwenDesktopConnector({ accessibility }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    });

    expect(result.recordings).toEqual([expect.objectContaining({
      transcriptComplete: false,
      transcript: '',
      summary: '',
    })]);
  });

  it.each([
    ['app_not_running', 'incompatible'],
    ['accessibility_denied', 'incompatible'],
    ['login_required', 'login_required'],
    ['network_failed', 'network_failed'],
  ] as const)('maps native %s to connector %s', async (nativeStatus, connectorStatus) => {
    const accessibility = adapter([{ status: nativeStatus, nodes: [] }]);

    await expect(new QianwenDesktopConnector({ accessibility }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    })).resolves.toMatchObject({ connectorStatus, recordings: [] });
  });

  it('reports a changed page structure as incompatible rather than an empty scan', async () => {
    const accessibility = adapter([snapshot([
      node('千问'),
      node('AI 办公助手'),
    ])]);

    await expect(new QianwenDesktopConnector({ accessibility }).scan({
      startDate: '2026-08-05',
      endDate: '2026-08-11',
    })).resolves.toMatchObject({
      connectorStatus: 'incompatible',
      recordings: [],
    });
  });
});
