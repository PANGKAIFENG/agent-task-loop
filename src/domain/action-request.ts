import { z } from 'zod';

import { canTransition } from './transitions.js';
import {
  multicaSummarySchema,
  type MulticaEvent,
  type MulticaEventState,
  type NotifiableEventState,
} from './multica-event.js';

// PAW-GOAL-003 T2 (TECH §2 / §3.1 / PRD 4.3): the original Obsidian task keeps
// exactly one current action_request — the pending human decision projected
// from the latest notifiable Multica event. Every action reply is validated
// against the Event × Action matrix before anything is written anywhere.
export const ACTION_REQUEST_TYPES: readonly NotifiableEventState[] = [
  'needs_decision',
  'blocked',
  'failed',
  'release_candidate_ready',
];

export const ACTION_REQUEST_STATUSES = ['pending', 'handled', 'superseded'] as const;

export const ACTION_REQUEST_TERMINAL_STEPS = [
  'supervisor_resumed',
  'completed_without_resume',
  'release_operator_started',
] as const;

export type ActionRequestType = NotifiableEventState;
export type ActionRequestStatus = (typeof ACTION_REQUEST_STATUSES)[number];
export type ActionRequestTerminalStep = (typeof ACTION_REQUEST_TERMINAL_STEPS)[number];

const TERMINAL_ACTIONS = ['approve', 'rework', 'block', 'cancel'] as const;
export type TerminalExternalAction = (typeof TERMINAL_ACTIONS)[number];
export type ExternalAction = TerminalExternalAction | `select:${string}`;

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9]*-[0-9]{1,10}$/;
const OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const STREAM_EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

const safeText = (maxLength: number) => z
  .string()
  .trim()
  .min(1)
  .max(maxLength)
  .refine(hasNoControlCharacters, 'Control characters are not allowed');

export interface ActionRequest {
  schemaVersion: 1;
  actionId: string;
  eventId: string;
  type: ActionRequestType;
  status: ActionRequestStatus;
  title: string;
  summary: string;
  allowedActions: ExternalAction[];
  multicaIssue: string;
  githubPr: string | null;
  headSha: string | null;
  notificationId: string | null;
  /**
   * CR fix 2 (TECH §6 step 2): the stream event that handled this request and
   * the terminal step its action decided. Both are persisted in the SAME task
   * write as the `handled` transition, so crash recovery proves the recording
   * from the task alone — never from the later audit append.
   */
  handledStreamEventId: string | null;
  handledTerminalStep: ActionRequestTerminalStep | null;
}

const externalActionSchema = z.string().refine(
  (value): value is ExternalAction => (
    (TERMINAL_ACTIONS as readonly string[]).includes(value)
    || (`select:`.length < value.length && value.startsWith('select:')
      && OPTION_ID_PATTERN.test(value.slice('select:'.length)))
  ),
  'Action must be approve/rework/block/cancel or select:<option_id>',
);

export const actionRequestSchema: z.ZodType<ActionRequest> = z
  .object({
    schemaVersion: z.literal(1),
    actionId: z.string().regex(
      /^action:[A-Za-z0-9][A-Za-z0-9._-]{0,99}:[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/,
      'actionId must look like action:<task_id>:<event_id>',
    ),
    eventId: safeText(200),
    type: z.enum(ACTION_REQUEST_TYPES),
    status: z.enum(ACTION_REQUEST_STATUSES),
    title: safeText(300),
    summary: multicaSummarySchema,
    allowedActions: z.array(externalActionSchema).min(1).max(24),
    multicaIssue: z.string().regex(IDENTIFIER_PATTERN, 'multicaIssue must look like TEP-42'),
    githubPr: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u).nullable(),
    headSha: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/u).nullable(),
    notificationId: safeText(256).nullable(),
    handledStreamEventId: safeText(200).nullable(),
    handledTerminalStep: z.enum(ACTION_REQUEST_TERMINAL_STEPS).nullable(),
  })
  .strict();

