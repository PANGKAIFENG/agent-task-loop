import { describe, expect, it, vi } from 'vitest';

import {
  DwsMaterialSearchConnector,
} from '../../../src/connectors/dws-material-search.js';

function result(value: unknown, exitCode = 0) {
  return { exitCode, stdout: JSON.stringify(value) };
}

describe('DwsMaterialSearchConnector', () => {
  it('records every external source as not connected without executing DWS', async () => {
    const runner = vi.fn();
    const connector = new DwsMaterialSearchConnector({ profile: null, runner });

    const outcomes = await connector.search({
      query: '精恭纺验收分类',
      occurredAt: '2026-08-10T16:00:00+08:00',
      projectId: 'project-jgf',
    });

    expect(outcomes.map(({ source, status }) => ({ source, status }))).toEqual([
      { source: 'dingtalk_message', status: 'not_connected' },
      { source: 'dingtalk_doc', status: 'not_connected' },
      { source: 'dingtalk_aitable', status: 'not_connected' },
      { source: 'dingtalk_drive', status: 'not_connected' },
      { source: 'yunxiao', status: 'not_connected' },
    ]);
    expect(runner).not.toHaveBeenCalled();
  });

  it('returns bounded message and document evidence and resolves only exact senders', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const command = args.slice(4).join(' ');
      if (command.startsWith('chat message search')) {
        return result({
          success: true,
          result: {
            conversationMessagesList: [{
              title: '精恭纺项目群',
              messages: [{
                content: '验收分类数量：第一类 12 项。',
                openMessageId: 'message-a',
                sender: '材料负责人',
                senderOpenDingTalkId: 'open-a',
              }],
            }],
          },
        });
      }
      if (command.startsWith('drive search')) {
        return result({
          success: true,
          result: {
            doc_results: { content: { documents: [{
              name: '精恭纺验收表',
              nodeId: 'doc-a',
              docUrl: 'https://alidocs.dingtalk.com/i/nodes/doc-a',
            }] } },
            drive_results: { content: { items: [{
              name: '验收附件.xlsx',
              fileId: 'drive-a',
              docUrl: 'https://alidocs.dingtalk.com/i/nodes/drive-a',
            }] } },
          },
        });
      }
      if (command.startsWith('doc read')) {
        return result({
          success: true,
          markdown: '验收分类表：已确认。',
          nodeId: 'doc-a',
        });
      }
      if (command.startsWith('aitable base search')) {
        return result({ success: true, data: { bases: [] } });
      }
      if (command.startsWith('aisearch person')) {
        return result({
          success: true,
          result: [{
            title: '材料负责人',
            userId: 'user-a',
            openDingTalkId: 'open-a',
            sourceType: 'person',
          }],
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const connector = new DwsMaterialSearchConnector({
      profile: 'ding-synthetic-profile',
      runner,
    });

    const outcomes = await connector.search({
      query: '精恭纺验收分类',
      occurredAt: '2026-08-10T16:00:00+08:00',
      projectId: 'project-jgf',
    });

    expect(outcomes.find(({ source }) => source === 'dingtalk_message')).toMatchObject({
      status: 'not_found',
      materials: [{
        sourceRef: 'dingtalk-message:message-a',
        content: '验收分类数量：第一类 12 项。',
      }],
      contacts: [{
        userId: 'user-a',
        displayName: '材料负责人',
        reason: '相关钉钉消息发送人',
        sourceRef: 'dingtalk-message:message-a',
        priority: 30,
      }],
    });
    expect(outcomes.find(({ source }) => source === 'dingtalk_doc')).toMatchObject({
      status: 'not_found',
      materials: [{
        sourceRef: 'https://alidocs.dingtalk.com/i/nodes/doc-a',
        content: '验收分类表：已确认。',
      }],
    });
    expect(outcomes.find(({ source }) => source === 'dingtalk_drive')).toMatchObject({
      status: 'not_found',
      materials: [{
        sourceRef: 'https://alidocs.dingtalk.com/i/nodes/drive-a',
        content: '验收附件.xlsx',
      }],
    });
    expect(outcomes.find(({ source }) => source === 'yunxiao')).toMatchObject({
      status: 'not_connected',
    });
  });

  it('reads matching AI Table records instead of treating a matching Base name as evidence', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const command = args.slice(4).join(' ');
      if (command.startsWith('chat message search')) {
        return result({ success: true, result: { conversationMessagesList: [] } });
      }
      if (command.startsWith('drive search')) {
        return result({ success: true, result: {} });
      }
      if (command === 'aitable base search --query 精恭纺验收分类') {
        return result({
          success: true,
          data: { bases: [{ baseId: 'base-a', baseName: '精恭纺验收总表' }] },
        });
      }
      if (command === 'aitable table get --base-id base-a') {
        return result({
          success: true,
          data: { tables: [{ tableId: 'table-a', tableName: '分类统计' }] },
        });
      }
      if (command === 'aitable record query --base-id base-a --table-id table-a --query 精恭纺验收分类 --limit 10') {
        return result({
          success: true,
          data: {
            records: [{
              recordId: 'record-a',
              cells: { 分类: '第一类', 数量: 12 },
            }],
          },
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const connector = new DwsMaterialSearchConnector({
      profile: 'ding-synthetic-profile',
      runner,
    });

    const outcomes = await connector.search({
      query: '精恭纺验收分类',
      occurredAt: '2026-08-10T16:00:00+08:00',
      projectId: 'project-jgf',
    });

    expect(outcomes.find(({ source }) => source === 'dingtalk_aitable')).toMatchObject({
      status: 'not_found',
      materials: [{
        sourceRef: 'dingtalk-aitable:base-a/table-a/record-a',
        content: 'Base：精恭纺验收总表\n数据表：分类统计\n记录：{"分类":"第一类","数量":12}',
      }],
    });
    expect(runner).toHaveBeenCalledWith([
      '--profile', 'ding-synthetic-profile', '--format', 'json',
      'aitable', 'record', 'query',
      '--base-id', 'base-a',
      '--table-id', 'table-a',
      '--query', '精恭纺验收分类',
      '--limit', '10',
    ]);
  });

  it('parses the native DWS result-array envelopes for every external source', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const command = args.slice(4).join(' ');
      if (command.startsWith('chat message search')) {
        return result({
          success: true,
          result: [{
            title: '精恭纺项目群',
            messages: [{
              content: '验收分类数量：第一类 12 项。',
              openMessageId: 'message-native',
              sender: '材料负责人',
              senderOpenDingTalkId: 'open-native',
            }],
          }],
        });
      }
      if (command.startsWith('drive search')) {
        return result({
          success: true,
          result: {
            doc_results: { content: { result: [{
              name: '精恭纺验收表',
              nodeId: 'doc-native',
              docUrl: 'https://alidocs.dingtalk.com/i/nodes/doc-native',
            }] } },
            drive_results: { content: { result: [{
              name: '验收附件.xlsx',
              fileId: 'drive-native',
              docUrl: 'https://alidocs.dingtalk.com/i/nodes/drive-native',
            }] } },
          },
        });
      }
      if (command.startsWith('doc read')) {
        return result({
          success: true,
          result: { markdown: '验收分类表：已确认。' },
        });
      }
      if (command === 'aitable base search --query 精恭纺验收分类') {
        return result({
          success: true,
          result: [{ baseId: 'base-native', baseName: '精恭纺验收总表' }],
        });
      }
      if (command === 'aitable table get --base-id base-native') {
        return result({
          success: true,
          result: [{ tableId: 'table-native', tableName: '分类统计' }],
        });
      }
      if (command === 'aitable record query --base-id base-native --table-id table-native --query 精恭纺验收分类 --limit 10') {
        return result({
          success: true,
          result: [{
            recordId: 'record-native',
            cells: { 分类: '第一类', 数量: 12 },
          }],
        });
      }
      if (command.startsWith('aisearch person')) {
        return result({
          success: true,
          result: [{
            title: '材料负责人',
            userId: 'user-native',
            openDingTalkId: 'open-native',
            sourceType: 'person',
          }],
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const connector = new DwsMaterialSearchConnector({
      profile: 'ding-synthetic-profile',
      runner,
    });

    const outcomes = await connector.search({
      query: '精恭纺验收分类',
      occurredAt: '2026-08-10T16:00:00+08:00',
      projectId: 'project-jgf',
    });

    expect(outcomes.find(({ source }) => source === 'dingtalk_message')).toMatchObject({
      materials: [{ sourceRef: 'dingtalk-message:message-native' }],
      contacts: [{ userId: 'user-native' }],
    });
    expect(outcomes.find(({ source }) => source === 'dingtalk_doc')).toMatchObject({
      materials: [{
        sourceRef: 'https://alidocs.dingtalk.com/i/nodes/doc-native',
        content: '验收分类表：已确认。',
      }],
    });
    expect(outcomes.find(({ source }) => source === 'dingtalk_drive')).toMatchObject({
      materials: [{ sourceRef: 'https://alidocs.dingtalk.com/i/nodes/drive-native' }],
    });
    expect(outcomes.find(({ source }) => source === 'dingtalk_aitable')).toMatchObject({
      materials: [{
        sourceRef: 'dingtalk-aitable:base-native/table-native/record-native',
      }],
    });
  });

  it('distinguishes permission failures from execution failures', async () => {
    const runner = vi.fn(async (args: string[]) => {
      const command = args.slice(4).join(' ');
      if (command.startsWith('chat message search')) {
        return result({ success: false, errorCode: '403', errorMsg: '无权限' }, 1);
      }
      if (command.startsWith('drive search')) return result({}, 1);
      if (command.startsWith('aitable base search')) {
        return result({ success: true, data: { bases: [] } });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const connector = new DwsMaterialSearchConnector({
      profile: 'ding-synthetic-profile',
      runner,
    });

    const outcomes = await connector.search({
      query: '验收分类表',
      occurredAt: '2026-08-10T16:00:00+08:00',
      projectId: null,
    });

    expect(outcomes.find(({ source }) => source === 'dingtalk_message')?.status)
      .toBe('permission_denied');
    expect(outcomes.find(({ source }) => source === 'dingtalk_doc')?.status)
      .toBe('failed');
    expect(outcomes.find(({ source }) => source === 'dingtalk_drive')?.status)
      .toBe('failed');
  });
});
