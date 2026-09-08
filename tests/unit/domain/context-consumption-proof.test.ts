import { describe, expect, it } from 'vitest';

import {
  ContextConsumptionInputError,
  evaluateContextConsumption,
  type FeedbackContextRule,
} from '../../../src/domain/context-consumption-proof.js';

const rule: FeedbackContextRule = {
  feedbackId: 'fb_01j9z8w7q3v5x2m4n6p8',
  candidateId: 'feedback-context-depth',
  version: 'v1',
  sha256: 'a'.repeat(64),
  stability: 'confirmed_pattern',
  confidence: 'high',
  validFrom: '2026-08-01T00:00:00.000Z',
  validUntil: null,
  scope: {
    taskIds: [],
    taskTypes: ['research'],
    projectIds: ['project-skill-eval'],
    requiredTags: ['decision_input'],
    excludedTags: ['html_rendering'],
  },
};

function manifestEntry(status: 'consumed' | 'excluded' | 'failed' | 'conflict') {
  return {
    candidateId: rule.candidateId,
    category: 'feedback' as const,
    sourceRef: `feedback://${rule.feedbackId}`,
    version: rule.version,
    sha256: status === 'consumed' ? rule.sha256 : null,
    status,
  };
}

const task = {
  taskId: 'task-synthetic-follow-up',
  taskType: 'research',
  projectId: 'project-skill-eval',
  tags: ['decision_input'],
  asOf: '2026-08-31T13:00:00.000Z',
};

describe('evaluateContextConsumption', () => {
  it('proves that an applicable confirmed Feedback rule was actually consumed', () => {
    const report = evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [manifestEntry('consumed')],
    });

    expect(report).toEqual({
      status: 'proven',
      applicableFeedbackIds: [rule.feedbackId],
      consumedFeedbackIds: [rule.feedbackId],
      missingFeedbackIds: [],
      misappliedFeedbackIds: [],
      manualGateFeedbackIds: [],
    });
  });

  it('emits missing-consumption evidence when applicable Feedback was not read', () => {
    const report = evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [manifestEntry('excluded')],
    });

    expect(report.status).toBe('missing_consumption');
    expect(report.missingFeedbackIds).toEqual([rule.feedbackId]);
  });

  it('detects misapplication on a counterexample task outside the Feedback scope', () => {
    const report = evaluateContextConsumption({
      task: {
        ...task,
        projectId: 'project-research-layout',
        tags: ['html_rendering'],
      },
      rules: [rule],
      manifestEntries: [manifestEntry('consumed')],
    });

    expect(report.status).toBe('misapplied');
    expect(report.applicableFeedbackIds).toEqual([]);
    expect(report.misappliedFeedbackIds).toEqual([rule.feedbackId]);
  });

  it('routes expired or low-confidence Feedback to a manual gate instead of auto-consuming it', () => {
    const report = evaluateContextConsumption({
      task,
      rules: [{
        ...rule,
        confidence: 'low',
        validUntil: '2026-08-30T00:00:00.000Z',
      }],
      manifestEntries: [manifestEntry('excluded')],
    });

    expect(report.status).toBe('needs_decision');
    expect(report.missingFeedbackIds).toEqual([]);
    expect(report.manualGateFeedbackIds).toEqual([rule.feedbackId]);
  });

  it('fails closed when a consumed Feedback entry is absent from the rule set', () => {
    const report = evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [{
        sourceRef: 'feedback://fb_bbbbbbbbbbbbbbbbbbbb',
        candidateId: 'feedback-unknown',
        category: 'feedback',
        version: 'v1',
        sha256: 'b'.repeat(64),
        status: 'consumed',
      }],
    });

    expect(report.status).toBe('misapplied');
    expect(report.misappliedFeedbackIds).toContain('fb_bbbbbbbbbbbbbbbbbbbb');
    expect(report.missingFeedbackIds).toContain(rule.feedbackId);
  });

  it('does not accept a consumed entry with a different Feedback version or SHA', () => {
    const report = evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [{
        ...manifestEntry('consumed'),
        version: 'v2',
        sha256: 'b'.repeat(64),
      }],
    });

    expect(report.status).toBe('misapplied');
    expect(report.misappliedFeedbackIds).toContain(rule.feedbackId);
    expect(report.missingFeedbackIds).toContain(rule.feedbackId);
  });

  it('rejects duplicate Feedback identities instead of silently choosing one entry', () => {
    expect(() => evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [
        manifestEntry('consumed'),
        {
          ...manifestEntry('consumed'),
          sourceRef: 'feedback://fb_bbbbbbbbbbbbbbbbbbbb',
        },
      ],
    })).toThrow(ContextConsumptionInputError);
  });

  it('rejects caller-forged Feedback identity fields', () => {
    expect(() => evaluateContextConsumption({
      task,
      rules: [{
        ...rule,
        feedbackId: 'forged',
        version: 'not-a-version',
        sha256: 'not-a-sha',
      }],
      manifestEntries: [{
        ...manifestEntry('consumed'),
        sourceRef: 'feedback://forged',
        version: 'not-a-version',
        sha256: 'not-a-sha',
      }],
    })).toThrow(ContextConsumptionInputError);
  });

  it('derives consumed Feedback identity from the Manifest sourceRef', () => {
    const entry = {
      ...manifestEntry('consumed'),
      sourceRef: 'feedback://fb_bbbbbbbbbbbbbbbbbbbb',
    };

    const report = evaluateContextConsumption({
      task,
      rules: [rule],
      manifestEntries: [entry],
    });

    expect(report.status).toBe('misapplied');
    expect(report.missingFeedbackIds).toContain(rule.feedbackId);
    expect(report.misappliedFeedbackIds).toContain('fb_bbbbbbbbbbbbbbbbbbbb');
  });
});
