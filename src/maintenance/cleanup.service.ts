import { createHash, randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config';
import { isPhotoReference } from '../media/max-photo-reference';
import type { MediaStorage } from '../media/media-storage.interface';
import type { ReportRange } from '../reports/report-range';
import { resolveRoles, isStaff } from '../users/roles';
import { ForbiddenError, ValidationError } from '../utils/errors';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('manual-cleanup');
export const CLEANUP_KEY = 'maintenance.manual-cleanup';
const TTL_MS = 10 * 60_000;
type Tx = Prisma.TransactionClient;
export type CleanupKind = 'data' | 'users';
export type CleanupActor = { maxUserId: bigint; displayName: string };
export type CleanupPlan = {
  token: string; kind: CleanupKind; actorId: string; actorName: string; chatId: string;
  from?: string; until: string; title: string; expiresAt: string; fingerprint: string;
  counts: { incidents: number; active: number; profiles: number; deletedProfiles: number; consents: number };
  status: 'PREVIEW' | 'QUEUED' | 'FILES' | 'DONE' | 'FAILED';
  files?: string[]; retryAt?: string; error?: string;
};

function encoded(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item);
}
function fingerprint(value: unknown): string { return createHash('sha256').update(encoded(value)).digest('hex'); }
function storageKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(storageKeys);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => key === 'storageKey' && typeof item === 'string' ? [item] : storageKeys(item));
}
function localFiles(value: unknown): string[] {
  return [...new Set(storageKeys(value).filter(key => key && !isPhotoReference(key)))];
}
const STAFF_PREFIX = 'maintenance.cleanup-staff:';

/** Manual deletion is previewed, bound to an administrator and committed once.
 * Execution is performed by the runtime only after handlers and senders drain.
 * File removals are durable and retryable after the database transaction. */
export class CleanupService {
  private timer?: NodeJS.Timeout;
  private task?: Promise<void>;
  private exclusive?: (work: () => Promise<void>) => Promise<void>;
  constructor(private readonly prisma: PrismaClient, private readonly storage: MediaStorage, private readonly config: AppConfig) {}

  async authorize(actor: CleanupActor, chatId: bigint | undefined, dialog = false): Promise<void> {
    if (dialog || chatId === undefined || chatId !== this.config.DELIVERY_ALERT_CHAT_ID) {
      throw new ForbiddenError('Очистка доступна только в системном чате аналитики.');
    }
    const user = await this.prisma.user.findUnique({ where: { maxUserId: actor.maxUserId } });
    if (!resolveRoles(actor.maxUserId, user?.roles ?? []).includes('ADMIN')) {
      throw new ForbiddenError('Очистка доступна только администраторам бота.');
    }
  }

  async preview(kind: CleanupKind, actor: CleanupActor, chatId: bigint, range?: ReportRange, now = new Date()): Promise<CleanupPlan> {
    await this.authorize(actor, chatId);
    const plan: CleanupPlan = {
      token: randomBytes(8).toString('hex'), kind, actorId: String(actor.maxUserId), actorName: actor.displayName,
      chatId: String(chatId), ...(range?.from ? { from: range.from.toISOString() } : {}),
      until: new Date(Math.min(now.getTime(), range?.to?.getTime() ?? now.getTime())).toISOString(),
      title: kind === 'users' ? 'все сохранённые жители' : range?.title ?? 'за всё время',
      expiresAt: new Date(now.getTime() + TTL_MS).toISOString(), status: 'PREVIEW', fingerprint: '',
      counts: { incidents: 0, active: 0, profiles: 0, deletedProfiles: 0, consents: 0 },
    };
    return this.prisma.$transaction(async tx => {
      await tx.$executeRawUnsafe('LOCK TABLE "SystemSetting" IN SHARE ROW EXCLUSIVE MODE');
      const existing = await tx.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
      if (existing && ['QUEUED', 'FILES'].includes((JSON.parse(existing.value) as CleanupPlan).status)) {
        throw new ValidationError('Предыдущая очистка ещё выполняется. Дождитесь результата.');
      }
      const snapshot = await this.snapshot(tx, plan);
      plan.fingerprint = snapshot.fingerprint;
      plan.counts = snapshot.counts;
      await tx.systemSetting.upsert({ where: { key: CLEANUP_KEY }, create: { key: CLEANUP_KEY, value: encoded(plan) }, update: { value: encoded(plan) } });
      return plan;
    }, { isolationLevel: 'RepeatableRead', timeout: 30_000 });
  }

