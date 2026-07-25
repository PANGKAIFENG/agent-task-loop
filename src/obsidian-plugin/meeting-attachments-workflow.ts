import type { ClaudeStructuredExecutor } from '../runner/claude-driver.js';
import {
  currentMeetingAnalysisInputHashFromFiles,
  MeetingAnalysisController,
  readMeetingAnalysis,
} from './meeting-analysis.js';
import {
  deduplicateMeetingAttachments,
  MeetingAttachmentStore,
  type MeetingAttachment,
  type MeetingAttachmentDraft,
  type MeetingAttachmentFileSystem,
} from './meeting-attachment.js';
import {
  prepareMeetingCandidates,
} from './meeting-candidate-controller.js';
import {
  extractMeetingTranscript,
  buildMeetingNotePath,
  MeetingNoteController,
  parseDingTalkMeetingSource,
  parseMeetingAttachments,
  type MeetingNoteFileSystem,
  type MeetingType,
} from './meeting-note.js';
import {
  type MeetingTranscriptAttachment,
} from './meeting-transcript-form.js';
import type {
  MeetingTranscriptInitialForm,
  MeetingTranscriptModalResult,
} from './meeting-transcript-modal.js';
import { parseTaskDocument } from '../storage/frontmatter.js';

export interface MeetingAttachmentsWorkflowFileSystem
  extends MeetingNoteFileSystem,
  MeetingAttachmentFileSystem {}

export interface MeetingAttachmentsWorkflowInput {
  eventPath: string;
  meetingType: MeetingType;
  participants: readonly string[];
  transcript: string;
  attachments: readonly MeetingTranscriptAttachment[];
  action: 'save' | 'analyze' | 'retry';
}

export interface MeetingAttachmentsWorkflowExisting {
  source: ReturnType<typeof parseDingTalkMeetingSource>;
  meetingPath: string;
  form: MeetingTranscriptInitialForm;
  analysis: ReturnType<typeof readMeetingAnalysis>;
  result: MeetingTranscriptModalResult | null;
}

function isDraft(
  attachment: MeetingTranscriptAttachment,
): attachment is MeetingAttachmentDraft {
  return 'data' in attachment;
}

function mergeAttachments(
  existing: readonly MeetingTranscriptAttachment[],
  stored: readonly MeetingAttachment[],
): MeetingAttachment[] {
  const persisted = existing.filter(
    (item): item is MeetingAttachment => !isDraft(item),
  );
  return deduplicateMeetingAttachments([...persisted, ...stored]);
}

async function withAttachmentAvailability(
  attachments: readonly MeetingAttachment[],
  fileSystem: MeetingAttachmentsWorkflowFileSystem,
): Promise<MeetingAttachment[]> {
  return Promise.all(attachments.map(async (attachment) => {
    try {
      if (await fileSystem.exists(attachment.path)) return attachment;
    } catch {
      // The attachment remains visible so the user can remove or replace it.
    }
    return {
      ...attachment,
      unavailableReason: '附件文件已丢失或无法读取',
    };
  }));
}

export class MeetingAttachmentsWorkflow {
  private readonly notes: MeetingNoteController;
  private readonly attachments: MeetingAttachmentStore;

  constructor(private readonly dependencies: {
    fileSystem: MeetingAttachmentsWorkflowFileSystem;
    executor: ClaudeStructuredExecutor | (() => Promise<ClaudeStructuredExecutor>);
    modelLabel?: string;
    candidateNotePath?: (path: string) => string;
    clock?: () => Date;
  }) {
    this.notes = new MeetingNoteController(dependencies.fileSystem);
    this.attachments = new MeetingAttachmentStore(dependencies.fileSystem);
  }

