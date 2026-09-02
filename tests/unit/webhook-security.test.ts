import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { getConfig } from '../../src/config';
import type { AppServices } from '../../src/app/container';
import type { Update } from '../../src/max/max-types';
import { buildUpdateKey } from '../../src/max/update-key';
import { createWebhookServer } from '../../src/server/webhook.server';
import type { UpdateDispatcher } from '../../src/server/update-dispatcher';

const SECRET = 'test-webhook-secret';

function sampleUpdate(mid: string): Update {
  return {
    update_type: 'message_created',
    timestamp: 1,
    message: {
      sender: { user_id: 1, name: 'T', username: null, is_bot: false, last_activity_time: 0 },
      recipient: { chat_id: 5, chat_type: 'dialog' },
      timestamp: 1,
      body: { mid, seq: 1, text: 'hi', attachments: null },
    },
  } as unknown as Update;
}

/**
 * §48 — the endpoint must reject anything that does not carry the shared
 * secret, and it must never hand an unauthenticated payload to the dispatcher.
 */
describe('webhook endpoint', () => {
  let app: FastifyInstance;
  const reserved: string[] = [];
  const processed: string[] = [];
  const pending: Update[] = [];
  const seen = new Set<string>();

  const dispatcher = {
    reserve: async (update: Update) => {
      const key = buildUpdateKey(update);
      reserved.push(key);
      const fresh = !seen.has(key);
      seen.add(key);
      if (fresh) pending.push(update);
      return { key, fresh };
    },
    kick: async () => {
      while (pending.length > 0) {
        processed.push(buildUpdateKey(pending.shift()!));
      }
    },
  } as unknown as UpdateDispatcher;

  beforeAll(async () => {
    const services = { config: getConfig(), prisma: { $queryRaw: async () => [1] } } as unknown as AppServices;
    app = await createWebhookServer(services, dispatcher);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request without the secret header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      payload: sampleUpdate('m-nosecret'),
    });
    expect(response.statusCode).toBe(401);
    expect(reserved).toHaveLength(0);
  });

  it('rejects a wrong secret', async () => {
    const response = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': 'not-the-secret' },
      payload: sampleUpdate('m-wrong'),
    });
    expect(response.statusCode).toBe(401);
    expect(reserved).toHaveLength(0);
  });

  it('rejects a payload that is not a MAX update', async () => {
    const response = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload: { hello: 'world' },
    });
    expect(response.statusCode).toBe(400);
    expect(reserved).toHaveLength(0);
  });

  it('accepts a valid update and answers immediately', async () => {
    const response = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload: sampleUpdate('m-ok'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(reserved).toHaveLength(1);
  });

  it('reports a redelivery as a duplicate without processing it again', async () => {
    const payload = sampleUpdate('m-dupe');
    const first = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: getConfig().WEBHOOK_PATH,
      headers: { 'x-max-bot-api-secret': SECRET },
      payload,
    });

    expect(first.json()).toEqual({ ok: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, duplicate: true });

    await new Promise((resolve) => setImmediate(resolve));
    expect(processed.filter((entry) => entry.includes('m-dupe'))).toHaveLength(1);
  });

  it('serves liveness and readiness probes', async () => {
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);
  });
});