  async confirm(kind: CleanupKind, token: string, actor: CleanupActor, chatId: bigint, now = new Date()): Promise<void> {
    await this.authorize(actor, chatId);
    if (!this.exclusive) throw new ValidationError('Обработчик очистки пока не запущен. Обратитесь к администратору сервера.');
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
    const plan = row && JSON.parse(row.value) as CleanupPlan | null;
    if (!plan || plan.status !== 'PREVIEW' || plan.kind !== kind || plan.token !== token || plan.actorId !== String(actor.maxUserId) || plan.chatId !== String(chatId)) {
      throw new ValidationError('Подтверждение недействительно: откройте свою команду очистки заново.');
    }
    if (new Date(plan.expiresAt) <= now) throw new ValidationError('Срок подтверждения истёк. Запросите новый подсчёт.');
    const claimed = await this.prisma.systemSetting.updateMany({ where: { key: CLEANUP_KEY, value: row!.value }, data: { value: encoded({ ...plan, status: 'QUEUED' }) } });
    if (!claimed.count) throw new ValidationError('Предварительный подсчёт уже изменился. Откройте команду заново.');
  }

  async cancel(actor: CleanupActor, chatId: bigint): Promise<void> {
    await this.authorize(actor, chatId);
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
    if (!row) return;
    const plan = JSON.parse(row.value) as CleanupPlan;
    if (plan.actorId !== String(actor.maxUserId) || plan.status !== 'PREVIEW') throw new ValidationError('Можно отменить только свой предварительный подсчёт.');
    await this.prisma.systemSetting.deleteMany({ where: { key: CLEANUP_KEY, value: row.value } });
  }

  start(exclusive: (work: () => Promise<void>) => Promise<void>): void {
    this.exclusive = exclusive;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(error => log.error({ err: String(error) }, 'cleanup worker failed')), 1_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async waitForIdle(): Promise<void> { await this.task; }
  async tick(): Promise<void> {
    if (this.task) return this.task;
    if (!this.exclusive) return;
    this.task = this.runPending().finally(() => { this.task = undefined; });
    return this.task;
  }
  private async runPending(): Promise<void> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
    if (!row) return;
    const plan = JSON.parse(row.value) as CleanupPlan;
    if (!['QUEUED', 'FILES'].includes(plan.status) || (plan.retryAt && new Date(plan.retryAt) > new Date())) return;
    await this.exclusive!(async () => {
      try {
        if (plan.status === 'QUEUED') {
          await this.authorize({ maxUserId: BigInt(plan.actorId), displayName: plan.actorName }, BigInt(plan.chatId));
          if (new Date(plan.expiresAt) <= new Date()) throw new ValidationError('Подтверждение истекло до запуска. Повторите команду.');
          await this.execute(plan, row.value);
        }
        await this.removeFiles(plan.token);
      } catch (error) {
        log.warn({ token: plan.token, err: String(error) }, 'manual cleanup was not completed');
        await this.prisma.$transaction(async tx => {
          const current = await tx.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
          const job = current && JSON.parse(current.value) as CleanupPlan | null;
          if (!job || job.token !== plan.token || job.status !== 'QUEUED') return;
          job.status = 'FAILED';
          job.error = error instanceof ValidationError || error instanceof ForbiddenError ? error.message : 'Внутренняя ошибка. Данные не удалены; обратитесь к администратору.';
          await tx.systemSetting.update({ where: { key: CLEANUP_KEY }, data: { value: encoded(job) } });
          await this.notice(tx, job, `Очистка не выполнена. ${job.error}`, 'failed');
        });
      }
    });
  }

