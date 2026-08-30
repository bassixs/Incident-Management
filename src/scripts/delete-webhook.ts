import { Bot } from '@maxhub/max-bot-api';

import { getConfig } from '../config';
import { createMaxClient } from '../max/max-client';

/**
 * Remove a webhook subscription so the bot can be driven by long polling.
 *
 * Usage: npm run webhook:delete [-- https://example.com/webhook/max]
 * With no argument every subscription is removed.
 */
async function main(): Promise<void> {
  const config = getConfig();
  const max = createMaxClient(new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } }));

  const explicit = process.argv[2] ?? config.WEBHOOK_URL;
  const subscriptions = await max.listWebhookSubscriptions();
  const targets = explicit ? subscriptions.filter((item) => item.url === explicit) : subscriptions;

  if (targets.length === 0) {
    process.stdout.write('Nothing to remove.\n');
    return;
  }
  for (const subscription of targets) {
    await max.unsubscribeWebhook(subscription.url);
    process.stdout.write(`Removed ${subscription.url}\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
