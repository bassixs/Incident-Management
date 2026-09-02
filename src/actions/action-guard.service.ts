import type { PrismaClient } from '@prisma/client';

import { isUniqueViolation } from '../database/prisma';

export type ActionLease = {
  key: string;
  maxUserId: bigint;
  action: string;
  incidentId?: string | undefined;
  ttlMs: number;
};

/**
 * Database-backed debounce for callback buttons.
 *
 * MAX creates a fresh callback_id for every physical tap, so webhook
 * idempotency cannot recognise a person pressing the same button five times.
 * A short lease closes that gap and also works when more than one app instance
 * is running. Expiry makes the lock self-healing after a crash.
 */
export class ActionGuardService {
  constructor(private readonly prisma: PrismaClient) {}

  async acquire(lease: ActionLease, now = new Date()): Promise<boolean> {
    const lockedUntil = new Date(now.getTime() + lease.ttlMs);
    const data = {
      key: lease.key,
      maxUserId: lease.maxUserId,
      incidentId: lease.incidentId ?? null,
      action: lease.action,
      lockedUntil,
    };

    try {
      await this.prisma.actionLock.create({ data });
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const reclaimed = await this.prisma.actionLock.updateMany({
      where: { key: lease.key, lockedUntil: { lte: now } },
      data: { ...data, createdAt: now },
    });
    return reclaimed.count === 1;
  }

  async release(key: string): Promise<void> {
    await this.prisma.actionLock.deleteMany({ where: { key } });
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const result = await this.prisma.actionLock.deleteMany({ where: { lockedUntil: { lt: now } } });
    return result.count;
  }
}