  private async snapshot(tx: Tx, plan: CleanupPlan) {
    const incidents = plan.kind === 'data' ? await tx.incident.findMany({
      where: { createdAt: { ...(plan.from ? { gte: new Date(plan.from) } : {}), lt: new Date(plan.until) } },
      orderBy: { id: 'asc' }, include: { attachments: true, answers: { include: { attachments: true }, orderBy: { id: 'asc' } },
        clarifications: { include: { attachments: true }, orderBy: { id: 'asc' } }, history: { orderBy: { id: 'asc' } } },
    }) : [];
    const allUsers = plan.kind === 'users' ? await tx.user.findMany({ where: { createdAt: { lt: new Date(plan.until) } }, orderBy: { id: 'asc' }, include: {
      _count: { select: { incidents: true, assignedByMe: true, respondingTo: true, approvedByMe: true, authoredAnswers: true, approvedAnswers: true, bansIssued: true } },
      legalAcceptances: { select: { id: true }, orderBy: { id: 'asc' } },
    } }) : [];
    // Context-only staff have no global role. Preserve users with staff history too.
    const staffIds = plan.kind === 'users' ? await this.staffIds(tx) : new Set<string>();
    const users = allUsers.filter(user => !isStaff(resolveRoles(user.maxUserId, user.roles)) && !staffIds.has(String(user.maxUserId)) &&
      !user._count.assignedByMe && !user._count.respondingTo && !user._count.approvedByMe && !user._count.authoredAnswers && !user._count.approvedAnswers && !user._count.bansIssued);
    const counts = { incidents: incidents.length, active: incidents.filter(incident => !['RESOLVED', 'REJECTED'].includes(incident.status)).length,
      profiles: users.length, deletedProfiles: users.filter(user => user._count.incidents === 0).length, consents: users.reduce((sum, user) => sum + user.legalAcceptances.length, 0) };
    return { incidents, users, counts, fingerprint: fingerprint({
      incidents: incidents.map(incident => ({ id: incident.id, updatedAt: incident.updatedAt, status: incident.status,
        answers: incident.answers.map(answer => [answer.id, answer.updatedAt, answer.status]),
        clarifications: incident.clarifications.map(item => [item.id, item.status, item.answeredAt]),
        history: incident.history.map(item => item.id),
        attachments: [...incident.attachments, ...incident.answers.flatMap(item => item.attachments), ...incident.clarifications.flatMap(item => item.attachments)].map(item => item.id).sort() })),
      users: users.map(user => [user.id, user.updatedAt, user._count.incidents, user.legalAcceptances]),
    }) };
  }

  private async staffIds(tx: Tx): Promise<Set<string>> {
    const [staffHistory, staffClarifications, staffAudit, remembered, related, chatUsers] = await Promise.all([
      tx.incidentHistory.findMany({ where: { actorMaxUserId: { not: null }, OR: ['ADMIN', 'DISPATCHER', 'RESPONDER', 'APPROVER'].map(role => ({ actorRole: { contains: role } })) }, select: { actorMaxUserId: true }, distinct: ['actorMaxUserId'] }),
      tx.clarification.findMany({ select: { askedByMaxUserId: true }, distinct: ['askedByMaxUserId'] }),
      tx.adminAuditLog.findMany({ select: { actorMaxUserId: true }, distinct: ['actorMaxUserId'] }),
      tx.systemSetting.findMany({ where: { key: { startsWith: STAFF_PREFIX } }, select: { value: true } }),
      tx.user.findMany({ where: { OR: [{ assignedByMe: { some: {} } }, { respondingTo: { some: {} } }, { approvedByMe: { some: {} } },
        { authoredAnswers: { some: {} } }, { approvedAnswers: { some: {} } }, { bansIssued: { some: {} } }] }, select: { maxUserId: true } }),
      tx.$queryRaw<Array<{ id: string | null }>>`SELECT DISTINCT COALESCE("payload" #>> '{callback,user,user_id}', "payload" #>> '{message,sender,user_id}', "payload" #>> '{user,user_id}') AS id
        FROM "InboundUpdate" WHERE ("payload" #>> '{message,recipient,chat_type}' = 'chat' OR "updateType" IN ('user_added', 'user_removed'))
        AND (COALESCE("payload" #>> '{message,recipient,chat_id}', "payload" ->> 'chat_id') IN (SELECT "maxChatId"::text FROM "ResponsibleGroup" WHERE "maxChatId" IS NOT NULL)
          OR COALESCE("payload" #>> '{message,recipient,chat_id}', "payload" ->> 'chat_id') IN (${String(this.config.DISTRIBUTION_CHAT_ID)}, ${String(this.config.REVIEW_CHAT_ID)}, ${String(this.config.DELIVERY_ALERT_CHAT_ID)}))`,
    ]);
    return new Set([...staffHistory.map(row => String(row.actorMaxUserId)), ...staffClarifications.map(row => String(row.askedByMaxUserId)),
      ...staffAudit.map(row => String(row.actorMaxUserId)), ...remembered.map(row => row.value), ...related.map(row => String(row.maxUserId)),
      ...chatUsers.flatMap(row => row.id ? [row.id] : [])]);
  }

