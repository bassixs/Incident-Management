import { Bot } from '@maxhub/max-bot-api';

import { getConfig } from '../config';
import { connectDatabase, disconnectDatabase } from '../database/prisma';
import { createMaxClient } from '../max/max-client';
import { createMediaStorage } from '../media/media.service';
import {
  formatRetentionPreview,
  formatRetentionRun,
  RetentionService,
  type RetentionRunResult,
} from '../retention/retention.service';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'preview';
  if (mode !== 'preview' && mode !== 'run') throw new Error('Использование: retention.ts preview | run --confirm');
  if (mode === 'run' && !process.argv.includes('--confirm')) {
    throw new Error('Удаление не запущено: сначала выполните preview, затем добавьте --confirm.');
  }

  const prisma = await connectDatabase();
  try {
    const retention = new RetentionService(prisma, createMediaStorage());
    if (mode === 'preview') {
      process.stdout.write(`${formatRetentionPreview(await retention.preview())}\n`);
      return;
    }

    const result = await retention.run();
    process.stdout.write(`${formatRetentionRun(result)}\n`);
    if (result.failures.length > 0) {
      await alertFailure(result);
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

async function alertFailure(result: RetentionRunResult): Promise<void> {
  const config = getConfig();
  if (config.DELIVERY_ALERT_CHAT_ID === undefined) return;
  const bot = new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } });
  const max = createMaxClient(bot);
  const codes = result.failures.slice(0, 10).map((failure) => failure.publicCode).join(', ');
  await max
    .sendToChat(
      config.DELIVERY_ALERT_CHAT_ID,
      ['🚨 Ошибка автоматического удаления обращений', '', `Не удалено: ${result.failures.length}`, `Обращения: ${codes}`, '', 'Проверка на сервере: npm run retention:preview'].join('\n'),
    )
    .catch((error) =>
      logger().error({ err: error instanceof Error ? error.message : String(error) }, 'failed to send retention alert'),
    );
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  logger().fatal({ err: message }, 'retention command failed');
  try {
    const config = getConfig();
    if (config.DELIVERY_ALERT_CHAT_ID !== undefined) {
      const bot = new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } });
      await createMaxClient(bot).sendToChat(
        config.DELIVERY_ALERT_CHAT_ID,
        '🚨 Автоматическое удаление обращений не запустилось. Проверьте журнал incident-bot-retention.service.',
      );
    }
  } catch {
    // The original error is still reported to stderr/systemd.
  }
  process.exitCode = 1;
});
