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

export class TextComponent {
  readonly inputEl = document.createElement('input');

  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
    return this;
  }
}

export class TextAreaComponent {
  readonly inputEl = document.createElement('textarea');

  setPlaceholder(value: string): this {
    this.inputEl.placeholder = value;
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener('input', () => callback(this.inputEl.value));
    return this;
  }
}

export class DropdownComponent {
  readonly selectEl = document.createElement('select');

  addOption(value: string, label: string): this {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    this.selectEl.append(option);
    return this;
  }

  setValue(value: string): this {
    this.selectEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.selectEl.addEventListener('change', () => callback(this.selectEl.value));
    return this;
  }
}

export class Setting {
  readonly settingEl = document.createElement('div');

  constructor(container: HTMLElement) {
    this.settingEl.classList.add('setting-item');
    container.append(this.settingEl);
  }

  setName(value: string): this {
    this.settingEl.dataset.name = value;
    return this;
  }

  setDesc(value: string): this {
    this.settingEl.dataset.description = value;
    return this;
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

  addText(callback: (text: TextComponent) => void): this {
    const text = new TextComponent();
    callback(text);
    this.settingEl.append(text.inputEl);
    return this;
  }

  addTextArea(callback: (text: TextAreaComponent) => void): this {
    const text = new TextAreaComponent();
    callback(text);
    this.settingEl.append(text.inputEl);
    return this;
  }

  addDropdown(callback: (dropdown: DropdownComponent) => void): this {
    const dropdown = new DropdownComponent();
    callback(dropdown);
    this.settingEl.append(dropdown.selectEl);
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