  private async execute(plan: CleanupPlan, expectedValue: string): Promise<void> {
    await this.prisma.$transaction(async tx => {
      // Other DB clients (including scheduled retention) must not mutate the
      // selected graph between validation and commit. Runtime sends are paused.
      await tx.$executeRawUnsafe('SET LOCAL lock_timeout = \'5s\'');
      await tx.$executeRawUnsafe('LOCK TABLE "SystemSetting", "User", "Incident", "IncidentAnswer", "IncidentAttachment", "AnswerAttachment", "Clarification", "ClarificationAttachment", "IncidentHistory", "OperatorSession", "LegalAcceptance", "OutboundMessage", "ActionLock", "Ban", "AdminAuditLog" IN SHARE ROW EXCLUSIVE MODE');
      const row = await tx.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
      if (row?.value !== expectedValue) throw new ValidationError('Задание очистки изменилось.');
      const administrator = await tx.user.findUnique({ where: { maxUserId: BigInt(plan.actorId) } });
      if (!resolveRoles(BigInt(plan.actorId), administrator?.roles ?? []).includes('ADMIN')) throw new ForbiddenError('Права администратора отозваны.');
      const retention = await tx.systemSetting.findUnique({ where: { key: 'maintenance.incident-retention' } });
      if (retention && retention.updatedAt.getTime() > Date.now() - 2 * 60 * 60_000) throw new ValidationError('Сейчас выполняется плановая очистка. Повторите команду после её окончания.');
      const snapshot = await this.snapshot(tx, plan);
      if (snapshot.fingerprint !== plan.fingerprint) throw new ValidationError('После подсчёта данные изменились. Ничего не удалено: запросите новый подсчёт и проверьте его.');
      const ids = snapshot.incidents.map(item => item.id);
      const userIds = snapshot.users.map(item => item.id);
      const maxIds = snapshot.users.map(item => item.maxUserId);
      if (plan.kind === 'users' && await tx.inboundUpdate.count({ where: {
        partitionKey: { in: maxIds.map(id => `user:${id}`) }, status: { in: ['PENDING', 'PROCESSING'] },
      } })) throw new ValidationError('У жителей есть сообщения в обработке. Ничего не сброшено; дождитесь обработки и повторите команду.');
      const answerIds = snapshot.incidents.flatMap(item => item.answers.map(answer => answer.id));
      let outboxWhere: Prisma.OutboundMessageWhereInput = plan.kind === 'data'
        ? { OR: [{ incidentId: { in: ids } }, { answerId: { in: answerIds } }] }
        : { targetType: 'user', targetId: { in: maxIds }, incidentId: null, answerId: null, createdAt: { lt: new Date(plan.until) } };
      if (plan.kind === 'data' && ids.length) {
        // Lookup replies and other untracked notices can contain an incident
        // card too. Do not deliver a cached card after its source was deleted.
        const references = new Set([...ids, ...snapshot.incidents.map(item => item.publicCode)]);
        const untracked = await tx.outboundMessage.findMany({ where: { incidentId: null, answerId: null }, select: { id: true, payload: true } });
        const cachedIds = untracked.filter(row => [...encoded(row.payload).matchAll(/INC-\d{8}-\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)]
          .some(match => references.has(match[0]))).map(row => row.id);
        outboxWhere = { OR: [outboxWhere, { id: { in: cachedIds } }] };
      }
      const outbox = await tx.outboundMessage.findMany({ where: outboxWhere });
      const sessions = await tx.operatorSession.findMany({ where: plan.kind === 'data' ? { incidentId: { in: ids } } : { maxUserId: { in: maxIds }, incidentId: null } });
      const files = localFiles([snapshot.incidents, outbox.map(item => item.attachments), sessions.map(item => item.data)]);
      await tx.outboundMessage.deleteMany({ where: outboxWhere });
      await tx.operatorSession.deleteMany({ where: { id: { in: sessions.map(item => item.id) } } });
      if (plan.kind === 'data') {
        const staffIds = await this.staffIds(tx);
        await tx.systemSetting.createMany({ skipDuplicates: true, data: [...staffIds].map(id => ({ key: `${STAFF_PREFIX}${id}`, value: id })) });
        await tx.actionLock.deleteMany({ where: { incidentId: { in: ids } } });
        await tx.incident.deleteMany({ where: { id: { in: ids } } });
      } else {
        await tx.legalAcceptance.deleteMany({ where: { userId: { in: userIds } } });
        await tx.user.updateMany({ where: { id: { in: userIds } }, data: { requesterName: null, requesterPhone: null, displayName: 'Житель', username: null } });
        await tx.actionLock.deleteMany({ where: { maxUserId: { in: maxIds }, incidentId: null } });
        await tx.user.deleteMany({ where: { id: { in: snapshot.users.filter(item => item._count.incidents === 0).map(item => item.id) } } });
      }
      // Never remove a physical object still referenced by surviving records.
      const surviving = files.length ? await Promise.all([
        tx.incidentAttachment.findMany({ where: { storageKey: { in: files } }, select: { storageKey: true } }),
        tx.answerAttachment.findMany({ where: { storageKey: { in: files } }, select: { storageKey: true } }),
        tx.clarificationAttachment.findMany({ where: { storageKey: { in: files } }, select: { storageKey: true } }),
        tx.outboundMessage.findMany({ select: { attachments: true } }),
        tx.operatorSession.findMany({ select: { data: true } }),
      ]) : [];
      const retained = new Set(storageKeys(surviving));
      plan.status = 'FILES'; plan.files = files.filter(key => !retained.has(key));
      await tx.systemSetting.update({ where: { key: CLEANUP_KEY }, data: { value: encoded(plan) } });
      await tx.adminAuditLog.create({ data: { action: 'MANUAL_CLEANUP', actorMaxUserId: BigInt(plan.actorId), actorName: plan.actorName,
        targetType: plan.kind, summary: plan.kind === 'data' ? `Удалено обращений: ${plan.counts.incidents}; ${plan.title}` : `Сброшено профилей: ${plan.counts.profiles}; удалено: ${plan.counts.deletedProfiles}`,
        metadata: { token: plan.token, counts: plan.counts, from: plan.from ?? null, until: plan.until } } });
    }, { timeout: 60_000 });
  }

