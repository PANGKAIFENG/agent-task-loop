import { PRIORITIES, type Priority } from '../domain/task.js';
import { localBusinessDate } from '../services/claim-task.js';
import type { CaptureTaskInput } from '../services/capture-task.js';

export interface QuickCaptureFormInput {
  title: string;
  body: string;
  priority: Priority;
}

export interface QuickCaptureErrors {
  title?: string;
  priority?: string;
}

export function validateQuickCapture(
  input: QuickCaptureFormInput,
): QuickCaptureErrors {
  const errors: QuickCaptureErrors = {};
  if (input.title.trim() === '') errors.title = '请输入任务标题';
  if (!PRIORITIES.includes(input.priority)) errors.priority = '请选择优先级';
  return errors;
}

export function toQuickCaptureInput(
  input: QuickCaptureFormInput,
  now: Date,
  id: string,
): CaptureTaskInput {
  const title = input.title.trim();
  const body = input.body.trim();
  return {
    title,
    body: body === '' ? title : body,
    origin: 'manual_obsidian',
    sourceDate: localBusinessDate(now),
    sourceNote: null,
    sourceQuote: null,
    sourceKey: `manual_obsidian:${id}`,
    priority: input.priority,
  };
}