  async submit(input: MeetingAttachmentsWorkflowInput & { action: 'save' }): Promise<null>;
  async submit(input: MeetingAttachmentsWorkflowInput & { action: 'analyze' | 'retry' }): Promise<MeetingTranscriptModalResult>;
  async submit(input: MeetingAttachmentsWorkflowInput): Promise<MeetingTranscriptModalResult | null> {
    const source = parseDingTalkMeetingSource(
      input.eventPath,
      await this.dependencies.fileSystem.read(input.eventPath),
    );
    const existingPath = await this.notes.findExistingPath(source);
    const meetingPath = existingPath ?? buildMeetingNotePath(source);
    const stored = await this.attachments.save(
      meetingPath,
      source.eventKeyHash,
      input.attachments.filter(isDraft),
    );
    const meeting = await this.notes.create({
      eventPath: input.eventPath,
      meetingType: input.meetingType,
      participants: input.participants,
      transcript: input.transcript,
      attachments: mergeAttachments(input.attachments, stored),
    });
    if (input.action === 'save') return null;

    const executor = typeof this.dependencies.executor === 'function'
      ? await this.dependencies.executor()
      : this.dependencies.executor;
    const controller = new MeetingAnalysisController({
      fileSystem: this.dependencies.fileSystem,
      executor,
      ...(this.dependencies.modelLabel === undefined
        ? {}
        : { modelLabel: this.dependencies.modelLabel }),
      ...(this.dependencies.clock === undefined ? {} : { clock: this.dependencies.clock }),
    });
    const analysis = await controller.analyze(meeting.path, {
      force: input.action === 'retry',
    });
    const raw = await this.dependencies.fileSystem.read(meeting.path);
    const parsed = parseTaskDocument(raw);
    const view = readMeetingAnalysis(raw);
    const prepared = prepareMeetingCandidates({
      meetingNotePath: this.dependencies.candidateNotePath?.(meeting.path) ?? meeting.path,
      meetingDate: source.meetingDate,
      analysis,
    });
    return {
      meetingPath: meeting.path,
      analysis: view,
      transcript: extractMeetingTranscript(raw),
      attachments: parseMeetingAttachments(parsed.data),
      prepared: prepared.candidates.length === 0 ? null : prepared,
    };
  }

  async load(eventPath: string): Promise<MeetingAttachmentsWorkflowExisting | null> {
    const source = parseDingTalkMeetingSource(
      eventPath,
      await this.dependencies.fileSystem.read(eventPath),
    );
    const meetingPath = await this.notes.findExistingPath(source);
    if (meetingPath === null) return null;
    const raw = await this.dependencies.fileSystem.read(meetingPath);
    const document = parseTaskDocument(raw);
    const meetingType = document.data.meeting_type;
    const participants = document.data.participants;
    if (
      (meetingType !== 'interview'
        && meetingType !== 'discussion'
        && meetingType !== 'review'
        && meetingType !== 'other')
      || !Array.isArray(participants)
      || !participants.every((value) => typeof value === 'string')
    ) return null;
    let attachments = await withAttachmentAvailability(
      parseMeetingAttachments(document.data),
      this.dependencies.fileSystem,
    );
    const hasUnavailableInput = attachments.some((attachment) => (
      attachment.unavailableReason !== undefined
      && attachment.analyzable
      && attachment.includeInAnalysis
    ));
    let view = readMeetingAnalysis(raw);
    if (hasUnavailableInput) {
      if (view.result !== null) view = { ...view, status: 'stale' };
    } else {
      try {
        view = readMeetingAnalysis(
          raw,
          await currentMeetingAnalysisInputHashFromFiles(
            raw,
            meetingPath,
            this.dependencies.fileSystem,
          ),
        );
      } catch {
        attachments = attachments.map((attachment) => (
          attachment.analyzable && attachment.includeInAnalysis
            ? { ...attachment, unavailableReason: '附件文件已丢失或无法读取' }
            : attachment
        ));
        if (view.result !== null) view = { ...view, status: 'stale' };
      }
    }
    const analysisResult = view.result === null ? null : {
      meetingPath,
      analysis: view,
      transcript: extractMeetingTranscript(raw),
      attachments,
      prepared: prepareMeetingCandidates({
        meetingNotePath: this.dependencies.candidateNotePath?.(meetingPath) ?? meetingPath,
        meetingDate: source.meetingDate,
        analysis: view.result,
      }),
    };
    return {
      source,
      meetingPath,
      form: {
        meetingType,
        participants,
        transcript: extractMeetingTranscript(raw),
        attachments,
      },
      analysis: view,
      result: analysisResult,
    };
  }
}
