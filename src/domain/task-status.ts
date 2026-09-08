// PAW-GOAL-003 T2: the controlled status list lives in this leaf module so
// domain modules that depend on the transition matrix (action-request) never
// create an import cycle with task.ts.
export const TASK_STATUSES = [
  'inbox',
  'ready',
  'agent_executable',
  'in_progress',
  'waiting_for_decision',
  'review',
  'done',
  'blocked',
  'cancelled',
] as const;

export type ControlledTaskStatus = (typeof TASK_STATUSES)[number];
export type TaskStatus = string;
