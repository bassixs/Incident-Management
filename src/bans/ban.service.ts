import type { Ban, PrismaClient } from '@prisma/client';

import type { PrismaLike } from '../database/prisma';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('bans');

export class BanService {
  constructor(private readonly prisma: PrismaClient) {}

  async findActive(maxUserId: bigint, tx?: PrismaLike): Promise<Ban | null> {
    return (tx ?? this.prisma).ban.findFirst({
      where: { maxUserId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async isBanned(maxUserId: bigint, tx?: PrismaLike): Promise<boolean> {
    return (await this.findActive(maxUserId, tx)) !== null;
  }

  async ban(input: { maxUserId: bigint; reason: string; createdById?: string | null }): Promise<Ban> {
    const existing = await this.findActive(input.maxUserId);
    if (existing) {
      return this.prisma.ban.update({
        where: { id: existing.id },
        data: { reason: input.reason, createdById: input.createdById ?? existing.createdById },
      });
    }
    const ban = await this.prisma.ban.create({
      data: {
        maxUserId: input.maxUserId,
        reason: input.reason,
        createdById: input.createdById ?? null,
      },
    });
    log.info({ maxUserId: input.maxUserId.toString(), action: 'USER_BANNED' }, 'user banned');
    return ban;
  }

  /** Returns the number of bans lifted (0 when the user was not banned). */
  async unban(maxUserId: bigint): Promise<number> {
    const result = await this.prisma.ban.updateMany({
      where: { maxUserId, isActive: true },
      data: { isActive: false, revokedAt: new Date() },
    });
    if (result.count > 0) {
      log.info({ maxUserId: maxUserId.toString(), action: 'USER_UNBANNED' }, 'user unbanned');
    }
    return result.count;
  }

  async listActive(): Promise<Ban[]> {
    return this.prisma.ban.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
  }
}
