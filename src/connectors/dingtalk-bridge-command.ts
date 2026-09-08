import { execFile } from 'node:child_process';

import { hasControlCharacters } from '../dingtalk-profile.js';
import type { DingTalkReplyEvent } from './dingtalk-bot-stream.js';

const BRIDGE_TIMEOUT_MS = 35 * 60 * 1_000;
const BRIDGE_OUTPUT_LIMIT = 2_000;

class DingTalkBridgeCommandError extends Error {
  readonly code = 'dingtalk_bridge_failed';

  constructor() {
    super('ATL DingTalk bridge failed');
    this.name = 'DingTalkBridgeCommandError';
  }
}

export function bridgeReplyArguments(
  bridgeEntry: string,
): string[] {
  return [
    bridgeEntry,
    'reply',
    '--stdin-json',
  ];
}

export function runDingTalkBridgeCommand(options: {
  nodeExecutable: string;
  bridgeEntry: string;
  environment?: NodeJS.ProcessEnv;
}): (event: DingTalkReplyEvent) => Promise<string> {
  return (event) => new Promise((resolve, reject) => {
    const child = execFile(
      options.nodeExecutable,
      bridgeReplyArguments(options.bridgeEntry),
      {
        encoding: 'utf8',
        env: options.environment ?? process.env,
        maxBuffer: 64 * 1_024,
        timeout: BRIDGE_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        const text = stdout.trim();
        if (
          error !== null
          || text.length === 0
          || text.length > BRIDGE_OUTPUT_LIMIT
          || hasControlCharacters(text)
        ) {
          reject(new DingTalkBridgeCommandError());
          return;
        }
        resolve(text);
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(JSON.stringify(event));
  });
}
