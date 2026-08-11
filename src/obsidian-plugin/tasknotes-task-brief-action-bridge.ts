export interface TaskNotesTaskBriefActionBridgeDependencies {
  document: Document;
  isTaskNotesEnabled(): boolean;
  getEligibleTaskPaths(): string[];
  open(path: string): void;
  notice(message: string): void;
  setIcon(element: HTMLElement, icon: string): void;
  saveTimeoutMs?: number;
}

const ACTION_SELECTOR = '[data-atl-task-brief-action]';
const BUTTON_BAR_SELECTOR = '.tn-task-modal__button-bar';
const EDIT_MODAL_SELECTOR = '.minimalist-task-modal';
const METADATA_VALUE_SELECTOR = '.metadata-item .metadata-value';
const OPEN_NOTE_SELECTOR = '.tn-task-modal__open-note-button';
const SAVE_BUTTON_SELECTOR = 'button.mod-cta';
const SAVE_FAILED_MESSAGE = '任务尚未保存，请检查当前字段后重试';
const TASK_NOT_FOUND_MESSAGE = '无法识别当前任务，请使用文件菜单中的智能完善任务';

interface PendingSave {
  button: HTMLButtonElement;
  disabledStates: Map<HTMLButtonElement, boolean>;
  dismissRoot: EventTarget;
  label: HTMLElement;
  observer: MutationObserver;
  preventDismissClick: EventListener;
  preventEscape: EventListener;
  timeout: ReturnType<typeof setTimeout>;
}

export class TaskNotesTaskBriefActionBridge {
  private readonly observers = new Map<Document, MutationObserver>();
  private readonly pendingSaves = new Map<HTMLElement, PendingSave>();

  constructor(
    private readonly dependencies: TaskNotesTaskBriefActionBridgeDependencies,
  ) {}

  start(): void {
    this.addDocument(this.dependencies.document);
  }

  addDocument(document: Document): void {
    if (
      this.observers.has(document)
      || document.body === null
    ) {
      return;
    }
    this.scan(document);
    const MutationObserverConstructor = document.defaultView?.MutationObserver
      ?? MutationObserver;
    const observer = new MutationObserverConstructor(() => this.scan(document));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.observers.set(document, observer);
  }

  removeDocument(document: Document): void {
    this.observers.get(document)?.disconnect();
    this.observers.delete(document);
    for (const modal of [...this.pendingSaves.keys()]) {
      if (modal.ownerDocument === document) this.takePendingSave(modal);
    }
    document.querySelectorAll(ACTION_SELECTOR).forEach((action) => action.remove());
  }

  stop(): void {
    for (const document of [...this.observers.keys()]) {
      this.removeDocument(document);
    }
  }

  private scan(document: Document): void {
    if (!this.dependencies.isTaskNotesEnabled()) return;
    document
      .querySelectorAll<HTMLElement>(EDIT_MODAL_SELECTOR)
      .forEach((modal) => this.inject(modal));
  }

  private inject(modal: HTMLElement): void {
    const buttonBar = modal.querySelector<HTMLElement>(BUTTON_BAR_SELECTOR);
    const openNote = modal.querySelector<HTMLElement>(OPEN_NOTE_SELECTOR);
    if (
      buttonBar === null
      || openNote === null
      || buttonBar.querySelector(ACTION_SELECTOR) !== null
    ) {
      return;
    }

    const button = this.dependencies.document.createElement('button');
    button.type = 'button';
    button.dataset.atlTaskBriefAction = '';

    const icon = this.dependencies.document.createElement('span');
    icon.className = 'atl-task-brief-action__icon';
    this.dependencies.setIcon(icon, 'sparkles');

    const label = this.dependencies.document.createElement('span');
    label.className = 'atl-task-brief-action__label';
    label.textContent = '智能完善';
    button.append(icon, label);
    button.addEventListener('click', () => this.handleAction(modal, button, label));
    buttonBar.insertBefore(button, openNote);
  }

