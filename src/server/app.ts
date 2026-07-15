import { randomBytes } from 'node:crypto';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import type { RunnerController } from '../runner/runner-controller.js';
import type { ServiceContext } from '../services/service-context.js';
import { registerRoutes } from './routes.js';

export interface CreateAppOptions {
  ctx: ServiceContext;
  runner: RunnerController;
  boardOrigin: string;
  environment?: NodeJS.ProcessEnv;
  staticRoot?: string;
}

export class InvalidBoardOriginError extends Error {
  readonly code = 'invalid_board_origin';

  constructor() {
    super('Board origin must be a local HTTP origin');
    this.name = 'InvalidBoardOriginError';
  }
}

function localBoardOrigin(value: string): string {
  try {
    const origin = new URL(value);
    if (
      origin.protocol !== 'http:'
      || origin.hostname !== '127.0.0.1'
      || origin.origin !== value
    ) {
      throw new Error('Invalid origin');
    }
    return origin.origin;
  } catch {
    throw new InvalidBoardOriginError();
  }
}

function boardToken(environment: NodeJS.ProcessEnv): string {
  return environment.ATL_BOARD_TOKEN ?? randomBytes(32).toString('hex');
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  const origin = localBoardOrigin(options.boardOrigin);
  const token = boardToken(options.environment ?? process.env);

  await registerRoutes(app, {
    ctx: options.ctx,
    runner: options.runner,
    boardOrigin: origin,
    token,
  });
  if (options.staticRoot !== undefined) {
    await app.register(fastifyStatic, {
      root: options.staticRoot,
      wildcard: false,
    });
    for (const route of ['/inbox', '/review', '/projects', '/projects/:id']) {
      app.get(route, async (_request, reply) => reply
        .type('text/html; charset=utf-8')
        .sendFile('index.html'));
    }
  }
  return app;
}
