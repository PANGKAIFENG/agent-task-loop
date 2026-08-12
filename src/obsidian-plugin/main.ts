import { randomUUID } from 'node:crypto';
import { readFile as readExternalFile, stat as statExternalFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join, relative, sep } from 'node:path';

import {
  FileSystemAdapter,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  setIcon,
  TFile,
  WorkspaceLeaf,
  type TAbstractFile,
  type ButtonComponent,
} from 'obsidian';

import './styles.css';

import { QianwenDesktopConnector } from '../connectors/qianwen-desktop-connector.js';
import { DwsMaterialSearchConnector } from '../connectors/dws-material-search.js';
import { optionalDingTalkProfile } from '../dingtalk-profile.js';
import type { ProgressDraft } from '../domain/progress.js';
import {
  currentIsoWeekPeriod,
  isoWeekPeriodForOccurredAt,
} from '../domain/week-period.js';
import { createClaudeStructuredExecutor } from '../runner/claude-driver.js';
import { createAcceptanceNotifier } from '../services/acceptance-notifier-factory.js';
import { authorizeAgentExecution } from '../services/authorize-agent-execution.js';
import { captureTask } from '../services/capture-task.js';
import { createMaterialGap } from '../services/create-material-gap.js';
import { createProgressVersion } from '../services/create-progress-version.js';
import {
  listRelatedMaterialSources,
  prepareMaterialGapRequest,
  type PrepareMaterialGapRequestInput,
} from '../services/prepare-material-gap-request.js';
import {
  confirmMeetingMatchWithEvidence,
  markRecordingWithoutCalendarWithEvidence,
} from '../services/materialize-meeting-match.js';
import { queryWorkProgressHub } from '../services/query-work-progress-hub.js';
import {
  acceptWeeklyReport,
  deferWeeklyReport,
  rejectWeeklyReportWithFeedback,
} from '../services/review-weekly-report.js';
import { revokeMeetingMatchDecision } from '../services/decide-meeting-match.js';
import { ensureWorkProgressEntry } from '../services/ensure-work-progress-entry.js';
import { generateWeeklyReport } from '../services/generate-weekly-report.js';
import { syncQianwenSource } from '../services/sync-qianwen-source.js';
import type { ServiceContext } from '../services/service-context.js';
import { MarkdownMaterialGapRepository } from '../storage/markdown-material-gap-repository.js';
import { MarkdownProgressRepository } from '../storage/markdown-progress-repository.js';
import { MarkdownWeeklyReportRepository } from '../storage/markdown-weekly-report-repository.js';
import { FileMeetingMatchDecisionRepository } from '../storage/meeting-match-decision-repository.js';
import { FileQianwenSourceStateRepository } from '../storage/qianwen-source-state-repository.js';
import { FileAcceptanceNotificationLedger } from '../storage/file-acceptance-notification-ledger.js';
import { qianwenRuntimeRoot } from '../qianwen-runtime-root.js';
import { FileWeeklyReviewDecisionRepository } from '../storage/weekly-review-decision-repository.js';
import { MarkdownTaskRepository } from '../storage/markdown-task-repository.js';
import { MarkdownProjectRepository } from '../storage/markdown-project-repository.js';
import { recordTaskCompletionDate } from '../services/record-task-completion-date.js';
import {
  collectWeeklyCoachContext,
  type WeeklyCoachContextGateway,
} from '../services/weekly-coach-context.js';
import {
  getWeeklyCoachSessionDraft,
  putWeeklyCoachSessionDraft,
  removeWeeklyCoachSessionDraft,
  type WeeklyCoachSessionDraft,
} from '../services/weekly-coach-draft.js';
import {
  confirmWeeklyFocus,
  currentIsoWeek,
  loadCurrentWeeklyFocus,
  type WeeklyFocusGateway,
} from '../services/weekly-focus.js';
import { createVaultWriteAuthorization } from '../storage/task-paths.js';
import { parseArtifactReference } from '../storage/artifact-reference.js';
import { MarkdownTaskTitleRepairRepository } from '../storage/markdown-task-title-repair-repository.js';
import {
  BackgroundRuntimeController,
  createBackgroundRuntimeDependencies,
  type BackgroundInspection,
} from './background-runtime-controller.js';
import {
  AgentAuthorizationPluginLifecycle,
  isAgentAuthorizationEligibleMetadata,
} from './agent-authorization-plugin-lifecycle.js';
import {
  BoardAppearanceController,
  type BoardPresetStatus,
} from './board-appearance-controller.js';
import { extractTaskCandidates } from './candidate-extractor.js';
import { CaptureCandidatesModal } from './capture-candidates-modal.js';
import { CaptureController } from './capture-controller.js';
import {
  CompletionDateBackfillModal,
  type CompletionDateBackfillTask,
} from './completion-date-backfill-modal.js';
import { formatCodexHandoff } from './codex-handoff.js';
import { ConfirmationController } from './confirmation-controller.js';
import {
  ConfirmationPluginLifecycle,
  confirmationActionFromMetadata,
} from './confirmation-plugin-lifecycle.js';
import { createReadOnlyDingTalkCalDavClient } from './dingtalk-caldav-client.js';
import { DingTalkCalendarController } from './dingtalk-calendar-controller.js';
import {
  createDingTalkCredentialStore,
  readLegacyDingTalkKeychainPassword,
  type DingTalkCredentialStore,
} from './dingtalk-credential-store.js';
import {
  DingTalkCalendarPluginLifecycle,
  formatDingTalkSyncResult,
} from './dingtalk-calendar-plugin.js';
import {
  DingTalkCalendarWriter,
  type DingTalkCalendarFileSystem,
} from './dingtalk-calendar-writer.js';
import { TaskConfirmationModal } from './confirmation-modal.js';
import { QuickCaptureModal } from './quick-capture-modal.js';
import {
  createObsidianReadServiceContext,
  createObsidianServiceContext,
} from './service-context.js';
import {
  ContributionDashboardController,
} from './contribution-dashboard-controller.js';
import { createOpenTokenAdapter } from './opentoken-adapter.js';
import {
  WORK_CONTRIBUTION_VIEW_TYPE,
  WorkContributionView,
} from './work-contribution-view.js';
import {
  backgroundActionState,
  DEFAULT_SETTINGS,
  modelServiceFieldState,
  modelServiceConfiguration,
  normalizeSettings,
  type CaptureState,
  type AtlPluginSettings,
} from './settings.js';
import { readSyncSourceRecords } from './sync-source-reader.js';
import { resolveSystemTimeZone } from './system-time-zone.js';
import {
  TaskLifecycleReconciliationController,
} from './task-lifecycle-reconciliation-controller.js';
import {
  isAtlInboxTaskPath,
  isAtlTaskPath,
  isTaskNotesTaskPath,
  taskIdFromMetadata,
  taskIdFromPath,
} from './task-eligibility.js';
import {
  ATL_UNIFIED_CALENDAR_PATH,
  UnifiedCalendarController,
} from './unified-calendar-controller.js';
import { UnifiedCalendarPluginLifecycle } from './unified-calendar-plugin.js';
import { runWithPersistentFeedback } from './persistent-operation-feedback.js';
import { enrichTask } from './task-enrichment.js';
import { createMeetingAttachmentDraft } from './meeting-attachment.js';
import { MeetingAttachmentsWorkflow } from './meeting-attachments-workflow.js';
import {
  assertMeetingDocumentSize,
  meetingDocumentKind,
  parseMeetingDocument,
} from './meeting-document-parser.js';
import { MeetingCandidateController } from './meeting-candidate-controller.js';
import { MeetingNoteController, parseDingTalkMeetingSource } from './meeting-note.js';
import { MeetingPluginLifecycle } from './meeting-plugin-lifecycle.js';
import { MeetingTranscriptModal } from './meeting-transcript-modal.js';
import { QianwenSyncPluginLifecycle } from './qianwen-sync-plugin.js';
import {
  WorkProgressHubController,
  type WorkProgressHubSnapshot,
} from './work-progress-hub-controller.js';
import {
  isSafeWorkProgressPath,
  WorkProgressPluginLifecycle,
} from './work-progress-plugin.js';
import {
  WORK_PROGRESS_VIEW_TYPE,
  WorkProgressView,
} from './work-progress-view.js';
import {
  MaterialGapEntryModal,
  ProgressEntryModal,
} from './work-progress-entry-modal.js';
import { WeeklyFeedbackModal } from './weekly-feedback-modal.js';
import { LegacyTaskTitleRepairController } from './legacy-task-title-repair-controller.js';
import { LegacyTaskTitleRepairModal } from './legacy-task-title-repair-modal.js';
import { WeeklyThinkingCoachModal } from './weekly-thinking-coach-modal.js';
import { runWeeklyThinkingCoach } from './weekly-thinking-coach.js';
import {
  ensureWeeklyFocusParentDirectories,
  runAuthorizedWeeklyFocusWrite,
} from './weekly-focus-vault-gateway.js';
import {
  type TaskNotesFieldGovernanceStatus,
} from './tasknotes-field-governance-controller.js';
import {
  createTaskNotesFieldGovernancePluginIntegration,
  taskNotesFieldControlState,
} from './tasknotes-field-governance-plugin-integration.js';
import { SerializedSettingsWriter } from './serialized-settings-writer.js';
import {
  TaskBriefController,
  TaskNotesTaskBriefController,
} from './task-brief-controller.js';
import { generateTaskBrief } from './task-brief-generation.js';
import { TaskBriefModal } from './task-brief-modal.js';
import { TaskBriefPluginLifecycle } from './task-brief-plugin-lifecycle.js';
import { TaskNotesTaskBriefActionBridge } from './tasknotes-task-brief-action-bridge.js';

const CARD_THEME_CLASS = 'atl-task-card-theme';

interface LocalPluginPaths {
  root: string;
  runnerPath: string;
}

