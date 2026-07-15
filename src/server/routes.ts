import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';

import { PRIORITIES, type Task } from '../domain/task.js';
import type { RunnerController } from '../runner/runner-controller.js';
import { RunnerBusyError } from '../runner/runner-controller.js';
import { captureTask, InvalidCaptureTaskInputError } from '../services/capture-task.js';
import { isClaimEligible } from '../services/claim-task.js';
import { confirmTask, type ConfirmTaskInput } from '../services/confirm-task.js';
import { reopenTask, type ReopenTaskInput } from '../services/reopen-task.js';
import {
  ReviewTaskInvalidInputError,
  reviewTask,
  type ReviewTaskInput,
} from '../services/review-task.js';
import type { ServiceContext } from '../services/service-context.js';
import { stopTask } from '../services/stop-task.js';
import { unblockTask, type UnblockTaskInput } from '../services/unblock-task.js';
import {
  TaskConflictError,
  TaskNotFoundError,
} from '../storage/markdown-task-repository.js';

interface RegisterRoutesOptions {
  ctx: ServiceContext;
  runner: RunnerController;
  boardOrigin: string;
  token: string;
}

interface TaskParams {
  id: string;
}

interface ProjectParams {
  id: string;
}

interface ApiErrorBody {
  code: string;
  message: string;
  details: unknown;
}

interface PublicError {
  statusCode: number;
  body: ApiErrorBody;
}

class TaskNotEligibleForRunError extends Error {
  readonly code = 'task_not_eligible_for_run';

  constructor() {
    super('Task must be Ready to run');
    this.name = 'TaskNotEligibleForRunError';
  }
}

function apiError(code: string, message: string, details: unknown = null): ApiErrorBody {
  return { code, message, details };
}

function codedError(error: unknown): string | null {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    && /^[a-z][a-z0-9_]{0,99}$/.test(error.code)
  ) {
    return error.code;
  }
  return null;
}

const publicServiceErrors: Readonly<Record<string, { code: string; message: string }>> = {
  invalid_capture_task_input: {
    code: 'invalid_capture_task_input',
    message: 'Invalid capture task input',
  },
  invalid_confirm_task_input: {
    code: 'invalid_confirm_task_input',
    message: 'Invalid confirm task input',
  },
  confirm_task_project_not_found: {
    code: 'confirm_task_project_not_found',
    message: 'Task project not found',
  },
  task_confirmation_invalid_state: {
    code: 'task_confirmation_invalid_state',
    message: 'Task must be in Inbox to confirm',
  },
  invalid_review_task_input: {
    code: 'invalid_review_task_input',
    message: 'Invalid task review input',
  },
  task_review_invalid_state: {
    code: 'task_review_invalid_state',
    message: 'Task must be in Review',
  },
  task_review_artifact_invalid: {
    code: 'task_review_artifact_invalid',
    message: 'Task Review Artifact is invalid',
  },
  task_stop_invalid_state: {
    code: 'task_stop_invalid_state',
    message: 'Task must be In Progress to stop',
  },
  invalid_unblock_task_input: {
    code: 'invalid_unblock_task_input',
    message: 'Invalid task recovery note',
  },
  task_unblock_invalid_state: {
    code: 'task_unblock_invalid_state',
    message: 'Task must be Blocked to unblock',
  },
  invalid_reopen_task_input: {
    code: 'invalid_reopen_task_input',
    message: 'Invalid task reopen reason',
  },
  task_reopen_invalid_state: {
    code: 'task_reopen_invalid_state',
    message: 'Task must be Done to reopen',
  },
  task_not_eligible_for_run: {
    code: 'task_not_eligible_for_run',
    message: 'Task must be Ready to run',
  },
};

function fastifyClientError(error: unknown): PublicError | null {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || typeof error.code !== 'string'
    || !error.code.startsWith('FST_ERR_')
    || !('statusCode' in error)
    || typeof error.statusCode !== 'number'
    || ![400, 413, 415].includes(error.statusCode)
  ) {
    return null;
  }
  const response = {
    400: apiError('invalid_request_body', 'Invalid request body'),
    413: apiError('request_body_too_large', 'Request body too large'),
    415: apiError('unsupported_media_type', 'Unsupported media type'),
  }[error.statusCode];
  return response === undefined
    ? null
    : { statusCode: error.statusCode, body: response };
}

function publicError(error: unknown): PublicError {
  const parserError = fastifyClientError(error);
  if (parserError !== null) {
    return parserError;
  }
  if (error instanceof TaskNotFoundError) {
    return {
      statusCode: 404,
      body: apiError('task_not_found', 'Task not found'),
    };
  }
  if (error instanceof RunnerBusyError) {
    return {
      statusCode: 409,
      body: apiError('runner_busy', 'Runner is busy'),
    };
  }
  if (error instanceof TaskConflictError) {
    return {
      statusCode: 409,
      body: apiError('task_conflict', 'Task conflict'),
    };
  }
  const mapped = publicServiceErrors[codedError(error) ?? ''];
  if (mapped !== undefined) {
    return { statusCode: 400, body: apiError(mapped.code, mapped.message) };
  }
  if (error instanceof Error && error.message.startsWith('Task is not ready:')) {
    return {
      statusCode: 400,
      body: apiError('task_not_ready', 'Task is not ready'),
    };
  }
  return {
    statusCode: 500,
    body: apiError('internal_error', 'Internal server error'),
  };
}

