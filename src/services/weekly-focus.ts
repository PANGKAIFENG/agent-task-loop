import YAML from 'yaml';

import {
  WEEKLY_COACH_SOURCES,
  type WeeklyCoachSource,
} from './weekly-coach-context.js';

const WEEK_PATTERN = /^\d{4}-W\d{2}$/;
const MAX_FOCUSES = 3;
const MAX_FIELD_LENGTH = 4_000;
const MAX_LIST_ITEMS = 30;
const MAX_DEFERRED_PER_FOCUS = 5;
const MAX_UNASSIGNED_DEFERRED = 10;
const MANAGED_START = '<!-- ATL_WEEKLY_FOCUS_START -->';
const MANAGED_END = '<!-- ATL_WEEKLY_FOCUS_END -->';
const WEEKLY_COACH_SOURCE_SET = new Set<string>(WEEKLY_COACH_SOURCES);

export type WeeklyFocusStatus = '草稿' | '已确认' | '已结束';
export type WeeklyReviewStatus = '待复盘' | '已复盘';

export interface WeeklyFocusItem {
  focus: string;
  outcome: string;
  whyThisWeek: string;
  evidence: string;
  deferredTaskQuestions: string[];
}

export interface WeeklyFocusBackground {
  facts: string[];
  assumptions: string[];
  gaps: string[];
  sources: string[];
}

export interface WeeklyFocusInput {
  conversationTopic: string;
  selectedSources: WeeklyCoachSource[];
  currentQuestion: string;
  coachSummary: string;
  focuses: WeeklyFocusItem[];
  noNewFocus: boolean;
  notDoing: string[];
  background: WeeklyFocusBackground;
  coachInsights: string[];
  consideredDirections: string[];
  keyAnswers: string[];
  linkedGoals: string[];
  linkedTasks: string[];
  adjustmentNote: string;
  unassignedDeferredTaskQuestions: string[];
}

export interface WeeklyFocusRecord {
  type: '周度重点';
  week: string;
  status: WeeklyFocusStatus;
  linkedGoals: string[];
  linkedTasks: string[];
  createdBy: 'ATL 思考教练';
  confirmedAt: string | null;
  reviewStatus: WeeklyReviewStatus;
  updatedAt: string;
  input: WeeklyFocusInput;
}

export interface WeeklyFocusDocument {
  path: string;
  record: WeeklyFocusRecord;
  raw: string;
}

export interface WeeklyFocusGateway {
  read(path: string): Promise<string | null>;
  write(path: string, content: string, expectedContent: string | null): Promise<boolean>;
}

export class WeeklyFocusConflictError extends Error {
  readonly code = 'weekly_focus_conflict';

  constructor() {
    super('周度重点已被其他编辑修改，请重新打开后再保存');
    this.name = 'WeeklyFocusConflictError';
  }
}

function localDateParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    day: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function localIsoTimestamp(date: Date, timeZone: string): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    calendar: 'iso8601',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    second: '2-digit',
    timeZone,
    timeZoneName: 'longOffset',
    year: 'numeric',
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  const offset = values.timeZoneName === 'GMT'
    ? 'Z'
    : values.timeZoneName?.replace(/^GMT/u, '') ?? 'Z';
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

export function currentIsoWeek(date: Date, timeZone = 'Asia/Shanghai'): string {
  if (!Number.isFinite(date.getTime())) throw new Error('无效的周次日期');
  const { year, month, day } = localDateParts(date, timeZone);
  const local = new Date(Date.UTC(year, month - 1, day));
  const weekday = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - weekday);
  const weekYear = local.getUTCFullYear();
  const firstDay = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil((((local.getTime() - firstDay.getTime()) / 86_400_000) + 1) / 7);
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}

export function weeklyFocusPath(week: string): string {
  if (!WEEK_PATTERN.test(week)) throw new Error('无效的周次');
  return `05_Reviews/Weekly/${week} 周度重点.md`;
}

