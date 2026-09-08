---
type: decision_trace
trace_id: trace-legacy-demo-accepted-001
policy_ref: policy.attention-priority.legacy-demo@v001
dimension: attention-priority
input_refs:
  - goal:PAW-GOAL-002@0.2
decision: focus_block_ranked
reasoning_summary: Due-date ranking placed the accepted goal first; no external writes required.
evidence_refs:
  - source_key:goal:PAW-GOAL-002@0.2
confidence: medium
user_feedback: accepted
final_outcome: accepted_after_review
created_at: 2026-08-18T07:45:00.000Z
history:
  - Weekly review accepted the ranking rationale.
---

# trace-legacy-demo-accepted-001

## Decision history

- Weekly review accepted the ranking rationale.

This trace stores references and a concise rationale, not hidden chain-of-thought or source transcripts.
