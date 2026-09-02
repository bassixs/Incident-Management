import { randomUUID } from 'node:crypto';

import { Bot } from '@maxhub/max-bot-api';
import { PrismaClient } from '@prisma/client';

import { getConfig } from '../config';
import { createMaxClient, type MaxClient } from '../max/max-client';
import { createMediaStorage } from '../media/media.service';

/**
 * Pre-flight check for a deployment.
 *
 * Answers the questions that otherwise turn into a confusing live test: is the
 * token valid, is the bot actually a member of every configured chat, are the
 * migrations applied, can we write media, is the webhook subscription the one
 * we think it is.
 *
 *   npm run doctor              — read-only checks
 *   npm run doctor -- --send    — additionally posts a probe message to every
 *                                 configured working chat
 */

type Status = 'ok' | 'warn' | 'fail';

type Check = { name: string; status: Status; detail: string };

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
  checks.push({ name, status, detail });
  const icon = status === 'ok' ? '✅' : status === 'warn' ? '⚠️ ' : '❌';
  process.stdout.write(`${icon} ${name}\n   ${detail}\n`);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function checkDatabase(prisma: PrismaClient): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    record('База данных', 'fail', `Нет подключения: ${describeError(error)}`);
    return;
  }

  try {
    const categories = await prisma.category.count();
    const incidents = await prisma.incident.count();
    record(
      'База данных',
      'ok',
      `Подключение есть, миграции применены. Сфер: ${categories}, обращений: ${incidents}.`,
    );
    if (categories === 0) {
      record('Сферы (Category)', 'warn', 'Таблица пуста. Выполните: npm run seed');
    }
  } catch (error) {
    record(
      'База данных',
      'fail',
      `Подключение есть, но схема не готова — выполните "npx prisma migrate deploy". ${describeError(error)}`,
    );
  }
}

async function checkBot(max: MaxClient): Promise<boolean> {
  try {
    const me = await max.getMe();
    record('Токен MAX', 'ok', `Бот: ${me.name} (@${me.username ?? '—'}), id ${me.user_id}`);
    return true;
  } catch (error) {
    record('Токен MAX', 'fail', `BOT_TOKEN не принят: ${describeError(error)}`);
    return false;
  }
}

async function checkChat(max: MaxClient, label: string, chatId: bigint | undefined, hint: string): Promise<boolean> {
  if (chatId === undefined) {
    record(label, 'fail', `Не задан. ${hint}`);
    return false;
  }
  try {
    const chat = await max.getChat(chatId);
    const membership = await max.api.getChatMembership(Number(chatId));
    const canWrite = membership.permissions === null || membership.permissions.includes('write');
    record(
      label,
      canWrite ? 'ok' : 'warn',
      `${chat.title ?? 'без названия'} (${chatId.toString()}), тип: ${chat.type}` +
        (canWrite ? '' : ' — у бота нет права писать в чат'),
    );
    return true;
  } catch (error) {
    record(label, 'fail', `Чат ${chatId.toString()} недоступен — бот не добавлен? ${describeError(error)}`);
    return false;
  }
}

async function checkCategories(prisma: PrismaClient, max: MaxClient): Promise<void> {
  const categories = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (categories.length === 0) {
    record('Профильные чаты', 'warn', 'Нет активных сфер.');
    return;
  }

  const pending = categories.filter((category) => category.maxChatId === null);
  const configured = categories.filter((category) => category.maxChatId !== null);

  // A сфера awaiting its chat is a rollout state, not a fault: the dispatcher
  // is never offered it, so nothing can break. Reported once, as a warning.
  if (pending.length > 0) {
    record(
      'Сферы без рабочего чата',
      'warn',
      `${pending.length} из ${categories.length}: ${pending.map((item) => item.code).join(', ')}.\n` +
        '   Диспетчеру они не показываются. Задать: /category_chat <КОД> <CHAT_ID>',
    );
  }

  if (configured.length === 0) {
    record('Профильные чаты', 'fail', 'Ни одна сфера не готова к распределению.');
    return;
  }

  for (const category of configured) {
    await checkChat(max, `Сфера ${category.code}`, category.maxChatId ?? undefined, '');
  }
}

async function checkWebhook(max: MaxClient): Promise<void> {
  const config = getConfig();
  if (config.BOT_MODE !== 'webhook') {
    record('Webhook', 'warn', `BOT_MODE=${config.BOT_MODE}. В продакшене должен быть webhook.`);
    return;
  }
  try {
    const subscriptions = await max.listWebhookSubscriptions();
    if (subscriptions.length === 0) {
      record('Webhook', 'fail', 'Подписок нет. Выполните: npm run webhook:register');
      return;
    }
    const expected = config.WEBHOOK_URL;
    const matching = expected ? subscriptions.find((item) => item.url === expected) : undefined;
    if (expected && !matching) {
      record(
        'Webhook',
        'fail',
        `Подписка на ${expected} отсутствует. Есть: ${subscriptions.map((item) => item.url).join(', ')}`,
      );
      return;
    }
    record('Webhook', 'ok', `Подписка активна: ${matching?.url ?? subscriptions[0]!.url}`);
  } catch (error) {
    record('Webhook', 'fail', `Не удалось получить список подписок: ${describeError(error)}`);
  }
}