function boundedString(value: unknown, name: string, allowEmpty = true): string {
  if (typeof value !== 'string') throw new Error(`${name}格式无效`);
  const normalized = value.trim();
  if (!allowEmpty && normalized === '') throw new Error(`${name}不能为空`);
  if (normalized.length > MAX_FIELD_LENGTH) throw new Error(`${name}内容过长`);
  return normalized;
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST_ITEMS) {
    throw new Error(`${name}格式无效`);
  }
  return value.map((item) => boundedString(item, name, false));
}

function normalizedQuestion(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function deferredQuestionList(value: unknown, name: string, maximum: number): string[] {
  const seen = new Set<string>();
  const questions: string[] = [];
  for (const question of stringList(value, name)) {
    const normalized = normalizedQuestion(question);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    questions.push(question);
    if (questions.length === maximum) break;
  }
  return questions;
}

function sourceList(value: unknown): WeeklyCoachSource[] {
  const sources = stringList(value, '授权范围');
  if (sources.some((source) => !WEEKLY_COACH_SOURCE_SET.has(source))) {
    throw new Error('授权范围包含不支持的来源');
  }
  return [...new Set(sources)] as WeeklyCoachSource[];
}

function firstString(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (typeof raw[key] === 'string' && raw[key].trim() !== '') return raw[key];
  }
  return '';
}

function normalizeFocus(
  value: unknown,
  requireComplete: boolean,
  allowMissingDeferred = false,
): WeeklyFocusItem {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('本周判断格式无效');
  }
  const raw = value as Record<string, unknown>;
  return {
    focus: boundedString(firstString(raw, [
      'focus', '重点事项', 'judgment', '用户最终判断', 'problem', '真正想解决的问题',
    ]), '重点事项', !requireComplete),
    outcome: boundedString(firstString(raw, [
      'outcome', '预期结果', '希望产生的结果',
    ]), '预期结果', !requireComplete),
    whyThisWeek: boundedString(firstString(raw, [
      'whyThisWeek', '为什么是本周', 'commitment', '本周承诺',
    ]), '为什么是本周', !requireComplete),
    evidence: boundedString(firstString(raw, [
      'evidence', '完成证据', '验证证据',
    ]), '完成证据', !requireComplete),
    deferredTaskQuestions: deferredQuestionList(
      raw.deferredTaskQuestions
        ?? raw['进入任务后待思考的问题']
        ?? (allowMissingDeferred ? [] : undefined),
      '进入任务后待思考的问题',
      MAX_DEFERRED_PER_FOCUS,
    ),
  };
}

function normalizeBackground(value: unknown): WeeklyFocusBackground {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AI背景格式无效');
  }
  const raw = value as Record<string, unknown>;
  return {
    facts: stringList(raw.facts ?? raw['已确认事实'] ?? [], '已确认事实'),
    assumptions: stringList(raw.assumptions ?? raw['仍是推测'] ?? [], '仍是推测'),
    gaps: stringList(raw.gaps ?? raw['关键信息缺口'] ?? [], '关键信息缺口'),
    sources: stringList(raw.sources ?? raw['资料来源'] ?? [], '资料来源'),
  };
}