  private async removeFiles(token: string): Promise<void> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CLEANUP_KEY } });
    const plan = row && JSON.parse(row.value) as CleanupPlan | null;
    if (!plan || plan.token !== token || plan.status !== 'FILES') return;
    const remaining: string[] = [];
    for (const key of plan.files ?? []) {
      try { await this.storage.remove(key); } catch { remaining.push(key); }
    }
    plan.files = remaining;
    plan.status = remaining.length ? 'FILES' : 'DONE';
    plan.retryAt = new Date(Date.now() + 60_000).toISOString();
    await this.prisma.$transaction(async tx => {
      await tx.systemSetting.update({ where: { key: CLEANUP_KEY }, data: { value: encoded(plan) } });
      const text = remaining.length
        ? `Данные в базе очищены. Не удалось удалить ${remaining.length} файлов из хранилища; бот повторит попытку. Новая очистка доступна после завершения этой.`
        : plan.kind === 'data'
          ? `Очистка завершена: удалено обращений — ${plan.counts.incidents} (${plan.title}). Сохранённые пользователи не сбрасывались.`
          : `Сброс завершён: данные жителей — ${plan.counts.profiles}, полностью удалённые профили без обращений — ${plan.counts.deletedProfiles}. При новом обращении бот снова запросит данные и согласия. Существующие обращения сохранены.`;
      await this.notice(tx, plan, text, remaining.length ? 'files-pending' : 'done');
    });
  }
  private async notice(tx: Tx, plan: CleanupPlan, text: string, stage: string) {
    await tx.outboundMessage.createMany({ skipDuplicates: true, data: [{
      dedupeKey: `manual-cleanup:${plan.token}:${stage}`, targetType: 'chat', targetId: BigInt(plan.chatId),
      payload: { text }, attachments: [], trackingApplied: true,
    }] });
  }
}

export function cleanupPreviewText(plan: CleanupPlan): string {
  const command = plan.kind === 'data' ? '/clear_data' : '/clear_users';
  return [
    '⚠️ Предварительный подсчёт. Пока ничего не удалено.', '',
    ...(plan.kind === 'data' ? [
      `Период создания обращений: ${plan.title}.`, `Обращений: ${plan.counts.incidents}, из них незавершённых: ${plan.counts.active}.`,
      'Будут удалены сами обращения, ответы, оценки, уточнения, история, связанные вложения и задания доставки. Профили жителей останутся.',
    ] : [
      `Сбросить сохранённые данные жителей: ${plan.counts.profiles}.`, `Из них полностью удалить профили без обращений: ${plan.counts.deletedProfiles}.`,
      `Удалить подтверждения документов: ${plan.counts.consents}.`,
      'У всех выбранных жителей будут сброшены ФИО, телефон и согласия, незавершённое заполнение нового обращения придётся начать заново.',
      'Сами обращения, сведения внутри них и ожидание уточнений сохраняются. MAX ID остаётся, если нужен для существующих обращений.',
    ]), '',
    'Сотрудники, права, настройки чатов, блокировки, нумерация и журнал действий администратора сохраняются.',
    'Сообщения, фото и отчёты, уже отправленные в MAX, а также резервные копии этой командой не удаляются.',
    'Отменить удаление через бота нельзя. Подтвердить может только автор подсчёта в течение 10 минут:', '',
    `${command} confirm ${plan.token}`, '', `${command} cancel — отмена.`,
  ].join('\n');
}
