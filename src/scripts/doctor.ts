import { randomUUID } from 'node:crypto';

import { Bot } from '@maxhub/max-bot-api';
import { InboxStatus, OutboxStatus, PrismaClient, UserRole } from '@prisma/client';

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
    const groups = await prisma.responsibleGroup.count();
    const incidents = await prisma.incident.count();
    record(
      'База данных',
      'ok',
      `Подключение есть, миграции применены. Тем: ${categories}, ответственных групп: ${groups}, обращений: ${incidents}.`,
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

async function checkResponsibleGroups(prisma: PrismaClient, max: MaxClient): Promise<void> {
  const groups = await prisma.responsibleGroup.findMany({
    where: { isActive: true },
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
  });
  if (groups.length === 0) {
    record('Профильные чаты', 'warn', 'Нет активных ответственных групп. Выполните: npm run seed');
    return;
  }

  const pending = groups.filter((group) => group.maxChatId === null);
  const configured = groups.filter((group) => group.maxChatId !== null);

  // A сфера awaiting its chat is a rollout state, not a fault: the dispatcher
  // is never offered it, so nothing can break. Reported once, as a warning.
  if (pending.length > 0) {
    record(
      'Группы без рабочего чата',
      'warn',
      `${pending.length} из ${groups.length}: ${pending.map((item) => item.code).join(', ')}.\n` +
        '   Диспетчеру они не показываются.',
    );
  }

  if (configured.length === 0) {
    record('Профильные чаты', 'fail', 'Ни одна ответственная группа не готова к распределению.');
    return;
  }

  for (const group of configured) {
    await checkChat(max, `Группа ${group.code}`, group.maxChatId ?? undefined, '');
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

async function checkRoles(prisma: PrismaClient): Promise<void> {
  const config = getConfig();
  let stored: Record<Exclude<UserRole, 'REQUESTER'>, number>;
  try {
    const [admins, dispatchers, approvers, responders] = await Promise.all([
      prisma.user.count({ where: { roles: { has: UserRole.ADMIN } } }),
      prisma.user.count({ where: { roles: { has: UserRole.DISPATCHER } } }),
      prisma.user.count({ where: { roles: { has: UserRole.APPROVER } } }),
      prisma.user.count({ where: { roles: { has: UserRole.RESPONDER } } }),
    ]);
    stored = {
      ADMIN: admins,
      DISPATCHER: dispatchers,
      APPROVER: approvers,
      RESPONDER: responders,
    };
  } catch (error) {
    record('Роли', 'fail', `Не удалось прочитать роли из базы: ${describeError(error)}`);
    return;
  }

  if (stored.ADMIN === 0 && config.ADMINS.length === 0) {
    record(
      'Роли',
      'fail',
      'Нет ни одного ADMIN в базе или ADMINS в .env. Узнайте свой MAX ID командой /whoami и временно добавьте его в ADMINS.',
    );
    return;
  }
  record(
    'Роли',
    'ok',
    `БД — ADMIN: ${stored.ADMIN}, DISPATCHER: ${stored.DISPATCHER}, ` +
      `APPROVER: ${stored.APPROVER}, RESPONDER: ${stored.RESPONDER}; ` +
      `bootstrap .env — ADMIN: ${config.ADMINS.length}, DISPATCHER: ${config.DISPATCHERS.length}, ` +
      `APPROVER: ${config.APPROVERS.length}, RESPONDER: ${config.RESPONDERS.length}`,
  );
}

async function checkDeliveryQueues(prisma: PrismaClient): Promise<void> {
  try {
    const [outPending, outSending, outFailed, inPending, inProcessing, inFailed] = await Promise.all([
      prisma.outboundMessage.count({ where: { status: OutboxStatus.PENDING } }),
      prisma.outboundMessage.count({ where: { status: OutboxStatus.SENDING } }),
      prisma.outboundMessage.count({ where: { status: OutboxStatus.FAILED } }),
      prisma.inboundUpdate.count({ where: { status: InboxStatus.PENDING } }),
      prisma.inboundUpdate.count({ where: { status: InboxStatus.PROCESSING } }),
      prisma.inboundUpdate.count({ where: { status: InboxStatus.FAILED } }),
    ]);
    const detail =
      `Исходящие — ждут: ${outPending}, отправляются: ${outSending}, ошибки: ${outFailed}; ` +
      `входящие — ждут: ${inPending}, обрабатываются: ${inProcessing}, ошибки: ${inFailed}`;
    record('Очереди доставки', outFailed > 0 || inFailed > 0 ? 'fail' : 'ok', detail);
  } catch (error) {
    record('Очереди доставки', 'fail', `Не удалось прочитать очереди: ${describeError(error)}`);
  }
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
  if (config.DELIVERY_ALERT_CHAT_ID !== undefined) {
    targets.push({ label: 'чат технических предупреждений', chatId: config.DELIVERY_ALERT_CHAT_ID });
  }
  for (const group of await prisma.responsibleGroup.findMany({ where: { isActive: true } })) {
    if (group.maxChatId !== null) {
      targets.push({ label: `профильный чат ${group.code}`, chatId: group.maxChatId });
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
    await checkChat(
      max,
      'Чат технических предупреждений',
      config.DELIVERY_ALERT_CHAT_ID,
      'Задайте DELIVERY_ALERT_CHAT_ID, чтобы получать сообщения о проблемах доставки.',
    );
    await checkResponsibleGroups(prisma, max);
    await checkWebhook(max);
  }

  await checkMediaStorage();
  await checkRoles(prisma);
  await checkDeliveryQueues(prisma);

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
