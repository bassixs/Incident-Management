import { InboxStatus, Prisma, type PrismaClient } from '@prisma/client';

import { isUniqueViolation } from '../database/prisma';
import type { MaxClient } from '../max/max-client';
import type { Update } from '../max/max-types';
import { buildUpdateKey } from '../max/update-key';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('dispatcher');
const INBOX_INTERVAL_MS = 250;

export type Reservation = { id?: string; key: string; fresh: boolean };

/**
 * Durable webhook inbox.
 *
 * The payload is committed before MAX receives HTTP 200. Processing then runs
 * from the database, so an accepted update cannot exist only in process
 * memory. Completed legacy ProcessedUpdate keys remain honoured during the
 * rollout and continue to protect against old redeliveries.
 */
export class UpdateDispatcher {
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
  ) {}

  async reserve(update: Update): Promise<Reservation> {
    const key = buildUpdateKey(update);
    const legacy = await this.prisma.processedUpdate.findUnique({
      where: { externalUpdateKey: key },
      select: { id: true },
    });
    if (legacy) return { key, fresh: false };

    try {
      const row = await this.prisma.inboundUpdate.create({
        data: {
          externalUpdateKey: key,
          updateType: update.update_type,
          payload: JSON.parse(JSON.stringify(update)) as Prisma.InputJsonValue,
        },
      });
      return { id: row.id, key, fresh: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        log.info({ key, updateType: update.update_type }, 'duplicate update ignored');
        return { key, fresh: false };
      }
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    const interrupted = await this.prisma.inboundUpdate.updateMany({
      where: { status: InboxStatus.PROCESSING },
      data: {
        status: InboxStatus.FAILED,
        lastError: 'Обработка была прервана перезапуском; требуется безопасная ручная проверка.',
        lockedAt: null,
      },
    });
    if (interrupted.count > 0) {
      log.error({ count: interrupted.count }, 'interrupted inbox updates require manual attention');
    }
    await this.purgeOlderThan(30);
    this.timer = setInterval(() => void this.kick(), INBOX_INTERVAL_MS);
    this.timer.unref?.();
    await this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async kick(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    for (let processed = 0; processed < 100; processed += 1) {
      const row = await this.prisma.inboundUpdate.findFirst({
        where: { status: InboxStatus.PENDING, nextAttemptAt: { lte: new Date() } },
        orderBy: { receivedAt: 'asc' },
        select: { id: true },
      });
      if (!row) break;
      await this.processById(row.id);
    }
  }

  private async processById(id: string): Promise<void> {
    const claimed = await this.prisma.inboundUpdate.updateMany({
      where: { id, status: InboxStatus.PENDING },
      data: { status: InboxStatus.PROCESSING, lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return;

    const row = await this.prisma.inboundUpdate.findUniqueOrThrow({ where: { id } });
    try {
      await this.max.dispatch(row.payload as unknown as Update);
      await this.prisma.inboundUpdate.update({
        where: { id },
        data: {
          status: InboxStatus.PROCESSED,
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.prisma.inboundUpdate.update({
        where: { id },
        data: {
          status: InboxStatus.FAILED,
          lockedAt: null,
          lastError: detail.slice(0, 4_000),
        },
      });
      log.error({ inboxId: id, key: row.externalUpdateKey, err: detail }, 'inbox update requires attention');
    }
  }

  /** Handle an update end to end (used by long polling in development). */
  async handle(update: Update): Promise<'processed' | 'duplicate'> {
    const reservation = await this.reserve(update);
    if (!reservation.fresh || !reservation.id) return 'duplicate';
    await this.processById(reservation.id);
    return 'processed';
  }

  /** Housekeeping so both old and new dedup tables stay bounded. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const [legacy, inbox] = await Promise.all([
      this.prisma.processedUpdate.deleteMany({ where: { processedAt: { lt: cutoff } } }),
      this.prisma.inboundUpdate.deleteMany({
        where: { receivedAt: { lt: cutoff }, status: { in: [InboxStatus.PROCESSED, InboxStatus.FAILED] } },
      }),
    ]);
    return legacy.count + inbox.count;
  }
}
