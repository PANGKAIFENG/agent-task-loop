import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  confirmWeeklyFocus,
  currentIsoWeek,
  loadCurrentWeeklyFocus,
  saveWeeklyFocusDraft,
  WeeklyFocusConflictError,
  weeklyFocusPath,
  type WeeklyFocusGateway,
  type WeeklyFocusInput,
} from '../../../src/services/weekly-focus.js';

const NOW = new Date('2026-07-26T08:00:00.000Z');

function input(overrides: Partial<WeeklyFocusInput> = {}): WeeklyFocusInput {
  return {
    conversationTopic: '我想判断本周是否应该收敛产品边界。',
    selectedSources: ['目标', '项目', '任务'],
    currentQuestion: '周五前希望出现什么可观察变化？',
    coachSummary: '用户希望减少重复讨论。',
    focuses: [{
      problem: '把产品边界从功能讨论收敛成可沟通的判断。',
      judgment: '先用两个真实流程验证分层。',
      outcome: '形成一页边界图。',
      evidence: '两个流程被团队共同确认。',
      commitment: '周五前完成边界图。',
    }],
    noNewFocus: false,
    notDoing: ['不扩展新的 Agent 名称。'],
    background: {
      facts: ['边界问题一周内重复出现。'],
      assumptions: ['边界图可能减少重复讨论。'],
      gaps: ['尚未确认评审人。'],
      sources: ['10_Tasks/Active/example.md'],
    },
    coachInsights: ['先验证结果价值，而不是先补任务数量。'],
    consideredDirections: ['先做两个客户流程的低成本验证。'],
    keyAnswers: ['希望团队在周五前使用同一份边界材料。'],
    linkedGoals: ['[[完善个人 AI 工作系统]]'],
    linkedTasks: [],
    adjustmentNote: '',
    ...overrides,
  };
}

class MemoryGateway implements WeeklyFocusGateway {
  readonly files = new Map<string, string>();

  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async write(
    path: string,
    content: string,
    expectedContent: string | null,
  ): Promise<boolean> {
    const current = this.files.get(path) ?? null;
    if (current !== expectedContent) return false;
    this.files.set(path, content);
    return true;
  }
}

function frontmatter(raw: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (match === null) throw new Error('missing frontmatter');
  return YAML.parse(match[1] ?? '') as Record<string, unknown>;
}

