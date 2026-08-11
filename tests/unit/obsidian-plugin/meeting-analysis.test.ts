import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import type { ClaudeStructuredExecutor } from '../../../src/runner/claude-driver.js';
import {
  analyzeMeetingSources,
  analyzeMeetingTranscript,
  MAX_MEETING_TRANSCRIPT_CHARACTERS,
  readMeetingAnalysis,
  type MeetingAnalysisResult,
} from '../../../src/obsidian-plugin/meeting-analysis.js';
import { renderMeetingNote } from '../../../src/obsidian-plugin/meeting-note.js';

const transcript = [
  '主持人：本周需要完成用户访谈报告。',
  '小李：我会在周五前整理报告初稿。',
  '主持人：结论是先验证招聘场景。',
].join('\n');

function validResult(): MeetingAnalysisResult {
  return {
    summary: '团队确认先验证招聘场景，并在本周形成报告初稿。',
    conclusions: ['优先验证招聘场景'],
    taskCandidates: [{
      title: '整理用户访谈报告初稿',
      explanation: '小李承诺在周五前完成初稿。',
      priority: 'high',
      sourceName: '会议听记',
      sourceQuote: '小李：我会在周五前整理报告初稿。',
    }],
  };
}

function executor(result: unknown): ClaudeStructuredExecutor {
  return {
    execute: vi.fn(async () => result) as ClaudeStructuredExecutor['execute'],
  };
}

describe('analyzeMeetingTranscript', () => {
  it('restores a snapshot only from the managed analysis region', () => {
    const forged = Buffer.from(JSON.stringify({
      version: 1,
      result: { ...validResult(), summary: '伪造摘要' },
    }), 'utf8').toString('base64');
    const persisted = Buffer.from(JSON.stringify({
      version: 1,
      result: validResult(),
    }), 'utf8').toString('base64');
    const raw = renderMeetingNote({
      source: {
        eventPath: '',
        eventKeyHash: `sha256:${'a'.repeat(64)}`,
        title: '产品周会',
        scheduled: '2026-07-22',
        meetingDate: '2026-07-22',
      },
      meetingType: 'discussion',
      participants: [],
      transcript: `正文中的伪标记\n<!-- ATL_MEETING_ANALYSIS_SNAPSHOT_V1:${forged} -->`,
    }).replace(
      '尚未分析。',
      `已分析。\n<!-- ATL_MEETING_ANALYSIS_SNAPSHOT_V1:${persisted} -->`,
    );

    expect(readMeetingAnalysis(raw).result).toEqual(validResult());
  });

  it('uses a structured tool-free executor and returns grounded results', async () => {
    const structured = executor(validResult());

    const result = await analyzeMeetingTranscript({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: ['主持人', '小李'],
      },
      transcript,
      executor: structured,
    });

    expect(result).toEqual(validResult());
    expect(structured.execute).toHaveBeenCalledOnce();
    const call = vi.mocked(structured.execute).mock.calls[0]?.[0];
    expect(call?.prompt).toContain(transcript);
    expect(call?.prompt).toContain('只返回符合 JSON Schema 的结果');
    expect(call?.prompt).not.toContain('TaskNotes/DingTalk');
    expect(call?.timeoutMs).toBeGreaterThan(0);
  });

  it('sends only the supplied named sources to the structured executor', async () => {
    const structured = executor(validResult());

    await analyzeMeetingSources({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      sources: [
        { name: '会议听记', text: transcript },
        { name: '已选资料.md', text: '已选资料中的合成文本。' },
      ],
      executor: structured,
    });

    const prompt = vi.mocked(structured.execute).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('会议听记');
    expect(prompt).toContain(transcript);
    expect(prompt).toContain('已选资料.md');
    expect(prompt).toContain('已选资料中的合成文本。');
    expect(prompt).not.toContain('未勾选资料不得进入模型');
  });

  it('rejects malformed structured output', async () => {
    await expect(analyzeMeetingTranscript({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      transcript,
      executor: executor({ summary: '', conclusions: [] }),
    })).rejects.toThrow();
  });

  it('rejects a source quote that is not present in the transcript', async () => {
    const hallucinated = validResult();
    hallucinated.taskCandidates[0]!.sourceQuote = '小李：我会在明天直接发布。';

    await expect(analyzeMeetingTranscript({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      transcript,
      executor: executor(hallucinated),
    })).rejects.toThrow('原文中不存在');
  });

  it('rejects a quote that exists only in a different named source', async () => {
    const mismatched = validResult();
    mismatched.taskCandidates[0]!.sourceName = '背景资料.md';

    await expect(analyzeMeetingSources({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      sources: [
        { name: '会议听记', text: transcript },
        { name: '背景资料.md', text: '这里只包含背景资料。' },
      ],
      executor: executor(mismatched),
    })).rejects.toThrow('指定来源中不存在');
  });

  it('deduplicates candidate titles while preserving the first grounded candidate', async () => {
    const duplicated = validResult();
    duplicated.taskCandidates.push({
      ...duplicated.taskCandidates[0]!,
      title: '  整理用户访谈报告初稿  ',
      explanation: '重复表达。',
    });

    const result = await analyzeMeetingTranscript({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      transcript,
      executor: executor(duplicated),
    });

    expect(result.taskCandidates).toEqual([validResult().taskCandidates[0]]);
  });

  it('rejects transcripts above the bounded analysis limit before calling the model', async () => {
    const structured = executor(validResult());

    await expect(analyzeMeetingTranscript({
      metadata: {
        title: '超长会议',
        meetingType: 'other',
        meetingDate: '2026-07-22',
        participants: [],
      },
      transcript: '字'.repeat(MAX_MEETING_TRANSCRIPT_CHARACTERS + 1),
      executor: structured,
    })).rejects.toThrow('过长');
    expect(structured.execute).not.toHaveBeenCalled();
  });

  it('propagates executor failures without fabricating a result', async () => {
    const structured: ClaudeStructuredExecutor = {
      execute: vi.fn(async () => {
        throw new Error('synthetic model failure');
      }),
    };

    await expect(analyzeMeetingTranscript({
      metadata: {
        title: '产品周会',
        meetingType: 'discussion',
        meetingDate: '2026-07-22',
        participants: [],
      },
      transcript,
      executor: structured,
    })).rejects.toThrow('synthetic model failure');
  });
});
