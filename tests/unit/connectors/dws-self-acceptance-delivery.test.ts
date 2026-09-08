import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dingTalkDeliveryReceiptId,
  DwsSelfAcceptanceDelivery,
  runDwsCommand,
  type DwsCommandRunner,
} from '../../../src/connectors/dws-self-acceptance-delivery.js';

const MESSAGE = {
  uuid: 'cc9169e9-5326-54f8-a190-419f55ae8004',
  title: 'ATL 待验收通知',
  text: [
    '标题：合成验收对象',
    '状态：待验收',
    '待确认：0 项',
    '位置：Obsidian -> ATL：工作沉淀 -> 待验收',
  ].join('\n'),
};
const ROBOT_CODE = 'ding-synthetic-atl-bot';

function success(value: unknown): string {
  return JSON.stringify(value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('DwsSelfAcceptanceDelivery', () => {
  it('uses an asynchronous task acknowledgement as the delivery receipt', () => {
    expect(dingTalkDeliveryReceiptId({
      taskId: 'synthetic-process-query-key',
      messageId: null,
    })).toBe('synthetic-process-query-key');
  });

  it('runs DWS arguments without a shell and captures stdout', async () => {
    await expect(runDwsCommand(['synthetic-output'], {
      executable: '/usr/bin/printf',
      timeoutMs: 1_000,
    })).resolves.toEqual({
      exitCode: 0,
      stdout: 'synthetic-output',
    });
  });

  it('uses the validated LaunchAgent DWS executable by default', async () => {
    vi.stubEnv('ATL_DWS_EXECUTABLE', '/usr/bin/printf');

    await expect(runDwsCommand(['synthetic-output'], {
      timeoutMs: 1_000,
    })).resolves.toEqual({
      exitCode: 0,
      stdout: 'synthetic-output',
    });
  });

  it.each(['', '   ', 'corp-a,corp-b'])('requires one explicit profile: %j', (profile) => {
    expect(() => new DwsSelfAcceptanceDelivery({
      profile,
      robotCode: ROBOT_CODE,
      runner: vi.fn<DwsCommandRunner>(),
    })).toThrowError(expect.objectContaining({ code: 'dingtalk_profile_invalid' }));
  });

  it.each(['', 'bad code', 'abc'])('requires one explicit robot code: %j', (robotCode) => {
    expect(() => new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode,
      runner: vi.fn<DwsCommandRunner>(),
    })).toThrowError(expect.objectContaining({ code: 'dingtalk_robot_code_invalid' }));
  });

  it('resolves self and sends only to that user in the same profile', async () => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ openTaskId: 'synthetic-open-task' }],
        }),
      });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: 'synthetic-open-task',
      messageId: null,
    });
    expect(runner).toHaveBeenNthCalledWith(1, [
      '--profile', 'synthetic-current-profile',
      '--format', 'json',
      'contact', 'user', 'get-self',
    ]);
    expect(runner).toHaveBeenNthCalledWith(2, [
      '--profile', 'synthetic-current-profile',
      '--format', 'json',
      'chat', 'message', 'send-by-bot',
      '--robot-code', ROBOT_CODE,
      '--users', 'synthetic-self-user',
      '--title', MESSAGE.title,
      '--text', MESSAGE.text,
      '--yes',
    ]);
  });

  it('uses the user id embedded in a production profile without an extra API lookup', async () => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: success({
        success: true,
        result: [{ openTaskId: 'synthetic-open-task' }],
      }),
    });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'ding-synthetic-corp:synthetic-self-user',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: 'synthetic-open-task',
      messageId: null,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith([
      '--profile', 'ding-synthetic-corp:synthetic-self-user',
      '--format', 'json',
      'chat', 'message', 'send-by-bot',
      '--robot-code', ROBOT_CODE,
      '--users', 'synthetic-self-user',
      '--title', MESSAGE.title,
      '--text', MESSAGE.text,
      '--yes',
    ]);
  });

  it('accepts the current DWS object result and snake-cased task id', async () => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          errorCode: 0,
          errorMessage: 'ok',
          result: { open_taskId: 'synthetic-current-dws-task' },
          success: true,
        }),
      });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: 'synthetic-current-dws-task',
      messageId: null,
    });
  });

  it('accepts the asynchronous processQueryKey returned by bot-to-user delivery', async () => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: { processQueryKey: 'synthetic-process-query-key' },
        }),
      });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: 'synthetic-process-query-key',
      messageId: null,
    });
  });

  it.each([
    ['no self result', { success: true, result: [] }],
    ['multiple self results', {
      success: true,
      result: [
        { orgEmployeeModel: { userId: 'synthetic-a' } },
        { orgEmployeeModel: { userId: 'synthetic-b' } },
      ],
    }],
    ['business failure', { success: false, result: [] }],
  ])('stops before sending on %s', async (_label, selfResult) => {
    const runner = vi.fn<DwsCommandRunner>().mockResolvedValue({
      exitCode: 0,
      stdout: success(selfResult),
    });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_self_resolution_failed',
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it.each([
    ['nonzero exit', { exitCode: 1, stdout: '' }],
    ['business failure', {
      exitCode: 0,
      stdout: success({ success: false, result: [] }),
    }],
    ['partial result', {
      exitCode: 0,
      stdout: success({ success: true, complete: false, failures: ['synthetic'] }),
    }],
  ])('rejects a %s send result even when the command was invoked', async (_label, sendResult) => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce(sendResult);
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_delivery_failed',
    });
  });

  it.each([
    ['invalid JSON', { exitCode: 0, stdout: 'not-json' }],
    ['unrecognized envelope', {
      exitCode: 0,
      stdout: success({ result: [] }),
    }],
  ])('marks a %s send result as unknown', async (_label, sendResult) => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce(sendResult);
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_delivery_unknown',
    });
  });

  it('records a successful send even when DingTalk omits usable delivery ids', async () => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({ success: true, result: 'delivered' }),
      });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: null,
      messageId: null,
    });
  });

  it('marks a terminated send command as an unknown delivery result', async () => {
    const runner = vi.fn<DwsCommandRunner>()
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: success({
          success: true,
          result: [{ orgEmployeeModel: { userId: 'synthetic-self-user' } }],
        }),
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        deliveryStatusUnknown: true,
      });
    const delivery = new DwsSelfAcceptanceDelivery({
      profile: 'synthetic-current-profile',
      robotCode: ROBOT_CODE,
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_delivery_unknown',
    });
  });
});
