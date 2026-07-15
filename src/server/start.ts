import { access } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { assertWriteEnabled, loadConfig } from '../config.js';
import {
  CLAUDE_RESEARCH_TIMEOUT_MS,
  createClaudeResearchDriver,
} from '../runner/claude-driver.js';
import { createRunnerController } from '../runner/runner-controller.js';
import { createTaskId, type ServiceContext } from '../services/service-context.js';
import { FileAuditLog } from '../storage/audit-log.js';
import { MarkdownArtifactRepository } from '../storage/markdown-artifact-repository.js';
import { MarkdownProjectRepository } from '../storage/markdown-project-repository.js';
import { MarkdownTaskRepository } from '../storage/markdown-task-repository.js';
import { createApp } from './app.js';

const BOARD_HOST = '127.0.0.1';
const DEFAULT_BOARD_PORT = 4173;

interface StartServerOptions {
  host?: string;
  port?: number;
}

export class InvalidBoardHostError extends Error {
  readonly code = 'invalid_board_host';

  constructor() {
    super('Board server host must be 127.0.0.1');
    this.name = 'InvalidBoardHostError';
  }
}

function createContext(vaultRoot: string): ServiceContext {
  return {
    tasks: new MarkdownTaskRepository(vaultRoot),
    artifacts: new MarkdownArtifactRepository(vaultRoot),
    projects: new MarkdownProjectRepository(vaultRoot),
    audit: new FileAuditLog(vaultRoot, { timeZone: 'Asia/Shanghai' }),
    clock: () => new Date(),
    id: () => createTaskId(),
  };
}

function boardPort(environment: NodeJS.ProcessEnv): number {
  const raw = environment.ATL_BOARD_PORT ?? String(DEFAULT_BOARD_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ATL_BOARD_PORT must be an integer between 1 and 65535');
  }
  return port;
}

function allowedLocalRoots(environment: NodeJS.ProcessEnv): string[] {
  const configured = environment.ATL_ALLOWED_LOCAL_ROOTS;
  if (configured === undefined || configured.trim() === '') {
    return [];
  }
  const roots = configured.split(delimiter).filter((root) => root !== '');
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) {
    throw new Error('ATL_ALLOWED_LOCAL_ROOTS must contain absolute paths');
  }
  return roots;
}

export async function findBoardStaticRoot(
  workingDirectory: string = process.cwd(),
): Promise<string | undefined> {
  const root = join(workingDirectory, 'build', 'ui');
  try {
    await access(root);
    return root;
  } catch {
    return undefined;
  }
}

export async function startServer(
  app: FastifyInstance,
  options: StartServerOptions = {},
): Promise<string> {
  const host = options.host ?? BOARD_HOST;
  if (host !== BOARD_HOST) {
    throw new InvalidBoardHostError();
  }
  return app.listen({ host, port: options.port ?? DEFAULT_BOARD_PORT });
}

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const requestedHost = environment.ATL_BOARD_HOST ?? BOARD_HOST;
  if (requestedHost !== BOARD_HOST) {
    throw new InvalidBoardHostError();
  }
  const config = loadConfig(environment);
  assertWriteEnabled(config);
  const port = boardPort(environment);
  const ctx = createContext(config.vaultRoot);
  const driver = await createClaudeResearchDriver({ environment });
  const runner = createRunnerController({
    ctx,
    driver,
    runtimeRoot: join(process.cwd(), '.atl-runtime'),
    allowedLocalRoots: allowedLocalRoots(environment),
    dailyLimit: config.dailyLimit,
    leaseMinutes: config.leaseMinutes,
    timeoutMs: CLAUDE_RESEARCH_TIMEOUT_MS,
    agent: driver.name,
    runId: () => `run-${createTaskId()}`,
  });
  const staticRoot = await findBoardStaticRoot();
  const app = await createApp({
    ctx,
    runner,
    boardOrigin: `http://${BOARD_HOST}:${port}`,
    environment,
    ...(staticRoot === undefined ? {} : { staticRoot }),
  });
  await startServer(app, { host: requestedHost, port });
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'Board server failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
