---
type: decision_policy
policy_id: policy.input-routing.legacy-demo
version: v001
status: observing
dimension: input-routing
decision_question: Should this legacy synthetic input become a work item?
sources:
  - synthetic_input
  - TEP27-PRD@1.1
next_review_at: 2026-08-24
---

# policy.input-routing.legacy-demo@v001

## Inputs

- Stable source reference
- Accepted Goal and task context

## Rules

- Preserve source_key and create an Inbox candidate first.

## Exceptions

- Real external writes always require a separate current authorization.

## Outputs

- An explainable state plus a Decision Trace reference.

## Metrics

- Trace coverage
