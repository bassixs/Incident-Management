import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, loadConfig } from '../../src/config';
import { botStatusDeliveryText, botStatusSlot, botStatusText, inspectBotHealth } from '../../src/monitoring/bot-status.service';
import { SUBSCRIBED_UPDATE_TYPES } from '../../src/max/max-types';

const base = { BOT_TOKEN: 'test', DATABASE_URL: 'postgresql://test:test@localhost/test', WEBHOOK_SECRET: 'test-secret' };
const config = () => ({ ...getConfig(), BOT_STATUS_USER_IDS: [555n], BOT_STATUS_TIME: '08:00', BOT_STATUS_WEEKDAY: 'monday' });
const at = (time: string) => new Date(`2026-10-05T${time}Z`);
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('weekly report configuration and Moscow schedule', () => {
  it('disables completely on empty recipients and validates only when enabled', () => {
    expect(loadConfig({ ...base, BOT_STATUS_USER_IDS: ' ', BOT_STATUS_TIME: 'bad', BOT_STATUS_WEEKDAY: 'bad' }).BOT_STATUS_USER_IDS).toEqual([]);
    expect(botStatusSlot({ ...config(), BOT_STATUS_USER_IDS: [] }, at('05:00:00'))).toBeUndefined();
  });
  it.each(['555', '555, 556', '555,555,556'])('parses positive distinct recipients %s', ids => {
    expect(loadConfig({ ...base, BOT_STATUS_USER_IDS: ids }).BOT_STATUS_USER_IDS).toEqual(ids === '555' ? [555n] : [555n, 556n]);
  });
  it.each(['0', '-1', '555,', 'abc', '1.5', '9007199254740992'])('rejects invalid recipients %s', ids => {
    expect(() => loadConfig({ ...base, BOT_STATUS_USER_IDS: ids })).toThrow('BOT_STATUS_USER_IDS');
  });
  it.each([{ BOT_STATUS_TIME: '8:00' }, { BOT_STATUS_TIME: '24:00' }, { BOT_STATUS_TIME: '08:60' }, { BOT_STATUS_WEEKDAY: 'Monday' }, { BOT_STATUS_WEEKDAY: 'noday' }])('validates enabled schedule %j', value => {
    expect(() => loadConfig({ ...base, BOT_STATUS_USER_IDS: '555', ...value })).toThrow('BOT_STATUS_');
  });
  it.each(['UTC', 'Europe/Moscow', 'Asia/Omsk'])('schedules by Moscow regardless of TZ=%s and APP_TIMEZONE', zone => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = zone;
      const c = { ...config(), APP_TIMEZONE: 'Asia/Omsk' };
      expect(botStatusSlot(c, at('04:59:59'))).toBeUndefined();
      expect(botStatusSlot(c, at('05:00:00'))).toMatchObject({ day: '2026-10-05', week: '2026-41', expiresAt: new Date('2026-10-05T21:00:00Z') });
      expect(botStatusSlot(c, at('20:59:59'))).toBeDefined();
      expect(botStatusSlot(c, at('21:00:00'))).toBeUndefined();
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('uses actual check time and dates delayed reports', () => {
    const text = botStatusText(at('06:17:00'), []);
    expect(text).toBe('Доброе утро! Чат-бот «На связи_регион40» работает. По автоматической проверке на 09:17 МСК проблем не обнаружено.');
    const op = { type: 'bot-status' as const, checkedAt: at('06:17:00').toISOString(), expiresAt: at('21:00:00').toISOString() };
    expect(botStatusDeliveryText(op, text, 555n, config(), at('06:17:30'))).toBe(text);
    expect(botStatusDeliveryText(op, text, 555n, config(), at('07:00:00'))).toContain('05.10.2026 09:17 МСК');
    expect(botStatusDeliveryText(op, text, 555n, config(), at('21:00:00'))).toBeUndefined();
    expect(botStatusDeliveryText(op, text, 556n, config(), at('07:00:00'))).toBeUndefined();
  });
});

function healthy() {
  return {
    prisma: { $queryRaw: vi.fn().mockResolvedValue([1]), inboundUpdate: { count: vi.fn().mockResolvedValue(0) }, outboundMessage: { count: vi.fn().mockResolvedValue(0) } },
    max: { getMe: vi.fn().mockResolvedValue({ user_id: 1 }), listWebhookSubscriptions: vi.fn().mockResolvedValue([{ url: 'https://test.invalid/webhook', update_types: [...SUBSCRIBED_UPDATE_TYPES] }]) },
    config: { BOT_MODE: 'webhook' as const, WEBHOOK_URL: 'https://test.invalid/webhook' },
  };
}
describe('safe mandatory status checks', () => {
  it('requires every probe and returns an empty problem list only on success', async () => {
    const h = healthy();
    expect(await inspectBotHealth(h.prisma as never, h.max as never, h.config, at('05:00:00'))).toEqual([]);
    expect(h.prisma.$queryRaw).toHaveBeenCalledOnce();
    expect(h.prisma.inboundUpdate.count).toHaveBeenCalledTimes(4);
    expect(h.max.getMe).toHaveBeenCalledOnce(); expect(h.max.listWebhookSubscriptions).toHaveBeenCalledOnce();
  });
  it('reports failure counts without raw errors or private payloads', async () => {
    const h = healthy();
    h.prisma.inboundUpdate.count.mockResolvedValueOnce(2);
    h.prisma.outboundMessage.count.mockResolvedValueOnce(3);
    h.max.getMe.mockRejectedValue(new Error('token=secret phone=79991234567'));
    h.max.listWebhookSubscriptions.mockRejectedValue(new Error('DATABASE_URL=secret'));
    const text = botStatusText(at('05:00:00'), await inspectBotHealth(h.prisma as never, h.max as never, h.config, at('05:00:00')));
    expect(text).toContain('входящих 2, исходящих 3');
    expect(text).toContain('MAX API недоступен'); expect(text).toContain('Проверка подписки вебхука недоступна');
    expect(text).not.toMatch(/secret|79991234567|DATABASE_URL|проблем не обнаружено/);
  });
  it('reports database and queue probes as unavailable', async () => {
    const h = healthy(); h.prisma.$queryRaw.mockRejectedValue(new Error('secret'));
    h.prisma.inboundUpdate.count.mockRejectedValue(new Error('secret'));
    const problems = await inspectBotHealth(h.prisma as never, h.max as never, h.config, at('05:00:00'));
    expect(problems).toEqual(['Проверка подключения к базе данных недоступна.', 'Проверка состояния очередей недоступна.']);
  });
  it('bounds an unavailable MAX check', async () => {
    vi.useFakeTimers(); const h = healthy(); h.max.getMe.mockImplementation(() => new Promise(() => {}));
    const result = inspectBotHealth(h.prisma as never, h.max as never, h.config, at('05:00:00'));
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await result).toEqual(['MAX API недоступен для проверки.']);
  });
  it.each([
    { subscriptions: [], expected: 'отсутствует' },
    { subscriptions: [{ url: 'https://test.invalid/webhook', update_types: ['bot_started'] }], expected: 'не охватывает' },
    { subscriptions: [{ url: 'https://test.invalid/webhook', update_types: [] }], expected: 'Не удалось подтвердить' },
    { subscriptions: [{ url: 'https://test.invalid/webhook', update_types: [...SUBSCRIBED_UPDATE_TYPES] }, { url: 'https://other.invalid', update_types: [] }], expected: 'дополнительные' },
  ])('checks webhook agreement $expected', async ({ subscriptions, expected }) => {
    const h = healthy(); h.max.listWebhookSubscriptions.mockResolvedValue(subscriptions);
    expect((await inspectBotHealth(h.prisma as never, h.max as never, h.config, at('05:00:00'))).join(' ')).toContain(expected);
  });
});
