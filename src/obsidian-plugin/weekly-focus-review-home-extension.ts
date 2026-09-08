import type { WeeklyFocusReviewIndex } from '../services/query-weekly-focus-review.js';

export interface WeeklyFocusReviewHomeExtensionDependencies {
  loadIndex: () => Promise<WeeklyFocusReviewIndex>;
  openReview: (week: string) => Promise<void> | void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class WeeklyFocusReviewHomeExtension {
  private observer: MutationObserver | null = null;
  private index: WeeklyFocusReviewIndex | null = null;
  private stopped = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly dependencies: WeeklyFocusReviewHomeExtensionDependencies,
  ) {}

  start(): void {
    this.stopped = false;
    this.observer = new MutationObserver(() => this.mount());
    this.observer.observe(this.root, { childList: true, subtree: true });
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    this.observer?.disconnect();
    this.observer = null;
    this.root.querySelector('.atl-weekly-focus-review-home')?.remove();
  }

  async refresh(): Promise<void> {
    try {
      this.index = await this.dependencies.loadIndex();
    } catch {
      this.index = null;
    }
    if (!this.stopped) this.mount();
  }

  private mount(): void {
    if (this.index === null || this.stopped) return;
    const overview = this.root.querySelector<HTMLElement>('.atl-home-view-overview');
    if (overview === null || overview.querySelector('.atl-weekly-focus-review-home') !== null) {
      return;
    }
    const section = element('section', 'atl-weekly-focus-review-home');
    const header = element('header', 'atl-weekly-focus-review-home-header');
    const title = element('div');
    title.append(
      element('small', undefined, 'WEEKLY FOCUS REVIEW'),
      element('h2', undefined, '本周重点复盘'),
    );
    header.append(title);
    section.append(header);

    const states = element('div', 'atl-weekly-focus-review-home-states');
    const current = this.index.current;
    if (current === null) {
      states.append(this.renderState(
        '本周',
        '本周尚未确认重点',
        '先通过本周思考教练确认 0-3 项重点。',
      ));
    } else {
      states.append(this.renderState(
        '本周',
        current.record.reviewStatus === '已复盘' ? '本周已复盘' : '本周待复盘',
        current.record.input.noNewFocus
          ? '本周明确不新增重点'
          : `${current.record.input.focuses.length} 项已确认重点`,
        current.record.week,
      ));
    }

    const previous = this.index.previousPending[0];
    if (previous !== undefined) {
      states.append(this.renderState(
        '跨周提醒',
        '上一周待复盘',
        `${previous.record.week} · ${previous.record.input.focuses.length} 项重点`,
        previous.record.week,
      ));
    }

    const pastReviewed = this.index.reviewed.find(({ record }) => (
      record.week !== this.index?.currentWeek
    ));
    if (pastReviewed !== undefined) {
      states.append(this.renderState(
        '历史',
        '已复盘记录',
        `${pastReviewed.record.week} · 可继续修订`,
        pastReviewed.record.week,
      ));
    }
    section.append(states);
    if (this.index.readFailures.length > 0) {
      section.append(element(
        'p',
        'atl-weekly-focus-review-home-warning',
        '部分周记录读取失败；打开后重试，不会覆盖人工内容。',
      ));
    }

    const focus = overview.querySelector('.atl-home-focus');
    if (focus === null) overview.append(section);
    else focus.insertAdjacentElement('afterend', section);
  }

  private renderState(
    eyebrow: string,
    title: string,
    detail: string,
    week?: string,
  ): HTMLElement {
    const card = element(week === undefined ? 'div' : 'button', 'atl-weekly-focus-review-home-state');
    if (card instanceof HTMLButtonElement) {
      card.type = 'button';
      card.addEventListener('click', () => {
        void this.dependencies.openReview(week!);
      });
    }
    card.append(
      element('small', undefined, eyebrow),
      element('strong', undefined, title),
      element('span', undefined, detail),
    );
    return card;
  }
}
