import { App, Modal } from 'obsidian';

export interface CompletionDateBackfillTask {
  taskId: string;
  title: string;
}

export class CompletionDateBackfillModal extends Modal {
  constructor(
    app: App,
    private readonly tasks: readonly CompletionDateBackfillTask[],
    private readonly onSubmit: (taskId: string, completedOn: string) => Promise<void>,
    private readonly canSubmit: () => boolean = () => true,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.modalEl.classList.add('atl-completion-backfill-modal');
    this.render();
  }

  override onClose(): void {
    this.contentEl.replaceChildren();
  }

  private render(): void {
    this.contentEl.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = '补齐历史完成日期';
    const description = document.createElement('p');
    description.className = 'atl-task-subtitle';
    description.textContent = '请选择你实际完成任务的日期。系统不会自动推断历史完成时间。';
    const list = document.createElement('div');
    list.className = 'atl-completion-backfill-list';
    for (const task of this.tasks) list.append(this.createRow(task));
    this.contentEl.append(title, description, list);
  }

  private createRow(task: CompletionDateBackfillTask): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'atl-completion-backfill-row';
    row.dataset.backfillTaskId = task.taskId;

    const taskTitle = document.createElement('strong');
    taskTitle.className = 'atl-completion-backfill-title';
    taskTitle.textContent = task.title.trim() === '' ? '未命名任务' : task.title;

    const input = document.createElement('input');
    input.type = 'date';
    input.setAttribute('aria-label', `${taskTitle.textContent}的完成日期`);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '补齐';
    button.disabled = true;

    const status = document.createElement('span');
    status.className = 'atl-completion-backfill-status';
    status.setAttribute('role', 'status');

    let submitting = false;
    input.addEventListener('input', () => {
      status.textContent = '';
      button.disabled = submitting || input.value === '';
    });
    button.addEventListener('click', () => {
      if (submitting || input.value === '') return;
      if (!this.canSubmit()) {
        status.textContent = 'Vault 管理权限已关闭，请重新开启后再补齐';
        return;
      }
      submitting = true;
      input.disabled = true;
      button.disabled = true;
      button.textContent = '补齐中...';
      status.textContent = '';
      void this.onSubmit(task.taskId, input.value).then(() => {
        row.remove();
      }).catch(() => {
        submitting = false;
        input.disabled = false;
        button.disabled = input.value === '';
        button.textContent = '补齐';
        status.textContent = '补齐失败，请重试';
      });
    });

    row.append(taskTitle, input, button, status);
    return row;
  }
}
