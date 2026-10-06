import { randomUUID } from 'node:crypto';
import { latency, withDeliveryTrace } from '../utils/latency';
import { AsyncActivity } from '../utils/async-activity';
import { minimiseInbound } from '../privacy/inbound-privacy';
import { getConfig } from '../config';
import { InboxStatus, Prisma, type PrismaClient } from '@prisma/client';

import { isUniqueViolation } from '../database/prisma';
import type { MaxClient } from '../max/max-client';
import type { Update } from '../max/max-types';
import { buildUpdateKey } from '../max/update-key';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('dispatcher');
const INBOX_INTERVAL_MS = 250;
const CONTACT_FAILURE = 'Не удалось обработать номер; данные события очищены. Проверьте текущую карточку и при необходимости введите номер снова.';

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
  // Failed state writes are retried by the existing sweep, never by replaying business work.
  private readonly settlements = new Map<string, { lockedAt: Date; token: string; beforeDispatch: boolean; contact: boolean; detail: string }>();
  private readonly reservations = new Map<string, Promise<Reservation>>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly max: MaxClient,
    private readonly concurrency = getConfig().INBOX_CONCURRENCY,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Inbox concurrency must be between 1 and 32');
  }

  async reserve(update: Update): Promise<Reservation> {
    const receivedAt = new Date();
    const key = updatePartition(update);
    const previous = this.reservations.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.reserveNow(update, receivedAt));
    this.reservations.set(key, operation);
    try { return await operation; }
    finally { if (this.reservations.get(key) === operation) this.reservations.delete(key); }
  }

  private async reserveNow(update: Update, receivedAt: Date): Promise<Reservation> {
    if (this.stopping) throw new Error('Dispatcher is shutting down; retry update later');
    const key = buildUpdateKey(update);
    const legacy = await this.prisma.processedUpdate.findUnique({
      where: { externalUpdateKey: key },
      select: { id: true },
    });
    if (legacy) return { key, fresh: false };

    const minimalUpdate = await minimiseInbound(update, this.prisma);

    try {
      const row = await this.prisma.inboundUpdate.create({
        data: {
          receivedAt,
          externalUpdateKey: key,
          updateType: update.update_type,
          partitionKey: updatePartition(update),
          payload: JSON.parse(JSON.stringify(minimalUpdate)) as Prisma.InputJsonValue,
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
    // Scrub interrupted contacts and failures left by older versions before
    // resuming work. Pending contacts must remain available for processing.
    await this.prisma.inboundUpdate.updateMany({
      where: {
        status: { in: [InboxStatus.PROCESSING, InboxStatus.FAILED] },
        OR: [{ payload: { path: ['verifiedDraftContact'], not: Prisma.AnyNull } },
          { payload: { path: ['draftPhoneInput'], not: Prisma.AnyNull } }],
      },
      data: {
        status: InboxStatus.FAILED,
        payload: {},
        lastError: CONTACT_FAILURE,
        lockedAt: null,
        processingToken: null,
      },
    });
    const interrupted = await this.prisma.inboundUpdate.updateMany({
      where: { status: InboxStatus.PROCESSING },
      data: {
        status: InboxStatus.FAILED,
        lastError: 'Обработка была прервана перезапуском; требуется безопасная ручная проверка.',
        lockedAt: null,
        processingToken: null,
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
    await this.settleFailures();
    const active = new Map<string, Promise<void>>();
    let failure: unknown;
    try {
      while (!this.stopping && !this.paused && !failure) {
        while (active.size < this.concurrency && !this.stopping && !this.paused && !failure) {
          const blocked = [...active.keys()];
          // A future retry or active claim is still the head of its lane.
          const [row] = await this.prisma.$queryRaw<Array<{ id: string; partitionKey: string }>>`
            SELECT i.id, i."partitionKey" FROM "InboundUpdate" i
            WHERE i.status='PENDING' AND i."nextAttemptAt" <= ${new Date()}
              ${blocked.length ? Prisma.sql`AND i."partitionKey" NOT IN (${Prisma.join(blocked)})` : Prisma.empty}
              AND NOT EXISTS (SELECT 1 FROM "InboundUpdate" head
                WHERE head."partitionKey"=i."partitionKey" AND head.sequence < i.sequence
                  AND head.status IN ('PENDING','PROCESSING'))
            ORDER BY i.sequence LIMIT 1`;
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
    const processingStartedAt = Date.now();
    const lockedAt = new Date();
    const token = randomUUID();
    // No claim exists yet: a failed eligibility read stops this sweep,
    // rather than spinning on the same unclaimed row.
    // Direct/long-polling calls must obey the same lane rule as drain.
    const eligible = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT i.id FROM "InboundUpdate" i WHERE i.id=${id}
        AND i.status='PENDING' AND i."nextAttemptAt" <= ${new Date()}
        AND NOT EXISTS (SELECT 1 FROM "InboundUpdate" head
          WHERE head."partitionKey"=i."partitionKey" AND head.sequence < i.sequence
            AND head.status IN ('PENDING','PROCESSING'))`;
    if (!eligible.length) return;
    try {
      const claimed = await this.prisma.inboundUpdate.updateMany({
        where: { id, status: InboxStatus.PENDING, nextAttemptAt: { lte: new Date() } },
        data: { status: InboxStatus.PROCESSING, lockedAt, processingToken: token, attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) return;
    } catch {
      // Even a lost claim ACK cannot imply that business work started. The CAS
      // below touches only the lease written by this attempt, if it exists.
      this.settlements.set(id, { lockedAt, token, beforeDispatch: true, contact: false,
        detail: 'PRE_DISPATCH_CLAIM_UNCERTAIN: бизнес-обработка не начиналась.' });
      await this.settleFailures();
      return;
    }

    let row: Awaited<ReturnType<typeof this.prisma.inboundUpdate.findUniqueOrThrow>> | undefined;
    let businessStarted = false;
    try {
      row = await this.prisma.inboundUpdate.findUniqueOrThrow({ where: { id } });
      if (row.status !== InboxStatus.PROCESSING || row.processingToken !== token || row.lockedAt?.getTime() !== lockedAt.getTime()) return;
      const claimedRow = row;
      // Inbox rows admitted before draft-screen binding was introduced have no
      // reliable destination for private text. Do not reinterpret them against
      // a new resident draft or a newly selected employee workspace after restart.
      const saved = (row.payload ?? {}) as Record<string, any>;
      const unboundPrivateText = saved.update_type === 'message_created' &&
        saved.message?.recipient?.chat_type === 'dialog' &&
        !saved.residentDraftInput && !saved.privateWorkInputId && !saved.draftPhoneInput &&
        !saved.verifiedDraftContact && !saved.contactRejected &&
        !/^\/[a-z_]+(?:\s|$)/i.test(saved.message?.body?.text ?? '');
      const payload = unboundPrivateText
        ? { ...saved, residentDraftInput: { sessionId: '', draftToken: '', screenToken: '' } }
        : saved;
      businessStarted = true;
      await withDeliveryTrace({ inboxId: row.id, receivedAt: row.receivedAt.getTime() }, async () => {
        latency('inbox-start', { waitMs: processingStartedAt - claimedRow.receivedAt.getTime(), attempt: claimedRow.attempts });
        await this.max.dispatch(payload as unknown as Update);
      });
      await this.prisma.inboundUpdate.updateMany({
        where: { id, status: InboxStatus.PROCESSING, lockedAt, processingToken: token },
        data: {
          status: InboxStatus.PROCESSED,
          processedAt: new Date(),
          lockedAt: null,
          processingToken: null,
          lastError: null,
          payload: {},
        },
      });
    } catch (error) {
      const payload = row?.payload as { verifiedDraftContact?: unknown; draftPhoneInput?: unknown } | undefined;
      const contact = !!(payload?.verifiedDraftContact || payload?.draftPhoneInput);
      const detail = !businessStarted ? 'PRE_DISPATCH_READ_FAILED: бизнес-обработка не начиналась.'
        : contact ? CONTACT_FAILURE : error instanceof Error ? error.message : String(error);
      this.settlements.set(id, { lockedAt, token, beforeDispatch: !businessStarted, contact, detail: detail.slice(0, 4_000) });
      await this.settleFailures();
      log.error({ inboxId: id, phase: businessStarted ? 'business-uncertain' : 'before-dispatch' }, 'inbox failure recorded; no blind business replay');
    }
  }

  private async settleFailures(): Promise<void> {
    for (const [id, failure] of this.settlements) {
      const where = { id, status: InboxStatus.PROCESSING, lockedAt: failure.lockedAt, processingToken: failure.token };
      // A confirmed pre-dispatch read failure is safe to retry, bounded and delayed.
      // If this write fails, the next existing sweep retries only this CAS.
      if (failure.beforeDispatch) {
        await this.prisma.inboundUpdate.updateMany({ where: { ...where, attempts: { lt: 3 } },
          data: { status: InboxStatus.PENDING, lockedAt: null, processingToken: null, nextAttemptAt: new Date(Date.now() + 5_000), lastError: failure.detail } });
      }
      if (failure.beforeDispatch) await this.prisma.inboundUpdate.updateMany({
        where: { ...where, attempts: { gte: 3 }, OR: [
          { payload: { path: ['verifiedDraftContact'], not: Prisma.AnyNull } },
          { payload: { path: ['draftPhoneInput'], not: Prisma.AnyNull } },
        ] },
        data: { status: InboxStatus.FAILED, lockedAt: null, processingToken: null, payload: {},
          lastError: failure.detail + ' ' + CONTACT_FAILURE },
      });
      await this.prisma.inboundUpdate.updateMany({ where,
        data: { status: InboxStatus.FAILED, lockedAt: null, processingToken: null, lastError: failure.detail,
          ...(failure.contact ? { payload: {} } : {}) } });
      this.settlements.delete(id);
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
