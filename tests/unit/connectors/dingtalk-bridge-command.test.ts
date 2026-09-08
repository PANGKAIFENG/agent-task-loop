import { describe, expect, it } from 'vitest';

import { bridgeReplyArguments } from '../../../src/connectors/dingtalk-bridge-command.js';

describe('bridgeReplyArguments', () => {
  it('keeps the complete pushed event out of process arguments', () => {
    expect(bridgeReplyArguments('/private/atl-dingtalk-bridge.mjs')).toEqual([
      '/private/atl-dingtalk-bridge.mjs',
      'reply',
      '--stdin-json',
    ]);
  });
});
