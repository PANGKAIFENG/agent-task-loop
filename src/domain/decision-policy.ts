import { z } from 'zod';

/** Stable decision dimension catalog (governance §3). */
export const DECISION_DIMENSIONS = [
  'input-routing',
  'goal-decomposition',
  'attention-priority',
  'agent-admission',
  'intervention-escalation',
  'external-action',
  'result-acceptance',
  'session-return',
  'capability-upgrade',
] as const;

export const POLICY_STATUSES = ['draft', 'observing', 'active', 'deprecated'] as const;

/**
 * Frozen legal policy status transitions (PRD I4). `deprecated` is terminal:
 * reactivation is forbidden and rollback happens via a new version (D6).
 */
export const LEGAL_POLICY_TRANSITIONS: Record<PolicyStatus, readonly PolicyStatus[]> = {
  draft: ['observing', 'deprecated'],
  observing: ['active', 'deprecated'],
  active: ['deprecated'],
  deprecated: [],
};

export type DecisionDimension = (typeof DECISION_DIMENSIONS)[number];
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

const policyIdPattern = /^policy\.[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9-]+)+$/u;
const policyVersionPattern = /^v\d{3}$/u;

const policyStatusHistoryEntrySchema = z.object({
  status: z.enum(POLICY_STATUSES),
  at: z.iso.datetime({ offset: true }),
}).strict();

const policyExampleSchema = z.object({
  input: z.string().trim().min(1).max(500),
  output: z.string().trim().min(1).max(500),
}).strict();

export const decisionPolicySchema = z.object({
  policy_id: z.string().regex(policyIdPattern),
  version: z.string().regex(policyVersionPattern),
  status: z.enum(POLICY_STATUSES),
  dimension: z.enum(DECISION_DIMENSIONS),
  decision_question: z.string().trim().min(1).max(500),
  inputs: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    source: z.string().trim().min(1).max(200),
  }).strict()).min(1),
  sources: z.array(z.string().trim().min(1)).min(1),
  rules: z.array(z.object({
    statement: z.string().trim().min(1).max(1000),
    priority: z.number().int().min(1).max(99).optional(),
  }).strict()).min(1),
  exceptions: z.array(z.string().trim().min(1)),
  outputs: z.array(z.string().trim().min(1)).min(1),
  rationale: z.string().trim().min(1).max(2000),
  examples: z.array(policyExampleSchema),
  counterexamples: z.array(policyExampleSchema),
  metrics: z.array(z.string().trim().min(1)).min(1),
  next_review_at: z.iso.date(),
  created_at: z.iso.datetime({ offset: true }),
  status_history: z.array(policyStatusHistoryEntrySchema).default([]),
}).strict();

export type PolicyStatusHistoryEntry = z.infer<typeof policyStatusHistoryEntrySchema>;
export type DecisionPolicy = z.infer<typeof decisionPolicySchema>;
