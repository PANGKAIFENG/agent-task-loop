---
type: decision_trace
trace_id: trace-legacy-demo-feedback-001
policy_ref: policy.input-routing.legacy-demo@v001
dimension: input-routing
input_refs:
  - goal:PAW-GOAL-002@0.2
decision: candidate_inbox
reasoning_summary: Traceable synthetic source with an accepted goal; execution stays unauthorized.
evidence_refs:
  - source_key:goal:PAW-GOAL-002@0.2
confidence: high
user_feedback: corrected
final_outcome: corrected_after_review
created_at: 2026-08-17T09:30:00.000Z
---

# trace-legacy-demo-feedback-001

## Decision history

- User corrected the routing rationale during weekly review.

This trace stores references and a concise rationale, not hidden chain-of-thought or source transcripts.