  private handleAction(
    modal: HTMLElement,
    button: HTMLButtonElement,
    label: HTMLElement,
  ): void {
    if (this.pendingSaves.has(modal)) return;

    const eligiblePaths = new Set(this.dependencies.getEligibleTaskPaths());
    const matchingPaths = [...new Set(
      Array.from(modal.querySelectorAll<HTMLElement>(METADATA_VALUE_SELECTOR))
        .filter((value) => this.isVisible(value, modal))
        .map((value) => value.textContent?.trim() ?? '')
        .filter((path) => eligiblePaths.has(path)),
    )];
    if (matchingPaths.length !== 1) {
      this.dependencies.notice(TASK_NOT_FOUND_MESSAGE);
      return;
    }

    const buttonBar = modal.querySelector<HTMLElement>(BUTTON_BAR_SELECTOR);
    if (buttonBar === null) {
      this.dependencies.notice(SAVE_FAILED_MESSAGE);
      return;
    }
    const saveButton = buttonBar.querySelector<HTMLButtonElement>(SAVE_BUTTON_SELECTOR);
    if (saveButton === null) {
      this.dependencies.notice(SAVE_FAILED_MESSAGE);
      return;
    }

    const disabledStates = new Map<HTMLButtonElement, boolean>();
    buttonBar.querySelectorAll<HTMLButtonElement>('button').forEach((control) => {
      if (control === saveButton) return;
      disabledStates.set(control, control.disabled);
      control.disabled = true;
    });
    label.textContent = '正在保存...';
    const ownerDocument = modal.ownerDocument;
    const dismissRoot = modal.closest('.modal-container') ?? ownerDocument;
    const preventDismissClick: EventListener = (event) => {
      const target = event.target as { closest?: (selector: string) => Element | null } | null;
      const dismissTarget = target?.closest?.('.modal-close-button, .modal-bg');
      if (dismissTarget === null || dismissTarget === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const preventEscape: EventListener = (event) => {
      if ((event as KeyboardEvent).key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    dismissRoot.addEventListener('click', preventDismissClick, true);
    modal.addEventListener('keydown', preventEscape, true);

    const MutationObserverConstructor = ownerDocument.defaultView?.MutationObserver
      ?? MutationObserver;
    const observer = new MutationObserverConstructor(() => {
      if (!modal.isConnected) this.finishSave(modal, matchingPaths[0]!);
    });
    observer.observe(ownerDocument.body, {
      childList: true,
      subtree: true,
    });
    const timeout = setTimeout(
      () => this.failSave(modal),
      this.dependencies.saveTimeoutMs ?? 5_000,
    );
    this.pendingSaves.set(modal, {
      button,
      disabledStates,
      dismissRoot,
      label,
      observer,
      preventDismissClick,
      preventEscape,
      timeout,
    });

    saveButton.click();
    if (!modal.isConnected) this.finishSave(modal, matchingPaths[0]!);
  }

  private finishSave(modal: HTMLElement, path: string): void {
    const pending = this.takePendingSave(modal);
    if (pending === null) return;
    this.dependencies.open(path);
  }

  private failSave(modal: HTMLElement): void {
    const pending = this.takePendingSave(modal);
    if (pending === null) return;
    pending.button.disabled = false;
    pending.label.textContent = '智能完善';
    this.dependencies.notice(SAVE_FAILED_MESSAGE);
  }

  private takePendingSave(modal: HTMLElement): PendingSave | null {
    const pending = this.pendingSaves.get(modal) ?? null;
    if (pending === null) return null;
    pending.observer.disconnect();
    clearTimeout(pending.timeout);
    pending.dismissRoot.removeEventListener('click', pending.preventDismissClick, true);
    modal.removeEventListener('keydown', pending.preventEscape, true);
    for (const [control, disabled] of pending.disabledStates) {
      control.disabled = disabled;
    }
    this.pendingSaves.delete(modal);
    return pending;
  }

  private isVisible(element: HTMLElement, modal: HTMLElement): boolean {
    if (element.closest('[hidden], [aria-hidden="true"]') !== null) return false;
    const view = element.ownerDocument.defaultView;
    if (view === null) return true;
    let current: HTMLElement | null = element;
    while (current !== null && current !== modal) {
      const style = view.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      current = current.parentElement;
    }
    return true;
  }
}
