import { describe, expect, it } from 'vitest';

import {
  toQuickCaptureInput,
  validateQuickCapture,
} from '../../../src/obsidian-plugin/quick-capture-form.js';

describe('validateQuickCapture', () => {
  it('requires a non-blank title', () => {
    expect(validateQuickCapture({
      title: '   ',
      body: '',
      priority: 'normal',
    })).toEqual({ title: '请输入任务标题' });
  });

  it('accepts the minimal valid form', () => {
    expect(validateQuickCapture({
      title: '调研方案',
      body: '',
      priority: 'high',
    })).toEqual({});
  });
});

describe('toQuickCaptureInput', () => {
  it('creates a manual Inbox capture input and falls back to the title body', () => {
    expect(toQuickCaptureInput(
      { title: '  调研方案  ', body: '   ', priority: 'high' },
      new Date('2026-07-17T06:30:00.000Z'),
      'manual-001',
    )).toEqual({
      title: '调研方案',
      body: '调研方案',
      origin: 'manual_obsidian',
      sourceDate: '2026-07-17',
      sourceNote: null,
      sourceQuote: null,
      sourceKey: 'manual_obsidian:manual-001',
      priority: 'high',
    });
  });

  it('preserves an explicit description without creating execution metadata', () => {
    const result = toQuickCaptureInput(
      { title: '调研方案', body: '  对比三个方案。  ', priority: 'normal' },
      new Date('2026-07-17T06:30:00.000Z'),
      'manual-002',
    );

    expect(result.body).toBe('对比三个方案。');
    expect(result).not.toHaveProperty('projectId');
    expect(result).not.toHaveProperty('autoExecutable');
  });
});