interface DirectoryDialog {
  showOpenDialog(options: {
    properties: Array<'openDirectory' | 'openFile' | 'multiSelections'>;
    title: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

type ElectronRequire = (id: '@electron/remote' | 'electron') => unknown;

function getDirectoryDialog(): DirectoryDialog | null {
  const desktopWindow = window as typeof window & { require?: ElectronRequire };
  if (desktopWindow.require === undefined) return null;
  try {
    const remote = desktopWindow.require('@electron/remote') as {
      dialog?: DirectoryDialog;
    };
    if (remote.dialog !== undefined) return remote.dialog;
  } catch {
    // Older Obsidian builds expose the same fixed API through electron.remote.
  }
  try {
    const electron = desktopWindow.require('electron') as {
      remote?: { dialog?: DirectoryDialog };
    };
    return electron.remote?.dialog ?? null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : fallback;
}

function meetingAttachmentMediaType(path: string): string {
  const extension = extname(path).toLocaleLowerCase('en-US');
  if (extension === '.txt') return 'text/plain';
  if (extension === '.md') return 'text/markdown';
  if (extension === '.docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === '.pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function isContributionDataPath(path: string): boolean {
  return isAtlTaskPath(path)
    || /^10_Tasks\/Audit\/\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path)
    || /^05_Reviews\/Weekly\/\d{4}-W\d{2} 周度重点\.md$/u.test(path);
}

function isWorkProgressDataPath(path: string): boolean {
  return path.startsWith('08_Meetings/')
    || path.startsWith('09_Progress/')
    || path.startsWith('TaskNotes/DingTalk/');
}

export default class AgentTaskLoopPlugin extends Plugin {
  settings: AtlPluginSettings = DEFAULT_SETTINGS;
  readonly boardAppearance = new BoardAppearanceController();
  private readonly settingsWriter = new SerializedSettingsWriter<AtlPluginSettings>(
    (snapshot) => this.saveData(snapshot),
  );
  private syncScanInFlight: Promise<void> | null = null;
  private unifiedCalendarOpenInFlight: Promise<void> | null = null;
  private taskLifecycleReconciliation: TaskLifecycleReconciliationController | null = null;
  private contributionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private workProgressRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private dingtalkCalendarController: DingTalkCalendarController | null = null;
  private dingtalkCalendarLifecycle: DingTalkCalendarPluginLifecycle | null = null;
  private dingtalkCredentialStore: DingTalkCredentialStore | null = null;

  override async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    if (this.settings.background.claudeConfigDirectory === '') {
      this.settings.background.claudeConfigDirectory = join(homedir(), '.claude');
    }
    this.applyTaskCardTheme();
    this.register(() => document.body.classList.remove(CARD_THEME_CLASS));
    this.initializeTaskLifecycleReconciliation();

    this.registerView(
      WORK_CONTRIBUTION_VIEW_TYPE,
      (leaf) => this.createContributionView(leaf),
    );
    this.registerView(
      WORK_PROGRESS_VIEW_TYPE,
      (leaf) => this.createWorkProgressView(leaf),
    );

    this.addRibbonIcon('square-pen', 'ATL：新建任务', () => {
      this.openQuickCapture();
    });
    this.addRibbonIcon('list-restart', 'ATL：从同步助手获取待办', () => {
      void this.scanSyncAssistant();
    });
    new UnifiedCalendarPluginLifecycle({
      addRibbonIcon: (icon, title, callback) => {
        this.addRibbonIcon(icon, title, callback);
      },
      addCommand: (command) => {
        this.addCommand(command);
      },
      open: () => this.openUnifiedCalendar(),
    }).start();
    new WorkProgressPluginLifecycle({
      addRibbonIcon: (icon, title, callback) => {
        this.addRibbonIcon(icon, title, callback);
      },
      addCommand: (command) => {
        this.addCommand(command);
      },
      open: () => this.activateWorkProgressView(),
    }).start();
    this.addRibbonIcon('layout-dashboard', 'ATL：个人首页', () => {
      void this.activateContributionView();
    });

    this.addCommand({
      id: 'quick-capture-task',
      name: '新建任务',
      callback: () => this.openQuickCapture(),
    });
    this.addCommand({
      id: 'capture-from-sync-assistant',
      name: '从同步助手获取待办',
      callback: () => {
        void this.scanSyncAssistant();
      },
    });
    this.addCommand({
      id: 'open-work-contribution',
      name: '打开个人首页',
      callback: () => {
        void this.activateContributionView();
      },
    });
    this.addCommand({
      id: 'repair-legacy-task-titles',
      name: '修复旧任务标题',
      callback: () => {
        void this.openLegacyTaskTitleRepair();
      },
    });

    new QianwenSyncPluginLifecycle({
      addCommand: (command) => this.addCommand(command),
      canSync: () => this.settings.allowVaultManagement,
      sync: () => this.syncQianwenNow(),
      onSuccess: (result) => {
        if (result.status === 'not_due') {
          new Notice('千问听记今天已同步');
          return;
        }
        new Notice(
          `千问听记同步完成：可用 ${result.available}，等待 ${result.waiting}，失败 ${result.failed}`,
        );
      },
      onError: (message) => new Notice(message),
    }).start();

    new MeetingPluginLifecycle({
      addCommand: (command) => {
        this.addCommand(command);
      },
      registerFileMenu: (handler) => {
        this.registerEvent(this.app.workspace.on(
          'file-menu',
          (menu: Menu, file: TAbstractFile) => {
            if (file instanceof TFile) handler(menu, file.path);
          },
        ));
      },
      getActiveFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      open: (path) => {
        void this.openMeetingTranscript(path);
      },
    }).start();

    new TaskBriefPluginLifecycle({
      addCommand: (command) => {
        this.addCommand(command);
      },
      registerFileMenu: (handler) => {
        this.registerEvent(this.app.workspace.on(
          'file-menu',
          (menu: Menu, file: TAbstractFile) => {
            if (file instanceof TFile) handler(menu, file.path);
          },
        ));
      },
      getActiveFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      isTaskPath: (path) => {
        if (isAtlTaskPath(path)) return true;
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile && isTaskNotesTaskPath(
          path,
          this.app.metadataCache.getFileCache(file)?.frontmatter,
        );
      },
      open: (path) => {
        void this.openTaskBrief(path);
      },
    }).start();

    new AgentAuthorizationPluginLifecycle({
      addCommand: (command) => {
        this.addCommand(command);
      },
      registerFileMenu: (handler) => {
        this.registerEvent(this.app.workspace.on(
          'file-menu',
          (menu: Menu, file: TAbstractFile) => {
            if (file instanceof TFile) handler(menu, file.path);
          },
        ));
      },
      getActiveFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      isEligible: (path) => {
        if (!isAtlTaskPath(path)) return false;
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile && isAgentAuthorizationEligibleMetadata(
          this.app.metadataCache.getFileCache(file)?.frontmatter,
        );
      },
      authorize: (path) => {
        void this.authorizeTaskForAgent(path);
      },
    }).start();

    new ConfirmationPluginLifecycle({
      addCommand: (command) => {
        this.addCommand(command);
      },
      registerFileMenu: (handler) => {
        this.registerEvent(this.app.workspace.on(
          'file-menu',
          (menu: Menu, file: TAbstractFile) => {
            if (file instanceof TFile) handler(menu, file.path);
          },
        ));
      },
      getActiveFilePath: () => this.app.workspace.getActiveFile()?.path ?? null,
      actionFor: (path) => {
        if (!isAtlTaskPath(path)) return null;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        return confirmationActionFromMetadata(
          isAtlInboxTaskPath(path),
          this.app.metadataCache.getFileCache(file)?.frontmatter,
        );
      },
      open: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void this.openConfirmation(file);
      },
    }).start();

    const appWithPluginRegistry = this.app as typeof this.app & {
      plugins?: { getPlugin(id: string): unknown };
    };
    const taskNotesTaskBriefBridge = new TaskNotesTaskBriefActionBridge({
      document,
      isTaskNotesEnabled: () => (
        appWithPluginRegistry.plugins?.getPlugin('tasknotes') != null
      ),
      getEligibleTaskPaths: () => this.app.vault.getMarkdownFiles()
        .filter((file) => isAtlTaskPath(file.path) || isTaskNotesTaskPath(
          file.path,
          this.app.metadataCache.getFileCache(file)?.frontmatter,
        ))
        .map((file) => file.path),
      open: (path) => {
        void this.openTaskBrief(path);
      },
      notice: (message) => {
        new Notice(message);
      },
      setIcon,
    });
    this.app.workspace.onLayoutReady(() => {
      taskNotesTaskBriefBridge.start();
      this.app.workspace.iterateAllLeaves((leaf) => {
        taskNotesTaskBriefBridge.addDocument(leaf.view.containerEl.ownerDocument);
      });
    });
    this.registerEvent(this.app.workspace.on(
      'window-open',
      (_workspaceWindow, openedWindow) => {
        taskNotesTaskBriefBridge.addDocument(openedWindow.document);
      },
    ));
    this.registerEvent(this.app.workspace.on(
      'window-close',
      (_workspaceWindow, closedWindow) => {
        taskNotesTaskBriefBridge.removeDocument(closedWindow.document);
      },
    ));
    this.register(() => taskNotesTaskBriefBridge.stop());

    this.registerEvent(this.app.workspace.on(
      'file-menu',
      (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || !isAtlTaskPath(file.path)) return;
        menu.addItem((item) => item
          .setTitle('复制给 Codex')
          .setIcon('copy')
          .onClick(() => this.copyTaskForCodex(file)));
      },
    ));

    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.scheduleContributionRefresh(file.path);
      this.scheduleWorkProgressRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on('create', (file) => {
      this.scheduleContributionRefresh(file.path);
      this.scheduleWorkProgressRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      this.scheduleContributionRefresh(file.path);
      this.scheduleWorkProgressRefresh(file.path);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.scheduleContributionRefresh(file.path);
      this.scheduleContributionRefresh(oldPath);
      this.scheduleWorkProgressRefresh(file.path);
      this.scheduleWorkProgressRefresh(oldPath);
    }));
    this.register(() => {
      if (this.contributionRefreshTimer !== null) {
        clearTimeout(this.contributionRefreshTimer);
        this.contributionRefreshTimer = null;
      }
    });
    this.register(() => {
      if (this.workProgressRefreshTimer !== null) {
        clearTimeout(this.workProgressRefreshTimer);
        this.workProgressRefreshTimer = null;
      }
    });

    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      if (!this.settings.allowVaultManagement || !isAtlTaskPath(file.path)) return;
      this.taskLifecycleReconciliation?.schedule(file.path);
    }));

    this.initializeDingTalkCalendar();

    this.addSettingTab(new AgentTaskLoopSettingTab(this));
  }

  async saveSettings(): Promise<void> {
    this.applyTaskCardTheme();
    await this.settingsWriter.write(structuredClone(this.settings));
  }

  createTaskNotesFieldGovernanceIntegration() {
    const appWithPluginRegistry = this.app as typeof this.app & {
      plugins?: { getPlugin(id: string): unknown };
    };
    return createTaskNotesFieldGovernancePluginIntegration({
      registry: appWithPluginRegistry.plugins,
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      notice: (message) => new Notice(message),
    });
  }

  private createContributionView(leaf: WorkspaceLeaf): WorkContributionView {
    return new WorkContributionView(leaf, {
      createController: () => this.createContributionController(),
      openTask: (taskId) => this.openContributionTask(taskId),
      openArtifact: (artifactRef, taskId) => this.openContributionArtifact(artifactRef, taskId),
      openCompletionDateBackfill: (tasks) => this.openCompletionDateBackfill(tasks),
      openSettings: () => this.openPluginSettings(),
      loadWeeklyFocus: () => this.loadWeeklyFocus(),
      loadWeeklyCoachDraft: async () => this.loadWeeklyCoachSessionDraft(
        currentIsoWeek(new Date(), resolveSystemTimeZone()),
      ),
      openWeeklyCoach: (onChanged) => this.openWeeklyCoach(onChanged),
      openWeeklyFocus: (path) => this.openWeeklyFocus(path),
    });
  }

  private createWorkProgressView(leaf: WorkspaceLeaf): WorkProgressView {
    return new WorkProgressView(leaf, {
      createController: () => this.createWorkProgressController(),
      openPath: (path) => this.openWorkProgressPath(path),
      requestWeeklyFeedback: (report) => this.requestWeeklyFeedback(report),
      requestProgressDraft: (initial) => this.requestProgressDraft(initial),
      requestMaterialGap: (progress) => this.requestMaterialGap(progress),
    });
  }

  private createWorkProgressController(): WorkProgressHubController {
    const paths = this.localPluginPaths();
    if (paths === null || !Platform.isDesktopApp) {
      throw new Error('Agent Task Loop 工作沉淀仅支持桌面版本地 Vault');
    }
    const root = paths.root;
    const runtimeRoot = qianwenRuntimeRoot({ runnerPath: paths.runnerPath });
    const sourceRepository = new FileQianwenSourceStateRepository(runtimeRoot);
    const decisionRepository = new FileMeetingMatchDecisionRepository(root);
    const progressRepository = new MarkdownProgressRepository(root);
    const materialGapRepository = new MarkdownMaterialGapRepository(root);
    const weeklyRepository = new MarkdownWeeklyReportRepository(root);
    const weeklyDecisionRepository = new FileWeeklyReviewDecisionRepository(root);
    const taskRepository = new MarkdownTaskRepository(root);
    const projectRepository = new MarkdownProjectRepository(root);

    const writeContext = () => {
      if (!this.settings.allowVaultManagement) {
        const error = new Error('请先允许 ATL 管理此 Vault') as Error & { code: string };
        error.code = 'work_progress_vault_management_required';
        throw error;
      }
      const writeAuthorization = createVaultWriteAuthorization(root);
      return {
        decisionRepository: new FileMeetingMatchDecisionRepository(root, {
          writeAuthorization,
        }),
        weeklyRepository: new MarkdownWeeklyReportRepository(root, {
          writeAuthorization,
        }),
        weeklyDecisionRepository: new FileWeeklyReviewDecisionRepository(root, {
          writeAuthorization,
        }),
        progressRepository: new MarkdownProgressRepository(root, {
          writeAuthorization,
        }),
        materialGapRepository: new MarkdownMaterialGapRepository(root, {
          writeAuthorization,
        }),
      };
    };
    const meetingNotes = new MeetingNoteController(this.workProgressMeetingFileSystem());
    const materializeContext = () => {
      const writable = writeContext();
      return {
        sourceRepository,
        decisionRepository: writable.decisionRepository,
        meetingNotes,
        listCalendarSources: () => this.listWorkProgressCalendarSources(),
        readCalendarSource: (path: string) => this.app.vault.adapter.read(path),
        readMeetingNote: (path: string) => this.app.vault.adapter.read(path),
        clock: () => new Date(),
        id: randomUUID,
      };
    };

    return new WorkProgressHubController({
      loadSnapshot: () => queryWorkProgressHub({
        sourceRepository,
        decisionRepository,
        progressRepository,
        materialGapRepository,
        weeklyRepository,
        weeklyDecisionRepository,
        taskRepository,
        notificationLedger: new FileAcceptanceNotificationLedger(join(root, '.atl-runtime')),
        listCalendarSources: () => this.listWorkProgressCalendarSources(),
        findMeetingPath: (recordingId) => meetingNotes.findExistingRecordingPath(recordingId),
        readMeetingNote: async (path) => (
          await this.app.vault.adapter.exists(path)
            ? this.app.vault.adapter.read(path)
            : null
        ),
      }),
      confirmMatch: (input) => confirmMeetingMatchWithEvidence(materializeContext(), input),
      markNoCalendar: (input) => markRecordingWithoutCalendarWithEvidence(
        materializeContext(),
        input,
      ),
      revokeMatch: (input) => {
        const writable = writeContext();
        return revokeMeetingMatchDecision({
          repository: writable.decisionRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, input);
      },
      acceptWeekly: (input) => {
        const writable = writeContext();
        return acceptWeeklyReport({
          weeklyRepository: writable.weeklyRepository,
          decisionRepository: writable.weeklyDecisionRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, input);
      },
      rejectWeekly: (input) => {
        const writable = writeContext();
        return rejectWeeklyReportWithFeedback({
          weeklyRepository: writable.weeklyRepository,
          decisionRepository: writable.weeklyDecisionRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, input);
      },
      deferWeekly: (input) => {
        const writable = writeContext();
        return deferWeeklyReport({
          weeklyRepository: writable.weeklyRepository,
          decisionRepository: writable.weeklyDecisionRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, input);
      },
      generateWeekly: () => {
        const writable = writeContext();
        const period = currentIsoWeekPeriod(new Date(), 'Asia/Shanghai');
        const notifyAcceptance = createAcceptanceNotifier({
          vaultRoot: root,
          profile: optionalDingTalkProfile(this.settings.background.dingtalkProfile),
        });
        return generateWeeklyReport({
          progressRepository,
          weeklyRepository: writable.weeklyRepository,
          clock: () => new Date(),
          ...(notifyAcceptance === undefined ? {} : { notifyAcceptance }),
        }, {
          weekKey: period.weekKey,
          week: {
            startDate: period.startDate,
            endDate: period.endDate,
          },
        });
      },
      createProgress: (draft) => {
        const writable = writeContext();
        const period = isoWeekPeriodForOccurredAt(draft.occurredAt, 'Asia/Shanghai');
        return createProgressVersion({
          repository: writable.progressRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, {
          draft,
          week: {
            startDate: period.startDate,
            endDate: period.endDate,
          },
        });
      },
      createMaterialGap: (input) => {
        const writable = writeContext();
        const materialSearch = new DwsMaterialSearchConnector({
          profile: optionalDingTalkProfile(this.settings.background.dingtalkProfile),
        });
        const readSource = async (path: string): Promise<string | null> => {
          const adapter = this.app.vault.adapter;
          if (!(await adapter.exists(path))) return null;
          const kind = meetingDocumentKind(path);
          if (kind === 'pdf' || kind === 'docx' || kind === 'csv' || kind === 'xlsx') {
            return parseMeetingDocument({
              name: path,
              data: new Uint8Array(await adapter.readBinary(path)),
            });
          }
          return adapter.read(path);
        };
        return prepareMaterialGapRequest({
          loadProgress: async (progressId, version) => (
            (await progressRepository.listVersions(progressId))
              .find((candidate) => candidate.version === version) ?? null
          ),
          readSource,
          listRelatedSources: (progress) => listRelatedMaterialSources({
            readSource,
            loadProject: async (projectId) => {
              try {
                return await projectRepository.get(projectId);
              } catch {
                return null;
              }
            },
            listTasks: () => taskRepository.list(),
          }, progress),
          searchExternalSources: (progress, request) => materialSearch.search({
            query: [...new Set([
              progress.topic.trim(),
              request.missing.description.trim(),
            ].filter((value) => value !== ''))].join(' '),
            occurredAt: progress.occurredAt,
            projectId: progress.primaryProjectId,
          }),
          clock: () => new Date(),
        }, input).then((prepared) => createMaterialGap({
          repository: writable.materialGapRepository,
          clock: () => new Date(),
          id: randomUUID,
        }, prepared));
      },
      syncSource: () => this.syncQianwenNow(),
    });
  }

  private createWeeklyFocusGateway(): WeeklyFocusGateway {
    const adapter = this.app.vault.adapter;
    return {
      read: async (path) => (
        await adapter.exists(path) ? adapter.read(path) : null
      ),
      write: async (path, content, expectedContent) => {
        if (!this.settings.allowVaultManagement) {
          throw new Error('vault_management_disabled');
        }
        const exists = await adapter.exists(path);
        const current = exists ? await adapter.read(path) : null;
        if (current !== expectedContent) return false;

        await ensureWeeklyFocusParentDirectories(
          adapter,
          path,
          () => this.settings.allowVaultManagement,
        );
        if (!this.settings.allowVaultManagement) {
          throw new Error('vault_management_disabled');
        }

        if (expectedContent === null) {
          if (await adapter.exists(path)) return false;
          await runAuthorizedWeeklyFocusWrite(
            () => this.settings.allowVaultManagement,
            () => this.app.vault.create(path, content),
          );
          return true;
        }
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        let matched = false;
        await runAuthorizedWeeklyFocusWrite(
          () => this.settings.allowVaultManagement,
          () => this.app.vault.process(file, (latest) => {
            if (latest !== expectedContent) return latest;
            matched = true;
            return content;
          }),
        );
        return matched;
      },
    };
  }

  private createWeeklyCoachContextGateway(): WeeklyCoachContextGateway {
    const adapter = this.app.vault.adapter;
    return {
      listMarkdownPaths: async () => (
        this.app.vault.getMarkdownFiles().map((file) => file.path)
      ),
      read: async (path) => adapter.read(path),
    };
  }

  private loadWeeklyFocus() {
    return loadCurrentWeeklyFocus(
      this.createWeeklyFocusGateway(),
      () => new Date(),
      resolveSystemTimeZone(),
    );
  }

  private loadWeeklyCoachSessionDraft(week: string): WeeklyCoachSessionDraft | null {
    return getWeeklyCoachSessionDraft(this.settings.weeklyCoachDrafts, week);
  }

  private async saveWeeklyCoachSessionDraft(draft: WeeklyCoachSessionDraft): Promise<void> {
    this.settings.weeklyCoachDrafts = putWeeklyCoachSessionDraft(
      this.settings.weeklyCoachDrafts,
      draft,
    );
    await this.saveSettings();
  }

  private async clearWeeklyCoachSessionDraft(week: string): Promise<void> {
    this.settings.weeklyCoachDrafts = removeWeeklyCoachSessionDraft(
      this.settings.weeklyCoachDrafts,
      week,
    );
    await this.saveSettings();
  }

  private weeklyCoachModelLabel(): string {
    const modelService = modelServiceConfiguration(this.settings.background);
    if (!modelService.valid) return '模型配置需检查（可人工整理）';
    return modelService.model === undefined
      ? '沿用 Claude Code / CC-Switch'
      : `自定义模型 · ${modelService.model}`;
  }

  private openWeeklyCoach(
    onChanged: () => void,
  ): void {
    const timeZone = resolveSystemTimeZone();
    const clock = () => new Date();
    const week = currentIsoWeek(clock(), timeZone);
    const gateway = this.createWeeklyFocusGateway();
    new WeeklyThinkingCoachModal(this.app, {
      week,
      modelLabel: this.weeklyCoachModelLabel(),
      loadRecord: () => loadCurrentWeeklyFocus(gateway, clock, timeZone),
      loadSessionDraft: () => this.loadWeeklyCoachSessionDraft(week),
      runCoach: async (turn, control) => {
        const context = await collectWeeklyCoachContext(
          this.createWeeklyCoachContextGateway(),
          turn.selectedSources,
          { now: clock() },
        );
        if (control.signal.aborted) throw new Error('weekly_coach_cancelled');
        control.onProgress({
          stage: 'context_ready',
          sourceCount: new Set(context.documents.map(({ source }) => source)).size,
          documentCount: context.documents.length,
          totalCharacters: context.totalCharacters,
        });
        const executor = await this.createStructuredExecutor();
        if (control.signal.aborted) throw new Error('weekly_coach_cancelled');
        return runWeeklyThinkingCoach(executor, {
          topic: turn.topic,
          latestAnswer: turn.latestAnswer,
          keyAnswers: turn.keyAnswers,
          previousSummary: turn.previousSummary,
          draftItems: turn.draftItems,
          deletedFocuses: turn.deletedFocuses,
          focusedItemId: turn.focusedItemId,
          deferredTaskQuestions: turn.deferredTaskQuestions,
          context,
        }, control);
      },
      saveSessionDraft: (draft) => this.saveWeeklyCoachSessionDraft(draft),
      clearSessionDraft: () => this.clearWeeklyCoachSessionDraft(week),
      confirm: (input, expectedContent) => confirmWeeklyFocus(
        gateway,
        clock,
        input,
        expectedContent,
        week,
        timeZone,
      ),
      canManageVault: () => this.settings.allowVaultManagement,
      onChanged,
      openRecord: (path) => this.openWeeklyFocus(path),
      notify: (message) => { new Notice(message); },
      now: clock,
      currentWeek: () => currentIsoWeek(clock(), timeZone),
      createId: randomUUID,
    }).open();
  }

  private async openWeeklyFocus(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('找不到本周判断记录');
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private openCompletionDateBackfill(tasks: readonly CompletionDateBackfillTask[]): void {
    if (!this.settings.allowVaultManagement) {
      new Notice('请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault');
      return;
    }
    const paths = this.localPluginPaths();
    if (paths === null) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return;
    }
    new CompletionDateBackfillModal(this.app, tasks, async (taskId, completedOn) => {
      if (!this.settings.allowVaultManagement) {
        new Notice('Vault 管理权限已关闭，请重新开启后再补齐');
        throw new Error('vault_management_disabled');
      }
      const currentPaths = this.localPluginPaths();
      if (currentPaths === null) {
        new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
        throw new Error('local_vault_unavailable');
      }
      const timeZone = resolveSystemTimeZone();
      const context = createObsidianServiceContext(
        currentPaths.root,
        createVaultWriteAuthorization(currentPaths.root),
        { timeZone },
      );
      const result = await recordTaskCompletionDate(context, {
        taskId,
        completedOn,
        timeZone,
      });
      new Notice(result.recorded ? '历史完成日期已补齐' : '这项任务已有完成日期记录');
      await Promise.all(
        this.app.workspace.getLeavesOfType(WORK_CONTRIBUTION_VIEW_TYPE)
          .map(async (leaf) => {
            if (leaf.view instanceof WorkContributionView) {
              await leaf.view.refreshContribution();
            }
          }),
      );
    }, () => this.settings.allowVaultManagement).open();
  }

  private async openLegacyTaskTitleRepair(): Promise<void> {
    if (!this.settings.allowVaultManagement) {
      new Notice('请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault');
      return;
    }
    const paths = this.localPluginPaths();
    if (paths === null) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return;
    }
    const previewController = new LegacyTaskTitleRepairController(
      new MarkdownTaskTitleRepairRepository(paths.root),
    );
    let preview;
    try {
      preview = await previewController.preview();
    } catch {
      new Notice('无法扫描旧任务标题，请检查任务文件后重试');
      return;
    }
    if (preview.candidates.length === 0) {
      new Notice(`已扫描 ${preview.filesScanned} 个 Markdown 文件，没有需要修复的旧任务标题`);
      return;
    }

    new LegacyTaskTitleRepairModal(this.app, preview, async () => {
      if (!this.settings.allowVaultManagement) {
        throw new Error('vault_management_disabled');
      }
      const currentPaths = this.localPluginPaths();
      if (currentPaths === null || currentPaths.root !== paths.root) {
        throw new Error('local_vault_changed');
      }
      const controller = new LegacyTaskTitleRepairController(
        new MarkdownTaskTitleRepairRepository(currentPaths.root, {
          writeAuthorization: createVaultWriteAuthorization(currentPaths.root),
        }),
      );
      const result = await controller.repair(preview);
      new Notice(`旧任务标题修复完成：成功 ${result.repaired} 个，跳过 ${result.skipped} 个`);
      return result;
    }, () => this.settings.allowVaultManagement).open();
  }

  private createContributionController(): ContributionDashboardController {
    const paths = this.localPluginPaths();
    if (paths === null) {
      throw new Error('Agent Task Loop 个人首页仅支持桌面版本地 Vault');
    }
    const timeZone = resolveSystemTimeZone();
    return new ContributionDashboardController({
      context: createObsidianReadServiceContext(paths.root, {
        timeZone,
      }),
      openToken: createOpenTokenAdapter(homedir()),
      getTokenCache: () => this.settings.dashboard,
      saveTokenCache: async (cache) => {
        this.settings.dashboard = cache;
        await this.saveSettings();
      },
      clock: () => new Date(),
      timeZone,
    });
  }

  private async activateContributionView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(WORK_CONTRIBUTION_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: WORK_CONTRIBUTION_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async activateWorkProgressView(): Promise<void> {
    if (this.settings.allowVaultManagement) {
      try {
        await ensureWorkProgressEntry({
          exists: (path) => this.app.vault.adapter.exists(path),
          ensureDirectory: (path) => this.ensureVaultDirectory(path),
          create: async (path, content) => {
            await this.app.vault.create(path, content);
          },
        });
      } catch (error) {
        new Notice(errorMessage(error, '无法创建工作沉淀文件入口'));
      }
    }
    const existing = this.app.workspace.getLeavesOfType(WORK_PROGRESS_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: WORK_PROGRESS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private scheduleContributionRefresh(path: string): void {
    if (!isContributionDataPath(path)) return;
    if (this.contributionRefreshTimer !== null) clearTimeout(this.contributionRefreshTimer);
    this.contributionRefreshTimer = setTimeout(() => {
      this.contributionRefreshTimer = null;
      for (const leaf of this.app.workspace.getLeavesOfType(WORK_CONTRIBUTION_VIEW_TYPE)) {
        const view = leaf.view;
        if (view instanceof WorkContributionView) {
          void Promise.all([
            view.refreshContribution(),
            view.refreshWeeklyCoachState(),
          ]);
        }
      }
    }, 250);
  }

  private scheduleWorkProgressRefresh(path: string): void {
    if (!isWorkProgressDataPath(path)) return;
    if (this.workProgressRefreshTimer !== null) clearTimeout(this.workProgressRefreshTimer);
    this.workProgressRefreshTimer = setTimeout(() => {
      this.workProgressRefreshTimer = null;
      this.refreshWorkProgressViews();
    }, 250);
  }

  private refreshWorkProgressViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WORK_PROGRESS_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WorkProgressView) void view.refresh();
    }
  }

  private async openWorkProgressPath(path: string): Promise<void> {
    if (!isSafeWorkProgressPath(path)) {
      new Notice('工作沉淀链接无效');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('找不到这项工作沉淀');
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private requestWeeklyFeedback(
    report: WorkProgressHubSnapshot['weeklyReports'][number],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (feedback: string | null) => {
        if (settled) return;
        settled = true;
        resolve(feedback);
      };
      new WeeklyFeedbackModal(
        this.app,
        { weekKey: report.weekKey, version: report.version },
        async (feedback) => settle(feedback),
        () => settle(null),
      ).open();
    });
  }

  private requestProgressDraft(initial?: ProgressDraft): Promise<ProgressDraft | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (draft: ProgressDraft | null) => {
        if (settled) return;
        settled = true;
        resolve(draft);
      };
      new ProgressEntryModal(
        this.app,
        async (draft) => settle(draft),
        () => settle(null),
        () => new Date(),
        initial,
      ).open();
    });
  }

  private requestMaterialGap(
    progress: WorkProgressHubSnapshot['progress'],
  ): Promise<PrepareMaterialGapRequestInput | null> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (input: PrepareMaterialGapRequestInput | null) => {
        if (settled) return;
        settled = true;
        resolve(input);
      };
      new MaterialGapEntryModal(
        this.app,
        progress,
        async (input) => settle(input),
        () => settle(null),
      ).open();
    });
  }

  private workProgressMeetingFileSystem() {
    return {
      exists: (path: string) => this.app.vault.adapter.exists(path),
      read: (path: string) => this.app.vault.adapter.read(path),
      listMarkdownFiles: async (path: string) => this.app.vault
        .getMarkdownFiles()
        .map((file) => file.path)
        .filter((filePath) => filePath.startsWith(`${path}/`)),
      ensureDirectory: (path: string) => this.ensureVaultDirectory(path),
      create: async (path: string, content: string) => {
        await this.app.vault.create(path, content);
      },
      removeIfContentMatches: async (path: string, expected: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        if (await this.app.vault.cachedRead(file) !== expected) return false;
        await this.app.vault.delete(file);
        return true;
      },
      process: async (path: string, transform: (content: string) => string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('会议笔记不存在');
        return this.app.vault.process(file, transform);
      },
    };
  }

  private async ensureVaultDirectory(path: string): Promise<void> {
    let directory = '';
    for (const segment of path.split('/').filter((value) => value !== '')) {
      directory = directory === '' ? segment : `${directory}/${segment}`;
      if (!(await this.app.vault.adapter.exists(directory))) {
        await this.app.vault.adapter.mkdir(directory);
      }
    }
  }

  private async listWorkProgressCalendarSources() {
    const sources = await Promise.all(this.app.vault.getMarkdownFiles()
      .filter((file) => file.path.startsWith('TaskNotes/DingTalk/'))
      .map(async (file) => {
        try {
          return parseDingTalkMeetingSource(
            file.path,
            await this.app.vault.adapter.read(file.path),
          );
        } catch {
          return null;
        }
      }));
    return sources.filter((source) => source !== null);
  }

  private async openContributionTask(taskId: string): Promise<void> {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    let file = markdownFiles.find((candidate) => (
      taskIdFromMetadata(
        candidate.path,
        this.app.metadataCache.getFileCache(candidate)?.frontmatter,
      ) === taskId
    ));
    if (file === undefined) {
      for (const candidate of markdownFiles) {
        if (!isAtlTaskPath(candidate.path)) continue;
        try {
          const markdown = await this.app.vault.cachedRead(candidate);
          if (taskIdFromMetadata(candidate.path, markdown) === taskId) {
            file = candidate;
            break;
          }
        } catch {
          // A concurrently moved task is skipped; the next refresh will update the list.
        }
      }
    }
    if (file === undefined) {
      new Notice('找不到这项任务文件');
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private async openContributionArtifact(artifactRef: string, taskId: string): Promise<void> {
    if (parseArtifactReference(artifactRef, taskId) === null) {
      new Notice('Agent 产出链接无效');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(`10_Tasks/${artifactRef}`);
    if (!(file instanceof TFile)) {
      new Notice('找不到这项 Agent 产出');
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  private openPluginSettings(): void {
    const setting = (this.app as typeof this.app & {
      setting?: { open(): void; openTabById?(id: string): void };
    }).setting;
    setting?.open();
    setting?.openTabById?.(this.manifest.id);
  }

  localPluginPaths(): LocalPluginPaths | null {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return null;
    const root = adapter.getBasePath();
    return {
      root,
      runnerPath: join(
        root,
        this.app.vault.configDir,
        'plugins',
        this.manifest.id,
        'atl-runner.mjs',
      ),
    };
  }

  createBackgroundController(): BackgroundRuntimeController | null {
    const paths = this.localPluginPaths();
    if (paths === null) return null;
    return new BackgroundRuntimeController(createBackgroundRuntimeDependencies({
      vaultRoot: paths.root,
      homeDirectory: homedir(),
      runnerPath: paths.runnerPath,
    }));
  }

  getDingTalkCredentialStore(): DingTalkCredentialStore {
    if (this.dingtalkCredentialStore === null) {
      this.dingtalkCredentialStore = createDingTalkCredentialStore({
        secretStorage: this.app.secretStorage,
        readLegacyKeychain: readLegacyDingTalkKeychainPassword,
      });
    }
    return this.dingtalkCredentialStore;
  }

  getDingTalkCalendarController(): DingTalkCalendarController {
    if (this.dingtalkCalendarController !== null) return this.dingtalkCalendarController;
    const adapter = this.app.vault.adapter;
    const timeZone = resolveSystemTimeZone();
    const fileSystem: DingTalkCalendarFileSystem = {
      exists: async (path) => adapter.exists(path),
      ensureDirectory: async (path) => {
        let directory = '';
        for (const segment of path.split('/').filter((value) => value !== '')) {
          directory = directory === '' ? segment : `${directory}/${segment}`;
          if (!(await adapter.exists(directory))) await adapter.mkdir(directory);
        }
      },
      listMarkdownFiles: async () => (
        this.app.vault.getMarkdownFiles().map((file) => file.path)
      ),
      read: async (path) => adapter.read(path),
      create: async (path, content) => {
        await this.app.vault.create(path, content);
      },
      modify: async (path, content) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('DingTalk calendar task file not found');
        await this.app.vault.modify(file, content);
      },
    };
    this.dingtalkCalendarController = new DingTalkCalendarController({
      client: createReadOnlyDingTalkCalDavClient(),
      writer: new DingTalkCalendarWriter({
        fileSystem,
        timeZone,
      }),
      credentialStore: this.getDingTalkCredentialStore(),
      getSettings: () => this.settings.dingtalkCalendar,
      saveSettings: async (settings) => {
        this.settings.dingtalkCalendar = settings;
        await this.saveSettings();
      },
      timeZone,
    });
    return this.dingtalkCalendarController;
  }

  async testDingTalkCalendarConnection(): Promise<string> {
    const summary = await this.getDingTalkCalendarController().testConnection();
    return summary.calendarName;
  }

  syncDingTalkCalendarNow(): Promise<void> {
    return this.dingtalkCalendarLifecycle?.run('manual') ?? Promise.resolve();
  }

  private async syncQianwenNow(): Promise<
    | { status: 'not_due' }
    | {
      status: 'completed';
      available: number;
      waiting: number;
      failed: number;
    }
  > {
    if (!this.settings.allowVaultManagement) {
      throw new Error('请先允许 ATL 管理此 Vault');
    }
    const paths = this.localPluginPaths();
    if (paths === null || !Platform.isDesktopApp) {
      throw new Error('千问听记同步仅支持 Obsidian 桌面版');
    }
    const runtimeRoot = qianwenRuntimeRoot({ runnerPath: paths.runnerPath });
    const result = await syncQianwenSource({
      repository: new FileQianwenSourceStateRepository(runtimeRoot, {
        writeAuthorization: createVaultWriteAuthorization(runtimeRoot),
      }),
      connector: new QianwenDesktopConnector(),
      now: new Date(),
      timeZone: resolveSystemTimeZone(),
      mode: 'manual',
    });
    this.refreshWorkProgressViews();
    if (result.status === 'not_due') return result;
    return {
      status: 'completed',
      available: result.snapshot.recordings.filter(({ status }) => status === 'available').length,
      waiting: result.snapshot.recordings.filter(({ status }) => status === 'waiting').length,
      failed: result.snapshot.recordings.filter(({ status }) => status === 'failed').length,
    };
  }

  openUnifiedCalendar(): Promise<void> {
    if (this.unifiedCalendarOpenInFlight !== null) {
      return this.unifiedCalendarOpenInFlight;
    }
    const opening = this.performOpenUnifiedCalendar().finally(() => {
      if (this.unifiedCalendarOpenInFlight === opening) {
        this.unifiedCalendarOpenInFlight = null;
      }
    });
    this.unifiedCalendarOpenInFlight = opening;
    return opening;
  }

  private async performOpenUnifiedCalendar(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('ATL 统一日历仅支持桌面版本地 Vault');
      return;
    }
    const root = adapter.getBasePath();
    const vaultPath = (path: string) => relative(root, path).split(sep).join('/');
    const controller = new UnifiedCalendarController({
      mkdir: async (path) => adapter.mkdir(vaultPath(path)),
      create: async (path, content) => {
        await this.app.vault.create(vaultPath(path), content);
      },
      process: async (path, update) => adapter.process(vaultPath(path), update),
    });

    try {
      const result = await controller.ensure(root);
      const file = this.app.vault.getAbstractFileByPath(ATL_UNIFIED_CALENDAR_PATH);
      if (!(file instanceof TFile)) {
        throw new Error('统一日历已创建，但 Obsidian 尚未识别该文件，请稍后重试');
      }
      await this.app.workspace.getLeaf(false).openFile(file);
      if (result.created) new Notice('已创建 ATL 统一日历');
    } catch (error) {
      new Notice(errorMessage(error, '无法打开 ATL 统一日历'));
    }
  }

  async clearDingTalkCalendarImportHistory(): Promise<void> {
    await this.getDingTalkCalendarController().clearImportHistory();
  }

  private initializeDingTalkCalendar(): void {
    const lifecycle = new DingTalkCalendarPluginLifecycle({
      isDesktop: Platform.isDesktopApp,
      isEnabled: () => this.settings.dingtalkCalendar.enabled,
      sync: () => this.getDingTalkCalendarController().sync(),
      addCommand: (command) => {
        this.addCommand(command);
      },
      onLayoutReady: (callback) => {
        this.app.workspace.onLayoutReady(callback);
      },
      registerInterval: (callback, milliseconds) => {
        this.registerInterval(window.setInterval(callback, milliseconds));
      },
      onSuccess: (result, source) => {
        if (source === 'manual' || result.errors > 0) {
          new Notice(formatDingTalkSyncResult(result));
        }
      },
      onError: (message) => {
        new Notice(message);
      },
    });
    this.dingtalkCalendarLifecycle = lifecycle;
    lifecycle.start();
  }

  private applyTaskCardTheme(): void {
    document.body.classList.toggle(
      CARD_THEME_CLASS,
      this.settings.taskCardThemeEnabled,
    );
  }

  private initializeTaskLifecycleReconciliation(): void {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const root = adapter.getBasePath();
    this.taskLifecycleReconciliation = new TaskLifecycleReconciliationController({
      context: createObsidianServiceContext(
        root,
        createVaultWriteAuthorization(root),
      ),
      onError: () => {
        new Notice('任务状态已更新，但 ATL 未能同步任务文件位置');
      },
    });
    this.register(() => {
      this.taskLifecycleReconciliation?.dispose();
      this.taskLifecycleReconciliation = null;
    });
  }

  private authorizedServiceContext(): {
    adapter: FileSystemAdapter;
    context: ServiceContext;
  } | null {
    if (!this.settings.allowVaultManagement) {
      new Notice('请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault');
      return null;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return null;
    }
    const root = adapter.getBasePath();
    return {
      adapter,
      context: createObsidianServiceContext(
        root,
        createVaultWriteAuthorization(root),
      ),
    };
  }

  private openQuickCapture(): void {
    const authorized = this.authorizedServiceContext();
    if (authorized === null) return;
    new QuickCaptureModal(this.app, async (input) => {
      await captureTask(authorized.context, input);
      new Notice('任务已加入 Inbox');
    }).open();
  }

  private async openMeetingTranscript(eventPath: string): Promise<void> {
    const authorized = this.authorizedServiceContext();
    if (authorized === null) return;
    const { adapter, context } = authorized;
    let source;
    try {
      source = parseDingTalkMeetingSource(
        eventPath,
        await adapter.read(eventPath),
      );
    } catch {
      new Notice('请选择有效的钉钉日程');
      return;
    }

    const fileSystem = {
      exists: async (path: string) => adapter.exists(path),
      read: async (path: string) => adapter.read(path),
      readBinary: async (path: string) => new Uint8Array(await adapter.readBinary(path)),
      ensureDirectory: async (path: string) => {
        let directory = '';
        for (const segment of path.split('/').filter(Boolean)) {
          directory = directory === '' ? segment : `${directory}/${segment}`;
          if (!(await adapter.exists(directory))) await adapter.mkdir(directory);
        }
      },
      create: async (path: string, content: string) => {
        await this.app.vault.create(path, content);
      },
      removeIfContentMatches: async (path: string, expected: string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return false;
        if (await this.app.vault.cachedRead(file) !== expected) return false;
        await this.app.vault.delete(file);
        return true;
      },
      createBinary: async (path: string, data: Uint8Array) => {
        await this.app.vault.createBinary(path, new Uint8Array(data).buffer);
      },
      process: async (path: string, transform: (content: string) => string) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error('会议笔记不存在');
        return this.app.vault.process(file, transform);
      },
      listMarkdownFiles: async (path: string) => this.app.vault
        .getMarkdownFiles()
        .map((file) => file.path)
        .filter((filePath) => filePath.startsWith(`${path}/`)),
    };
    const modelService = modelServiceConfiguration(this.settings.background);
    const modelLabel = modelService.model ?? 'inherit';
    const workflow = new MeetingAttachmentsWorkflow({
      fileSystem,
      executor: () => this.createStructuredExecutor(),
      modelLabel,
      candidateNotePath: (path) => join(adapter.getBasePath(), path),
    });
    let existing;
    try {
      existing = await workflow.load(eventPath);
    } catch {
      new Notice('无法读取已有会议资料，请检查会议笔记后重试');
      return;
    }
    const candidateController = new MeetingCandidateController({ context });
    const openMeetingFile = async (path: string): Promise<void> => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error('Obsidian 尚未识别会议笔记');
      await this.app.workspace.getLeaf(false).openFile(file);
    };

    new MeetingTranscriptModal(
      this.app,
      source,
      async (input, action) => {
        const result = action === 'save'
          ? await workflow.submit({ eventPath, ...input, action })
          : await workflow.submit({ eventPath, ...input, action });
        if (result === null) {
          const saved = await workflow.load(eventPath);
          if (saved !== null) await openMeetingFile(saved.meetingPath);
          new Notice('会议资料已保存');
          return null;
        }
        await openMeetingFile(result.meetingPath);
        return result;
      },
      {
        ...(existing === null ? {} : { initialForm: existing.form }),
        ...(existing?.result === null || existing?.result === undefined
          ? {}
          : { initialResult: existing.result }),
        ...(existing === null
          ? {}
          : { initialAnalysisStatus: existing.analysis.status }),
        modelLabel,
        pickTranscriptFile: async () => {
          const files = await this.pickMeetingFiles('transcript', false);
          return files[0] ?? null;
        },
        pickReferenceFiles: async () => this.pickMeetingFiles('reference', true),
        onCommitCandidates: async (prepared, selectedIds) => (
          candidateController.commit(prepared, selectedIds)
        ),
      },
    ).open();
  }

  private async pickMeetingFiles(
    role: 'transcript' | 'reference',
    multiple: boolean,
  ) {
    const dialog = getDirectoryDialog();
    if (dialog === null) throw new Error('当前 Obsidian 无法打开系统文件选择器');
    const result = await dialog.showOpenDialog({
      title: role === 'transcript' ? '选择会议听记文件' : '选择会议关联资料',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      ...(role === 'transcript'
        ? { filters: [{ name: '会议文档', extensions: ['txt', 'md', 'docx', 'pdf'] }] }
        : {}),
    });
    if (result.canceled) return [];
    const attachments = [];
    for (const path of result.filePaths) {
      const stats = await statExternalFile(path);
      if (!stats.isFile()) throw new Error('请选择有效文件');
      assertMeetingDocumentSize(stats.size);
      const data = new Uint8Array(await readExternalFile(path));
      attachments.push(await createMeetingAttachmentDraft({
        name: basename(path),
        mediaType: meetingAttachmentMediaType(path),
        data,
        role,
      }));
    }
    return attachments;
  }

  private scanSyncAssistant(): Promise<void> {
    if (this.syncScanInFlight !== null) {
      new Notice('ATL 正在扫描同步助手，请稍候');
      return this.syncScanInFlight;
    }
    const progress = new Notice('ATL 正在从同步助手获取待办...', 0);
    const scan = runWithPersistentFeedback(
      progress,
      () => this.performSyncAssistantScan(),
    ).finally(() => {
      if (this.syncScanInFlight === scan) this.syncScanInFlight = null;
    });
    this.syncScanInFlight = scan;
    return scan;
  }

  private async performSyncAssistantScan(): Promise<void> {
    const authorized = this.authorizedServiceContext();
    if (authorized === null) return;
    const { adapter, context } = authorized;
    if (!(await adapter.exists('笔记同步助手'))) {
      new Notice('尚未检测到“笔记同步助手”目录');
      return;
    }

    try {
      const executor = await this.createStructuredExecutor();
      const fileSystem = {
        exists: async (relativePath: string) => adapter.exists(relativePath),
        listMarkdownFiles: async (relativeDirectory: string) => (
          (await adapter.list(relativeDirectory)).files
        ),
        read: async (relativePath: string) => adapter.read(relativePath),
      };
      const controller = new CaptureController({
        context,
        readSources: async ({ now, lastSuccessfulScanAt }) => (
          readSyncSourceRecords({
            fileSystem,
            now,
            lastSuccessfulScanAt,
          })
        ),
        extractCandidates: async (records) => extractTaskCandidates({
          records,
          executor,
        }),
        getState: () => ({
          captureStateVersion: 2,
          lastSuccessfulScanAt: this.settings.capture.lastSuccessfulScanAt,
          reviewedFingerprints: [...this.settings.capture.reviewedFingerprints],
          processedRecordFingerprints: [
            ...this.settings.capture.processedRecordFingerprints,
          ],
        }),
        saveState: async (state: CaptureState) => {
          this.settings.capture = {
            captureStateVersion: 2,
            lastSuccessfulScanAt: state.lastSuccessfulScanAt,
            reviewedFingerprints: [...state.reviewedFingerprints],
            processedRecordFingerprints: [...state.processedRecordFingerprints],
          };
          await this.saveSettings();
        },
      });

      const prepared = await controller.scan();
      if (prepared.recordsConsidered === 0) {
        await controller.commit(prepared, []);
        new Notice('同步助手中没有需要扫描的新记录');
        return;
      }
      if (prepared.candidates.length === 0) {
        await controller.commit(prepared, []);
        new Notice('本次没有发现新的待办候选');
        return;
      }

      new CaptureCandidatesModal(this.app, prepared, async (selectedIds, ignoredIds) => {
        const result = await controller.commit(prepared, selectedIds, ignoredIds);
        const accepted = result.createdTaskIds.length + result.existingTaskIds.length;
        new Notice(accepted === 0 && ignoredIds.length > 0
          ? `已忽略 ${ignoredIds.length} 个待办候选`
          : accepted === 0
            ? '未选候选已保留，稍后仍可处理'
            : `已处理 ${accepted} 个待办候选`);
      }).open();
    } catch (error) {
      new Notice(errorMessage(
        error,
        '同步助手扫描失败，任务和扫描进度均未修改',
      ));
    }
  }

  private async ensureClaudeExecutable(): Promise<void> {
    if (this.settings.background.claudeExecutable !== '') return;
    const controller = this.createBackgroundController();
    if (controller === null) {
      throw new Error('当前 Obsidian 无法检测 Claude Code');
    }
    const inspection = await controller.inspect(this.settings.background);
    if (inspection.detected.nodeExecutable !== '') {
      this.settings.background.nodeExecutable = inspection.detected.nodeExecutable;
    }
    if (inspection.detected.claudeExecutable !== '') {
      this.settings.background.claudeExecutable = inspection.detected.claudeExecutable;
    }
    await this.saveSettings();
    if (inspection.checks.claude !== 'ok') {
      throw new Error(
        inspection.errorMessage ?? 'Claude Code 尚未就绪，请先在 ATL 设置中检测环境',
      );
    }
  }

  private async createStructuredExecutor() {
    await this.ensureClaudeExecutable();
    const background = this.settings.background;
    const modelService = modelServiceConfiguration(background);
    if (!modelService.valid) {
      throw new Error('模型配置无效，请在 ATL 设置中检查 Model 和 Base URL');
    }
    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment.ATL_CLAUDE_BIN;
    delete environment.ATL_CLAUDE_CONFIG_DIR;
    delete environment.ATL_CLAUDE_MODEL;
    environment.ATL_CLAUDE_BIN = background.claudeExecutable;
    environment.ATL_CLAUDE_CONFIG_DIR = background.claudeConfigDirectory;
    if (modelService.model !== undefined) {
      environment.ATL_CLAUDE_MODEL = modelService.model;
    }
    if (modelService.baseUrl !== undefined) {
      environment.ANTHROPIC_BASE_URL = modelService.baseUrl;
    }
    return createClaudeStructuredExecutor({ environment });
  }

  private async openConfirmation(file: TFile): Promise<void> {
    if (!this.settings.allowVaultManagement) {
      new Notice('请先在“设置 → Agent Task Loop”中允许 ATL 管理此 Vault');
      return;
    }
    const taskId = taskIdFromPath(file.path);
    const adapter = this.app.vault.adapter;
    if (taskId === null || !(adapter instanceof FileSystemAdapter)) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return;
    }

    const root = adapter.getBasePath();
    const authorization = createVaultWriteAuthorization(root);
    const controller = new ConfirmationController(createObsidianServiceContext(
      root,
      authorization,
    ));
    try {
      const prepared = await controller.prepare(taskId);
      new TaskConfirmationModal(
        this.app,
        controller,
        prepared,
        async (input) => enrichTask(await this.createStructuredExecutor(), input),
      ).open();
    } catch {
      new Notice('无法读取这项任务，请刷新看板后重试');
    }
  }

  private async authorizeTaskForAgent(path: string): Promise<void> {
    const authorized = this.authorizedServiceContext();
    if (authorized === null) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile) || !isAtlTaskPath(path)) {
      new Notice('请选择有效的 ATL 任务');
      return;
    }

    let taskId = taskIdFromPath(path);
    if (taskId === null) {
      try {
        taskId = taskIdFromMetadata(path, await this.app.vault.cachedRead(file));
      } catch {
        taskId = null;
      }
    }
    if (taskId === null) {
      new Notice('无法识别这项 ATL 任务');
      return;
    }

    try {
      await authorizeAgentExecution(authorized.context, taskId);
      new Notice('已授权 Agent 执行，系统将在下一轮领取');
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as Error & { code?: string }).code
        : undefined;
      if (code === 'task_agent_authorization_not_ready') {
        new Notice('任务信息不完整，请先补齐项目、目标和验收标准');
        return;
      }
      if (code === 'task_agent_authorization_invalid_state') {
        new Notice('任务已经不在待执行状态，请刷新看板');
        return;
      }
      new Notice('Agent 执行授权失败，请刷新任务后重试');
    }
  }

  private async openTaskBrief(path: string): Promise<void> {
    const authorized = this.authorizedServiceContext();
    if (authorized === null) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('请选择有效的 TaskNotes 任务');
      return;
    }

    let raw: string;
    try {
      raw = await this.app.vault.cachedRead(file);
    } catch {
      new Notice('无法读取这项任务，请刷新看板后重试');
      return;
    }
    const atlTask = isAtlTaskPath(file.path);
    const taskNotesTask = isTaskNotesTaskPath(file.path, raw);
    if (!atlTask && !taskNotesTask) {
      new Notice('请选择有效的 TaskNotes 任务');
      return;
    }

    if (taskNotesTask && !atlTask) {
      const controller = new TaskNotesTaskBriefController({
        path: file.path,
        read: (taskPath) => authorized.adapter.read(taskPath),
        process: async (taskPath, update) => {
          if (!this.settings.allowVaultManagement) {
            throw new Error('vault_management_disabled');
          }
          const target = this.app.vault.getAbstractFileByPath(taskPath);
          if (!(target instanceof TFile)) throw new Error('task_not_found');
          return this.app.vault.process(target, update);
        },
        appendAudit: (event) => authorized.context.audit.append(event),
        clock: authorized.context.clock,
      });
      try {
        const prepared = await controller.prepare();
        new TaskBriefModal(
          this.app,
          controller,
          prepared,
          async (input) => generateTaskBrief(
            await this.createStructuredExecutor(),
            input,
          ),
        ).open();
      } catch {
        new Notice('无法读取这项任务，请刷新看板后重试');
      }
      return;
    }

    let taskId: string | null;
    try {
      taskId = taskIdFromMetadata(file.path, raw);
    } catch {
      taskId = taskIdFromMetadata(
        file.path,
        this.app.metadataCache.getFileCache(file)?.frontmatter,
      );
    }
    if (taskId === null) {
      new Notice('无法识别这项 ATL 任务');
      return;
    }

    const controller = new TaskBriefController(authorized.context);
    try {
      const prepared = await controller.prepare(taskId);
      new TaskBriefModal(
        this.app,
        controller,
        prepared,
        async (input) => generateTaskBrief(
          await this.createStructuredExecutor(),
          input,
        ),
      ).open();
    } catch {
      new Notice('无法读取这项任务，请刷新看板后重试');
    }
  }

  private async copyTaskForCodex(file: TFile): Promise<void> {
    const taskId = taskIdFromPath(file.path);
    const adapter = this.app.vault.adapter;
    if (taskId === null || !(adapter instanceof FileSystemAdapter)) {
      new Notice('Agent Task Loop 仅支持桌面版本地 Vault');
      return;
    }
    const root = adapter.getBasePath();
    try {
      const context = createObsidianServiceContext(
        root,
        createVaultWriteAuthorization(root),
      );
      const task = await context.tasks.get(taskId);
      await navigator.clipboard.writeText(formatCodexHandoff(
        task,
        join(root, file.path),
      ));
      new Notice('任务上下文已复制，可粘贴到 Codex');
    } catch {
      new Notice('复制失败，请重新打开任务后重试');
    }
  }
}

