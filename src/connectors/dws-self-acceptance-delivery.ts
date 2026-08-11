import { execFile } from 'node:child_process';

import { isValidDingTalkProfile } from '../dingtalk-profile.js';
import type { AcceptanceDelivery } from '../services/notify-acceptance.js';

export interface DwsCommandResult {
  exitCode: number;
  stdout: string;
}

export type DwsCommandRunner = (args: string[]) => Promise<DwsCommandResult>;

class DwsAcceptanceDeliveryError extends Error {
  constructor(
    readonly code: 'dingtalk_profile_invalid'
      | 'dingtalk_self_resolution_failed'
      | 'dingtalk_delivery_failed',
    message: string,
  ) {
    super(message);
    this.name = 'DwsAcceptanceDeliveryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, code: DwsAcceptanceDeliveryError['code']): Record<string, unknown> {
  try {
    const value = JSON.parse(stdout) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // Normalize parser details so DWS output never leaks through service errors.
  }
  throw new DwsAcceptanceDeliveryError(code, 'DingTalk returned an invalid result');
}

function successfulEnvelope(
  result: DwsCommandResult,
  code: DwsAcceptanceDeliveryError['code'],
): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new DwsAcceptanceDeliveryError(code, 'DingTalk command failed');
  }
  const envelope = parseJson(result.stdout, code);
  if (
    envelope.success !== true
    || envelope.complete === false
    || (Array.isArray(envelope.failures) && envelope.failures.length > 0)
  ) {
    throw new DwsAcceptanceDeliveryError(code, 'DingTalk operation was not successful');
  }
  return envelope;
}

function resolveSelfUserId(result: DwsCommandResult): string {
  const envelope = successfulEnvelope(result, 'dingtalk_self_resolution_failed');
  if (!Array.isArray(envelope.result) || envelope.result.length !== 1) {
    throw new DwsAcceptanceDeliveryError(
      'dingtalk_self_resolution_failed',
      'DingTalk self target was not unique',
    );
  }
  const entry = envelope.result[0];
  const employee = isRecord(entry) && isRecord(entry.orgEmployeeModel)
    ? entry.orgEmployeeModel
    : null;
  const userId = employee?.userId;
  if (typeof userId !== 'string' || userId.trim() === '' || userId.length > 256) {
    throw new DwsAcceptanceDeliveryError(
      'dingtalk_self_resolution_failed',
      'DingTalk self target was invalid',
    );
  }
  return userId;
}

function optionalId(entry: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim() !== '' && value.length <= 256) {
      return value;
    }
  }
  return null;
}

function parseDeliveryResult(result: DwsCommandResult): {
  taskId: string | null;
  messageId: string | null;
} {
  const envelope = successfulEnvelope(result, 'dingtalk_delivery_failed');
  const rawResult = envelope.result;
  if (
    rawResult !== undefined
    && !Array.isArray(rawResult)
    && !isRecord(rawResult)
  ) {
    throw new DwsAcceptanceDeliveryError(
      'dingtalk_delivery_failed',
      'DingTalk delivery result was invalid',
    );
  }
  if (Array.isArray(rawResult) && rawResult.length > 1) {
    throw new DwsAcceptanceDeliveryError(
      'dingtalk_delivery_failed',
      'DingTalk delivery result was ambiguous',
    );
  }
  const entry = Array.isArray(rawResult) && isRecord(rawResult[0])
    ? rawResult[0]
    : isRecord(rawResult) ? rawResult : {};
  return {
    taskId: optionalId(entry, ['openTaskId', 'open_taskId', 'taskId', 'task_id']),
    messageId: optionalId(entry, [
      'openMessageId',
      'open_messageId',
      'messageId',
      'message_id',
    ]),
  };
}

export function runDwsCommand(
  args: string[],
  options: { executable?: string; timeoutMs?: number } = {},
): Promise<DwsCommandResult> {
  return new Promise((resolve) => {
    execFile(options.executable ?? 'dws', args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: options.timeoutMs ?? 45_000,
      windowsHide: true,
    }, (error, stdout) => {
      resolve({
        exitCode: error === null
          ? 0
          : typeof error.code === 'number' ? error.code : 1,
        stdout,
      });
    });
  });
}

const defaultRunner: DwsCommandRunner = (args) => runDwsCommand(args);

export class DwsSelfAcceptanceDelivery implements AcceptanceDelivery {
  private readonly profile: string;
  private readonly runner: DwsCommandRunner;

  constructor(options: { profile: string; runner?: DwsCommandRunner }) {
    if (!isValidDingTalkProfile(options.profile)) {
      throw new DwsAcceptanceDeliveryError(
        'dingtalk_profile_invalid',
        'One explicit DingTalk profile is required',
      );
    }
    this.profile = options.profile;
    this.runner = options.runner ?? defaultRunner;
  }

  async send(message: {
    uuid: string;
    title: string;
    text: string;
  }): Promise<{ taskId: string | null; messageId: string | null }> {
    const self = resolveSelfUserId(await this.runner([
      '--profile', this.profile,
      '--format', 'json',
      'contact', 'user', 'get-self',
    ]));
    const result = await this.runner([
      '--profile', this.profile,
      '--format', 'json',
      'chat', 'message', 'send',
      '--user', self,
      '--title', message.title,
      '--text', message.text,
      '--uuid', message.uuid,
      '--yes',
    ]);
    return parseDeliveryResult(result);
  }
}
