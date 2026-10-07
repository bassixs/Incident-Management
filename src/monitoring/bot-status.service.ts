import { Prisma, type PrismaClient } from '@prisma/client';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import type { AppConfig } from '../config';
import type { MaxClient } from '../max/max-client';
import { SUBSCRIBED_UPDATE_TYPES } from '../max/max-types';
import { moduleLogger } from '../utils/logger';

const ZONE = 'Europe/Moscow';
const log = moduleLogger('bot-status');
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
type StatusConfig = Pick<AppConfig, 'BOT_STATUS_USER_IDS' | 'BOT_STATUS_TIME' | 'BOT_STATUS_WEEKDAY'>;
export type BotStatusOperation = { type: 'bot-status'; checkedAt: string; expiresAt: string };

/** Only today's scheduled run can be caught up. ISO week is independent of OS TZ. */
export function botStatusSlot(config: StatusConfig, now: Date) {
  if (!config.BOT_STATUS_USER_IDS.length) return undefined;
  if (WEEKDAYS[Number(formatInTimeZone(now, ZONE, 'i')) - 1] !== config.BOT_STATUS_WEEKDAY
    || formatInTimeZone(now, ZONE, 'HH:mm') < config.BOT_STATUS_TIME) return undefined;
  const day = formatInTimeZone(now, ZONE, 'yyyy-MM-dd');
  const tomorrow = new Date(`${day}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return { week: formatInTimeZone(now, ZONE, 'RRRR-II'), day,
    expiresAt: fromZonedTime(`${tomorrow.toISOString().slice(0, 10)}T00:00:00`, ZONE) };
}

export function botStatusText(checkedAt: Date, problems: string[]): string {
  const time = formatInTimeZone(checkedAt, ZONE, 'HH:mm');
  if (!problems.length) return `Доброе утро! Чат-бот «На связи_регион40» работает. По автоматической проверке на ${time} МСК проблем не обнаружено.`;
  return [`⚠️ Чат-бот «На связи_регион40»: требуется проверка.`,
    `Результат автоматической проверки на ${formatInTimeZone(checkedAt, ZONE, 'dd.MM.yyyy HH:mm')} МСК:`,
    ...problems.map(reason => `• ${reason}`)].join('\n');
}

/** Re-evaluated by the durable worker immediately before every delivery attempt. */
export function botStatusDeliveryText(operation: BotStatusOperation, text: string, recipient: bigint, config: StatusConfig, now: Date): string | undefined {
  const checkedAt = new Date(operation.checkedAt), expiresAt = new Date(operation.expiresAt);
  if (!Number.isFinite(checkedAt.getTime()) || !Number.isFinite(expiresAt.getTime())
    || now >= expiresAt || checkedAt > now || !config.BOT_STATUS_USER_IDS.includes(recipient)
    || formatInTimeZone(checkedAt, ZONE, 'yyyy-MM-dd') !== formatInTimeZone(now, ZONE, 'yyyy-MM-dd')) return undefined;
  if (Math.floor(now.getTime() / 60_000) > Math.floor(checkedAt.getTime() / 60_000)) {
    return `Отложенный отчёт. Результат проверки от ${formatInTimeZone(checkedAt, ZONE, 'dd.MM.yyyy HH:mm')} МСК.\n\n${text}`;
  }
  return text;
}

async function bounded<T>(work: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Status check timeout')), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Counts and fixed labels only: no message bodies, contact data or raw errors. */
export async function inspectBotHealth(prisma: PrismaClient, max: Pick<MaxClient, 'getMe' | 'listWebhookSubscriptions'>, config: Pick<AppConfig, 'BOT_MODE' | 'WEBHOOK_URL'>, now: Date): Promise<string[]> {
  const results = await Promise.all([
    bounded(async () => { await prisma.$queryRaw`SELECT 1`; return [] as string[]; })
      .catch(() => ['Проверка подключения к базе данных недоступна.']),
    bounded(async () => {
      const stale = new Date(now.getTime() - 120_000), delayed = new Date(now.getTime() - 15 * 60_000);
      const [inFailed, outFailed, inRetry, outRetry, inStuck, outStuck, inLate, outLate] = await Promise.all([
        prisma.inboundUpdate.count({ where: { status: 'FAILED' } }),
        prisma.outboundMessage.count({ where: { status: 'FAILED' } }),
        prisma.inboundUpdate.count({ where: { status: 'PENDING', attempts: { gt: 0 } } }),
        prisma.outboundMessage.count({ where: { status: { in: ['PENDING', 'DEFERRED'] }, attempts: { gt: 0 } } }),
        prisma.inboundUpdate.count({ where: { status: 'PROCESSING', OR: [{ lockedAt: null }, { lockedAt: { lte: stale } }] } }),
        prisma.outboundMessage.count({ where: { status: 'SENDING', OR: [{ lockedAt: null }, { lockedAt: { lte: stale } }] } }),
        prisma.inboundUpdate.count({ where: { status: 'PENDING', attempts: 0, nextAttemptAt: { lte: delayed }, receivedAt: { lte: delayed } } }),
        prisma.outboundMessage.count({ where: { status: { in: ['PENDING', 'DEFERRED'] }, attempts: 0, nextAttemptAt: { lte: delayed }, createdAt: { lte: delayed } } }),
      ]);
      return [
        inFailed + outFailed ? `Ошибки очередей: входящих ${inFailed}, исходящих ${outFailed}.` : '',
        inRetry + outRetry ? `Задания с повторными попытками: входящих ${inRetry}, исходящих ${outRetry}.` : '',
        inStuck + outStuck ? `Зависшая обработка: входящих ${inStuck}, исходящих ${outStuck}.` : '',
        inLate + outLate ? `Ожидание обработки более 15 минут: входящих ${inLate}, исходящих ${outLate}.` : '',
      ].filter(Boolean);
    }).catch(() => ['Проверка состояния очередей недоступна.']),
    bounded(async () => { await max.getMe(); return [] as string[]; })
      .catch(() => ['MAX API недоступен для проверки.']),
    bounded(async () => {
      if (config.BOT_MODE !== 'webhook' || !config.WEBHOOK_URL) return ['Не задан ожидаемый вебхук для проверки.'];
      const subscriptions = await max.listWebhookSubscriptions();
      const matching = subscriptions.find(item => item.url === config.WEBHOOK_URL);
      if (!matching) return ['Подписка на ожидаемый вебхук отсутствует.'];
      if (!matching.update_types?.length) return ['Не удалось подтвердить список событий подписки вебхука.'];
      if (SUBSCRIBED_UPDATE_TYPES.some(type => !matching.update_types!.includes(type))) {
        return ['Подписка вебхука не охватывает необходимые события.'];
      }
      if (subscriptions.some(item => item.url !== config.WEBHOOK_URL)) return ['Найдены дополнительные подписки вебхука.'];
      return [] as string[];
    }).catch(() => ['Проверка подписки вебхука недоступна.']),
  ]);
  return results.flat();
}

/** A scheduled report of a running application, not an external uptime monitor. */
export class BotStatusService {
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  constructor(private readonly prisma: PrismaClient, max: Pick<MaxClient, 'getMe' | 'listWebhookSubscriptions'>,
    private readonly config: AppConfig, private readonly clock: () => Date = () => new Date(),
    private readonly inspect: (now: Date) => Promise<string[]> = now => inspectBotHealth(prisma, max, config, now)) {}

  start(): void {
    if (!this.config.BOT_STATUS_USER_IDS.length || this.timer) return;
    this.timer = setInterval(() => this.schedule(), 60_000);
    this.timer.unref?.();
    this.schedule();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async waitForIdle(): Promise<void> { await this.current; }
  private schedule(): void {
    void this.checkNow().catch(() => log.warn('Weekly status report could not be persisted; retrying while today remains eligible'));
  }
  checkNow(): Promise<void> {
    if (!this.current) this.current = this.check().finally(() => { this.current = undefined; });
    return this.current;
  }
  private async check(): Promise<void> {
    const checkedAt = this.clock(), slot = botStatusSlot(this.config, checkedAt);
    if (!slot) return;
    const key = `bot-status-run:${slot.week}`;
    if (await this.prisma.systemSetting.findUnique({ where: { key } })) return;
    const problems = await this.inspect(checkedAt).catch(() => ['Автоматическая проверка не завершена.']);
    if (botStatusSlot(this.config, this.clock())?.day !== slot.day) return;
    const operation: BotStatusOperation = { type: 'bot-status', checkedAt: checkedAt.toISOString(), expiresAt: slot.expiresAt.toISOString() };
    const payload = { text: botStatusText(checkedAt, problems), operation };
    // The weekly marker and every recipient's job commit together. A crash cannot
    // leave a completed marker without jobs. Unique keys arbitrate other instances.
    await this.prisma.$transaction(async tx => {
      const claimed = await tx.systemSetting.createMany({ skipDuplicates: true,
        data: [{ key, value: checkedAt.toISOString() }] });
      if (!claimed.count) return;
      await tx.outboundMessage.createMany({ skipDuplicates: true, data: this.config.BOT_STATUS_USER_IDS.map(id => ({
        dedupeKey: `bot-status:${slot.week}:${id}`, targetType: 'user', targetId: id,
        payload: payload as Prisma.InputJsonValue, attachments: [], trackingApplied: true,
      })) });
    });
  }
}
