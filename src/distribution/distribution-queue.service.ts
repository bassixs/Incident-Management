import { type PrismaClient } from '@prisma/client';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { queueDistribution, queueMessage, queueDistributionRefresh } from '../delivery/workflow-outbox';
import { getConfig } from '../config';
import { INCIDENT_INCLUDE } from '../incidents/incident.repository';
import { distributionCard } from '../bot/views/cards';
import { distributionKeyboard } from '../bot/keyboards';
import { requireChat, requirePermission } from '../bot/middleware/authorize';
import type { ResolvedActor } from '../bot/handlers/helpers';
import type { MaxMessageService } from '../max/max-message.service';
import { AsyncActivity } from '../utils/async-activity';
import { ConflictError, ValidationError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';
import { CLAIM_LOCK, CLAIM_MINUTES, assertClaimOwner, distributionAlertsAllowed, queueKeyboard, queueSnapshot, waitLabel } from './queue-state';

const log = moduleLogger('distribution-queue');

export class DistributionQueueService {
  private timer?: NodeJS.Timeout;
  private readonly activity = new AsyncActivity();
  private running?: Promise<void>;
  constructor(private readonly prisma: PrismaClient, private readonly messages: MaxMessageService) {}

  authorize(actor: ResolvedActor, chatId: bigint | undefined) {
    requirePermission(actor, 'incident.distribute');
    requireChat(chatId, getConfig().DISTRIBUTION_CHAT_ID, 'распределение');
  }

  async claim(actor: ResolvedActor, chatId: bigint, incidentId?: string, showCard = false) {
    this.authorize(actor, chatId);
    const incident = await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const now = new Date();
      const own = await tx.incident.findFirst({ where: { status: 'DISTRIBUTION', distributionClaimedBy: actor.maxUserId, distributionClaimUntil: { gt: now } } });
      if (own && incidentId && own.id !== incidentId) throw new ConflictError(`Сначала распределите ${own.publicCode} или освободите его кнопкой под выданной карточкой.`);
      const candidate = incidentId
        ? await tx.incident.findUnique({ where: { id: incidentId } })
        : own ?? await tx.incident.findFirst({ where: { status: 'DISTRIBUTION', OR: [{ distributionClaimUntil: null }, { distributionClaimUntil: { lte: now } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (!candidate) return null;
      if (candidate.status !== 'DISTRIBUTION') throw new ConflictError('Обращение уже распределено или отклонено.');
      assertClaimOwner(candidate, actor.maxUserId, now);
      const until = own?.id === candidate.id ? own.distributionClaimUntil! : new Date(now.getTime() + CLAIM_MINUTES * 60_000);
      const updated = await tx.incident.update({ where: { id: candidate.id }, data: {
        distributionClaimedBy: actor.maxUserId, distributionClaimedName: actor.displayName, distributionClaimUntil: until,
      }, include: INCIDENT_INCLUDE });
      if (!own || own.id !== updated.id) await tx.incidentHistory.create({ data: {
        incidentId: updated.id, action: 'DISTRIBUTION_CLAIMED', actorMaxUserId: actor.maxUserId,
        metadata: { operator: actor.displayName, until: until.toISOString() },
      } });
      if (showCard) await queueMessage(tx, { chatId }, {
        text: `${distributionCard(updated)}\n\nРаспределяет: ${actor.displayName}. Закреплено на 15 минут.`,
        label: `№ ${updated.publicCode}`,
        ...(updated.distributionMessageId ? { replyToMessageId: updated.distributionMessageId } : {}),
        keyboard: [...distributionKeyboard(updated.id), [{ type: 'callback', text: 'Освободить обращение', payload: `queue:release:${updated.id}` }]],
        delivery: { dedupeKey: `distribution-claim:${updated.id}:${actor.maxUserId}:${until.getTime()}` },
      }, updated.id, updated.attachments);
      if (!own || own.id !== updated.id) await queueDistributionRefresh(tx, updated.id);
      return updated;
    }, TRANSACTION_OPTIONS);
    if (showCard) await this.messages.flush();
    return incident;
  }

  async release(actor: ResolvedActor, chatId: bigint, id: string) {
    this.authorize(actor, chatId);
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const released = await tx.incident.updateMany({ where: { id, status: 'DISTRIBUTION', distributionClaimedBy: actor.maxUserId },
        data: { distributionClaimedBy: null, distributionClaimedName: null, distributionClaimUntil: null } });
      if (!released.count) throw new ConflictError('Обращение уже обработано, свободно или закреплено за другим оператором.');
      await tx.incidentHistory.create({ data: { incidentId: id, action: 'DISTRIBUTION_RELEASED', actorMaxUserId: actor.maxUserId } });
      await queueDistributionRefresh(tx, id);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
  }

  async list(actor: ResolvedActor, chatId: bigint, page: number) {
    this.authorize(actor, chatId);
    if (!Number.isSafeInteger(page) || page < 0 || page > 100_000) throw new ValidationError('Некорректная страница очереди.');
    const now = new Date();
    const total = await this.prisma.incident.count({ where: { status: 'DISTRIBUTION' } });
    page = Math.min(page, Math.max(0, Math.ceil(total / 10) - 1));
    const items = await this.prisma.incident.findMany({ where: { status: 'DISTRIBUTION' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * 10, take: 10 });
    await this.messages.send({ chatId }, {
      text: [`📋 Нераспределённые: ${total}. Страница ${page + 1}.`, '', ...items.map(i => {
        const minutes = Math.max(0, Math.floor((now.getTime() - i.createdAt.getTime()) / 60_000));
        const owner = i.distributionClaimUntil && i.distributionClaimUntil > now ? ` · ${i.distributionClaimedName}` : ' · свободно';
        return `${minutes >= 30 ? '⚠️' : '•'} ${i.publicCode} — ${waitLabel(minutes)}${owner}`;
      }), ...(!total ? ['Очередь пуста.'] : [])].join('\n'),
      keyboard: [...items.map(i => [{ type: 'callback' as const, text: `Открыть ${i.publicCode}`, payload: `queue:open:${i.id}` }]),
        [{ type: 'callback', text: '←', payload: `queue:list:${Math.max(0, page - 1)}` }, { type: 'callback', text: '→', payload: `queue:list:${page + 1}` }],
        ...queueKeyboard().slice(0, 1)],
    });
  }

  async refresh(): Promise<void> {
    const chatId = getConfig().DISTRIBUTION_CHAT_ID;
    if (chatId === undefined) return;
    // Reuse one durable job: concurrent refreshes cannot create several panels.
    await this.prisma.$transaction(async tx => {
      const dedupeKey = `distribution-panel:${chatId}`;
      await tx.outboundMessage.createMany({ skipDuplicates: true, data: [{ dedupeKey, targetType: 'chat', targetId: chatId,
        payload: { text: 'Очередь распределения', operation: { type: 'distribution-panel' } }, attachments: [], trackingApplied: true }] });
      await tx.outboundMessage.updateMany({ where: { dedupeKey, status: { in: ['SENT', 'FAILED'] } },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
    });
  }

  start() {
    if (!getConfig().DISTRIBUTION_QUEUE_ENABLED || this.timer) return;
    this.timer = setInterval(() => void this.sweep().catch(error => log.error({ err: String(error) }, 'queue sweep failed')), 60_000);
    this.timer.unref();
    void this.sweep().catch(error => log.error({ err: String(error) }, 'queue startup failed'));
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  waitForIdle() { return this.activity.waitForIdle(); }
  sweep(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.activity.run(() => this.sweepNow()).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweepNow() {
    const config = getConfig();
    if (config.DISTRIBUTION_CHAT_ID === undefined) return;
    // Retire expired copies even when no other operator takes the incident.
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const expired = await tx.incident.findMany({ where: { status: 'DISTRIBUTION', distributionClaimUntil: { lte: new Date() } }, take: 100 });
      for (const incident of expired) {
        await tx.incident.update({ where: { id: incident.id }, data: {
          distributionClaimedBy: null, distributionClaimedName: null, distributionClaimUntil: null,
        } });
        await queueDistributionRefresh(tx, incident.id, `expired:${incident.distributionClaimUntil!.getTime()}`);
      }
    }, TRANSACTION_OPTIONS);
    await this.refresh();
    // Repair missing delivery jobs only; normal retries/FAILED alerts remain owned by the outbox.
    const missing = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT i.id FROM "Incident" i WHERE i.status = 'DISTRIBUTION' AND i."distributionMessageId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "OutboundMessage" o WHERE o."dedupeKey" = 'distribution-card:' || i.id)
      ORDER BY i."createdAt", i.id LIMIT 10`;
    for (const incident of missing) await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const current = await tx.incident.findUnique({ where: { id: incident.id } });
      if (current?.status === 'DISTRIBUTION' && !current.distributionMessageId) await queueDistribution(tx, incident.id);
    }, TRANSACTION_OPTIONS);
    const now = new Date();
    if (!distributionAlertsAllowed(now, config)) return;
    const snapshot = await queueSnapshot(this.prisma, now);
    const overloaded = snapshot.total >= config.DISTRIBUTION_OVERLOAD_COUNT;
    const hour = Math.floor(now.getTime() / 3_600_000);
    for (const level of ['normal', 'escalation'] as const) {
      const needed = level === 'normal' ? snapshot.delayed60 > 0 || overloaded : snapshot.delayed120 > 0 || overloaded;
      const target: bigint | undefined = level === 'normal' ? config.DISTRIBUTION_CHAT_ID : config.DELIVERY_ALERT_CHAT_ID;
      if (!needed || target === undefined || (level === 'escalation' && target === config.DISTRIBUTION_CHAT_ID)) continue;
      await this.prisma.outboundMessage.createMany({ skipDuplicates: true, data: [{
        dedupeKey: `distribution-alert:${target}:${hour}`, targetType: 'chat', targetId: target, attachments: [], trackingApplied: true,
        payload: { text: 'Контроль очереди распределения', operation: { type: 'distribution-alert', level, hour } },
      }] });
    }
  }
}