const TYPE_TITLES: Record<ActionRequestType, string> = {
  needs_decision: '选择恢复策略',
  blocked: 'Multica 任务被阻塞',
  failed: 'Multica 执行失败需要处理',
  release_candidate_ready: 'RC 待验收：接受并发布',
};

function allowedActionsForEvent(event: MulticaEvent): ExternalAction[] {
  if (event.state === 'needs_decision') {
    const options = event.decision?.options ?? [];
    return [
      ...options.map((option) => `select:${option.id}` as ExternalAction),
      'block',
      'cancel',
    ];
  }
  if (event.state === 'blocked' || event.state === 'failed') {
    return event.recoverability?.recoverable === true
      ? ['rework', 'block', 'cancel']
      : ['block', 'cancel'];
  }
  return ['approve', 'rework', 'block', 'cancel'];
}

/**
 * Projects one notifiable event into the single pending action_request of the
 * original task (PRD 4.3.2). Only matrix-legal actions are listed — blocked
 * and failed events never expose approve, and unrecoverable ones drop rework.
 */
export function actionRequestForEvent(
  event: MulticaEvent,
  issueIdentifier: string,
): ActionRequest {
  const release = event.state === 'release_candidate_ready' ? event.release : null;
  return actionRequestSchema.parse({
    schemaVersion: 1,
    actionId: `action:${event.atlTaskId}:${event.eventId}`,
    eventId: event.eventId,
    type: event.state as ActionRequestType,
    status: 'pending',
    title: TYPE_TITLES[event.state as ActionRequestType],
    summary: event.summary,
    allowedActions: allowedActionsForEvent(event),
    multicaIssue: issueIdentifier,
    githubPr: release?.pr ?? null,
    headSha: release?.headSha ?? null,
    notificationId: null,
    handledStreamEventId: null,
    handledTerminalStep: null,
  });
}

export type ExternalActionVerdict =
  | {
    status: 'ok';
    action: ExternalAction;
    nextTaskStatus: string;
    resumesSupervisor: boolean;
    terminalStep: ActionRequestTerminalStep;
  }
  | {
    status: 'invalid';
    code: 'invalid_external_action' | 'action_request_not_pending' | 'action_request_superseded'
      | 'invalid_task_transition';
    reason: string;
  };

/**
 * TECH §3.1 Event × Action matrix. Unlisted combinations return
 * invalid_external_action and must not modify the task, comment, or rerun.
 */
