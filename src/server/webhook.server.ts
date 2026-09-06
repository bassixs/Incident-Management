import { timingSafeEqual } from 'node:crypto';

import Fastify, { type FastifyInstance } from 'fastify';

import type { AppServices } from '../app/container';
import type { Update } from '../max/max-types';
import { moduleLogger } from '../utils/logger';
import type { UpdateDispatcher } from './update-dispatcher';

const log = moduleLogger('webhook');

const SECRET_HEADER = 'x-max-bot-api-secret';

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function looksLikeUpdate(body: unknown): body is Update {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { update_type?: unknown }).update_type === 'string'
  );
}

/**
 * Webhook endpoint (§48).
 *
 * Contract with MAX: verify the shared secret, answer 200 as fast as possible,
 * never process the same event twice. The business work happens after the
 * response is sent, so a slow LLM call or a media download cannot cause MAX to
 * time out and redeliver.
 */
export async function createWebhookServer(
  services: AppServices,
  dispatcher: UpdateDispatcher,
): Promise<FastifyInstance> {
  const config = services.config;
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    trustProxy: true,
  });

  app.get('/health', async () => ({ status: 'ok', mode: config.BOT_MODE }));

  app.get('/ready', async (_request, reply) => {
    try {
      await services.prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.post(config.WEBHOOK_PATH, async (request, reply) => {
    const provided = request.headers[SECRET_HEADER];
    const secret = config.WEBHOOK_SECRET ?? '';
    if (!secretMatches(Array.isArray(provided) ? provided[0] : provided, secret)) {
      log.warn({ ip: request.ip }, 'webhook request rejected: bad secret');
      return reply.code(401).send({ ok: false });
    }

    const body = request.body;
    if (!looksLikeUpdate(body)) {
      log.warn('webhook request rejected: payload is not a MAX update');
      return reply.code(400).send({ ok: false });
    }

    // The reservation is a single fast INSERT; taking it before responding is
    // what makes redelivery safe.
    let reservation;
    try {
      reservation = await dispatcher.reserve(body);
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'failed to reserve update; asking MAX to retry',
      );
      return reply.code(503).send({ ok: false });
    }

    if (!reservation.fresh) {
      return reply.code(200).send({ ok: true, duplicate: true });
    }

    await reply.code(200).send({ ok: true });

    setImmediate(() => void dispatcher.kick().catch(error => log.error({ err: String(error) }, 'inbox sweep failed')));
    return reply;
  });

  return app;
}
