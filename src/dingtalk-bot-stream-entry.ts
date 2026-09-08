#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DingTalkBotStreamService,
  FetchDingTalkSessionReplySender,
  type DingTalkRobotStreamClient,
} from './connectors/dingtalk-bot-stream-service.js';
import {
  loadDingTalkBotStreamConfig,
  loadDwsAppCredentials,
  type DingTalkBotStreamConfig,
} from './connectors/dingtalk-bot-stream-config.js';
import { runDingTalkBridgeCommand } from './connectors/dingtalk-bridge-command.js';
import { createDingTalkStreamSdkClient } from './connectors/dingtalk-stream-sdk-client.js';

export interface DingTalkBotStreamRuntime {
  stop(): void;
}

export interface StartDingTalkBotStreamOptions {
  loadConfig?: () => DingTalkBotStreamConfig;
  loadCredentials?: (config: DingTalkBotStreamConfig) => Promise<{
    clientId: string;
    clientSecret: string;
  }>;
  createClient?: (
    credentials: { clientId: string; clientSecret: string },
    reportError: (code: string) => void,
  ) => DingTalkRobotStreamClient;
  report?: (code: string) => void;
}

function reportToStandardError(code: string): void {
  process.stderr.write(`[atl] ${code}\n`);
}

export async function startDingTalkBotStream(
  options: StartDingTalkBotStreamOptions = {},
): Promise<DingTalkBotStreamRuntime> {
  const report = options.report ?? reportToStandardError;
  const config = (options.loadConfig ?? loadDingTalkBotStreamConfig)();
  const credentials = await (options.loadCredentials ?? loadDwsAppCredentials)(config);
  const client = (options.createClient ?? createDingTalkStreamSdkClient)(
    credentials,
    report,
  );
  const service = new DingTalkBotStreamService({
    client,
    policy: config.policy,
    runBridge: runDingTalkBridgeCommand({
      nodeExecutable: config.nodeExecutable,
      bridgeEntry: config.bridgeEntry,
    }),
    replySender: new FetchDingTalkSessionReplySender(),
  });
  await service.start();
  report('dingtalk_stream_started');
  return { stop: () => service.stop() };
}

async function main(): Promise<void> {
  const runtime = await startDingTalkBotStream();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runtime.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void main().catch(() => {
    reportToStandardError('dingtalk_stream_start_failed');
    process.exitCode = 1;
  });
}
