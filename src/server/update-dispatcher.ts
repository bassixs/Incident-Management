import type { PrismaClient } from '@prisma/client';

import { isUniqueViolation } from '../database/prisma';
import type { MaxClient } from '../max/max-client';
import type { Update } from '../max/max-types';
import { buildUpdateKey } from '../max/update-key';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('dispatcher');

export type Reservation = { key: string; fresh: boolean };

/**
 * Idempotent update intake (§48-§49).
 *
 * MAX may deliver the same webhook event more than once. Each update gets a
 * deterministic key; the unique index on ProcessedUpdate turns a replay into a
 * no-op, so a redelivered "create incident" message cannot produce a second
 * incident. The reservation is taken *before* any business logic runs, and is
 * released again only if the update could not be handed to the bot at all.
 */
export class UpdateDispatcher {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
  ) {}

  async reserve(update: Update): Promise<Reservation> {
    const key = buildUpdateKey(update);
    try {
      await this.prisma.processedUpdate.create({
        data: { externalUpdateKey: key, updateType: update.update_type },
      });
      return { key, fresh: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        log.info({ key, updateType: update.update_type }, 'duplicate update ignored');
        return { key, fresh: false };
      }
      throw error;
    }
  }

  /** Run the middleware stack. Never throws: bot.catch reports failures. */
  async process(update: Update, reservation: Reservation): Promise<void> {
    try {
      await this.max.dispatch(update);
    } catch (error) {
      // The bot could not even start processing (e.g. the library changed
      // shape). Release the key so a MAX redelivery gets another chance.
      await this.prisma.processedUpdate
        .deleteMany({ where: { externalUpdateKey: reservation.key } })
        .catch(() => undefined);
      log.error(
        { key: reservation.key, err: error instanceof Error ? error.message : String(error) },
        'update dispatch failed; reservation released',
      );
    }
  }

  /** Handle an update end to end (used by long polling in development). */
  async handle(update: Update): Promise<'processed' | 'duplicate'> {
    const reservation = await this.reserve(update);
    if (!reservation.fresh) return 'duplicate';
    await this.process(update, reservation);
    return 'processed';
  }

  /** Housekeeping so the dedup table does not grow without bound. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const result = await this.prisma.processedUpdate.deleteMany({
      where: { processedAt: { lt: cutoff } },
    });
    return result.count;
  }
}
