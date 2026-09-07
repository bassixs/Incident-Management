import { AsyncActivity } from '../utils/async-activity';
import { getConfig } from '../config';
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
  private stopping = false;
  private paused = false;
  private readonly activity = new AsyncActivity();
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;
  private readonly reservations = new Map<string, Promise<Reservation>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
    private readonly concurrency = getConfig().INBOX_CONCURRENCY,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Inbox concurrency must be between 1 and 32');
  }

  async reserve(update: Update): Promise<Reservation> {
    const key = updatePartition(update);
    const previous = this.reservations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.reserveNow(update));
    this.reservations.set(key, operation);
    try { return await operation; }
    finally { if (this.reservations.get(key) === operation) this.reservations.delete(key); }
  }

  private async reserveNow(update: Update): Promise<Reservation> {
    if (this.stopping) throw new Error('Dispatcher is shutting down; retry update later');
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
          partitionKey: updatePartition(update),
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
    this.stopping = false;
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
    this.timer = setInterval(() => void this.kick().catch(error => log.error({ err: String(error) }, 'inbox sweep failed')), INBOX_INTERVAL_MS);
    this.timer.unref?.();
    await this.kick();
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.drainPromise;
    await this.activity.waitForIdle();
  }

  /** Keep accepting durable webhook reservations while maintenance drains work. */
  pauseProcessing(): void { this.paused = true; }
  resumeProcessing(): void {
    this.paused = false;
    if (!this.stopping) void this.kick().catch(error => log.error({ err: String(error) }, 'inbox resume failed'));
  }

  async kick(): Promise<void> {
    if (this.stopping || this.paused) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    const active = new Map<string, Promise<void>>();
    let failure: unknown;
    try {
      while (!this.stopping && !this.paused && !failure) {
        while (active.size < this.concurrency && !this.stopping && !this.paused && !failure) {
          const blocked = [...active.keys()];
          const row = await this.prisma.inboundUpdate.findFirst({
            where: { status: InboxStatus.PENDING, nextAttemptAt: { lte: new Date() },
              partitionKey: { notIn: blocked } },
            orderBy: { sequence: 'asc' },
            select: { id: true, partitionKey: true },
          });
          if (!row && blocked.length && !active.size) continue;
          if (!row || this.stopping || this.paused) break;
          const task = this.processById(row.id)
            .catch(error => { failure = error; })
            .finally(() => { active.delete(row.partitionKey); });
          active.set(row.partitionKey, task);
        }
        if (!active.size) break;
        await Promise.race(active.values());
      }
    } finally {
      await Promise.all(active.values());
    }
    if (failure) throw failure;
  }

  private async processById(id: string): Promise<void> {
    if (this.stopping || this.paused) return;
    return this.activity.run(() => this.processClaimed(id));
  }

  private async processClaimed(id: string): Promise<void> {
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

/** One user's messages and callbacks share a lane, even across chats.
 * Unknown updates remain serial. Business transactions still arbitrate
 * different employees changing the same incident. One app process only.
 */
export function updatePartition(update: Update): string {
  const value = update as unknown as {
    callback?: { user?: { user_id?: number } };
    message?: { sender?: { user_id?: number } };
    user?: { user_id?: number };
  };
  const id = value.callback?.user?.user_id ?? value.message?.sender?.user_id ?? value.user?.user_id;
  return typeof id === 'number' && Number.isSafeInteger(id) ? `user:${id}` : 'legacy';
}