function normalizeInput(value: WeeklyFocusInput, requireComplete: boolean): WeeklyFocusInput {
  if (!Array.isArray(value.focuses)) throw new Error('本周判断格式无效');
  if (value.focuses.length > MAX_FOCUSES) throw new Error('最多确认三项本周判断');
  if (value.focuses.length > 0 && value.noNewFocus) {
    throw new Error('已有本周判断时，不能选择本周暂不新增重点');
  }
  if (requireComplete && value.focuses.length === 0 && !value.noNewFocus) {
    throw new Error('至少确认一项本周判断，或选择本周暂不新增重点');
  }
  return {
    conversationTopic: boundedString(value.conversationTopic, '讨论主题'),
    selectedSources: sourceList(value.selectedSources),
    currentQuestion: boundedString(value.currentQuestion, '当前问题'),
    coachSummary: boundedString(value.coachSummary, '教练摘要'),
    focuses: value.focuses.map((focus) => normalizeFocus(focus, requireComplete)),
    noNewFocus: Boolean(value.noNewFocus),
    notDoing: stringList(value.notDoing, '本周不做'),
    background: normalizeBackground(value.background),
    coachInsights: stringList(value.coachInsights, '教练启发'),
    consideredDirections: stringList(value.consideredDirections, '考虑过的方案'),
    keyAnswers: stringList(value.keyAnswers, '关键回答'),
    linkedGoals: stringList(value.linkedGoals, '关联目标'),
    linkedTasks: stringList(value.linkedTasks, '关联任务'),
    adjustmentNote: boundedString(value.adjustmentNote, '调整说明'),
    unassignedDeferredTaskQuestions: deferredQuestionList(
      value.unassignedDeferredTaskQuestions,
      '其他进入任务后待思考的问题',
      MAX_UNASSIGNED_DEFERRED,
    ),
  };
}

function visibleFocus(focus: WeeklyFocusItem): Record<string, string | string[]> {
  return {
    重点事项: focus.focus,
    预期结果: focus.outcome,
    为什么是本周: focus.whyThisWeek,
    完成证据: focus.evidence,
    进入任务后待思考的问题: focus.deferredTaskQuestions,
  };
}

function visibleBackground(background: WeeklyFocusBackground): Record<string, string[]> {
  return {
    已确认事实: background.facts,
    仍是推测: background.assumptions,
    关键信息缺口: background.gaps,
    资料来源: background.sources,
  };
}

function bulletList(values: readonly string[], emptyText = '暂无'): string {
  return values.length === 0 ? emptyText : values.map((value) => `- ${value}`).join('\n');
}

function renderFocuses(input: WeeklyFocusInput): string {
  if (input.noNewFocus && input.focuses.length === 0) {
    return '本周暂不新增重点，先完成既有承诺。';
  }
  return input.focuses.map((focus, index) => {
    const lines = [
      `### ${index + 1}. ${focus.focus || '待补充'}`,
      '',
      `**重点事项**：${focus.focus || '待补充'}`,
      '',
      `**预期结果**：${focus.outcome || '待补充'}`,
      '',
      `**为什么是本周**：${focus.whyThisWeek || '待补充'}`,
      '',
      `**完成证据**：${focus.evidence || '待补充'}`,
    ];
    if (focus.deferredTaskQuestions.length > 0) {
      lines.push(
        '',
        '#### 进入任务后待思考的问题',
        '',
        bulletList(focus.deferredTaskQuestions),
      );
    }
    return lines.join('\n');
  }).join('\n\n');
}

function renderManagedBody(record: WeeklyFocusRecord): string {
  const { input } = record;
  return [
    '',
    `# ${record.week} 周度重点`,
    '',
    '> 这是你确认前可持续修改的判断记录。AI 只负责启发和整理，不替你决定重点。',
    '',
    '## 本周重点',
    '',
    renderFocuses(input),
    ...(input.unassignedDeferredTaskQuestions.length === 0 ? [] : [
      '',
      '## 其他进入任务后待思考的问题',
      '',
      bulletList(input.unassignedDeferredTaskQuestions),
    ]),
    '',
    '## 当前教练上下文',
    '',
    `- 讨论主题：${input.conversationTopic || '暂无'}`,
    `- 当前问题：${input.currentQuestion || '暂无'}`,
    `- 教练摘要：${input.coachSummary || '暂无'}`,
    `- 本次授权：${input.selectedSources.join('、') || '无'}`,
    '',
    '## AI 已了解的背景',
    '',
    '### 已确认事实',
    bulletList(input.background.facts),
    '',
    '### 仍是推测',
    bulletList(input.background.assumptions),
    '',
    '### 关键信息缺口',
    bulletList(input.background.gaps),
    '',
    '### 资料来源',
    bulletList(input.background.sources),
    '',
    '## 教练启发',
    '',
    bulletList(input.coachInsights),
    '',
    '## 考虑过的方案',
    '',
    bulletList(input.consideredDirections),
    '',
    '## 影响判断的关键回答',
    '',
    bulletList(input.keyAnswers),
    '',
    '## 本周不做',
    '',
    bulletList(input.notDoing),
    '',
    '## 调整说明',
    '',
    input.adjustmentNote || '暂无',
  ].join('\n');
}

