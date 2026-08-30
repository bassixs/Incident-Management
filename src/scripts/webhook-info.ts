import { Bot } from '@maxhub/max-bot-api';

import { getConfig } from '../config';
import { createMaxClient } from '../max/max-client';

/** Print the bot identity and its current webhook subscriptions. */
async function main(): Promise<void> {
  const config = getConfig();
  const max = createMaxClient(new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } }));

  const me = await max.getMe();
  process.stdout.write(`Bot: ${me.name} (@${me.username ?? '—'}, id ${me.user_id})\n\n`);

  const subscriptions = await max.listWebhookSubscriptions();
  if (subscriptions.length === 0) {
    process.stdout.write('No webhook subscriptions. The bot is in long-polling mode.\n');
    return;
  }
  for (const subscription of subscriptions) {
    process.stdout.write(
      `- ${subscription.url}\n  update_types: ${subscription.update_types?.join(', ') ?? 'all'}\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
