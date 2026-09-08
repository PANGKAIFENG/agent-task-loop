import { feedbackIdSchema } from './decision-feedback.js';

export interface FeedbackContextRule {
  feedbackId: string;
  candidateId: string;
  version: string;
  sha256: string;
  stability: 'single_exception' | 'pattern_candidate' | 'confirmed_pattern' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  validFrom: string;
  validUntil: string | null;
  scope: {
    taskIds: string[];
    taskTypes: string[];
    projectIds: string[];
    requiredTags: string[];
    excludedTags: string[];
  };
}

export interface ContextConsumptionTask {
  taskId: string;
  taskType: string;
  projectId: string;
  tags: string[];
  asOf: string;
}

export interface FeedbackManifestEntry {
  candidateId: string;
  category: 'feedback';
  sourceRef: string;
  version: string;
  sha256: string | null;
  status: 'consumed' | 'excluded' | 'failed' | 'conflict';
}

function feedbackIdFromSourceRef(sourceRef: string): string | null {
  const prefix = 'feedback://';
  if (!sourceRef.startsWith(prefix)) return null;
  const feedbackId = sourceRef.slice(prefix.length);
  return feedbackIdSchema.safeParse(feedbackId).success ? feedbackId : null;
}

export interface ContextConsumptionReport {
  status: 'proven' | 'not_applicable' | 'missing_consumption' | 'misapplied' | 'needs_decision';
  applicableFeedbackIds: string[];
  consumedFeedbackIds: string[];
  missingFeedbackIds: string[];
  misappliedFeedbackIds: string[];
  manualGateFeedbackIds: string[];
}

export class ContextConsumptionInputError extends Error {
  readonly code = 'context_consumption_invalid_input';

  constructor() {
    super('Context consumption proof input is invalid');
    this.name = 'ContextConsumptionInputError';
  }
}

function withinScope(rule: FeedbackContextRule, task: ContextConsumptionTask): boolean {
  const includes = (values: string[], value: string): boolean => (
    values.length === 0 || values.includes(value)
  );
  return includes(rule.scope.taskIds, task.taskId)
    && includes(rule.scope.taskTypes, task.taskType)
    && includes(rule.scope.projectIds, task.projectId)
    && rule.scope.requiredTags.every((tag) => task.tags.includes(tag))
    && rule.scope.excludedTags.every((tag) => !task.tags.includes(tag));
}

function isCurrent(rule: FeedbackContextRule, asOf: number): boolean {
  const validFrom = Date.parse(rule.validFrom);
  const validUntil = rule.validUntil === null ? null : Date.parse(rule.validUntil);
  return Number.isFinite(validFrom)
    && validFrom <= asOf
    && (validUntil === null || (Number.isFinite(validUntil) && asOf <= validUntil));
}

export function evaluateContextConsumption(input: {
  task: ContextConsumptionTask;
  rules: FeedbackContextRule[];
  manifestEntries: FeedbackManifestEntry[];
}): ContextConsumptionReport {
  const asOf = Date.parse(input.task.asOf);
  if (!Number.isFinite(asOf)) throw new ContextConsumptionInputError();
  const uniqueCount = (values: string[]): number => new Set(values).size;
  const validVersion = (version: string): boolean => /^v[1-9][0-9]*$/u.test(version);
  const validSha256 = (sha256: string): boolean => /^[0-9a-f]{64}$/u.test(sha256);
  const normalizedEntries = input.manifestEntries.map((entry) => {
    const feedbackId = feedbackIdFromSourceRef(entry.sourceRef);
    if (feedbackId === null) throw new ContextConsumptionInputError();
    return { ...entry, feedbackId };
  });
  if (
    input.rules.some((rule) => (
      !feedbackIdSchema.safeParse(rule.feedbackId).success
      || rule.candidateId.trim() === ''
      || !validVersion(rule.version)
      || !validSha256(rule.sha256)
    ))
    || normalizedEntries.some((entry) => (
      entry.candidateId.trim() === ''
      || !validVersion(entry.version)
      || (entry.sha256 !== null && !validSha256(entry.sha256))
      || (entry.status === 'consumed' && entry.sha256 === null)
    ))
    || uniqueCount(input.rules.map(({ candidateId }) => candidateId)) !== input.rules.length
    || uniqueCount(input.rules.map(({ feedbackId }) => feedbackId)) !== input.rules.length
    || uniqueCount(normalizedEntries.map(({ candidateId }) => candidateId))
      !== normalizedEntries.length
    || uniqueCount(normalizedEntries.map(({ feedbackId }) => feedbackId))
      !== normalizedEntries.length
  ) throw new ContextConsumptionInputError();
  const entries = new Map(normalizedEntries.map((entry) => [entry.candidateId, entry]));
  const rules = new Map(input.rules.map((rule) => [rule.candidateId, rule]));
  const applicableFeedbackIds: string[] = [];
  const consumedFeedbackIds: string[] = [];
  const missingFeedbackIds: string[] = [];
  const misappliedFeedbackIds: string[] = [];
  const manualGateFeedbackIds: string[] = [];

  for (const rule of input.rules) {
    const scoped = withinScope(rule, input.task);
    const entry = entries.get(rule.candidateId);
    const identityMatches = entry !== undefined
      && entry.feedbackId === rule.feedbackId
      && entry.version === rule.version
      && entry.sha256 === rule.sha256;
    const consumed = entry?.status === 'consumed' && identityMatches;
    const autoApplicable = scoped
      && rule.stability === 'confirmed_pattern'
      && rule.confidence !== 'low'
      && isCurrent(rule, asOf);
    const manualGate = scoped && !autoApplicable;
    if (autoApplicable) applicableFeedbackIds.push(rule.feedbackId);
    if (consumed) consumedFeedbackIds.push(rule.feedbackId);
    if (autoApplicable && !consumed) missingFeedbackIds.push(rule.feedbackId);
    if (consumed && !autoApplicable) misappliedFeedbackIds.push(rule.feedbackId);
    if (entry?.status === 'consumed' && !identityMatches) {
      misappliedFeedbackIds.push(entry.feedbackId);
    }
    if (manualGate) manualGateFeedbackIds.push(rule.feedbackId);
  }

  for (const entry of normalizedEntries) {
    if (rules.has(entry.candidateId)) continue;
    if (entry.status === 'consumed') misappliedFeedbackIds.push(entry.feedbackId);
    else manualGateFeedbackIds.push(entry.feedbackId);
  }

  const unique = (values: string[]): string[] => [...new Set(values)];
  const normalizedMisapplied = unique(misappliedFeedbackIds);
  const normalizedMissing = unique(missingFeedbackIds);
  const normalizedManualGate = unique(manualGateFeedbackIds);

  const status = normalizedMisapplied.length > 0
    ? 'misapplied' as const
    : normalizedMissing.length > 0
      ? 'missing_consumption' as const
      : normalizedManualGate.length > 0
        ? 'needs_decision' as const
        : applicableFeedbackIds.length > 0
          ? 'proven' as const
          : 'not_applicable' as const;
  return {
    status,
    applicableFeedbackIds,
    consumedFeedbackIds,
    missingFeedbackIds: normalizedMissing,
    misappliedFeedbackIds: normalizedMisapplied,
    manualGateFeedbackIds: normalizedManualGate,
  };
}
