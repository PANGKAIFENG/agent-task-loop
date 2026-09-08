import {
  DINGTALK_ROBOT_TOPIC,
  parseTrustedDingTalkRobotMessage,
  type DingTalkBotStreamPolicy,
  type DingTalkReplyEvent,
  type DingTalkRobotStreamEnvelope,
} from './dingtalk-bot-stream.js';

export interface DingTalkRobotStreamClient {
  registerCallbackListener(
    topic: string,
    listener: (message: DingTalkRobotStreamEnvelope) => Promise<void>,
  ): this;
  connect(): Promise<unknown>;
  disconnect(): void;
  getAccessToken(): Promise<string>;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

export interface DingTalkSessionReplySender {
  send(input: {
    accessToken: string;
    sessionWebhook: string;
    text: string;
  }): Promise<unknown>;
}

export type DingTalkBridgeRunner = (event: DingTalkReplyEvent) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasFailureCode(
  response: Record<string, unknown>,
  field: 'errcode' | 'errorCode' | 'code',
): boolean {
  if (!(field in response)) return false;
  const value = response[field];
  return value !== 0 && value !== '0';
}

function isDingTalkBusinessFailure(response: Record<string, unknown>): boolean {
  return response.success === false
    || response.ok === false
    || hasFailureCode(response, 'errcode')
    || hasFailureCode(response, 'errorCode')
    || hasFailureCode(response, 'code');
}

class DingTalkReplyDeliveryError extends Error {
  readonly code = 'dingtalk_reply_delivery_failed';

  constructor() {
    super('DingTalk reply delivery failed');
    this.name = 'DingTalkReplyDeliveryError';
  }
}

export class FetchDingTalkSessionReplySender implements DingTalkSessionReplySender {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async send(input: {
    accessToken: string;
    sessionWebhook: string;
    text: string;
  }): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(input.sessionWebhook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': input.accessToken,
        },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: input.text },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new DingTalkReplyDeliveryError();
    }
    const body = await response.text();
    if (!response.ok || body.length === 0 || body.length > 64 * 1_024) {
      throw new DingTalkReplyDeliveryError();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw new DingTalkReplyDeliveryError();
    }
    if (!isRecord(parsed) || isDingTalkBusinessFailure(parsed)) {
      throw new DingTalkReplyDeliveryError();
    }
    return parsed;
  }
}

export class DingTalkBotStreamService {
  private readonly client: DingTalkRobotStreamClient;
  private readonly policy: DingTalkBotStreamPolicy;
  private readonly runBridge: DingTalkBridgeRunner;
  private readonly replySender: DingTalkSessionReplySender;
  private readonly inFlightDeliveries = new Map<string, Promise<unknown>>();

  constructor(options: {
    client: DingTalkRobotStreamClient;
    policy: DingTalkBotStreamPolicy;
    runBridge: DingTalkBridgeRunner;
    replySender: DingTalkSessionReplySender;
  }) {
    this.client = options.client;
    this.policy = options.policy;
    this.runBridge = options.runBridge;
    this.replySender = options.replySender;
  }

  async start(): Promise<void> {
    this.client.registerCallbackListener(
      DINGTALK_ROBOT_TOPIC,
      (message) => this.handle(message),
    );
    await this.client.connect();
  }

  stop(): void {
    this.client.disconnect();
  }

  private async handle(message: DingTalkRobotStreamEnvelope): Promise<void> {
    const parsed = parseTrustedDingTalkRobotMessage(message, this.policy);
    if (parsed.kind === 'ignored') {
      if (parsed.transportMessageId !== null) {
        this.client.socketCallBackResponse(
          parsed.transportMessageId,
          { ignored: true },
        );
      }
      return;
    }

    let delivery = this.inFlightDeliveries.get(parsed.event.eventId);
    if (delivery === undefined) {
      delivery = this.deliver(parsed.event, parsed.sessionWebhook);
      this.inFlightDeliveries.set(parsed.event.eventId, delivery);
      const settled = (): void => {
        if (this.inFlightDeliveries.get(parsed.event.eventId) === delivery) {
          this.inFlightDeliveries.delete(parsed.event.eventId);
        }
      };
      void delivery.then(settled, settled);
    }

    const result = await delivery;
    this.client.socketCallBackResponse(parsed.transportMessageId, result);
  }

  private async deliver(
    event: DingTalkReplyEvent,
    sessionWebhook: string,
  ): Promise<unknown> {
    let replyText: string;
    try {
      replyText = await this.runBridge(event);
    } catch {
      replyText = 'ATL 暂时无法处理这条回复，请稍后重试。';
    }

    try {
      const accessToken = await this.client.getAccessToken();
      return await this.replySender.send({
        accessToken,
        sessionWebhook,
        text: replyText,
      });
    } catch {
      throw new DingTalkReplyDeliveryError();
    }
  }
}
