import { describe, expect, it, vi } from 'vitest';

import {
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

function success(value: unknown): string {
  return JSON.stringify(value);
}

describe('DwsSelfAcceptanceDelivery', () => {
  it('runs DWS arguments without a shell and captures stdout', async () => {
    await expect(runDwsCommand(['synthetic-output'], {
      executable: '/usr/bin/printf',
      timeoutMs: 1_000,
    })).resolves.toEqual({
      exitCode: 0,
      stdout: 'synthetic-output',
    });
  });

  it.each(['', '   ', 'corp-a,corp-b'])('requires one explicit profile: %j', (profile) => {
    expect(() => new DwsSelfAcceptanceDelivery({
      profile,
      runner: vi.fn<DwsCommandRunner>(),
    })).toThrowError(expect.objectContaining({ code: 'dingtalk_profile_invalid' }));
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
      'chat', 'message', 'send',
      '--user', 'synthetic-self-user',
      '--title', MESSAGE.title,
      '--text', MESSAGE.text,
      '--uuid', MESSAGE.uuid,
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
      runner,
    });

    await expect(delivery.send(MESSAGE)).resolves.toEqual({
      taskId: 'synthetic-current-dws-task',
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
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_self_resolution_failed',
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it.each([
    ['nonzero exit', { exitCode: 1, stdout: '' }],
    ['invalid JSON', { exitCode: 0, stdout: 'not-json' }],
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
      runner,
    });

    await expect(delivery.send(MESSAGE)).rejects.toMatchObject({
      code: 'dingtalk_delivery_failed',
    });
  });
});
