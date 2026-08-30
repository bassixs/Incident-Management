import { describe, expect, it } from 'vitest';

import type { Update } from '../../src/max/max-types';
import { buildUpdateKey } from '../../src/max/update-key';

function messageCreated(mid: string, seq = 1): Update {
  return {
    update_type: 'message_created',
    timestamp: 1_700_000_000,
    message: {
      sender: { user_id: 1, name: 'Test', username: null, is_bot: false, last_activity_time: 0 },
      recipient: { chat_id: -1001, chat_type: 'chat' },
      timestamp: 1_700_000_000,
      body: { mid, seq, text: 'hello', attachments: null },
    },
  } as unknown as Update;
}

describe('buildUpdateKey', () => {
  it('is stable for a redelivered message', () => {
    expect(buildUpdateKey(messageCreated('mid-1'))).toBe(buildUpdateKey(messageCreated('mid-1')));
  });

  it('distinguishes different messages', () => {
    expect(buildUpdateKey(messageCreated('mid-1'))).not.toBe(buildUpdateKey(messageCreated('mid-2')));
  });

  it('keys callbacks by callback_id', () => {
    const callback = {
      update_type: 'message_callback',
      timestamp: 1,
      callback: {
        timestamp: 1,
        callback_id: 'cb-42',
        payload: 'incident:approve:550e8400-e29b-41d4-a716-446655440000',
        user: { user_id: 7, name: 'Op', username: null, is_bot: false, last_activity_time: 0 },
      },
    } as unknown as Update;
    expect(buildUpdateKey(callback)).toBe('message_callback:cb-42');
  });

  it('falls back to a content hash for unknown shapes', () => {
    const unknown = { update_type: 'something_new', timestamp: 5 } as unknown as Update;
    const first = buildUpdateKey(unknown);
    expect(first).toMatch(/^something_new:sha256:[0-9a-f]{32}$/);
    expect(buildUpdateKey(unknown)).toBe(first);
  });
});
