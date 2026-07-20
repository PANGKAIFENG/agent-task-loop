export class App {}

export class WorkspaceLeaf {
  readonly app = new App();
  view: unknown = null;

  async setViewState(state: unknown): Promise<void> {
    void state;
  }
}

export class ItemView {
  readonly app: App;
  readonly containerEl = document.createElement('div');
  readonly contentEl = document.createElement('div');

  constructor(readonly leaf: WorkspaceLeaf) {
    this.app = leaf.app;
    this.containerEl.append(this.contentEl);
    leaf.view = this;
  }
}

export function setIcon(element: HTMLElement, icon: string): void {
  element.dataset.icon = icon;
}

export class ButtonComponent {
  readonly buttonEl = document.createElement('button');

  setButtonText(value: string): this {
    this.buttonEl.textContent = value;
    return this;
  }

  setDisabled(value: boolean): this {
    this.buttonEl.disabled = value;
    return this;
  }

  setCta(): this {
    return this;
  }

  onClick(callback: () => void): this {
    this.buttonEl.addEventListener('click', callback);
    return this;
  }
}

export class Setting {
  readonly settingEl = document.createElement('div');

  constructor(container: HTMLElement) {
    container.append(this.settingEl);
  }

  setClass(value: string): this {
    this.settingEl.classList.add(value);
    return this;
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    const button = new ButtonComponent();
    callback(button);
    this.settingEl.append(button.buttonEl);
    return this;
  }
}

export class Modal {
  readonly containerEl = document.createElement('div');
  readonly modalEl = document.createElement('div');
  readonly contentEl = document.createElement('div');
  selection: Selection | null = null;

  constructor(readonly app: unknown) {
    this.modalEl.append(this.contentEl);
    this.containerEl.append(this.modalEl);
  }

  open(): void {
    // Obsidian owns this runtime field while restoring editor selection.
    this.selection = window.getSelection();
    (this as unknown as { onOpen(): void }).onOpen();
  }

  close(): void {
    (this as unknown as { onClose(): void }).onClose();
  }
}
