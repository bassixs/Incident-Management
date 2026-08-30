import { Bot, Keyboard } from '@maxhub/max-bot-api';
import { describe, expect, it } from 'vitest';

import type { Update } from '../../src/max/max-types';

/**
 * Guards the assumptions this project makes about `@maxhub/max-bot-api`.
 *
 * The library only wires its middleware stack to long polling, so webhook mode
 * feeds updates in through `Bot#handleUpdate` — a runtime instance property
 * whose `private` marker exists only in the type declarations. If a future
 * version renames or removes it, this test fails instead of the bot going
 * silent in production.
 */
describe('MAX client contract', () => {
  const bot = new Bot('test-token');

  it('exposes the methods the MaxClient wrapper delegates to', () => {
    expect(typeof (bot as unknown as Record<string, unknown>).handleUpdate).toBe('function');
    expect(typeof bot.api.sendMessageToChat).toBe('function');
    expect(typeof bot.api.sendMessageToUser).toBe('function');
    expect(typeof bot.api.editMessage).toBe('function');
    expect(typeof bot.api.answerOnCallback).toBe('function');
    expect(typeof bot.api.getUpdates).toBe('function');
    expect(typeof bot.api.setMyCommands).toBe('function');
    expect(typeof bot.api.upload.image).toBe('function');
    expect(typeof bot.api.upload.file).toBe('function');
  });

  it('builds the documented inline keyboard attachment shape', () => {
    const button = Keyboard.button.callback('Распределить', 'incident:assign:x', { intent: 'positive' });
    expect(button).toEqual({
      type: 'callback',
      text: 'Распределить',
      payload: 'incident:assign:x',
      intent: 'positive',
    });
    expect(Keyboard.inlineKeyboard([[button]])).toEqual({
      type: 'inline_keyboard',
      payload: { buttons: [[button]] },
    });
  });

  it('routes a hand-fed update through the middleware stack', async () => {
    const local = new Bot('test-token');
    let seen: string | null | undefined;
    local.on('message_created', (ctx) => {
      seen = ctx.message?.body.text;
    });

    const update = {
      update_type: 'message_created',
      timestamp: 1,
      message: {
        sender: { user_id: 1, name: 'T', username: null, is_bot: false, last_activity_time: 0 },
        recipient: { chat_id: 5, chat_type: 'dialog' },
        timestamp: 1,
        body: { mid: 'm1', seq: 1, text: 'hello from webhook', attachments: null },
      },
    } as unknown as Update;

    await (local as unknown as { handleUpdate: (u: Update) => Promise<void> }).handleUpdate(update);
    expect(seen).toBe('hello from webhook');
  });
});