const STATE_LABELS: Record<BackgroundInspection['state'], string> = {
  unconfigured: '未配置',
  installable: '待安装',
  ready: '已就绪',
  running: '正在执行',
  error: '配置异常',
};

const CHECK_LABELS = {
  ok: '正常',
  missing: '未找到',
  invalid: '无效',
  logged_out: '未登录',
  absent: '未安装',
  installed: '已安装',
  running: '执行中',
  conflict: '冲突',
  unknown: '待检测',
} as const;

class AgentTaskLoopSettingTab extends PluginSettingTab {
  private inspection: BackgroundInspection | null = null;
  private boardStatus: BoardPresetStatus | null = null;
  private taskNotesFieldStatus: TaskNotesFieldGovernanceStatus | null = null;
  private refreshing = false;
  private statusLoaded = false;

  constructor(private readonly atlPlugin: AgentTaskLoopPlugin) {
    super(atlPlugin.app, atlPlugin);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('atl-settings');
    this.renderVaultAccess(containerEl);
    this.renderContributionData(containerEl);
    this.renderDingTalkCalendar(containerEl);
    this.renderBackground(containerEl);
    this.renderBoard(containerEl);
    if (!this.refreshing && !this.statusLoaded) {
      void this.refreshStatus();
    }
  }

  private renderVaultAccess(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: 'Vault 权限' });
    new Setting(containerEl)
      .setName('允许 ATL 管理此 Vault')
      .setDesc('允许确认和移动任务、写入执行结果，并管理本插件的后台配置。默认关闭。')
      .addToggle((toggle) => toggle
        .setValue(this.atlPlugin.settings.allowVaultManagement)
        .onChange(async (value) => {
          this.atlPlugin.settings.allowVaultManagement = value;
          await this.atlPlugin.saveSettings();
          this.display();
        }));
    containerEl.createEl('p', {
      cls: 'setting-item-description atl-settings-note',
      text: 'ATL 只管理 10_Tasks 下的任务数据与自己的后台配置，不会修改其他 Obsidian 笔记。',
    });
  }

  private renderContributionData(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '个人首页数据' });
    new Setting(containerEl)
      .setName('任务贡献数据')
      .setDesc('来自 ATL 可审计的任务完成记录；不依赖 OpenToken，也不会修改任务。');
    new Setting(containerEl)
      .setName('Token 数据')
      .setDesc('自动读取本机 OpenToken 的每日汇总，只保存日期和聚合数字，不保存会话内容或凭据。未检测到时，请通过原安装来源安装或更新 OpenToken。');
  }

  private renderDingTalkCalendar(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '钉钉日历' });
    containerEl.createEl('p', {
      cls: 'setting-item-description atl-calendar-warning',
      text: '只从钉钉读取，不会创建、修改或删除钉钉日程。',
    });
    const calendar = this.atlPlugin.settings.dingtalkCalendar;
    new Setting(containerEl)
      .setName('启用日历同步')
      .setDesc('启动 Obsidian 时同步一次，此后每 15 分钟同步。')
      .addToggle((toggle) => toggle
        .setValue(calendar.enabled)
        .onChange(async (value) => {
          calendar.enabled = value;
          await this.atlPlugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('CalDAV 地址')
      .setDesc('填写钉钉提供的 HTTPS CalDAV 服务地址。')
      .addText((input) => {
        input.inputEl.type = 'url';
        input
          .setPlaceholder('https://calendar.example.com/caldav')
          .setValue(calendar.serverUrl)
          .onChange(async (value) => {
            calendar.serverUrl = value.trim();
            await this.atlPlugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName('账号')
      .setDesc('钉钉 CalDAV 账号。')
      .addText((input) => input
        .setPlaceholder('name@example.com')
        .setValue(calendar.username)
        .onChange(async (value) => {
          calendar.username = value.trim();
          await this.atlPlugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('密码')
      .setDesc('保存到 Obsidian SecretStorage，不写入插件 data.json；留空不会修改。')
      .addText((input) => {
        input.inputEl.type = 'password';
        input
          .setPlaceholder('输入或更新密码')
          .setValue('')
          .onChange(async (value) => {
            if (value !== '') {
              await this.atlPlugin.getDingTalkCredentialStore().setPassword(value);
            }
          });
      });
    new Setting(containerEl)
      .setName('同步范围')
      .setDesc('只读取主日历，回看最近 7 天并覆盖未来 90 天；个别历史日期失败不会阻断其他日期。');
    new Setting(containerEl)
      .setName('本地使用方式')
      .setDesc('导入到 TaskNotes/DingTalk，使用 scheduled 展示；可在 TaskNotes 日历中拖动本地副本。');

    const actions = new Setting(containerEl)
      .setName('连接与同步')
      .setDesc(calendar.lastResult === null
        ? '尚未同步'
        : formatDingTalkSyncResult(calendar.lastResult));
    actions.addButton((button) => button
      .setButtonText('测试连接')
      .onClick(async () => {
        try {
          const name = await this.atlPlugin.testDingTalkCalendarConnection();
          new Notice(`连接成功，已识别主日历：${name}`);
        } catch (error) {
          new Notice(errorMessage(error, '连接失败，请检查设置后重试'));
        }
      }));
    actions.addButton((button) => button
      .setCta()
      .setButtonText('立即同步')
      .setIcon('refresh-cw')
      .onClick(() => this.atlPlugin.syncDingTalkCalendarNow()));

    let clearArmed = false;
    new Setting(containerEl)
      .setName('清除导入记录')
      .setDesc('只清除同步 ledger，不删除 TaskNotes/DingTalk 中已有的本地文件。')
      .addButton((button) => button
        .setWarning()
        .setButtonText('清除记录')
        .onClick(async () => {
          if (!clearArmed) {
            clearArmed = true;
            button.setButtonText('再次点击确认清除');
            new Notice('再次点击确认；已有日历文件不会被删除');
            return;
          }
          await this.atlPlugin.clearDingTalkCalendarImportHistory();
          new Notice('钉钉日历导入记录已清除，本地文件未删除');
          this.display();
        }));
  }

  private renderBackground(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '后台执行' });
    const inspection = this.inspection;
    new Setting(containerEl)
      .setName('运行状态')
      .setDesc(inspection === null
        ? '正在检测本机环境…'
        : inspection.errorMessage ?? '每天 08:00 至 22:00 整点检查可执行的调研任务。')
      .then((setting) => setting.controlEl.createSpan({
        cls: `atl-status-badge atl-status-${inspection?.state ?? 'loading'}`,
        text: inspection === null ? '检测中' : STATE_LABELS[inspection.state],
      }));

    if (inspection !== null) {
      const checks = containerEl.createDiv({ cls: 'atl-runtime-checks' });
      this.renderCheck(checks, 'ATL Runner', inspection.checks.runner);
      this.renderCheck(checks, 'Node.js 24+', inspection.checks.node);
      this.renderCheck(checks, 'Claude Code', inspection.checks.claude);
      this.renderCheck(checks, '后台任务', inspection.checks.scheduler);
    }

    const background = this.atlPlugin.settings.background;
    let applyConfigButton: ButtonComponent | null = null;
    const updateApplyAvailability = () => {
      applyConfigButton?.setDisabled(
        !this.atlPlugin.settings.allowVaultManagement
        || !modelServiceFieldState(background).canApply,
      );
    };
    new Setting(containerEl)
      .setName('模型服务')
      .setDesc('沿用 Claude Code 当前配置，或为 ATL 单独指定模型服务。')
      .addDropdown((dropdown) => dropdown
        .addOption('inherit', '沿用 Claude Code 当前配置')
        .addOption('custom', '自定义服务')
        .setValue(background.modelServiceMode)
        .onChange(async (value) => {
          background.modelServiceMode = value === 'custom' ? 'custom' : 'inherit';
          await this.atlPlugin.saveSettings();
          this.display();
        }));

    const notificationSetting = new Setting(containerEl)
      .setName('待验收通知')
      .setDesc('填写 DingTalk profile 后，新的 Artifact 和周报会通知你本人；留空则关闭钉钉通知。');
    notificationSetting.addText((input) => input
      .setPlaceholder('例如 default')
      .setValue(background.dingtalkProfile)
      .onChange(async (value) => {
        const normalized = value.trim();
        if (normalized !== '' && optionalDingTalkProfile(normalized) === null) {
          notificationSetting.setDesc('请输入一个明确的 DingTalk profile，不能包含逗号或换行。');
          return;
        }
        background.dingtalkProfile = normalized;
        await this.atlPlugin.saveSettings();
        notificationSetting.setDesc(
          '填写 DingTalk profile 后，新的 Artifact 和周报会通知你本人；留空则关闭钉钉通知。',
        );
      }));

    const modelFields = modelServiceFieldState(background);
    if (modelFields.showCustomFields) {
      const modelSetting = new Setting(containerEl)
        .setName('Model')
        .setDesc(modelFields.modelError ?? '填写服务支持的模型标识。');
      modelSetting.addText((input) => input
        .setPlaceholder('例如 glm-4-flash')
        .setValue(background.model)
        .onChange(async (value) => {
          background.model = value;
          await this.atlPlugin.saveSettings();
          const state = modelServiceFieldState(background);
          modelSetting.setDesc(state.modelError ?? '填写服务支持的模型标识。');
          updateApplyAvailability();
        }));

      const baseUrlSetting = new Setting(containerEl)
        .setName('Base URL')
        .setDesc(modelFields.baseUrlError ?? '填写完整的 http 或 https 服务地址。');
      baseUrlSetting.addText((input) => {
        input.inputEl.type = 'url';
        input
          .setPlaceholder('https://api.example.com/anthropic')
          .setValue(background.baseUrl)
          .onChange(async (value) => {
            background.baseUrl = value;
            await this.atlPlugin.saveSettings();
            const state = modelServiceFieldState(background);
            baseUrlSetting.setDesc(
              state.baseUrlError ?? '填写完整的 http 或 https 服务地址。',
            );
            updateApplyAvailability();
          });
      });
      containerEl.createEl('p', {
        cls: 'setting-item-description atl-settings-note',
        text: 'Agent 调研时会把任务目标和已授权资料发送到该服务。API Key 仍由 Claude Code 或系统环境管理，ATL 不会保存。',
      });
    }

    new Setting(containerEl)
      .setName('资料来源文件夹')
      .setDesc('Agent 只能读取你在这里选择的本地文件夹。')
      .addButton((button) => button
        .setButtonText('选择文件夹')
        .setIcon('folder-plus')
        .onClick(() => this.pickSourceFolders()));
    const roots = this.atlPlugin.settings.background.allowedLocalRoots;
    const sourceList = containerEl.createDiv({ cls: 'atl-source-list' });
    if (roots.length === 0) {
      sourceList.createSpan({
        cls: 'setting-item-description',
        text: '尚未添加资料来源',
      });
    }
    roots.forEach((path) => {
      new Setting(sourceList)
        .setName(basename(path))
        .setDesc(path)
        .addExtraButton((button) => button
          .setIcon('trash-2')
          .setTooltip('移除资料来源')
          .onClick(async () => {
            this.atlPlugin.settings.background.allowedLocalRoots = roots.filter(
              (candidate) => candidate !== path,
            );
            await this.atlPlugin.saveSettings();
            this.inspection = null;
            this.statusLoaded = false;
            this.display();
          }));
    });

    const actions = new Setting(containerEl)
      .setName('后台操作')
      .setDesc('启用后无需打开终端；试跑只处理符合条件的待执行任务。');
    const actionState = backgroundActionState({
      state: inspection?.state ?? 'unconfigured',
    });
    if (inspection?.state === 'installable'
      || inspection?.state === 'ready'
      || inspection?.state === 'running') {
      actions.addButton((button) => {
        applyConfigButton = button;
        button
          .setCta()
          .setButtonText(actionState.primaryLabel)
          .setDisabled(
            !this.atlPlugin.settings.allowVaultManagement
            || !modelServiceFieldState(background).canApply,
          )
          .onClick(() => this.enableBackground());
      });
    } else {
      actions.addButton((button) => button
        .setButtonText(actionState.primaryLabel)
        .setIcon('refresh-cw')
        .onClick(() => this.refreshStatus()));
    }
    if (actionState.canRunNow) {
      actions.addButton((button) => button
        .setButtonText('立即试跑')
        .setIcon('play')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.runNow()));
    }
    const schedulerManaged = inspection?.checks.scheduler === 'installed'
      || inspection?.checks.scheduler === 'running';
    if (actionState.canDisable && schedulerManaged) {
      actions.addExtraButton((button) => button
        .setIcon('power')
        .setTooltip('停用后台执行')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.disableBackground()));
    }

    if (inspection !== null) {
      const details = containerEl.createEl('details', { cls: 'atl-technical-details' });
      details.createEl('summary', { text: '技术详情' });
      const nodePath = inspection.detected.nodeExecutable || '未检测到';
      const claudePath = inspection.detected.claudeExecutable || '未检测到';
      details.createEl('p', { text: `Node.js: ${nodePath}` });
      details.createEl('p', { text: `Claude Code: ${claudePath}` });
    }
  }

  private renderBoard(containerEl: HTMLElement): void {
    containerEl.createEl('h2', { text: '任务看板' });
    new Setting(containerEl)
      .setName('统一任务日历')
      .setDesc('同时查看本地任务和钉钉日程；未设置计划时间的任务在“待排期任务”中。')
      .addButton((button) => button
        .setCta()
        .setButtonText('打开统一日历')
        .setIcon('calendar-range')
        .onClick(() => this.atlPlugin.openUnifiedCalendar()));
    new Setting(containerEl)
      .setName('ATL 紧凑卡片')
      .setDesc('在 TaskNotes 看板中优先显示项目、来源日期、入箱时间、有效计划时间和优先级，并在日历中单行省略过长标题。')
      .addToggle((toggle) => toggle
        .setValue(this.atlPlugin.settings.taskCardThemeEnabled)
        .onChange(async (value) => {
          this.atlPlugin.settings.taskCardThemeEnabled = value;
          await this.atlPlugin.saveSettings();
        }));

    const fieldControlState = taskNotesFieldControlState(
      this.taskNotesFieldStatus,
      this.atlPlugin.settings.allowVaultManagement,
    );
    const fieldSetting = new Setting(containerEl)
      .setName('任务编辑字段')
      .setDesc(fieldControlState.description);
    if (fieldControlState.showApply) {
      fieldSetting.addButton((button) => button
        .setCta()
        .setButtonText('应用精简字段')
        .setDisabled(fieldControlState.disabled)
        .onClick(() => this.applyTaskNotesFieldPreset()));
    }
    if (fieldControlState.showRestore) {
      fieldSetting.addButton((button) => button
        .setButtonText('恢复原字段')
        .setDisabled(fieldControlState.disabled)
        .onClick(() => this.restoreTaskNotesFieldPreset()));
    }

    const status = this.boardStatus;
    const setting = new Setting(containerEl)
      .setName('人工任务看板布局')
      .setDesc(status === null
        ? '正在读取任务总看板…'
        : status.available
          ? '按任务状态显示四列，并保留人工拖动优先；首次应用会保留原始备份。'
          : '未找到 10_Tasks/Views/任务总看板.base');
    if (status?.available === true && !status.applied) {
      setting.addButton((button) => button
        .setCta()
        .setButtonText('应用人工任务布局')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.applyBoardPreset()));
    }
    if (status?.restorable === true) {
      setting.addButton((button) => button
        .setButtonText('恢复原布局')
        .setDisabled(!this.atlPlugin.settings.allowVaultManagement)
        .onClick(() => this.restoreBoardPreset()));
    }
  }

  private renderCheck(
    container: HTMLElement,
    label: string,
    state: keyof typeof CHECK_LABELS,
  ): void {
    const row = container.createDiv({ cls: 'atl-runtime-check' });
    row.createSpan({ text: label });
    row.createSpan({
      cls: `atl-check-value atl-check-${state}`,
      text: CHECK_LABELS[state],
    });
  }

  private async refreshStatus(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const paths = this.atlPlugin.localPluginPaths();
      const controller = this.atlPlugin.createBackgroundController();
      this.inspection = controller === null
        ? null
        : await controller.inspect(this.atlPlugin.settings.background);
      if (this.inspection !== null) {
        const { detected } = this.inspection;
        if (detected.nodeExecutable !== '') {
          this.atlPlugin.settings.background.nodeExecutable = detected.nodeExecutable;
        }
        if (detected.claudeExecutable !== '') {
          this.atlPlugin.settings.background.claudeExecutable = detected.claudeExecutable;
        }
        await this.atlPlugin.saveSettings();
      }
      this.boardStatus = paths === null
        ? { available: false, applied: false, restorable: false }
        : await this.atlPlugin.boardAppearance.status(paths.root);
    } catch (error) {
      new Notice(errorMessage(error, '无法读取 ATL 配置'));
    }
    try {
      this.taskNotesFieldStatus = await this.atlPlugin
        .createTaskNotesFieldGovernanceIntegration()
        .status();
    } finally {
      this.refreshing = false;
      this.statusLoaded = true;
      this.display();
    }
  }

  private async pickSourceFolders(): Promise<void> {
    const dialog = getDirectoryDialog();
    if (dialog === null) {
      new Notice('当前 Obsidian 无法打开系统文件夹选择器');
      return;
    }
    const result = await dialog.showOpenDialog({
      title: '选择 Agent 可以读取的资料文件夹',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (result.canceled) return;
    this.atlPlugin.settings.background.allowedLocalRoots = [...new Set([
      ...this.atlPlugin.settings.background.allowedLocalRoots,
      ...result.filePaths,
    ])];
    await this.atlPlugin.saveSettings();
    this.inspection = null;
    this.statusLoaded = false;
    this.display();
  }

  private async enableBackground(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.enable(this.atlPlugin.settings.background);
      new Notice('ATL 后台执行已启用');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法启用 ATL 后台执行'));
    }
  }

  private async runNow(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.runNow();
      new Notice('已启动一次 ATL 任务检查');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法启动 ATL 任务检查'));
    }
  }

  private async disableBackground(): Promise<void> {
    const controller = this.atlPlugin.createBackgroundController();
    if (controller === null) return;
    try {
      await controller.disable();
      new Notice('ATL 后台执行已停用');
      this.inspection = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法停用 ATL 后台执行'));
    }
  }

  private async applyBoardPreset(): Promise<void> {
    const paths = this.atlPlugin.localPluginPaths();
    if (paths === null) return;
    try {
      await this.atlPlugin.boardAppearance.applyRecommendedPreset(paths.root);
      new Notice('已应用 ATL 推荐看板布局，并保留原始备份');
      this.boardStatus = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法应用推荐看板布局'));
    }
  }

  private async refreshTaskNotesFieldStatus(): Promise<void> {
    this.taskNotesFieldStatus = await this.atlPlugin
      .createTaskNotesFieldGovernanceIntegration()
      .status();
  }

  private async applyTaskNotesFieldPreset(): Promise<void> {
    try {
      await this.atlPlugin.createTaskNotesFieldGovernanceIntegration().apply();
    } finally {
      await this.refreshTaskNotesFieldStatus();
      this.display();
    }
  }

  private async restoreTaskNotesFieldPreset(): Promise<void> {
    try {
      await this.atlPlugin.createTaskNotesFieldGovernanceIntegration().restore();
    } finally {
      await this.refreshTaskNotesFieldStatus();
      this.display();
    }
  }

  private async restoreBoardPreset(): Promise<void> {
    const paths = this.atlPlugin.localPluginPaths();
    if (paths === null) return;
    try {
      await this.atlPlugin.boardAppearance.restorePreset(paths.root);
      new Notice('已恢复原始任务看板布局');
      this.boardStatus = null;
      this.statusLoaded = false;
      this.display();
    } catch (error) {
      new Notice(errorMessage(error, '无法恢复任务看板布局'));
    }
  }
}
