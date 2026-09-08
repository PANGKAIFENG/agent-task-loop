import type { FeedbackSample } from '../domain/decision-feedback.js';
import type { DecisionPolicy } from '../domain/decision-policy.js';
import type { DecisionTrace } from '../domain/decision-trace.js';
import { parseTaskDocument, serializeTaskDocument } from './frontmatter.js';

/**
 * Decision documents are YAML frontmatter plus a Markdown body (D1). The
 * frontmatter is the only source of truth; the body is a deterministic
 * human-readable projection of it and is never parsed back into state.
 */
export interface DecisionDocument {
  data: Record<string, unknown>;
  body: string;
}

export function parseDecisionDocument(raw: string): DecisionDocument {
  // Reuses the vault-wide frontmatter fence regex and YAML rules.
  return parseTaskDocument(raw);
}

export function serializeDecisionDocument(
  frontmatter: Record<string, unknown>,
  body: string,
): string {
  return serializeTaskDocument(frontmatter, body);
}

function renderExampleList(title: string, examples: { input: string; output: string }[]): string[] {
  if (examples.length === 0) {
    return [`## ${title}`, '', '- None.'];
  }
  return [
    `## ${title}`,
    '',
    ...examples.map((example) => `- ${example.input} -> ${example.output}`),
  ];
}

export function renderPolicyBody(policy: DecisionPolicy): string {
  const history = policy.status_history
    .map((entry) => `${entry.status} at ${entry.at}`)
    .join(', ');
  return [
    '',
    `# ${policy.policy_id}@${policy.version}`,
    '',
    `Status: ${policy.status}${history === '' ? '' : ` (history: ${history})`}`,
    `Dimension: ${policy.dimension}`,
    `Next review: ${policy.next_review_at}`,
    '',
    '## Decision question',
    '',
    policy.decision_question,
    '',
    '## Inputs',
    ...policy.inputs.map((input) => `- ${input.name} - ${input.source}`),
    '',
    '## Sources',
    ...policy.sources.map((source) => `- ${source}`),
    '',
    '## Rules',
    ...policy.rules.map((rule) => rule.priority === undefined
      ? `- ${rule.statement}`
      : `- [${rule.priority}] ${rule.statement}`),
    '',
    '## Exceptions',
    ...(policy.exceptions.length === 0
      ? ['- None.']
      : policy.exceptions.map((exception) => `- ${exception}`)),
    '',
    '## Outputs',
    ...policy.outputs.map((output) => `- ${output}`),
    '',
    '## Metrics',
    ...policy.metrics.map((metric) => `- ${metric}`),
    '',
    '## Rationale',
    '',
    policy.rationale,
    '',
    ...renderExampleList('Examples', policy.examples),
    '',
    ...renderExampleList('Counterexamples', policy.counterexamples),
    '',
  ].join('\n');
}

export function renderTraceBody(trace: DecisionTrace): string {
  return [
    '',
    `# ${trace.trace_id}`,
    '',
    `Policy: ${trace.policy_ref}`,
    `Dimension: ${trace.dimension}`,
    `Status: ${trace.status} (feedback summary: ${trace.feedback_summary_status}, count: ${trace.feedback_count})`,
    `Confidence: ${trace.confidence}`,
    '',
    '## Decision',
    '',
    trace.decision,
    '',
    '## Reasoning summary',
    '',
    trace.reasoning_summary,
    '',
    '## Input references',
    ...trace.input_refs.map((ref) => `- ${ref}`),
    '',
    '## Evidence references',
    ...trace.evidence_refs.map((ref) => `- ${ref}`),
    '',
    '## Status history',
    ...(trace.status_history.length === 0
      ? ['- No status change recorded.']
      : trace.status_history.map((entry) => `- ${entry.status} at ${entry.at} by ${entry.actor}`)),
    '',
    'This trace stores references and a concise rationale, not hidden chain-of-thought or source transcripts.',
    '',
  ].join('\n');
}

export function renderFeedbackBody(sample: FeedbackSample): string {
  return [
    '',
    `# ${sample.feedback_id}`,
    '',
    `Trace: ${sample.trace_id}`,
    `Kind: ${sample.kind}`,
    `Stability: ${sample.stability}`,
    `Source: ${sample.source_ref}`,
    ...(sample.policy_ref === undefined ? [] : [`Policy: ${sample.policy_ref}`]),
    '',
    '## Correction summary',
    '',
    sample.correction_summary ?? 'None.',
    '',
    '## Final outcome',
    '',
    sample.final_outcome ?? 'pending',
    '',
    'This sample is an immutable feedback fact; trace summaries are rebuilt from it.',
    '',
  ].join('\n');
}
