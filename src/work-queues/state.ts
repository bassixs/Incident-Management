import { SECTOR_LEASE_ACTION } from './leases';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { Tx } from '../database/prisma';
import { acquireAdvisoryLock } from '../database/prisma';
import { getConfig } from '../config';
import type { Button } from '../max/max-types';
import { ConflictError, ForbiddenError } from '../utils/errors';

export type WorkKind = 'sector' | 'review';
export const REVIEW_LOCK = ['work-queue', 'review'] as const;
export const REVIEW_LEASE_ACTION = 'review-queue';
export const workPanelKey = (chatId: bigint) => `work-panel:${chatId}`;
export const workButtons = (): Button[][] => [
  [{ type: 'callback', text: 'Моя работа в личном диалоге', payload: 'personal:home' }],
  [{ type: 'callback', text: 'Следующее свободное', payload: 'work:next' }],
  [{ type: 'callback', text: 'Посмотреть очередь', payload: 'work:list:0' }, { type: 'callback', text: 'Мои в работе', payload: 'work:mine:0' }],
  [{ type: 'callback', text: 'За сегодня', payload: 'work:today:0' }, { type: 'callback', text: 'Обновить', payload: 'work:refresh' }],
];
export async function workScope(db: PrismaClient | Tx, chatId: bigint): Promise<{ kind: WorkKind; where: Prisma.IncidentWhereInput }> {
  if (chatId === getConfig().REVIEW_CHAT_ID) return { kind: 'review', where: { status: 'WAITING_REVIEW' } };
  const groups = await db.responsibleGroup.findMany({ where: { maxChatId: chatId, isActive: true }, select: { id: true } });
  if (!groups.length) throw new ForbiddenError('Очередь доступна в профильном чате или чате согласования.');
  return { kind: 'sector', where: { assignedGroupId: { in: groups.map(g => g.id) }, status: { in: ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'] } } };
}
export async function workPanelText(db: PrismaClient | Tx, chatId: bigint): Promise<string> {
  const scope = await workScope(db, chatId);
  const total = await db.incident.count({ where: scope.where });
  const busy = await db.actionLock.count({ where: { action: scope.kind === 'sector' ? SECTOR_LEASE_ACTION : REVIEW_LEASE_ACTION, lockedUntil: { gt: new Date() }, incidentId: { in: (await db.incident.findMany({ where: scope.where, select: { id: true } })).map(i => i.id) } } });
  return [scope.kind === 'sector' ? '📋 ОЧЕРЕДЬ ПРОФИЛЬНОГО ЧАТА' : '📋 ОЧЕРЕДЬ СОГЛАСОВАНИЯ', '',
    `Ожидают обработки: ${total}`, `Свободны: ${total - busy} · В работе: ${busy}`, '',
    '«Следующее свободное» — самое старое свободное обращение.',
    'Закрепление за сотрудником на 15 минут. Имя и время указаны в карточке. Можно освободить кнопкой.',
    '«За сегодня» — статусы обращений, зарегистрированных сегодня по Москве.',
    'Панель обновляется каждую минуту.',
  ].join('\n');
}
export async function queueWorkPanel(db: PrismaClient | Tx, chatId: bigint): Promise<void> {
  const dedupeKey = workPanelKey(chatId);
  await db.outboundMessage.createMany({ skipDuplicates: true, data: [{ dedupeKey, targetType: 'chat', targetId: chatId,
    payload: { text: 'Очередь обращений', operation: { type: 'work-panel' } }, attachments: [], trackingApplied: true }] });
  await db.outboundMessage.updateMany({ where: { dedupeKey, status: { in: ['SENT', 'FAILED'] } },
    data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null } });
}
export async function assertReviewReservation(tx: Tx, incidentId: string, maxUserId: bigint): Promise<void> {
  await acquireAdvisoryLock(tx, ...REVIEW_LOCK);
  const lock = await tx.actionLock.findFirst({ where: { incidentId, action: REVIEW_LEASE_ACTION, lockedUntil: { gt: new Date() } } });
  if (lock && lock.maxUserId !== maxUserId) throw new ConflictError('Ответ уже взят на согласование другим сотрудником. Дождитесь освобождения.');
}