describe('weekly focus service', () => {
  it('uses the ISO week for Asia/Shanghai and a stable weekly review path', () => {
    expect(currentIsoWeek(NOW, 'Asia/Shanghai')).toBe('2026-W30');
    expect(weeklyFocusPath('2026-W30')).toBe(
      '05_Reviews/Weekly/2026-W30 周度重点.md',
    );
  });

  it('saves a draft with Chinese user-visible frontmatter and review sections', async () => {
    const gateway = new MemoryGateway();

    const document = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input(),
      null,
      'Asia/Shanghai',
    );

    expect(document.record).toMatchObject({
      type: '周度重点',
      week: '2026-W30',
      status: '草稿',
      createdBy: 'ATL 思考教练',
      reviewStatus: '待复盘',
      confirmedAt: null,
    });
    const data = frontmatter(document.raw);
    expect(Object.keys(data)).toEqual([
      '类型',
      '周次',
      '状态',
      '关联目标',
      '关联任务',
      '创建方式',
      '确认时间',
      '复盘状态',
      '更新时间',
      '本周判断',
      '本周暂不新增重点',
      '本周不做',
      'AI背景',
      '教练启发',
      '考虑过的方案',
      '关键回答',
      '调整说明',
      '讨论主题',
      '授权范围',
      '当前问题',
      '教练摘要',
    ]);
    expect(data).toMatchObject({
      类型: '周度重点',
      周次: '2026-W30',
      状态: '草稿',
      创建方式: 'ATL 思考教练',
      复盘状态: '待复盘',
    });
    expect(document.raw).not.toMatch(/\b(?:type|week|status|confirmed|pending)\s*:/i);
    expect(document.raw).toContain('## 本周真正想解决的问题');
    expect(document.raw).toContain('## AI 已了解的背景');
    expect(document.raw).toContain('## 周末复盘');
  });

  it('loads the current draft without losing structured content', async () => {
    const gateway = new MemoryGateway();
    await saveWeeklyFocusDraft(gateway, () => NOW, input(), null, 'Asia/Shanghai');

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');

    expect(loaded?.record.input).toEqual(input());
    expect(loaded?.path).toBe('05_Reviews/Weekly/2026-W30 周度重点.md');
  });

  it('confirms zero new focuses only when the user explicitly chooses that outcome', async () => {
    const gateway = new MemoryGateway();
    const noFocus = input({
      focuses: [],
      noNewFocus: true,
      notDoing: ['先完成已有承诺。'],
    });

    const confirmed = await confirmWeeklyFocus(
      gateway,
      () => NOW,
      noFocus,
      null,
      'Asia/Shanghai',
    );

    expect(confirmed.record.status).toBe('已确认');
    expect(confirmed.record.confirmedAt).toBe('2026-07-26T16:00:00+08:00');
    expect(confirmed.raw).toContain('本周暂不新增重点，先完成既有承诺。');
    await expect(confirmWeeklyFocus(
      new MemoryGateway(),
      () => NOW,
      input({ focuses: [], noNewFocus: false }),
      null,
      'Asia/Shanghai',
    )).rejects.toThrow('至少确认一项本周判断');
  });

  it('rejects more than three focus items', async () => {
    const focus = input().focuses[0]!;
    await expect(saveWeeklyFocusDraft(
      new MemoryGateway(),
      () => NOW,
      input({ focuses: [focus, focus, focus, focus] }),
      null,
      'Asia/Shanghai',
    )).rejects.toThrow('最多确认三项本周判断');
  });

  it('rejects authorization sources outside the weekly coach allow-list', async () => {
    await expect(saveWeeklyFocusDraft(
      new MemoryGateway(),
      () => NOW,
      input({ selectedSources: ['项目', '整个 Vault' as never] }),
      null,
      'Asia/Shanghai',
    )).rejects.toThrow('授权范围包含不支持的来源');
  });

  it('rejects a tampered weekly note with an unknown authorization source', async () => {
    const gateway = new MemoryGateway();
    const saved = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input(),
      null,
      'Asia/Shanghai',
    );
    gateway.files.set(saved.path, saved.raw.replace(
      '  - 任务\n',
      '  - 任务\n  - 整个 Vault\n',
    ));

    await expect(loadCurrentWeeklyFocus(
      gateway,
      () => NOW,
      'Asia/Shanghai',
    )).rejects.toThrow('授权范围包含不支持的来源');
  });

  it('does not silently overwrite a weekly note edited after it was loaded', async () => {
    const gateway = new MemoryGateway();
    const first = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input(),
      null,
      'Asia/Shanghai',
    );
    gateway.files.set(first.path, `${first.raw}\n用户手工补充`);

    await expect(saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input({ adjustmentNote: '更新判断' }),
      first.raw,
      'Asia/Shanghai',
    )).rejects.toBeInstanceOf(WeeklyFocusConflictError);
    expect(gateway.files.get(first.path)).toContain('用户手工补充');
  });

  it('preserves manual review notes outside the ATL-managed decision block', async () => {
    const gateway = new MemoryGateway();
    const first = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input(),
      null,
      'Asia/Shanghai',
    );
    const reviewed = first.raw.replace(
      '- 实际结果：',
      '- 实际结果：团队已经共同使用边界图。',
    );
    gateway.files.set(first.path, reviewed);

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');
    const updated = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input({ adjustmentNote: '周中调整了验证对象。' }),
      loaded!.raw,
      'Asia/Shanghai',
    );

    expect(updated.raw).toContain('- 实际结果：团队已经共同使用边界图。');
    expect(updated.raw).toContain('周中调整了验证对象。');
    expect(updated.raw).toContain('<!-- ATL_WEEKLY_FOCUS_START -->');
    expect(updated.raw).toContain('<!-- ATL_WEEKLY_FOCUS_END -->');
  });

  it('preserves the complete manual body when adopting a valid note without ATL markers', async () => {
    const gateway = new MemoryGateway();
    const first = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input(),
      null,
      'Asia/Shanghai',
    );
    const frontmatterOnly = first.raw.slice(0, first.raw.indexOf('\n---\n') + 5);
    const manualBody = [
      '# 我的本周重点',
      '',
      '这段背景和下面的复盘都是用户手工维护的。',
      '',
      '## 周末复盘',
      '',
      '- 实际结果：保留手工结果',
    ].join('\n');
    const manual = `${frontmatterOnly}${manualBody}`;
    gateway.files.set(first.path, manual);

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');
    const updated = await saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input({ adjustmentNote: '由 ATL 接管结构化判断区。' }),
      loaded!.raw,
      'Asia/Shanghai',
    );

    expect(updated.raw).toContain(manualBody);
    expect(updated.raw).toContain('<!-- ATL_WEEKLY_FOCUS_START -->');
    expect(updated.raw).toContain('由 ATL 接管结构化判断区。');
  });
});
