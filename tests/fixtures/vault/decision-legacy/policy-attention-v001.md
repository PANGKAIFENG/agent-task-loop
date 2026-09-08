---
type: decision_policy
policy_id: policy.attention-priority.legacy-demo
version: v001
status: observing
dimension: attention-priority
decision_question: Which pending item deserves the next focus block?
sources:
  - synthetic_input
  - TEP27-PRD@1.1
next_review_at: 2026-08-24
---

# policy.attention-priority.legacy-demo@v001

## Inputs

- Dashboard task queue
- Current focus window

## Rules

- Rank admitted tasks by due date before backlog items.

## Exceptions

- User-pinned items always win the next block.

## Outputs

- A single next-focus recommendation.

## Metrics

- Focus block utilization
