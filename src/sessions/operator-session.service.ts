import { type OperatorSession, type PrismaClient, SessionType } from '@prisma/client';

import { getConfig } from '../config';
import type { PrismaLike } from '../database/prisma';
import { moduleLogger } from '../utils/logger';
import type { IncomingMedia } from '../media/media.service';

const log = moduleLogger('sessions');

export { SessionType };

export type SessionData = {
  /** Legacy name is never collected. Phone is optional and scoped to this draft only. */
  requesterName?: string;
  requesterPhone?: string;
  draftToken?: string;
  previewToken?: string;
  previewStartedAt?: number;
  /** Start of this manual phone-entry step; rejects older text events. */
  phoneInputStartedAt?: number;
  previewMessageId?: string;
  /** Persisted preview delivery failed/in flight; never submit until shown. */
  previewDeliveryPending?: boolean;
  /** Legacy unconfirmed contact. Never promote it automatically after an upgrade. */
  pendingPhone?: string;
  /** Requester draft: the тема the requester selected, if any. */
  selectedCategoryId?: string | null;
  problemMunicipalityCode?: string;
  problemMunicipalityName?: string;
  problemLocality?: string | null;
  /** Completed requester draft, kept outside Incident until explicit confirmation. */
  draftText?: string;
  draftMedia?: IncomingMedia[];
  /** Failed preview: accepts replacement photos or explicit continuation without them. */
  draftPhotoRetry?: boolean;
  draftEditField?: 'name' | 'phone' | 'category' | 'location' | 'text' | 'photo';
  /** WAITING_BAN_REASON: whom to ban (the incident author). */
  targetMaxUserId?: string;
  /** WAITING_FOR_ANSWER: text pre-filled from a template or an AI draft. */
  prefillText?: string;
  [key: string]: unknown;
};

/**
 * A pending "your next message means X" state.
 *
 * Two properties matter:
 *  * it is scoped by (maxUserId, chatId) — one operator working in three
 *    different sector chats keeps three independent states, and a message in
 *    one chat can never be attached to an incident from another;
 *  * it lives in Postgres, so a redeploy in the middle of someone typing an
 *    answer does not lose the binding to the incident.
 */
export class OperatorSessionService {
  constructor(private readonly prisma: PrismaClient) {}

  private expiry(): Date {
    return new Date(Date.now() + getConfig().SESSION_TTL_MINUTES * 60_000);
  }

  async find(maxUserId: bigint, chatId: bigint, tx?: PrismaLike): Promise<OperatorSession | null> {
    const session = await (tx ?? this.prisma).operatorSession.findUnique({
      where: { maxUserId_chatId: { maxUserId, chatId } },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      // A concurrent fresh draft/extension must not be deleted with the expired session.
      await (tx ?? this.prisma).operatorSession.deleteMany({ where: { id: session.id, expiresAt: session.expiresAt } });
      return null;
    }
    return session;
  }

  async start(input: {
    maxUserId: bigint;
    chatId: bigint;
    type: SessionType;
    incidentId?: string | null;
    data?: SessionData | null;
  }): Promise<OperatorSession> {
    const expiresAt = this.expiry();
    const session = await this.prisma.operatorSession.upsert({
      where: { maxUserId_chatId: { maxUserId: input.maxUserId, chatId: input.chatId } },
      create: {
        maxUserId: input.maxUserId,
        chatId: input.chatId,
        type: input.type,
        incidentId: input.incidentId ?? null,
        data: (input.data ?? undefined) as never,
        expiresAt,
      },
      update: {
        type: input.type,
        incidentId: input.incidentId ?? null,
        data: (input.data ?? undefined) as never,
        expiresAt,
      },
    });
    log.debug(
      { maxUserId: input.maxUserId.toString(), chatId: input.chatId.toString(), type: input.type },
      'operator session started',
    );
    return session;
  }

  async clear(maxUserId: bigint, chatId: bigint, tx?: PrismaLike): Promise<void> {
    await (tx ?? this.prisma).operatorSession.deleteMany({ where: { maxUserId, chatId } });
  }

  /** Compare-and-swap: never recreate a cancelled, submitted or replaced draft. */
  async replaceCurrent(session: OperatorSession, type: SessionType, data: SessionData): Promise<boolean> {
    const changed = await this.prisma.operatorSession.updateMany({
      where: { id: session.id, maxUserId: session.maxUserId, chatId: session.chatId,
        type: session.type, expiresAt: { gt: new Date() }, data: { equals: session.data! } },
      data: { type, data: data as never },
    });
    return changed.count === 1;
  }

  async clearCurrent(session: OperatorSession): Promise<boolean> {
    const removed = await this.prisma.operatorSession.deleteMany({ where: {
      id: session.id, maxUserId: session.maxUserId, chatId: session.chatId,
      type: session.type, expiresAt: { gt: new Date() }, data: { equals: session.data! },
    } });
    return removed.count === 1;
  }

  async extend(sessionId: string): Promise<void> {
    await this.prisma.operatorSession.update({
      where: { id: sessionId },
      data: { expiresAt: this.expiry() },
    });
  }

  async purgeExpired(): Promise<number> {
    const result = await this.prisma.operatorSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  readData(session: OperatorSession): SessionData {
    return (session.data ?? {}) as SessionData;
  }
}