function reviewBody(previousRaw: string | null): string {
  if (previousRaw !== null) {
    const managedEnd = previousRaw.indexOf(MANAGED_END);
    if (managedEnd >= 0) {
      return previousRaw.slice(managedEnd + MANAGED_END.length).replace(/^\r?\n/u, '');
    }
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/u.exec(previousRaw);
    if (frontmatter !== null) return previousRaw.slice(frontmatter[0].length);
  }
  return [
    '## 周末复盘',
    '',
    '- 实际结果：',
    '- 价值判断：',
    '- 被验证或推翻的假设：',
    '- 下周继续、调整或停止：',
    '',
  ].join('\n');
}

function serialize(record: WeeklyFocusRecord, previousRaw: string | null): string {
  const data: Record<string, unknown> = {
    类型: record.type,
    周次: record.week,
    状态: record.status,
    关联目标: record.linkedGoals,
    关联任务: record.linkedTasks,
    创建方式: record.createdBy,
    确认时间: record.confirmedAt,
    复盘状态: record.reviewStatus,
    更新时间: record.updatedAt,
    本周判断: record.input.focuses.map(visibleFocus),
    其他进入任务后待思考的问题: record.input.unassignedDeferredTaskQuestions,
    本周暂不新增重点: record.input.noNewFocus,
    本周不做: record.input.notDoing,
    AI背景: visibleBackground(record.input.background),
    教练启发: record.input.coachInsights,
    考虑过的方案: record.input.consideredDirections,
    关键回答: record.input.keyAnswers,
    调整说明: record.input.adjustmentNote,
    讨论主题: record.input.conversationTopic,
    授权范围: record.input.selectedSources,
    当前问题: record.input.currentQuestion,
    教练摘要: record.input.coachSummary,
  };
  return [
    '---',
    YAML.stringify(data).trimEnd(),
    '---',
    MANAGED_START,
    renderManagedBody(record).trim(),
    MANAGED_END,
    reviewBody(previousRaw).trimStart(),
  ].join('\n');
}

function recordFromRaw(raw: string, expectedWeek: string): WeeklyFocusRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (match === null) throw new Error('周度重点缺少有效属性');
  const parsed: unknown = YAML.parse(match[1] ?? '');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('周度重点属性格式无效');
  }
  const data = parsed as Record<string, unknown>;
  const status = data['状态'];
  if (data['类型'] !== '周度重点' || data['周次'] !== expectedWeek) {
    throw new Error('周度重点属性不匹配');
  }
  if (status !== '草稿' && status !== '已确认' && status !== '已结束') {
    throw new Error('周度重点状态无效');
  }
  const visibleFocuses = data['本周判断'];
  const background = data['AI背景'];
  const confirmedAt = data['确认时间'];
  const reviewStatus = data['复盘状态'];
  if (confirmedAt !== null && typeof confirmedAt !== 'string') {
    throw new Error('确认时间格式无效');
  }
  if (reviewStatus !== '待复盘' && reviewStatus !== '已复盘') {
    throw new Error('复盘状态无效');
  }
  if (!Array.isArray(visibleFocuses)) throw new Error('本周判断格式无效');
  const input = normalizeInput({
    conversationTopic: boundedString(data['讨论主题'] ?? '', '讨论主题'),
    selectedSources: sourceList(data['授权范围'] ?? []),
    currentQuestion: boundedString(data['当前问题'] ?? '', '当前问题'),
    coachSummary: boundedString(data['教练摘要'] ?? '', '教练摘要'),
    focuses: visibleFocuses.map((focus) => normalizeFocus(
      focus,
      status === '已确认',
      true,
    )),
    noNewFocus: data['本周暂不新增重点'] === true,
    notDoing: stringList(data['本周不做'] ?? [], '本周不做'),
    background: normalizeBackground(background ?? {}),
    coachInsights: stringList(data['教练启发'] ?? [], '教练启发'),
    consideredDirections: stringList(data['考虑过的方案'] ?? [], '考虑过的方案'),
    keyAnswers: stringList(data['关键回答'] ?? [], '关键回答'),
    linkedGoals: stringList(data['关联目标'] ?? [], '关联目标'),
    linkedTasks: stringList(data['关联任务'] ?? [], '关联任务'),
    adjustmentNote: boundedString(data['调整说明'] ?? '', '调整说明'),
    unassignedDeferredTaskQuestions: stringList(
      data['其他进入任务后待思考的问题'] ?? [],
      '其他进入任务后待思考的问题',
    ),
  }, status === '已确认');
  return {
    type: '周度重点',
    week: expectedWeek,
    status,
    linkedGoals: input.linkedGoals,
    linkedTasks: input.linkedTasks,
    createdBy: 'ATL 思考教练',
    confirmedAt,
    reviewStatus,
    updatedAt: boundedString(data['更新时间'], '更新时间', false),
    input,
  };
}

