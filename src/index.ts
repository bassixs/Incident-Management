import { completeShutdown } from './server/shutdown';
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
import { withRuntimePaused } from './maintenance/runtime-maintenance';

const log = moduleLogger('bootstrap');

async function main(): Promise<void> {
  const config = getConfig();
  const prisma = await connectDatabase();
  const services: AppServices = buildServices(prisma);

  registerHandlers(services);
  services.messages.start();
  services.deliveryAlerts.start();
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
  services.distributionQueue.start();

  let shuttingDown = false;
  services.cleanup.start(work => withRuntimePaused(dispatcher, services.messages,
    [services.sla, services.distributionQueue, services.deliveryAlerts], work, () => shuttingDown));

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      log.info({ signal }, 'shutting down');
      shuttingDown = true;
      services.cleanup.stop();
      dispatcher.stop();
      polling?.stop();
      services.sla.stop();
      services.distributionQueue.stop();
      services.deliveryAlerts.stop();
      services.messages.stop();
      await completeShutdown({
        closeIngress: async () => server?.close(),
        waitForHandlers: async () => Promise.all([
          dispatcher.waitForIdle(), polling?.waitForIdle(),
          services.sla.waitForIdle(), services.deliveryAlerts.waitForIdle(),
          services.distributionQueue.waitForIdle(),
          services.cleanup.waitForIdle(),
        ]),
        waitForMessages: () => services.messages.waitForIdle(),
        disconnect: disconnectDatabase,
      });
      services.bot.stop();
      log.info('graceful shutdown completed');
      process.exit(0);
    })().catch(error => {
      log.fatal({ err: error instanceof Error ? error.message : String(error) }, 'shutdown did not complete; durable jobs retained');
      process.exit(1);
    });
    return shutdownPromise;
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
  if (services.config.DELIVERY_ALERT_CHAT_ID === undefined) {
    log.warn('DELIVERY_ALERT_CHAT_ID is not set — delivery failures will not be reported to MAX');
  }
}

main().catch((error) => {
  logger().fatal(
    { err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined },
    'failed to start',
  );
  process.exit(1);
});