export function validateExternalAction(
  event: MulticaEvent,
  request: ActionRequest,
  rawAction: string,
  currentTaskStatus: string,
): ExternalActionVerdict {
  const action = parseExternalAction(rawAction);
  if (action === null) {
    return {
      status: 'invalid',
      code: 'invalid_external_action',
      reason: `malformed external action: ${rawAction.slice(0, 100)}`,
    };
  }
  if (request.status !== 'pending') {
    return {
      status: 'invalid',
      code: 'action_request_not_pending',
      reason: `action request is ${request.status}`,
    };
  }
  if (request.eventId !== event.eventId || request.actionId !== `action:${event.atlTaskId}:${event.eventId}`) {
    return {
      status: 'invalid',
      code: 'action_request_superseded',
      reason: `action request targets event ${request.eventId}, current event is ${event.eventId}`,
    };
  }
  if (
    action === 'rework'
    && (event.state === 'blocked' || event.state === 'failed')
    && event.recoverability?.recoverable !== true
  ) {
    return {
      status: 'invalid',
      code: 'invalid_external_action',
      reason: `${event.state} event is not recoverable; rework is rejected`,
    };
  }
  if (action.startsWith('select:')) {
    const optionId = action.slice('select:'.length);
    const option = event.decision?.options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      return {
        status: 'invalid',
        code: 'invalid_external_action',
        reason: `unknown option ${optionId} for event ${event.eventId}`,
      };
    }
  }
  if (!request.allowedActions.includes(action)) {
    return {
      status: 'invalid',
      code: 'invalid_external_action',
      reason: `action ${action} is not allowed for ${event.state} event`,
    };
  }

  let nextTaskStatus: string;
  let resumesSupervisor: boolean;
  let terminalStep: ActionRequestTerminalStep;
  switch (event.state) {
    case 'needs_decision':
      if (action === 'block') {
        nextTaskStatus = 'blocked';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      } else if (action === 'cancel') {
        nextTaskStatus = 'cancelled';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      } else {
        const optionId = action.slice('select:'.length);
        const option = event.decision?.options.find((candidate) => candidate.id === optionId);
        if (option === undefined) {
          return {
            status: 'invalid',
            code: 'invalid_external_action',
            reason: `unknown option ${optionId} for event ${event.eventId}`,
          };
        }
        nextTaskStatus = 'agent_executable';
        resumesSupervisor = true;
        terminalStep = 'supervisor_resumed';
      }
      break;
    case 'blocked':
    case 'failed':
      if (action === 'rework') {
        nextTaskStatus = 'agent_executable';
        resumesSupervisor = true;
        terminalStep = 'supervisor_resumed';
      } else if (action === 'block') {
        nextTaskStatus = currentTaskStatus === 'blocked' ? 'blocked' : 'blocked';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      } else {
        nextTaskStatus = 'cancelled';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      }
      break;
    case 'release_candidate_ready':
      if (action === 'approve') {
        // RC approve keeps ATL in review; only the Release Receipt completes it.
        nextTaskStatus = 'review';
        resumesSupervisor = false;
        terminalStep = 'release_operator_started';
      } else if (action === 'rework') {
        nextTaskStatus = 'agent_executable';
        resumesSupervisor = true;
        terminalStep = 'supervisor_resumed';
      } else if (action === 'block') {
        nextTaskStatus = 'blocked';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      } else {
        nextTaskStatus = 'cancelled';
        resumesSupervisor = false;
        terminalStep = 'completed_without_resume';
      }
      break;
    default:
      return {
        status: 'invalid',
        code: 'invalid_external_action',
        reason: `state ${event.state satisfies MulticaEventState} does not accept actions`,
      };
  }

  if (nextTaskStatus !== currentTaskStatus && !canTransition(currentTaskStatus, nextTaskStatus)) {
    return {
      status: 'invalid',
      code: 'invalid_task_transition',
      reason: `invalid task transition: ${currentTaskStatus} -> ${nextTaskStatus}`,
    };
  }
  return { status: 'ok', action, nextTaskStatus, resumesSupervisor, terminalStep };
}

export function parseExternalAction(raw: string): ExternalAction | null {
  if ((TERMINAL_ACTIONS as readonly string[]).includes(raw)) {
    return raw as TerminalExternalAction;
  }
  if (raw.startsWith('select:')) {
    const optionId = raw.slice('select:'.length);
    return OPTION_ID_PATTERN.test(optionId) ? `select:${optionId}` as ExternalAction : null;
  }
  return null;
}

/**
 * DingTalk reply contract for Multica actions: exactly `<action> <task-id>`.
 * The task id is mandatory so a reply can never be attributed to the wrong
 * pending task when several are waiting.
 */
export function parseMulticaActionReply(
  message: string,
): { taskId: string; action: ExternalAction } | null {
  const tokens = message.trim().split(/\s+/u);
  if (tokens.length !== 2) {
    return null;
  }
  const [rawAction, rawTaskId] = tokens as [string, string];
  const action = parseExternalAction(rawAction);
  if (action === null || !TASK_ID_PATTERN.test(rawTaskId)) {
    return null;
  }
  return { taskId: rawTaskId, action };
}

// TECH §6: the remote comment marker that makes one trusted reply write
// idempotent across crashes and retries.
export function multicaResponseMarker(streamEventId: string): string {
  if (!STREAM_EVENT_ID_PATTERN.test(streamEventId)) {
    throw new Error('Invalid Multica response stream event id');
  }
  return `[ATL_RESPONSE:${streamEventId}]`;
}
