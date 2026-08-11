import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeStructuredExecutor } from '../../../src/runner/claude-driver.js';
import {
  MeetingAnalysisController,
  readMeetingAnalysis,
  type MeetingAnalysisResult,
} from '../../../src/obsidian-plugin/meeting-analysis.js';
import {
  extractMeetingTranscript,
  MeetingNoteController,
  type MeetingNoteFileSystem,
} from '../../../src/obsidian-plugin/meeting-note.js';
import {
  buildMeetingAttachmentPath,
  type MeetingAttachment,
} from '../../../src/obsidian-plugin/meeting-attachment.js';
import { parseTaskDocument } from '../../../src/storage/frontmatter.js';

const EVENT_HASH = `sha256:${'c'.repeat(64)}`;
const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'c'.repeat(64)}.md`;
const MEETING_PATH = `08_Meetings/2026-07/2026-07-22-周会-${'c'.repeat(64)}.md`;
let root: string;

function eventDocument(): string {
  return [
    '---',
    'type: task',
    'title: 周会',
    'origin: dingtalk_caldav',
    `dingtalk_event_key_hash: ${EVENT_HASH}`,
    'scheduled: 2026-07-22T09:00:00+08:00',
    '---',
    '',
    '远端日程描述。',
    '',
  ].join('\n');
}

function nodeFileSystem(): MeetingNoteFileSystem {
  return {
    exists: async (path) => readFile(join(root, path)).then(() => true, () => false),
    read: async (path) => readFile(join(root, path), 'utf8'),
    ensureDirectory: async (path) => {
      await mkdir(join(root, path), { recursive: true });
    },
    create: async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, { encoding: 'utf8', flag: 'wx' });
    },
    removeIfContentMatches: async (path, expected) => {
      const fullPath = join(root, path);
      const current = await readFile(fullPath, 'utf8').catch(() => null);
      if (current !== expected) return false;
      await rm(fullPath);
      return true;
    },
    process: async (path, transform) => {
      const fullPath = join(root, path);
      const next = transform(await readFile(fullPath, 'utf8'));
      await writeFile(fullPath, next, 'utf8');
      return next;
    },
    listMarkdownFiles: async (path) => {
      try {
        const entries = await readdir(join(root, path), {
          recursive: true,
          withFileTypes: true,
        });
        const base = join(root, path);
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
          .map((entry) => join(
            path,
            entry.parentPath.slice(base.length + 1),
            entry.name,
          ));
      } catch {
        return [];
      }
    },
  };
}

function referenceAttachment(includeInAnalysis = true): MeetingAttachment {
  return {
    id: `sha256:${'d'.repeat(64)}`,
    name: 'synthetic-reference.md',
    path: `08_Meetings/2026-07/attachments/${'c'.repeat(64)}/${'d'.repeat(12)}-synthetic-reference.md`,
    mediaType: 'text/markdown',
    size: 32,
    role: 'reference',
    analyzable: true,
    includeInAnalysis,
  };
}

function analysisResult(): MeetingAnalysisResult {
  return {
    summary: '团队确认周五提交方案。',
    conclusions: ['本周先完成方案'],
    taskCandidates: [{
      title: '周五提交方案',
      explanation: '李四承诺提交。',
      priority: 'normal',
      sourceName: '会议听记',
      sourceQuote: '李四：周五提交。',
    }],
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atl-meeting-note-'));
  await mkdir(dirname(join(root, EVENT_PATH)), { recursive: true });
  await writeFile(join(root, EVENT_PATH), eventDocument(), 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('MeetingNoteController', () => {
  it('creates a meeting note in a temporary Vault without changing the event', async () => {
    const controller = new MeetingNoteController(nodeFileSystem());
    const eventBefore = await readFile(join(root, EVENT_PATH), 'utf8');

    const result = await controller.create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['张三', '李四'],
      transcript: '张三：确认本周方案。\n李四：周五提交。',
    });

    expect(result).toEqual({
      created: true,
      path: `08_Meetings/2026-07/2026-07-22-周会-${'c'.repeat(64)}.md`,
    });
    const note = parseTaskDocument(await readFile(join(root, result.path), 'utf8'));
    expect(note.data).toMatchObject({
      type: 'meeting',
      meeting_type: 'discussion',
      participants: ['张三', '李四'],
      analysis_status: 'pending',
    });
    expect(note.body).toContain('张三：确认本周方案。');
    await expect(readFile(join(root, EVENT_PATH), 'utf8')).resolves.toBe(eventBefore);
  });

  it('updates an existing note while preserving its analysis and manual content', async () => {
    const controller = new MeetingNoteController(nodeFileSystem());
    const first = await controller.create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '第一版听记',
    });
    const existing = await readFile(join(root, first.path), 'utf8');
    await writeFile(
      join(root, first.path),
      `${existing.replace('尚未分析。', '已有分析。')}\n人工补充。\n`,
      'utf8',
    );

    const second = await controller.create({
      eventPath: EVENT_PATH,
      meetingType: 'interview',
      participants: ['新参与人'],
      transcript: '第二版听记',
      attachments: [referenceAttachment()],
    });

    expect(second).toEqual({ created: false, path: first.path });
    const preserved = await readFile(join(root, first.path), 'utf8');
    const document = parseTaskDocument(preserved);
    expect(document.data).toMatchObject({
      meeting_type: 'interview',
      participants: ['新参与人'],
      attachments: [{
        name: 'synthetic-reference.md',
        include_in_analysis: true,
      }],
    });
    expect(preserved).not.toContain('第一版听记');
    expect(preserved).toContain('第二版听记');
    expect(preserved).toContain('已有分析。');
    expect(preserved).toContain('人工补充。');
  });

  it('reuses the same event note after DingTalk changes its title and date', async () => {
    const controller = new MeetingNoteController(nodeFileSystem());
    const first = await controller.create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '原始听记',
    });
    await writeFile(join(root, EVENT_PATH), eventDocument()
      .replace('title: 周会', 'title: 周会（改期）')
      .replace('2026-07-22T09:00:00+08:00', '2026-08-03T14:00:00+08:00'), 'utf8');

    const second = await controller.create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '更新后的听记',
    });

    expect(second).toEqual({ created: false, path: first.path });
    expect(await readFile(join(root, first.path), 'utf8')).toContain('更新后的听记');
    await expect(readdir(join(root, '08_Meetings', '2026-08'))).rejects.toThrow();
  });

  it('does not create a note for an invalid source file', async () => {
    const unsafePath = 'TaskNotes/DingTalk/not-a-real-event.md';
    await writeFile(join(root, unsafePath), eventDocument(), 'utf8');
    const controller = new MeetingNoteController(nodeFileSystem());

    await expect(controller.create({
      eventPath: unsafePath,
      meetingType: 'other',
      participants: [],
      transcript: '内容',
    })).rejects.toThrow('有效的钉钉日程');
  });

  it('creates one idempotent standalone meeting note for a recording without calendar', async () => {
    const controller = new MeetingNoteController(nodeFileSystem());
    const input = {
      meetingType: 'discussion' as const,
      participants: [],
      transcript: '发言人：确认验收分类。',
      qianwen: {
        recordingId: 'recording-no-calendar',
        title: '精恭纺验收推进会议',
        createdAt: '2026-08-10T17:42:00+08:00',
        durationSeconds: 1200,
        sourceUrl: 'qianwen.com/chat/recording-no-calendar',
        summary: '确认验收分类。',
      },
    };

    const first = await controller.createStandalone(input);
    const second = await controller.createStandalone({
      ...input,
      transcript: '不应覆盖的内容',
    });

    expect(first.created).toBe(true);
    expect(second).toEqual({ created: false, path: first.path });
    const raw = await readFile(join(root, first.path), 'utf8');
    expect(raw).toContain('发言人：确认验收分类。');
    expect(raw).not.toContain('不应覆盖的内容');
  });

  it('persists analysis in its managed region while preserving the transcript', async () => {
    const transcript = '张三：确认本周方案。\n\n李四：周五提交。\n';
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['张三', '李四'],
      transcript,
    });
    const executor: ClaudeStructuredExecutor = {
      execute: vi.fn(async () => analysisResult()) as ClaudeStructuredExecutor['execute'],
    };
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor,
      modelLabel: 'synthetic-model',
      clock: () => new Date('2026-07-24T06:00:00.000Z'),
    });

    const result = await controller.analyze(meeting.path);

    expect(result).toEqual(analysisResult());
    const raw = await readFile(join(root, meeting.path), 'utf8');
    const document = parseTaskDocument(raw);
    expect(document.data).toMatchObject({
      analysis_status: 'ready_for_confirm',
      analysis_model: 'synthetic-model',
      analysis_updated_at: '2026-07-24T06:00:00.000Z',
    });
    expect(document.data.analysis_input_hash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(document.body).toContain('团队确认周五提交方案。');
    expect(document.body).toContain('周五提交方案');
    expect(extractMeetingTranscript(raw)).toBe(transcript);
    expect(readMeetingAnalysis(raw)).toMatchObject({
      status: 'ready_for_confirm',
      result: analysisResult(),
      model: 'synthetic-model',
      updatedAt: '2026-07-24T06:00:00.000Z',
    });
  });

  it('loads only selected analyzable reference attachments into the model prompt', async () => {
    const selectedText = '已选资料：需要核对周五发布范围。';
    const unselectedText = '未勾选资料不得进入模型。';
    const selected = referenceAttachment(true);
    const unselected = {
      ...referenceAttachment(false),
      id: `sha256:${createHash('sha256').update(unselectedText).digest('hex')}`,
      name: 'private-unselected.md',
      path: '',
    };
    selected.id = `sha256:${createHash('sha256').update(selectedText).digest('hex')}`;
    selected.path = buildMeetingAttachmentPath(MEETING_PATH, EVENT_HASH, selected);
    unselected.path = buildMeetingAttachmentPath(MEETING_PATH, EVENT_HASH, unselected);
    await mkdir(dirname(join(root, selected.path)), { recursive: true });
    await writeFile(join(root, selected.path), selectedText, 'utf8');
    await writeFile(join(root, unselected.path), unselectedText, 'utf8');
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
      attachments: [selected, unselected],
    });
    const executor: ClaudeStructuredExecutor = {
      execute: vi.fn(async () => analysisResult()) as ClaudeStructuredExecutor['execute'],
    };
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        readBinary: async (path) => new Uint8Array(await readFile(join(root, path))),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor,
    });

    await controller.analyze(meeting.path);

    const prompt = vi.mocked(executor.execute).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain(selected.name);
    expect(prompt).toContain(selectedText);
    expect(prompt).not.toContain(unselected.name);
    expect(prompt).not.toContain(unselectedText);
  });

  it('does not persist a result when a selected attachment changes during analysis', async () => {
    const originalText = '分析开始前的资料。';
    const attachment = referenceAttachment(true);
    attachment.id = `sha256:${createHash('sha256').update(originalText).digest('hex')}`;
    attachment.path = buildMeetingAttachmentPath(MEETING_PATH, EVENT_HASH, attachment);
    await mkdir(dirname(join(root, attachment.path)), { recursive: true });
    await writeFile(join(root, attachment.path), originalText, 'utf8');
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
      attachments: [attachment],
    });
    let started!: () => void;
    let release!: () => void;
    const analysisStarted = new Promise<void>((resolve) => { started = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        readBinary: async (path) => new Uint8Array(await readFile(join(root, path))),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor: {
        execute: vi.fn(async () => {
          started();
          await waiting;
          return analysisResult();
        }) as ClaudeStructuredExecutor['execute'],
      },
    });

    const analyzing = controller.analyze(meeting.path);
    await analysisStarted;
    await writeFile(join(root, attachment.path), '分析期间被修改的资料。', 'utf8');
    release();

    await expect(analyzing).rejects.toThrow('分析输入在处理期间发生变化');
    const persisted = readMeetingAnalysis(await readFile(join(root, meeting.path), 'utf8'));
    expect(persisted.result).toBeNull();
    expect(persisted.status).toBe('failed');
  });

  it('marks analysis retryable after an executor failure without changing the transcript', async () => {
    const transcript = '原始听记必须保留。';
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'other',
      participants: [],
      transcript,
    });
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor: {
        execute: vi.fn(async () => {
          throw new Error('synthetic analysis failure');
        }),
      },
    });

    await expect(controller.analyze(meeting.path)).rejects.toThrow(
      'synthetic analysis failure',
    );

    const raw = await readFile(join(root, meeting.path), 'utf8');
    expect(parseTaskDocument(raw).data.analysis_status).toBe('failed');
    expect(extractMeetingTranscript(raw)).toBe(transcript);
  });

  it('does not rerun or overwrite an existing successful analysis', async () => {
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
    });
    const executor: ClaudeStructuredExecutor = {
      execute: vi.fn(async () => analysisResult()) as ClaudeStructuredExecutor['execute'],
    };
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor,
    });
    await controller.analyze(meeting.path);
    const analyzed = await readFile(join(root, meeting.path), 'utf8');
    await writeFile(join(root, meeting.path), `${analyzed}\n人工分析补充。\n`, 'utf8');

    await expect(controller.analyze(meeting.path)).rejects.toThrow('已经完成分析');

    expect(executor.execute).toHaveBeenCalledOnce();
    await expect(readFile(join(root, meeting.path), 'utf8'))
      .resolves.toBe(`${analyzed}\n人工分析补充。\n`);
  });

  it('replaces an existing successful analysis only after explicit reanalysis', async () => {
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
    });
    const executor: ClaudeStructuredExecutor = {
      execute: vi.fn(async () => analysisResult()) as ClaudeStructuredExecutor['execute'],
    };
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor,
    });
    await controller.analyze(meeting.path);

    await expect(controller.analyze(meeting.path, { force: true }))
      .resolves.toEqual(analysisResult());
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves edits made while the model is analyzing', async () => {
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
    });
    let analysisStarted!: () => void;
    let releaseAnalysis!: () => void;
    const started = new Promise<void>((resolve) => {
      analysisStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      releaseAnalysis = resolve;
    });
    const controller = new MeetingAnalysisController({
      fileSystem: {
        read: async (path) => readFile(join(root, path), 'utf8'),
        process: async (path, transform) => {
          const fullPath = join(root, path);
          const next = transform(await readFile(fullPath, 'utf8'));
          await writeFile(fullPath, next, 'utf8');
          return next;
        },
      },
      executor: {
        execute: vi.fn(async () => {
          analysisStarted();
          await waiting;
          return analysisResult();
        }) as ClaudeStructuredExecutor['execute'],
      },
    });

    const analyzing = controller.analyze(meeting.path);
    await started;
    const raw = await readFile(join(root, meeting.path), 'utf8');
    await writeFile(join(root, meeting.path), `${raw}\n分析期间人工补充。\n`, 'utf8');
    releaseAnalysis();
    await analyzing;

    await expect(readFile(join(root, meeting.path), 'utf8'))
      .resolves.toContain('分析期间人工补充。');
  });

  it('preserves edits made in the former final-read/write window', async () => {
    const meeting = await new MeetingNoteController(nodeFileSystem()).create({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '李四：周五提交。',
    });
    const writeWindowEdit = '\n最终读取后人工补充。\n';
    const fileSystem = {
      read: async (path: string) => readFile(join(root, path), 'utf8'),
      process: async (path: string, transform: (content: string) => string) => {
        const fullPath = join(root, path);
        const current = await readFile(fullPath, 'utf8');
        await writeFile(fullPath, `${current}${writeWindowEdit}`, 'utf8');
        const latest = await readFile(fullPath, 'utf8');
        const next = transform(latest);
        await writeFile(fullPath, next, 'utf8');
        return next;
      },
    };
    const controller = new MeetingAnalysisController({
      fileSystem,
      executor: {
        execute: vi.fn(async () => analysisResult()) as ClaudeStructuredExecutor['execute'],
      },
    });

    await controller.analyze(meeting.path);

    await expect(readFile(join(root, meeting.path), 'utf8'))
      .resolves.toContain('最终读取后人工补充。');
  });
});
