import { Prisma, type PrismaClient } from '@prisma/client';
import type { MaxMessageService } from '../max/max-message.service';
import type { SectorService } from '../sector/sector.service';
import type { ResolvedActor } from '../bot/handlers/helpers';
import { requirePermission } from '../bot/middleware/authorize';
import { getConfig } from '../config';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { queueMessage, queueStaffRefresh } from '../delivery/workflow-outbox';
import { INCIDENT_INCLUDE } from '../incidents/incident.repository';
import { reviewCard, sectorCard } from '../bot/views/cards';
import { reviewKeyboard, sectorKeyboard } from '../bot/keyboards';
import { ConflictError, ForbiddenError, ValidationError } from '../utils/errors';
import { AsyncActivity } from '../utils/async-activity';
import { moduleLogger } from '../utils/logger';
import { dayBoundaries } from '../utils/datetime';
import { queueWorkPanel, REVIEW_LEASE_ACTION, REVIEW_LOCK, workScope } from './state';

const log = moduleLogger('work-queues');
export class WorkQueueService {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private activity = new AsyncActivity();
  constructor(private prisma: PrismaClient, private messages: MaxMessageService, private sector: SectorService) {}

  async authorize(actor: ResolvedActor, chatId: bigint) {
    const scope = await workScope(this.prisma, chatId);
    requirePermission(actor, scope.kind === 'review' ? 'incident.approve' : 'incident.lookup');
    return scope;
  }
  async refresh(actor: ResolvedActor, chatId: bigint) {
    await this.authorize(actor, chatId);
    await queueWorkPanel(this.prisma, chatId);
    await this.messages.flush();
  }
  async claim(actor: ResolvedActor, chatId: bigint) {
    const scope = await this.authorize(actor, chatId);
    let id: string | undefined;
    if (scope.kind === 'sector') {
      // Optimistic status transition in SectorService prevents two winners.
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = await this.prisma.incident.findFirst({ where: { AND: [scope.where, { status: { in: ['ASSIGNED', 'REVISION_REQUIRED'] } }] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
        if (!candidate) break;
        try { await this.sector.takeInWork(candidate.id, actor); id = candidate.id; break; }
        catch (error) { if (!(error instanceof ConflictError)) throw error; }
      }
    } else {
      id = await this.prisma.$transaction(async tx => {
        await acquireAdvisoryLock(tx, ...REVIEW_LOCK);
        const now = new Date();
        const waiting = await tx.incident.findMany({ where: scope.where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } });
        const locks = await tx.actionLock.findMany({ where: { action: REVIEW_LEASE_ACTION, lockedUntil: { gt: now }, incidentId: { in: waiting.map(i => i.id) } } });
        const own = locks.find(l => l.maxUserId === actor.maxUserId);
        if (own?.incidentId) return own.incidentId;
        const candidate = waiting.find(i => !locks.some(l => l.incidentId === i.id));
        if (!candidate) return undefined;
        const key = `review-queue:${candidate.id}`;
        const data = { incidentId: candidate.id, maxUserId: actor.maxUserId, action: REVIEW_LEASE_ACTION, lockedUntil: new Date(now.getTime() + 900_000) };
        await tx.actionLock.upsert({ where: { key }, create: { key, ...data }, update: data });
        await tx.incidentHistory.create({ data: { incidentId: candidate.id, action: 'REVIEW_CLAIMED', actorMaxUserId: actor.maxUserId, metadata: { operator: actor.displayName } } });
        return candidate.id;
      }, TRANSACTION_OPTIONS);
    }
    if (id) await this.open(actor, chatId, id);
    await this.refresh(actor, chatId);
    return id ? 'Обращение взято в работу. Карточка отправлена в чат.' : 'Свободных обращений нет.';
  }
  async release(actor: ResolvedActor, chatId: bigint, id: string) {
    const scope = await this.authorize(actor, chatId);
    if (scope.kind !== 'review') throw new ForbiddenError('Освобождение доступно в очереди согласования.');
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...REVIEW_LOCK);
      const deleted = await tx.actionLock.deleteMany({ where: { incidentId: id, action: REVIEW_LEASE_ACTION, maxUserId: actor.maxUserId } });
      if (!deleted.count) throw new ConflictError('Закрепление уже завершено или принадлежит другому сотруднику.');
      await tx.operatorSession.deleteMany({ where: { incidentId: id, maxUserId: actor.maxUserId, type: 'WAITING_REVISION_REASON' } });
      await queueStaffRefresh(tx, id);
    }, TRANSACTION_OPTIONS);
    await this.refresh(actor, chatId);
  }
  async open(actor: ResolvedActor, chatId: bigint, id: string) {
    const scope = await this.authorize(actor, chatId);
    const incident = await this.prisma.incident.findFirst({ where: { AND: [scope.where, { id }] }, include: INCIDENT_INCLUDE });
    if (!incident) throw new ConflictError('Обращение уже вышло из очереди. Обновите список.');
    const answer = incident.answers.at(-1);
    const review = scope.kind === 'review';
    if (review && !answer) throw new ConflictError('Ответ для согласования не найден.');
    const lease = review ? await this.prisma.actionLock.findFirst({ where: { incidentId: id, action: REVIEW_LEASE_ACTION, maxUserId: actor.maxUserId, lockedUntil: { gt: new Date() } } }) : null;
    const key = `work-copy:${scope.kind}:${id}:${actor.maxUserId}:${lease?.lockedUntil.getTime() ?? incident.updatedAt.getTime()}`;
    await this.prisma.$transaction(async tx => {
      await queueMessage(tx, { chatId }, {
        text: review ? reviewCard(incident, answer!, incident.assignedGroup) : sectorCard(incident, incident.assignedGroup!),
        label: `№ ${incident.publicCode}`,
        keyboard: review ? [...reviewKeyboard(id, answer!.id), ...(lease ? [[{ type: 'callback' as const, text: 'Освободить обращение', payload: `work:release:${id}` }]] : [])]
          : sectorKeyboard(id, { hasTemplate: !!incident.assignedGroup?.answerTemplate, status: incident.status }),
        delivery: { dedupeKey: key },
      }, id, review ? answer!.attachments : incident.attachments);
      if (review) await tx.outboundMessage.updateMany({ where: { dedupeKey: key }, data: { answerId: answer!.id } });
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
  }
  async list(actor: ResolvedActor, chatId: bigint, page = 0, mine = false, today = false) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100_000) throw new ValidationError('Некорректная страница.');
    let where: Prisma.IncidentWhereInput;
    let kind: 'sector' | 'review' | undefined;
    if (today) {
      requirePermission(actor, 'incident.lookup');
      const c = getConfig();
      const global = [c.DISTRIBUTION_CHAT_ID, c.REVIEW_CHAT_ID, c.DELIVERY_ALERT_CHAT_ID].includes(chatId);
      const groups = await this.prisma.responsibleGroup.findMany({ where: { maxChatId: chatId, isActive: true }, select: { id: true } });
      if (!global && !groups.length) throw new ForbiddenError('Сводка доступна только в рабочем чате.');
      const { start, end } = dayBoundaries(new Date(), 'Europe/Moscow');
      where = { createdAt: { gte: start, lt: end }, ...(!global ? { assignedGroupId: { in: groups.map(g => g.id) } } : {}) };
    } else {
      const scope = await this.authorize(actor, chatId); where = scope.where; kind = scope.kind;
      if (mine) where = { AND: [where, kind === 'sector' ? { currentResponderId: actor.userId, status: 'IN_PROGRESS' }
        : { id: { in: (await this.prisma.actionLock.findMany({ where: { action: REVIEW_LEASE_ACTION, maxUserId: actor.maxUserId, lockedUntil: { gt: new Date() } } })).flatMap(l => l.incidentId ? [l.incidentId] : []) } }] };
    }
    const total = await this.prisma.incident.count({ where });
    page = Math.min(page, Math.max(0, Math.ceil(total / 8) - 1));
    const items = await this.prisma.incident.findMany({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], skip: page * 8, take: 8, include: INCIDENT_INCLUDE });
    const statuses: Record<string, string> = { NEW: 'Принято', DISTRIBUTION: 'Распределение', ASSIGNED: 'Свободное', IN_PROGRESS: 'В работе', WAITING_REVIEW: 'На согласовании', REVISION_REQUIRED: 'На доработке', REJECTED: 'Отклонено', RESOLVED: 'Ожидает доставки' };
    const action = today ? 'today' : mine ? 'mine' : 'list';
    const counts = today ? await this.prisma.incident.groupBy({ by: ['status'], where, _count: true }) : [];
    const delivered = today ? await this.prisma.incident.count({ where: { AND: [where, { status: 'RESOLVED', answers: { some: { deliveredAt: { not: null } } } }] } }) : 0;
    await this.messages.send({ chatId }, { text: [today ? '📅 ОБРАЩЕНИЯ ЗА СЕГОДНЯ · МСК' : mine ? '📋 МОИ В РАБОТЕ' : '📋 ОЧЕРЕДЬ ОБРАЩЕНИЙ',
      `Всего: ${total}. Страница ${page + 1} из ${Math.max(1, Math.ceil(total / 8))}.`,
      ...(today ? ['Зарегистрированы сегодня; показан текущий статус.', ...counts.flatMap(r => r.status === 'RESOLVED'
        ? [`Отработано: ${delivered}`, `Ожидает доставки: ${r._count - delivered}`] : [`${statuses[r.status]}: ${r._count}`])] : []), '',
      ...items.map(i => `${i.publicCode} — ${i.status === 'RESOLVED' && i.answers.at(-1)?.deliveredAt ? 'Отработано' : statuses[i.status]}${i.currentResponder ? ` · ${i.currentResponder.displayName}` : ''}`),
      ...(!total ? ['Обращений нет.'] : []), ...(today ? ['', 'Подробности: /incident НОМЕР_ОБРАЩЕНИЯ'] : []),
    ].join('\n'), keyboard: [
      ...(!today ? items.map(i => [{ type: 'callback' as const, text: `Открыть ${i.publicCode}`, payload: `work:open:${i.id}` }]) : []),
      [{ type: 'callback', text: '←', payload: `work:${action}:${Math.max(0, page - 1)}` }, { type: 'callback', text: 'Обновить', payload: `work:${action}:${page}` }, { type: 'callback', text: '→', payload: `work:${action}:${page + 1}` }],
    ] });
  }
  start() { if (this.timer) return; this.timer = setInterval(() => void this.sweep().catch(e => log.error({ err: String(e) }, 'work queue refresh failed')), 60_000); this.timer.unref(); void this.sweep().catch(e => log.error({ err: String(e) }, 'work queue startup failed')); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  waitForIdle() { return this.activity.waitForIdle(); }
  sweep(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.activity.run(async () => {
      await this.prisma.$transaction(async tx => {
        await acquireAdvisoryLock(tx, ...REVIEW_LOCK);
        const expired = await tx.actionLock.findMany({ where: { action: REVIEW_LEASE_ACTION, lockedUntil: { lte: new Date() } } });
        await tx.actionLock.deleteMany({ where: { key: { in: expired.map(l => l.key) } } });
        for (const lock of expired) if (lock.incidentId && await tx.incident.count({ where: { id: lock.incidentId } })) await queueStaffRefresh(tx, lock.incidentId, `expired:${lock.lockedUntil.getTime()}`);
      }, TRANSACTION_OPTIONS);
      const groups = await this.prisma.responsibleGroup.findMany({ where: { isActive: true, maxChatId: { not: null } }, select: { maxChatId: true } });
      const chats = new Set([...groups.map(g => g.maxChatId!), ...([getConfig().REVIEW_CHAT_ID].filter(x => x != null) as bigint[])]);
      for (const chat of chats) if (chat !== getConfig().DISTRIBUTION_CHAT_ID) await queueWorkPanel(this.prisma, chat);
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
}
