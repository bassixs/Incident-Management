import { afterEach, expect, it, vi } from 'vitest';
import { Bot } from '@maxhub/max-bot-api';
import { MaxClient } from '../../src/max/max-client';
import { MaxMessageService } from '../../src/max/max-message.service';
import { OLD_SCREEN_NOTICE, screenFacts } from '../../src/bot/draft-screen-delivery';
import { draftRefusal } from '../../src/bot/draft-screen';
import { withDeliveryTrace } from '../../src/utils/latency';

const recorded = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ moduleLogger: () => recorded }));
afterEach(() => { vi.restoreAllMocks(); recorded.info.mockClear(); });

it('retirement removes only controls and preserves all photos; never deletes the message', async () => {
  const bot = new Bot('isolated-test-token');
  const photo = { type: 'image', payload: { token: 'synthetic-photo' } };
  const get = vi.spyOn(bot.api, 'getMessage').mockResolvedValue({ body: { text: 'Synthetic preview', attachments: [photo,
    { type: 'inline_keyboard', payload: { buttons: [[{ type: 'callback', text: 'Old', payload: 'old' }]] } }] } } as never);
  const edit = vi.spyOn(bot.api, 'editMessage').mockResolvedValue({ success: true });
  const remove = vi.spyOn(bot.api, 'deleteMessage').mockRejectedValue(new Error('Must not delete'));
  const service = new MaxMessageService(new MaxClient(bot));
  expect(await service.retireDraftScreen('known-draft-message', OLD_SCREEN_NOTICE)).toBe(true);
  expect(get).toHaveBeenCalledWith('known-draft-message');
  expect(edit).toHaveBeenCalledWith('known-draft-message', { text: OLD_SCREEN_NOTICE, attachments: [photo] });
  expect(remove).not.toHaveBeenCalled();
});

it('logs bounded safe correlation and explicit refusal reason, without contents or raw tokens', () => {
  const data = { draftToken: 'synthetic-draft-token', screenToken: 'synthetic-screen-token', draftStage: 'category' as const,
    screenPage: 5, draftText: 'private problem', requesterPhone: '+7 900 123-45-67' };
  const inboxId = '00000000-0000-4000-8000-000000000001';
  withDeliveryTrace({ inboxId }, () => {
    for (let i = 0; i < 15; i++) draftRefusal('SCREEN_MISMATCH', data, 'raw-callback-token');
  });
  expect(recorded.info).toHaveBeenCalledTimes(1);
  expect(recorded.info).toHaveBeenCalledWith(expect.objectContaining({ inboxId, stage: 'category', page: 5, reason: 'SCREEN_MISMATCH' }), 'draft action refused');
  const output = JSON.stringify(recorded.info.mock.calls);
  for (const secret of [data.draftToken, data.screenToken, data.draftText, data.requesterPhone, 'raw-callback-token']) expect(output).not.toContain(secret);
  expect(screenFacts(data).draft).toMatch(/^[a-f0-9]{16}$/);
  expect(screenFacts({ ...data, screenStage: 'WAITING_INCIDENT_CONFIRMATION' }).stage).toBe('WAITING_INCIDENT_CONFIRMATION');
});