async function taskDto(ctx: ServiceContext, task: Task) {
  const artifactSummaries = await Promise.all(task.artifactRefs.map(async (ref) => {
    const artifact = await ctx.artifacts.readSummary(ref);
    return {
      summary: artifact.summary,
      evidenceCount: artifact.evidenceCount,
    };
  }));
  return {
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    reviewState: task.reviewState,
    projectId: task.projectId,
    taskType: task.taskType,
    objective: task.objective,
    acceptanceCriteria: task.acceptanceCriteria,
    autoExecutable: task.autoExecutable,
    permissionProfile: task.permissionProfile,
    origin: task.origin,
    sourceDate: task.sourceDate,
    sourceExcerpt: task.sourceQuote,
    possibleDuplicateIds: task.possibleDuplicateIds,
    priority: task.priority,
    attempts: task.attempts,
    claim: task.claim,
    artifactSummaries,
    reviewFeedback: task.reviewFeedback,
    readyAt: task.readyAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function requireWriteAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  options: Pick<RegisterRoutesOptions, 'boardOrigin' | 'token'>,
) {
  if (request.headers['x-atl-token'] !== options.token) {
    return reply.code(401).send(apiError('unauthorized', 'Invalid board token'));
  }
  if (request.headers.origin !== options.boardOrigin) {
    return reply.code(403).send(apiError('forbidden_origin', 'Invalid board origin'));
  }
}

function createInput(body: unknown) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new InvalidCaptureTaskInputError();
  }
  const input = body as Record<string, unknown>;
  const allowed = new Set(['title', 'sourceKey', 'body', 'sourceExcerpt', 'priority']);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new InvalidCaptureTaskInputError();
  }
  const title = input.title;
  const sourceKey = input.sourceKey;
  const details = input.body ?? title;
  const sourceExcerpt = input.sourceExcerpt ?? null;
  const priority = input.priority ?? 'normal';
  if (
    typeof title !== 'string'
    || typeof sourceKey !== 'string'
    || typeof details !== 'string'
    || (sourceExcerpt !== null && typeof sourceExcerpt !== 'string')
    || typeof priority !== 'string'
    || !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])
  ) {
    throw new InvalidCaptureTaskInputError();
  }
  return {
    title,
    body: details,
    origin: 'local_board',
    sourceDate: null,
    sourceNote: null,
    sourceQuote: sourceExcerpt,
    sourceKey,
    priority: priority as (typeof PRIORITIES)[number],
  };
}

function reviewInput(body: unknown): ReviewTaskInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ReviewTaskInvalidInputError();
  }
  return body as ReviewTaskInput;
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  app.setErrorHandler((error, _request, reply) => {
    const response = publicError(error);
    return reply.code(response.statusCode).send(response.body);
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST') {
      return requireWriteAccess(request, reply, options);
    }
  });

  app.get('/runtime-config.js', async (_request, reply) => {
    const config = JSON.stringify({ token: options.token, apiBase: options.boardOrigin });
    return reply
      .type('application/javascript; charset=utf-8')
      .send(`globalThis.ATL_RUNTIME_CONFIG=${config};\n`);
  });

  app.get('/api/inbox', async () => ({
    tasks: await Promise.all(
      (await options.ctx.tasks.list())
        .filter((task) => task.status === 'inbox')
        .map((task) => taskDto(options.ctx, task)),
    ),
  }));

  app.get('/api/review', async () => ({
    tasks: await Promise.all(
      (await options.ctx.tasks.list())
        .filter((task) => task.status === 'review')
        .map((task) => taskDto(options.ctx, task)),
    ),
  }));

  app.get('/api/projects', async () => ({ projects: await options.ctx.projects.list() }));

  app.get<{ Params: ProjectParams }>(
    '/api/projects/:id/tasks',
    async (request) => ({
      tasks: await Promise.all(
        (await options.ctx.tasks.list())
          .filter((task) => task.projectId === request.params.id)
          .map((task) => taskDto(options.ctx, task)),
      ),
    }),
  );

  app.post('/api/tasks', async (request, reply) => {
    const task = await captureTask(options.ctx, createInput(request.body));
    return reply.code(201).send(await taskDto(options.ctx, task));
  });

  app.post<{ Params: TaskParams; Body: ConfirmTaskInput }>(
    '/api/tasks/:id/confirm',
    async (request) => taskDto(
      options.ctx,
      await confirmTask(options.ctx, request.params.id, request.body),
    ),
  );

  app.post<{ Params: TaskParams }>(
    '/api/tasks/:id/run',
    async (request, reply) => {
      const task = await options.ctx.tasks.get(request.params.id);
      if (!isClaimEligible(task)) {
        throw new TaskNotEligibleForRunError();
      }
      const started = await options.runner.start({ taskId: task.taskId, mode: 'manual' });
      return reply.code(202).send({ taskId: task.taskId, runId: started.runId });
    },
  );

  app.post<{ Params: TaskParams; Body: ReviewTaskInput }>(
    '/api/tasks/:id/review',
    async (request) => taskDto(
      options.ctx,
      await reviewTask(options.ctx, request.params.id, reviewInput(request.body)),
    ),
  );

  app.post<{ Params: TaskParams }>(
    '/api/tasks/:id/stop',
    async (request) => taskDto(
      options.ctx,
      await stopTask(options.ctx, request.params.id),
    ),
  );

  app.post<{ Params: TaskParams; Body: UnblockTaskInput }>(
    '/api/tasks/:id/unblock',
    async (request) => taskDto(
      options.ctx,
      await unblockTask(options.ctx, request.params.id, request.body),
    ),
  );

  app.post<{ Params: TaskParams; Body: ReopenTaskInput }>(
    '/api/tasks/:id/reopen',
    async (request) => taskDto(
      options.ctx,
      await reopenTask(options.ctx, request.params.id, request.body),
    ),
  );
}
