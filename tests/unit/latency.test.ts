import { Bot, MaxError } from '@maxhub/max-bot-api';
import { afterEach, expect, it, vi } from 'vitest';
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../src/utils/logger', () => ({ moduleLogger: () => logs }));
import { deliveryTrace, latency, observeMembership, withDeliveryTrace } from '../../src/utils/latency';
import { MaxClient } from '../../src/max/max-client';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); logs.info.mockClear(); logs.warn.mockClear(); });

it('isolates concurrent traces and never copies arbitrary persisted fields into logs', async () => {
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  await Promise.all([a, b].map(inboxId => withDeliveryTrace({ inboxId, receivedAt: 1, text: 'private', phone: '+79001234567', token: 'secret' } as never, async () => {
    await Promise.resolve(); latency('inbox-start', { waitMs: 2 }); expect(deliveryTrace().inboxId).toBe(inboxId);
  })));
  expect(deliveryTrace()).toEqual({});
  expect(logs.info.mock.calls.map(c => c[0].inboxId)).toEqual([a, b]);
  expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(/private|79001234567|secret|phone|token/);
  withDeliveryTrace({ inboxId: '+79001234567' }, () => latency('inbox-start'));
  expect(logs.info.mock.calls.at(-1)?.[0]).not.toHaveProperty('inboxId');
});

it('measures rate wait separately from MAX request time and retries 429/503 without logging response content', async () => {
  const bot = new Bot('secret-test-token');
  const send = vi.spyOn(bot.api, 'sendMessageToUser')
    .mockRejectedValueOnce(new MaxError(429, { code: 'rate', message: 'private +79001234567 secret' }))
    .mockRejectedValueOnce(new MaxError(503, { code: 'temporary', message: 'private secret' }))
    .mockImplementation(async () => { await new Promise(r => setTimeout(r, 80)); return { body: { mid: 'test' } } as never; });
  const client = new MaxClient(bot);
  const work = withDeliveryTrace({ inboxId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }, () => client.sendToUser(1n, 'private +79001234567'));
  await work;
  expect(send).toHaveBeenCalledTimes(3);
  const measurements = logs.info.mock.calls.map(c => c[0]);
  expect(measurements.map(x => x.status)).toEqual([429, 503, undefined]);
  expect(measurements.at(-1).requestMs).toBeGreaterThanOrEqual(70);
  expect(measurements.some(x => x.rateWaitMs > 0)).toBe(true);
  expect(measurements.every(x => x.rateWaitMs >= 0 && x.requestId && x.inboxId)).toBe(true);
  expect(JSON.stringify([logs.info.mock.calls, logs.warn.mock.calls])).not.toMatch(/private|79001234567|secret-test-token|temporary/);
});

it('membership measurements preserve errors and do not add retries or log member data', async () => {
  const failure = new MaxError(503, { code: 'temporary', message: 'private phone token' });
  const lookup = vi.fn().mockRejectedValue(failure);
  await expect(observeMembership(lookup)).rejects.toBe(failure);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(logs.info.mock.calls[0]?.[0]).toMatchObject({ method: 'getChatMembers', status: 503, ok: false, rateWaitMs: 0 });
  expect(JSON.stringify(logs.info.mock.calls)).not.toMatch(/private|phone|token/);
});
