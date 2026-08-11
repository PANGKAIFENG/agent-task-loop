import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeStructuredExecutor } from '../../../src/runner/claude-driver.js';
import {
  MeetingAttachmentsWorkflow,
} from '../../../src/obsidian-plugin/meeting-attachments-workflow.js';
import {
  createMeetingAttachmentDraft,
  type MeetingAttachmentFileSystem,
  type MeetingAttachmentDraft,
} from '../../../src/obsidian-plugin/meeting-attachment.js';
import type { MeetingNoteFileSystem } from '../../../src/obsidian-plugin/meeting-note.js';
import {
  MeetingAnalysisAlreadyExistsError,
  type MeetingAnalysisFileSystem,
  MeetingAnalysisRetryRequiredError,
} from '../../../src/obsidian-plugin/meeting-analysis.js';
import {
  MeetingCandidateController,
} from '../../../src/obsidian-plugin/meeting-candidate-controller.js';
import {
  createObsidianServiceContext,
} from '../../../src/obsidian-plugin/service-context.js';
import {
  parseTaskDocument,
  serializeTaskDocument,
} from '../../../src/storage/frontmatter.js';
import { createVaultWriteAuthorization } from '../../../src/storage/task-paths.js';

const EVENT_PATH = `TaskNotes/DingTalk/sha256-${'f'.repeat(64)}.md`;
const EVENT_HASH = `sha256:${'f'.repeat(64)}`;
let root: string;

function eventDocument(): string {
  return [
    '---',
    'type: task',
    'title: 合成会议',
    'origin: dingtalk_caldav',
    `dingtalk_event_key_hash: ${EVENT_HASH}`,
    'scheduled: 2026-07-24T09:00:00+08:00',
    '---',
    '',
    '钉钉镜像不可修改。',
    '',
  ].join('\n');
}

function fileSystem(): MeetingNoteFileSystem & MeetingAnalysisFileSystem & MeetingAttachmentFileSystem {
  return {
    exists: async (path) => readFile(join(root, path)).then(() => true, () => false),
    read: async (path) => readFile(join(root, path), 'utf8'),
    readBinary: async (path) => new Uint8Array(await readFile(join(root, path))),
    ensureDirectory: async (path) => {
      await mkdir(join(root, path), { recursive: true });
    },
    create: async (path, content) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content, { encoding: 'utf8', flag: 'wx' });
    },
    createBinary: async (path: string, data: Uint8Array) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), data, { flag: 'wx' });
    },
    process: async (path, transform) => {
      const fullPath = join(root, path);
      const next = transform(await readFile(fullPath, 'utf8'));
      await writeFile(fullPath, next, 'utf8');
      return next;
    },
    listMarkdownFiles: async (path) => {
      let entries;
      try {
        entries = await readdir(join(root, path), {
          recursive: true,
          withFileTypes: true,
        });
      } catch {
        return [];
      }
      const base = join(root, path);
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
        .map((entry) => join(
          path,
          entry.parentPath.slice(base.length + 1),
          entry.name,
        ));
    },
  };
}

function executor(): ClaudeStructuredExecutor {
  return {
    execute: vi.fn(async () => ({
      summary: '会议确认周五提交方案。',
      conclusions: ['先完成方案'],
      taskCandidates: [{
        title: '提交方案',
        explanation: '会议中明确的行动项。',
        priority: 'normal',
        sourceName: '会议听记',
        sourceQuote: '小李：周五提交方案。',
      }],
    })) as ClaudeStructuredExecutor['execute'],
  };
}