async function checkMediaStorage(): Promise<void> {
  const config = getConfig();
  const storage = createMediaStorage();
  const key = `healthcheck/${randomUUID()}.txt`;
  const payload = Buffer.from('doctor');
  try {
    await storage.save({ key, body: payload, mimeType: 'text/plain' });
    const loaded = await storage.load(key);
    await storage.remove(key);
    if (!loaded.equals(payload)) {
      record('Хранилище вложений', 'fail', 'Файл прочитан, но содержимое не совпало.');
      return;
    }
    record(
      'Хранилище вложений',
      'ok',
      config.MEDIA_STORAGE === 's3'
        ? `S3, бакет ${config.S3_BUCKET}: запись и чтение работают`
        : `Локальное: ${config.mediaLocalAbsolutePath}`,
    );
  } catch (error) {
    record('Хранилище вложений', 'fail', describeError(error));
  }
}

function checkRoles(): void {
  const config = getConfig();
  if (config.ADMINS.length === 0) {
    record(
      'Роли',
      'fail',
      'ADMINS пуст. Узнайте свой MAX ID командой /whoami в диалоге с ботом и впишите его в .env.',
    );
    return;
  }
  record(
    'Роли',
    'ok',
    `ADMINS: ${config.ADMINS.length}, DISPATCHERS: ${config.DISPATCHERS.length}, ` +
      `APPROVERS: ${config.APPROVERS.length}, RESPONDERS: ${config.RESPONDERS.length}`,
  );
}

async function sendProbes(prisma: PrismaClient, max: MaxClient): Promise<void> {
  const config = getConfig();
  const targets: Array<{ label: string; chatId: bigint }> = [];
  if (config.DISTRIBUTION_CHAT_ID !== undefined) {
    targets.push({ label: 'чат распределения', chatId: config.DISTRIBUTION_CHAT_ID });
  }
  if (config.REVIEW_CHAT_ID !== undefined) {
    targets.push({ label: 'чат согласования', chatId: config.REVIEW_CHAT_ID });
  }
  for (const category of await prisma.category.findMany({ where: { isActive: true } })) {
    if (category.maxChatId !== null) {
      targets.push({ label: `профильный чат ${category.code}`, chatId: category.maxChatId });
    }
  }

  for (const target of targets) {
    try {
      await max.sendToChat(target.chatId, `🩺 Проверка связи: это ${target.label}. Сообщение можно удалить.`);
      record(`Отправка: ${target.label}`, 'ok', `Сообщение доставлено в ${target.chatId.toString()}`);
    } catch (error) {
      record(`Отправка: ${target.label}`, 'fail', describeError(error));
    }
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  process.stdout.write(
    [
      'Проверка окружения Incident Management Bot',
      `NODE_ENV=${config.NODE_ENV}  BOT_MODE=${config.BOT_MODE}  TZ=${config.APP_TIMEZONE}`,
      `Лимит/сутки: ${config.DAILY_INCIDENT_LIMIT}  Длина: ${config.INCIDENT_MAX_LENGTH}  SLA: ${config.INCIDENT_SLA_HOURS}ч`,
      '',
    ].join('\n'),
  );

  const prisma = new PrismaClient();
  const max = createMaxClient(new Bot(config.BOT_TOKEN, { clientOptions: { baseUrl: config.MAX_API_BASE_URL } }));

  await checkDatabase(prisma);
  const botOk = await checkBot(max);

  if (botOk) {
    await checkChat(max, 'Чат распределения', config.DISTRIBUTION_CHAT_ID, 'Задайте DISTRIBUTION_CHAT_ID.');
    await checkChat(max, 'Чат согласования', config.REVIEW_CHAT_ID, 'Задайте REVIEW_CHAT_ID.');
    await checkCategories(prisma, max);
    await checkWebhook(max);
  }

  await checkMediaStorage();
  checkRoles();

  if (process.argv.includes('--send') && botOk) {
    process.stdout.write('\nОтправка проверочных сообщений в рабочие чаты…\n');
    await sendProbes(prisma, max);
  }

  await prisma.$disconnect();

  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  process.stdout.write(
    `\nИтог: ${checks.length - failed.length - warned.length} ок, ${warned.length} предупреждений, ${failed.length} ошибок\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${describeError(error)}\n`);
  process.exit(1);
});
