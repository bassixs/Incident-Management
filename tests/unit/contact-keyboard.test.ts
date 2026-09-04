import { describe, expect, it } from 'vitest';

import { requesterContactKeyboard } from '../../src/bot/keyboards';

describe('MAX requester contact button', () => {
  it('asks MAX for the account owner contact', () => {
    expect(requesterContactKeyboard()).toEqual([
      [{ type: 'request_contact', text: '📱 Поделиться контактом' }],
    ]);
  });
});
