import { workingHours } from '../utils/work-calendar';
import type { Incident, PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config';
import type { Tx } from '../database/prisma';
import type { Button } from '../max/max-types';
import { ConflictError } from '../utils/errors';

export const CLAIM_MINUTES = 15;
export const CLAIM_LOCK = ['distribution-queue', 'claims'] as const;
export const panelSettingKey = (chatId: bigint) => `distribution-panel:${chatId}`;
export const queueKeyboard = (): Button[][] => [
  [{ type: 'callback', text: 'Следующее обращение', payload: 'queue:next' }],
  [{ type: 'callback', text: 'Посмотреть список', payload: 'queue:list:0' },
    { type: 'callback', text: 'Обновить', payload: 'queue:refresh' }],
  [{ type: 'callback', text: 'За сегодня', payload: 'work:today:0' }],
];

export function assertClaimOwner(incident: Incident, userId: bigint, now = new Date()): void {
  if (incident.distributionClaimUntil && incident.distributionClaimUntil > now && incident.distributionClaimedBy !== userId) {
    throw new ConflictError(`Обращение распределяет ${incident.distributionClaimedName ?? 'другой оператор'}. Дождитесь завершения или освобождения обращения.`);
  }
}

export async function queueSnapshot(db: PrismaClient | Tx, now: Date) {
  const where = { status: 'DISTRIBUTION' as const };
  const [total, reserved, delayed30, delayed60, delayed120, oldest] = await Promise.all([
    db.incident.count({ where }),
    db.incident.count({ where: { ...where, distributionClaimUntil: { gt: now } } }),
    db.incident.count({ where: { ...where, createdAt: { lte: new Date(now.getTime() - 30 * 60_000) } } }),
    db.incident.count({ where: { ...where, createdAt: { lte: new Date(now.getTime() - 60 * 60_000) } } }),
    db.incident.count({ where: { ...where, createdAt: { lte: new Date(now.getTime() - 120 * 60_000) } } }),
    db.incident.findFirst({ where, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { createdAt: true } }),
  ] as const);
  return { total, reserved, delayed30, delayed60, delayed120,
    oldestMinutes: oldest ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 60_000)) : 0 };
}

export type QueueSnapshot = Awaited<ReturnType<typeof queueSnapshot>>;
export const waitLabel = (minutes: number) => `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
export function queuePanelText(s: QueueSnapshot): string {
  return ['📋 ОЧЕРЕДЬ РАСПРЕДЕЛЕНИЯ', '', `Ожидают распределения: ${s.total}`,
    `Свободны: ${s.total - s.reserved} · У операторов: ${s.reserved}`,
    `Более 30 минут: ${s.delayed30} · Более часа: ${s.delayed60}`,
    `Самое старое ожидает: ${waitLabel(s.oldestMinutes)}`, '',
    '«Следующее обращение» — самое старое свободное. Закрепление за оператором на 15 минут.',
    'Обращение остаётся в очереди до распределения или отклонения.',
    'Панель обновляется каждую минуту. Напоминания: пн–пт, 08:00–17:00 МСК.',
  ].join('\n');
}

/** Distribution summaries use the same work schedule as SLA reminders. */
export function distributionAlertsAllowed(now: Date, config: Pick<AppConfig, 'WORKDAY_START' | 'WORKDAY_END'>): boolean {
  return workingHours(now, config);
}
