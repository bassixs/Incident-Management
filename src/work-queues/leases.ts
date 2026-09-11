import type { PrismaClient } from '@prisma/client';
import type { Tx } from '../database/prisma';
import { acquireAdvisoryLock } from '../database/prisma';
import { ConflictError } from '../utils/errors';
import { formatDateTime } from '../utils/datetime';

export const SECTOR_LEASE_ACTION = 'sector-queue';
export const LEASE_MS = 15 * 60_000;
export type LeaseView = { name: string; until: Date } | null;
export async function leaseView(db: PrismaClient | Tx, incidentId: string, action: string): Promise<LeaseView> {
  const lease = await db.actionLock.findFirst({ where: { incidentId, action, lockedUntil: { gt: new Date() } } });
  if (!lease) return null;
  const user = await db.user.findUnique({ where: { maxUserId: lease.maxUserId } });
  return { name: user?.displayName ?? `Сотрудник ${lease.maxUserId}`, until: lease.lockedUntil };
}
export const leaseText = (lease: LeaseView) => lease
  ? `👤 Закреплено за: ${lease.name}\n⏳ До ${formatDateTime(lease.until)} (МСК)`
  : '🟢 Свободно — можно взять в работу';

/** Shares the answer lock with submit/return/release, so expired owners cannot overwrite a new claim. */
export async function assertSectorReservation(tx: Tx, id: string, maxUserId: bigint): Promise<void> {
  await acquireAdvisoryLock(tx, 'incident-answer', id);
  const lock = await tx.actionLock.findFirst({ where: { incidentId: id, action: SECTOR_LEASE_ACTION, lockedUntil: { gt: new Date() } } });
  if (lock && lock.maxUserId !== maxUserId) {
    const owner = await tx.user.findUnique({ where: { maxUserId: lock.maxUserId } });
    throw new ConflictError(`Обращение закреплено за ${owner?.displayName ?? 'другим сотрудником'} до ${formatDateTime(lock.lockedUntil)}. Дождитесь освобождения.`);
  }
}
