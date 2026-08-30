import { Bot } from '@maxhub/max-bot-api';

import { getConfig } from '../config';
import { createMaxClient } from '../max/max-client';
import { SUBSCRIBED_UPDATE_TYPES, type UpdateType } from '../max/max-types';

/**
 * Register (or re-register) the webhook subscription.
 *
 * Usage: npm run webhook:register [-- https://example.com/webhook/max]
 */
async function main(): Promise<void> {
  const config = getConfig();
  const url = process.argv[2] ?? config.WEBHOOK_URL;
  if (!url) {
    throw new Error('Provide the webhook URL as an argument or set WEBHOOK_URL.');
  }
  if (!url.startsWith('https://')) {
    throw new Error('MAX requires an https:// webhook URL.');
  }
  if (!config.WEBHOOK_SECRET) {
    throw new Error('WEBHOOK_SECRET must be set so incoming requests can be verified.');
  }

  const max = createMaxClient(new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } }));

  const existing = await max.listWebhookSubscriptions();
  if (existing.some((subscription) => subscription.url === url)) {
    await max.unsubscribeWebhook(url);
    process.stdout.write(`Removed the previous subscription for ${url}\n`);
  }

  await max.subscribeWebhook({
    url,
    updateTypes: [...SUBSCRIBED_UPDATE_TYPES] as UpdateType[],
    secret: config.WEBHOOK_SECRET,
  });
  process.stdout.write(`Subscribed ${url} to: ${SUBSCRIBED_UPDATE_TYPES.join(', ')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
