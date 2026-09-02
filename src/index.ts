import type { FastifyInstance } from 'fastify';

import { buildServices, type AppServices } from './app/container';
import { publishBotCommands, registerHandlers } from './bot/bot';
import { getConfig } from './config';
import { connectDatabase, disconnectDatabase } from './database/prisma';
import { SUBSCRIBED_UPDATE_TYPES, type UpdateType } from './max/max-types';
import { PollingRunner } from './server/polling.runner';
import { UpdateDispatcher } from './server/update-dispatcher';
import { createWebhookServer } from './server/webhook.server';
import { logger, moduleLogger } from './utils/logger';

const log = moduleLogger('bootstrap');

async function main(): Promise<void> {
  const config = getConfig();
  const prisma = await connectDatabase();
  const services: AppServices = buildServices(prisma);

  registerHandlers(services);
  services.messages.start();
  await services.actionGuard.purgeExpired();

  const me = await services.max.getMe();
  log.info({ botId: me.user_id, username: me.username, mode: config.BOT_MODE }, 'connected to MAX');
  await publishBotCommands(services);
  warnAboutMissingChats(services);

  const dispatcher = new UpdateDispatcher(prisma, services.max);
  await dispatcher.start();

  let server: FastifyInstance | undefined;
  let polling: PollingRunner | undefined;

  if (config.BOT_MODE === 'webhook') {
    server = await createWebhookServer(services, dispatcher);
    await server.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
    log.info({ host: config.HTTP_HOST, port: config.HTTP_PORT, path: config.WEBHOOK_PATH }, 'webhook server listening');

    if (config.WEBHOOK_URL && config.WEBHOOK_AUTO_REGISTER) {
      await registerWebhook(services);
    } else if (!config.WEBHOOK_URL) {
      log.warn('WEBHOOK_URL is not set — register the subscription manually with npm run webhook:register');
    }
  } else {
    polling = new PollingRunner(prisma, services.max, dispatcher);
    await polling.start();
  }

  services.sla.start();

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    services.sla.stop();
    services.messages.stop();
    dispatcher.stop();
    polling?.stop();
    services.bot.stop();
    await server?.close().catch(() => undefined);
    await services.messages.flush().catch(() => undefined);
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error({ reason: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error.message, stack: error.stack }, 'uncaught exception');
    process.exit(1);
  });
}

/**
 * Subscribing is idempotent from our side: an existing subscription for the
 * same URL is replaced so a redeploy cannot leave two of them behind.
 */
async function registerWebhook(services: AppServices): Promise<void> {
  const config = services.config;
  const url = config.WEBHOOK_URL!;
  try {
    const existing = await services.max.listWebhookSubscriptions();
    if (existing.some((subscription) => subscription.url === url)) {
      await services.max.unsubscribeWebhook(url);
    }
    await services.max.subscribeWebhook({
      url,
      updateTypes: [...SUBSCRIBED_UPDATE_TYPES] as UpdateType[],
      ...(config.WEBHOOK_SECRET ? { secret: config.WEBHOOK_SECRET } : {}),
    });
    log.info({ url }, 'webhook subscription registered');
  } catch (error) {
    log.error(
      { url, err: error instanceof Error ? error.message : String(error) },
      'failed to register webhook subscription',
    );
  }
}

function warnAboutMissingChats(services: AppServices): void {
  if (services.config.DISTRIBUTION_CHAT_ID === undefined) {
    log.warn('DISTRIBUTION_CHAT_ID is not set — new incidents cannot be published');
  }
  if (services.config.REVIEW_CHAT_ID === undefined) {
    log.warn('REVIEW_CHAT_ID is not set — answers cannot be sent for approval');
  }
}

main().catch((error) => {
  logger().fatal(
    { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
    'failed to start',
  );
  process.exit(1);
});
