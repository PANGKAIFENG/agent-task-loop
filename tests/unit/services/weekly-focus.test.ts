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
      focus: '验证 StyleWork 产品边界是否能被团队复用。',
      outcome: '形成一页团队共同使用的边界图。',
      whyThisWeek: '本周有两个真实流程可用于验证，延后会继续重复讨论。',
      evidence: '两个流程的负责人都确认采用同一份说明。',
      deferredTaskQuestions: ['定义边界图的内部模板'],
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
    unassignedDeferredTaskQuestions: ['确认后续任务承载位置'],
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
      '其他进入任务后待思考的问题',
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
    expect(data['本周判断']).toEqual([{
      重点事项: '验证 StyleWork 产品边界是否能被团队复用。',
      预期结果: '形成一页团队共同使用的边界图。',
      为什么是本周: '本周有两个真实流程可用于验证，延后会继续重复讨论。',
      完成证据: '两个流程的负责人都确认采用同一份说明。',
      进入任务后待思考的问题: ['定义边界图的内部模板'],
    }]);
    expect(data['其他进入任务后待思考的问题']).toEqual(['确认后续任务承载位置']);
    expect(document.raw).not.toMatch(/\b(?:type|week|status|confirmed|pending)\s*:/i);
    expect(document.raw).toContain('## 本周重点');
    expect(document.raw).toContain('**为什么是本周**：本周有两个真实流程可用于验证');
    expect(document.raw).toContain('#### 进入任务后待思考的问题');
    expect(document.raw).toContain('## 其他进入任务后待思考的问题');
    expect(document.raw).not.toContain('用户最终判断');
    expect(document.raw).not.toContain('本周承诺');
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

  it('normalizes legacy five-field weekly notes into the four public fields', async () => {
    const gateway = new MemoryGateway();
    const saved = await saveWeeklyFocusDraft(gateway, () => NOW, input(), null, 'Asia/Shanghai');
    const data = frontmatter(saved.raw);
    data['本周判断'] = [{
      真正想解决的问题: '收敛产品边界。',
      用户最终判断: '先验证两个真实流程。',
      希望产生的结果: '形成一页团队共同使用的边界图。',
      验证证据: '两个流程的负责人都确认采用同一份说明。',
      本周承诺: '周五前完成一页边界图。',
    }];
    const legacy = saved.raw.replace(
      /^---\n[\s\S]*?\n---/u,
      `---\n${YAML.stringify(data).trimEnd()}\n---`,
    );
    gateway.files.set(saved.path, legacy);

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');

    expect(loaded?.record.input.focuses[0]).toEqual({
      focus: '先验证两个真实流程。',
      outcome: '形成一页团队共同使用的边界图。',
      whyThisWeek: '周五前完成一页边界图。',
      evidence: '两个流程的负责人都确认采用同一份说明。',
      deferredTaskQuestions: [],
    });
  });

  it('loads old records without deferred-question fields as empty lists', async () => {
    const gateway = new MemoryGateway();
    const saved = await saveWeeklyFocusDraft(gateway, () => NOW, input(), null, 'Asia/Shanghai');
    const data = frontmatter(saved.raw);
    delete data['其他进入任务后待思考的问题'];
    const focuses = data['本周判断'] as Array<Record<string, unknown>>;
    delete focuses[0]?.['进入任务后待思考的问题'];
    const legacy = saved.raw.replace(
      /^---\n[\s\S]*?\n---/u,
      `---\n${YAML.stringify(data).trimEnd()}\n---`,
    );
    gateway.files.set(saved.path, legacy);

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');

    expect(loaded?.record.input.focuses[0]?.deferredTaskQuestions).toEqual([]);
    expect(loaded?.record.input.unassignedDeferredTaskQuestions).toEqual([]);
  });

  it('deduplicates and caps deferred questions when saving a formal weekly record', async () => {
    const gateway = new MemoryGateway();
    const linkedQuestions = [
      ...Array.from({ length: 6 }, (_, index) => `重点问题 ${index + 1}`),
      '重点问题 1。',
    ];
    const unassignedQuestions = [
      ...Array.from({ length: 11 }, (_, index) => `未关联问题 ${index + 1}`),
      '未关联问题 1！',
    ];

    const saved = await saveWeeklyFocusDraft(gateway, () => NOW, input({
      focuses: [{ ...input().focuses[0]!, deferredTaskQuestions: linkedQuestions }],
      unassignedDeferredTaskQuestions: unassignedQuestions,
    }), null, 'Asia/Shanghai');

    expect(saved.record.input.focuses[0]?.deferredTaskQuestions).toEqual(
      linkedQuestions.slice(0, 5),
    );
    expect(saved.record.input.unassignedDeferredTaskQuestions).toEqual(
      unassignedQuestions.slice(0, 10),
    );
  });

  it('deduplicates and caps deferred questions parsed from an existing weekly record', async () => {
    const gateway = new MemoryGateway();
    const saved = await saveWeeklyFocusDraft(gateway, () => NOW, input(), null, 'Asia/Shanghai');
    const data = frontmatter(saved.raw);
    const focuses = data['本周判断'] as Array<Record<string, unknown>>;
    focuses[0]!['进入任务后待思考的问题'] = [
      ...Array.from({ length: 6 }, (_, index) => `重点问题 ${index + 1}`),
      '重点问题 1。',
    ];
    data['其他进入任务后待思考的问题'] = [
      ...Array.from({ length: 11 }, (_, index) => `未关联问题 ${index + 1}`),
      '未关联问题 1！',
    ];
    gateway.files.set(saved.path, saved.raw.replace(
      /^---\n[\s\S]*?\n---/u,
      `---\n${YAML.stringify(data).trimEnd()}\n---`,
    ));

    const loaded = await loadCurrentWeeklyFocus(gateway, () => NOW, 'Asia/Shanghai');

    expect(loaded?.record.input.focuses[0]?.deferredTaskQuestions).toEqual(
      Array.from({ length: 5 }, (_, index) => `重点问题 ${index + 1}`),
    );
    expect(loaded?.record.input.unassignedDeferredTaskQuestions).toEqual(
      Array.from({ length: 10 }, (_, index) => `未关联问题 ${index + 1}`),
    );
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
      '2026-W30',
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
      '2026-W30',
      'Asia/Shanghai',
    )).rejects.toThrow('至少确认一项本周判断');
  });

  it('rejects focus items combined with the no-new-focus flag before saving', async () => {
    const gateway = new MemoryGateway();

    await expect(saveWeeklyFocusDraft(
      gateway,
      () => NOW,
      input({ noNewFocus: true }),
      null,
      'Asia/Shanghai',
    )).rejects.toThrow('已有本周判断时，不能选择本周暂不新增重点');

    expect(gateway.files.size).toBe(0);
  });

  it('rejects a manually edited record that combines focuses with no-new-focus', async () => {
    const gateway = new MemoryGateway();
    const saved = await saveWeeklyFocusDraft(gateway, () => NOW, input(), null, 'Asia/Shanghai');
    gateway.files.set(saved.path, saved.raw.replace(
      '本周暂不新增重点: false',
      '本周暂不新增重点: true',
    ));

    await expect(loadCurrentWeeklyFocus(
      gateway,
      () => NOW,
      'Asia/Shanghai',
    )).rejects.toThrow('已有本周判断时，不能选择本周暂不新增重点');
  });

  it('rejects a stale session week immediately before formal confirmation writes', async () => {
    const gateway = new MemoryGateway();

    await expect(confirmWeeklyFocus(
      gateway,
      () => NOW,
      input(),
      null,
      '2026-W29',
      'Asia/Shanghai',
    )).rejects.toThrow('已进入新的自然周');
    expect(gateway.files.size).toBe(0);
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
