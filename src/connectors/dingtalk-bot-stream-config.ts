import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { isValidDingTalkProfile } from '../dingtalk-profile.js';
import type { DingTalkBotStreamPolicy } from './dingtalk-bot-stream.js';
import {
  parseDwsAppCredentials,
  type DingTalkAppCredentials,
} from './dws-app-credentials.js';

export interface DingTalkBotStreamConfig {
  profile: string;
  unifiedAppId: string;
  robotCode: string;
  policy: DingTalkBotStreamPolicy;
  bridgeEntry: string;
  dwsExecutable: string;
  nodeExecutable: string;
}

class DingTalkBotStreamConfigError extends Error {
  readonly code = 'dingtalk_stream_configuration_invalid';

  constructor(key: string) {
    super(`${key} is missing or invalid`);
    this.name = 'DingTalkBotStreamConfigError';
  }
}

function requiredIdentifier(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key];
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9_:+./=-]{1,256}$/u.test(value)
  ) throw new DingTalkBotStreamConfigError(key);
  return value;
}

function requiredAbsolutePath(
  environment: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = environment[key];
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new DingTalkBotStreamConfigError(key);
  }
  return value;
}

export function loadDingTalkBotStreamConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DingTalkBotStreamConfig {
  const profile = environment.ATL_DINGTALK_PROFILE;
  if (!isValidDingTalkProfile(profile)) {
    throw new DingTalkBotStreamConfigError('ATL_DINGTALK_PROFILE');
  }
  const parts = profile.split(':');
  if (
    parts.length !== 2
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[0] ?? '')
    || !/^[A-Za-z0-9_-]{1,128}$/u.test(parts[1] ?? '')
  ) throw new DingTalkBotStreamConfigError('ATL_DINGTALK_PROFILE');
  const [trustedCorpId, trustedSenderUserId] = parts as [string, string];
  const unifiedAppId = environment.ATL_DINGTALK_UNIFIED_APP_ID;
  if (
    typeof unifiedAppId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(unifiedAppId)
  ) throw new DingTalkBotStreamConfigError('ATL_DINGTALK_UNIFIED_APP_ID');
  const robotCode = requiredIdentifier(environment, 'ATL_DINGTALK_ROBOT_CODE');
  const trustedConversationId = requiredIdentifier(
    environment,
    'ATL_DINGTALK_TRUSTED_CONVERSATION_ID',
  );
  return {
    profile,
    unifiedAppId,
    robotCode,
    policy: {
      robotCode,
      trustedCorpId,
      trustedSenderUserId,
      trustedConversationId,
    },
    bridgeEntry: requiredAbsolutePath(environment, 'ATL_DINGTALK_BRIDGE_ENTRY'),
    dwsExecutable: requiredAbsolutePath(environment, 'ATL_DWS_EXECUTABLE'),
    nodeExecutable: environment.ATL_NODE_EXECUTABLE === undefined
      ? process.execPath
      : requiredAbsolutePath(environment, 'ATL_NODE_EXECUTABLE'),
  };
}

export function dwsCredentialArguments(config: DingTalkBotStreamConfig): string[] {
  return [
    '--profile', config.profile,
    '--format', 'json',
    'dev', 'app', 'credentials', 'get',
    '--unified-app-id', config.unifiedAppId,
  ];
}

export function loadDwsAppCredentials(
  config: DingTalkBotStreamConfig,
): Promise<DingTalkAppCredentials> {
  return new Promise((resolve, reject) => {
    execFile(config.dwsExecutable, dwsCredentialArguments(config), {
      encoding: 'utf8',
      maxBuffer: 64 * 1_024,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        reject(new DingTalkBotStreamConfigError('DingTalk app credentials'));
        return;
      }
      try {
        resolve(parseDwsAppCredentials(stdout, config));
      } catch {
        reject(new DingTalkBotStreamConfigError('DingTalk app credentials'));
      }
    });
  });
}