async function draft(
  name: string,
  role: 'transcript' | 'reference',
  text: string,
): Promise<MeetingAttachmentDraft> {
  return createMeetingAttachmentDraft({
    name,
    mediaType: 'text/markdown',
    data: new TextEncoder().encode(text),
    role,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atl-meeting-workflow-'));
  await mkdir(dirname(join(root, EVENT_PATH)), { recursive: true });
  await writeFile(join(root, EVENT_PATH), eventDocument(), 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('MeetingAttachmentsWorkflow', () => {
  it('treats a v0.6.0 markdown-only analysis as stale and allows explicit reanalysis', async () => {
    const model = executor();
    const storage = fileSystem();
    const workflow = new MeetingAttachmentsWorkflow({ fileSystem: storage, executor: model });
    const analyzed = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'analyze',
    });
    await storage.process(analyzed.meetingPath, (content) => {
      const document = parseTaskDocument(content);
      const data = { ...document.data };
      delete data.analysis_input_hash;
      delete data.analysis_model;
      delete data.analysis_updated_at;
      return serializeTaskDocument(
        data,
        document.body.replace(
          /\n<!-- ATL_MEETING_ANALYSIS_SNAPSHOT_V1:[A-Za-z0-9+/=]+ -->/u,
          '',
        ),
      );
    });

    const legacy = await workflow.load(EVENT_PATH);
    expect(legacy?.analysis).toMatchObject({ status: 'stale', result: null });
    expect(await readFile(join(root, analyzed.meetingPath), 'utf8'))
      .toContain('会议确认周五提交方案。');

    await expect(workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'retry',
    })).resolves.toMatchObject({
      analysis: { status: 'ready_for_confirm' },
    });
    expect(vi.mocked(model.execute)).toHaveBeenCalledTimes(2);
  });

  it('treats a corrupt analysis snapshot as stale and allows explicit reanalysis', async () => {
    const model = executor();
    const storage = fileSystem();
    const workflow = new MeetingAttachmentsWorkflow({ fileSystem: storage, executor: model });
    const analyzed = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'analyze',
    });
    await storage.process(analyzed.meetingPath, (content) => content.replace(
      /ATL_MEETING_ANALYSIS_SNAPSHOT_V1:[A-Za-z0-9+/=]+/u,
      'ATL_MEETING_ANALYSIS_SNAPSHOT_V1:not-valid-base64',
    ));

    const corrupt = await workflow.load(EVENT_PATH);
    expect(corrupt?.analysis).toMatchObject({ status: 'stale', result: null });
    await expect(workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'retry',
    })).resolves.toMatchObject({
      analysis: { status: 'ready_for_confirm' },
    });
    expect(vi.mocked(model.execute)).toHaveBeenCalledTimes(2);
  });

  it('opens with a missing selected attachment and can remove it before reanalysis', async () => {
    const selected = {
      ...await draft('selected.md', 'reference', '选中的资料支持周五提交。'),
      includeInAnalysis: true,
    };
    const model = executor();
    const storage = fileSystem();
    const workflow = new MeetingAttachmentsWorkflow({ fileSystem: storage, executor: model });
    const analyzed = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [selected],
      action: 'analyze',
    });
    const attachmentPath = analyzed.attachments[0]?.path;
    expect(attachmentPath).toBeDefined();
    await unlink(join(root, attachmentPath!));

    const missing = await workflow.load(EVENT_PATH);
    expect(missing?.analysis.status).toBe('stale');
    expect(missing?.analysis.result?.summary).toBe('会议确认周五提交方案。');
    expect(missing?.form.attachments).toMatchObject([{
      name: 'selected.md',
      unavailableReason: '附件文件已丢失或无法读取',
    }]);

    await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'save',
    });
    await expect(workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [],
      action: 'retry',
    })).resolves.toMatchObject({
      analysis: { status: 'ready_for_confirm' },
      attachments: [],
    });
  });

  it('promotes duplicate content from reference metadata to the transcript role', async () => {
    const storage = fileSystem();
    const workflow = new MeetingAttachmentsWorkflow({
      fileSystem: storage,
      executor: executor(),
    });
    const reference = await draft('shared.md', 'reference', '同一份合成内容。');
    await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '手工听记。',
      attachments: [reference],
      action: 'save',
    });
    const existing = await workflow.load(EVENT_PATH);
    expect(existing?.form.attachments[0]?.role).toBe('reference');

    const transcriptDraft = await draft('shared.md', 'transcript', '同一份合成内容。');
    await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '同一份合成内容。',
      attachments: [...(existing?.form.attachments ?? []), transcriptDraft],
      action: 'save',
    });

    const updated = await workflow.load(EVENT_PATH);
    expect(updated?.form.attachments).toMatchObject([{
      id: reference.id,
      role: 'transcript',
      includeInAnalysis: true,
    }]);
  });

  it('marks a restored result stale and allows retry when a selected local attachment changed', async () => {
    const model = executor();
    const selected = {
      ...await draft('selected.md', 'reference', '选中的资料支持周五提交。'),
      includeInAnalysis: true,
    };
    const workflow = new MeetingAttachmentsWorkflow({
      fileSystem: fileSystem(),
      executor: model,
    });
    const analyzed = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: [selected],
      action: 'analyze',
    });
    const attachmentPath = analyzed.attachments[0]?.path;
    expect(attachmentPath).toBeDefined();
    await writeFile(join(root, attachmentPath!), '附件内容已变化。', 'utf8');

    const restored = await workflow.load(EVENT_PATH);
    expect(restored?.analysis.status).toBe('stale');
    expect(restored?.analysis.result?.summary).toBe('会议确认周五提交方案。');

    const retried = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: [],
      transcript: '小李：周五提交方案。',
      attachments: analyzed.attachments,
      action: 'retry',
    });
    expect(retried.analysis.status).toBe('ready_for_confirm');
    expect(vi.mocked(model.execute)).toHaveBeenCalledTimes(2);
    await expect(workflow.load(EVENT_PATH)).resolves.toMatchObject({
      analysis: { status: 'ready_for_confirm' },
    });
  });

  it('stores selected materials, analyzes only them and restores a result with candidates', async () => {
    const selected = {
      ...await draft('selected.md', 'reference', '选中的资料支持周五提交。'),
      includeInAnalysis: true,
    };
    const unselected = await draft('unselected.md', 'reference', '未勾选资料不得发送。');
    const model = executor();
    const storage = fileSystem();
    const workflow = new MeetingAttachmentsWorkflow({
      fileSystem: storage,
      executor: model,
      modelLabel: 'synthetic-model',
      candidateNotePath: (path) => `/vault/${path}`,
    });

    const result = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['小李'],
      transcript: '小李：周五提交方案。',
      attachments: [selected, { ...unselected, includeInAnalysis: false }],
      action: 'analyze',
    });

    expect(result.analysis.result?.summary).toBe('会议确认周五提交方案。');
    expect(result.analysis.model).toBe('synthetic-model');
    expect(result.prepared?.candidates).toHaveLength(1);
    const prompt = vi.mocked(model.execute).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('selected.md');
    expect(prompt).toContain('选中的资料支持周五提交。');
    expect(prompt).not.toContain('unselected.md');
    expect(prompt).not.toContain('未勾选资料不得发送');

    const raw = await readFile(join(root, result.meetingPath), 'utf8');
    expect(parseTaskDocument(raw).data).toMatchObject({
      analysis_status: 'ready_for_confirm',
      attachments: [
        { name: 'selected.md', include_in_analysis: true },
        { name: 'unselected.md', include_in_analysis: false },
      ],
    });
    expect(await readFile(join(root, EVENT_PATH), 'utf8')).toBe(eventDocument());
    const files = await readdir(join(root, '08_Meetings/2026-07/attachments', 'f'.repeat(64)));
    expect(files).toHaveLength(2);
    expect(result.attachments.every((item) => item.id.startsWith('sha256:'))).toBe(true);
    expect(result.attachments[0]?.id).toBe(
      `sha256:${createHash('sha256').update(new TextEncoder().encode('选中的资料支持周五提交。')).digest('hex')}`,
    );

    const restored = await workflow.load(EVENT_PATH);
    expect(restored?.analysis.status).toBe('ready_for_confirm');
    expect(restored?.result?.analysis.result?.summary).toBe('会议确认周五提交方案。');
    expect(restored?.result?.prepared?.candidates).toHaveLength(1);

    await expect(workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['小李'],
      transcript: '小李：周五提交方案。',
      attachments: result.attachments,
      action: 'analyze',
    })).rejects.toBeInstanceOf(MeetingAnalysisAlreadyExistsError);

    await storage.process(result.meetingPath, (content) => (
      `${content}\n人工补充：这段内容必须保留。\n`
    ));
    const changedTranscript = '小李：周五提交方案。\n主持人：补充验证计划。';
    await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['小李'],
      transcript: changedTranscript,
      attachments: result.attachments,
      action: 'save',
    });

    const stale = await workflow.load(EVENT_PATH);
    expect(stale?.analysis.status).toBe('stale');
    expect(stale?.result?.analysis.result?.summary).toBe('会议确认周五提交方案。');
    await expect(workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['小李'],
      transcript: changedTranscript,
      attachments: result.attachments,
      action: 'analyze',
    })).rejects.toBeInstanceOf(MeetingAnalysisRetryRequiredError);

    const refreshed = await workflow.submit({
      eventPath: EVENT_PATH,
      meetingType: 'discussion',
      participants: ['小李'],
      transcript: changedTranscript,
      attachments: result.attachments,
      action: 'retry',
    });
    expect(refreshed.analysis.status).toBe('ready_for_confirm');
    expect(vi.mocked(model.execute)).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, result.meetingPath), 'utf8'))
      .toContain('人工补充：这段内容必须保留。');

    const context = createObsidianServiceContext(
      root,
      createVaultWriteAuthorization(root),
      {
        clock: () => new Date('2026-07-24T10:00:00.000Z'),
        id: () => 'task-20260724-meeting-0001',
      },
    );
    const candidates = new MeetingCandidateController({ context });
    const selectedCandidate = refreshed.prepared?.candidates[0];
    expect(selectedCandidate).toBeDefined();
    await candidates.commit(refreshed.prepared!, [selectedCandidate!.candidateId]);
    await expect(context.tasks.list()).resolves.toEqual([
      expect.objectContaining({
        taskId: 'task-20260724-meeting-0001',
        status: 'inbox',
        reviewState: 'candidate',
        autoExecutable: false,
        origin: 'obsidian_meeting',
        sourceNote: `/vault/${result.meetingPath}`,
      }),
    ]);
    expect(await readFile(join(root, EVENT_PATH), 'utf8')).toBe(eventDocument());
  });
});
