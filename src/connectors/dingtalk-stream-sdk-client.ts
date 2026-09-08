import {
  DWClient,
  type DWClientDownStream,
} from 'dingtalk-stream';

import { hasControlCharacters } from '../dingtalk-profile.js';
import type { DingTalkRobotStreamClient } from './dingtalk-bot-stream-service.js';
import type { DingTalkRobotStreamEnvelope } from './dingtalk-bot-stream.js';

export interface DingTalkStreamCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DingTalkStreamSdkClient {
  registerCallbackListener(
    topic: string,
    listener: (message: DWClientDownStream) => void,
  ): unknown;
  connect(): Promise<void>;
  disconnect(): void;
  getAccessToken(): Promise<unknown>;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

export type DingTalkStreamErrorReporter = (code: string) => void;

function envelope(message: DWClientDownStream): DingTalkRobotStreamEnvelope {
  return {
    headers: {
      messageId: message.headers.messageId,
      topic: message.headers.topic,
    },
    data: message.data,
  };
}

export class DingTalkStreamSdkClientAdapter implements DingTalkRobotStreamClient {
  constructor(
    private readonly client: DingTalkStreamSdkClient,
    private readonly reportError: DingTalkStreamErrorReporter,
  ) {}

  registerCallbackListener(
    topic: string,
    listener: (message: DingTalkRobotStreamEnvelope) => Promise<void>,
  ): this {
    this.client.registerCallbackListener(topic, (message) => {
      void listener(envelope(message)).catch(() => {
        this.reportError('dingtalk_stream_callback_failed');
      });
    });
    return this;
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  async getAccessToken(): Promise<string> {
    const token = await this.client.getAccessToken();
    if (
      typeof token !== 'string'
      || token.length === 0
      || token.length > 4_096
      || hasControlCharacters(token)
    ) throw new Error('DingTalk access token was unavailable');
    return token;
  }

  socketCallBackResponse(messageId: string, result: unknown): void {
    this.client.socketCallBackResponse(messageId, result);
  }
}

export function createDingTalkStreamSdkClient(
  credentials: DingTalkStreamCredentials,
  reportError: DingTalkStreamErrorReporter,
): DingTalkRobotStreamClient {
  const client = new DWClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    keepAlive: true,
    debug: false,
  });
  return new DingTalkStreamSdkClientAdapter(client, reportError);
}