export async function loadCurrentWeeklyFocus(
  gateway: WeeklyFocusGateway,
  clock: () => Date,
  timeZone = 'Asia/Shanghai',
): Promise<WeeklyFocusDocument | null> {
  const week = currentIsoWeek(clock(), timeZone);
  const path = weeklyFocusPath(week);
  const raw = await gateway.read(path);
  if (raw === null) return null;
  return { path, record: recordFromRaw(raw, week), raw };
}

async function persist(
  gateway: WeeklyFocusGateway,
  clock: () => Date,
  input: WeeklyFocusInput,
  expectedContent: string | null,
  status: '草稿' | '已确认',
  timeZone: string,
  expectedWeek: string | null,
): Promise<WeeklyFocusDocument> {
  const now = clock();
  if (!Number.isFinite(now.getTime())) throw new Error('无效的保存时间');
  const week = currentIsoWeek(now, timeZone);
  if (expectedWeek !== null && week !== expectedWeek) {
    throw new Error('已进入新的自然周，请重新打开本周思考教练。');
  }
  const normalized = normalizeInput(input, status === '已确认');
  const path = weeklyFocusPath(week);
  const record: WeeklyFocusRecord = {
    type: '周度重点',
    week,
    status,
    linkedGoals: normalized.linkedGoals,
    linkedTasks: normalized.linkedTasks,
    createdBy: 'ATL 思考教练',
    confirmedAt: status === '已确认' ? localIsoTimestamp(now, timeZone) : null,
    reviewStatus: '待复盘',
    updatedAt: localIsoTimestamp(now, timeZone),
    input: normalized,
  };
  const raw = serialize(record, expectedContent);
  if (!await gateway.write(path, raw, expectedContent)) {
    throw new WeeklyFocusConflictError();
  }
  return { path, record, raw };
}

export function saveWeeklyFocusDraft(
  gateway: WeeklyFocusGateway,
  clock: () => Date,
  input: WeeklyFocusInput,
  expectedContent: string | null,
  timeZone = 'Asia/Shanghai',
): Promise<WeeklyFocusDocument> {
  return persist(gateway, clock, input, expectedContent, '草稿', timeZone, null);
}

export function confirmWeeklyFocus(
  gateway: WeeklyFocusGateway,
  clock: () => Date,
  input: WeeklyFocusInput,
  expectedContent: string | null,
  expectedWeek: string,
  timeZone = 'Asia/Shanghai',
): Promise<WeeklyFocusDocument> {
  return persist(gateway, clock, input, expectedContent, '已确认', timeZone, expectedWeek);
}
