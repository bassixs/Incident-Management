import { randomUUID } from 'node:crypto';

import {
  DeliveryTrackingType,
  OutboxStatus,
  Prisma,
  type OutboundMessage,
  type PrismaClient,
} from '@prisma/client';
import type { AttachmentRequest, Button, Message } from './max-types';

import { HistoryAction } from '../incidents/incident-history.service';
import type { MediaStorage } from '../media/media-storage.interface';
import { isUniqueViolation } from '../database/prisma';
import { moduleLogger } from '../utils/logger';
import { MaxClient } from './max-client';
import { queueDeliveryStatus, reviewDeliveryNotice } from '../delivery/delivery-status';
import { INCIDENT_INCLUDE } from '../incidents/incident.repository';
import { distributionWorkedNotice } from '../bot/views/cards';

const log = moduleLogger('max-message');

/** Conservative MAX text ceiling; long cards are split rather than truncated. */
const MAX_TEXT_LENGTH = 3800;
/** Attachments of one kind per outgoing message. */
const ATTACHMENTS_PER_MESSAGE = 4;

export type OutboundAttachment = {
  type: 'IMAGE' | 'FILE';
  body: Buffer;
  originalName?: string | null;
};

export type SendTarget = { chatId: bigint } | { userId: bigint };

export type CompositeMessage = {
  text: string;
  operation?: { type: 'delivery-card'; incidentId: string; answerId: string; card: 'review' | 'distribution' };
  /** Prefix repeated on every follow-up part, e.g. `№ INC-20260823-0001`. */
  label?: string;
  keyboard?: Button[][];
  attachments?: OutboundAttachment[];
  disableLinkPreview?: boolean;
  delivery?: {
    dedupeKey?: string | undefined;
    tracking?:
      | { type: 'DISTRIBUTION_CARD' | 'SECTOR_CARD'; incidentId: string }
      | { type: 'REVIEW_CARD'; incidentId: string; answerId: string }
      | { type: 'ANSWER_TO_REQUESTER'; incidentId: string; answerId: string };
  };
};

export type MessageSendResult = {
  firstMessageId?: string | undefined;
  state: 'sent' | 'queued';
  trackingApplied: boolean;
};

type DurableMessageDependencies = { prisma: PrismaClient; storage: MediaStorage };

type StoredPayload = {
  text: string;
  operation?: CompositeMessage['operation'];
  label?: string | undefined;
  keyboard?: Button[][] | undefined;
  disableLinkPreview?: boolean | undefined;
};

type StagedAttachment = {
  type: 'IMAGE' | 'FILE';
  storageKey: string;
  originalName?: string | null | undefined;
  /** false for original incident/answer files, which the outbox must never delete. */
  owned?: boolean;
};

const OUTBOX_INTERVAL_MS = 5_000;
const OUTBOX_LEASE_MS = 120_000;
const OUTBOX_MAX_ATTEMPTS = 12;

/**
 * Delivers a logical message that may not fit into a single MAX message.
 *
 * MAX will not accept arbitrary mixes of attachments in one message, and long
 * text has a hard ceiling, so we split. Every part after the first repeats the
 * incident label so an operator scrolling a busy chat can still see which
 * incident the fragment belongs to.
 */
export class MaxMessageService {
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;

  constructor(
    private readonly max: MaxClient,
    private readonly durable?: DurableMessageDependencies,
  ) {}

  /**
   * Deliver text, media and buttons as ONE MAX message wherever possible.
   *
   * MAX accepts an image and an inline keyboard side by side in a single
   * message, and an edit that omits `attachments` leaves both untouched — so
   * a card can carry its photo and still be updated later. Extra messages are
   * only produced when the text overflows or when attachments of a second
   * kind have to travel (MAX groups media by type).
   */
  async send(target: SendTarget, message: CompositeMessage): Promise<MessageSendResult> {
    if (!this.durable) {
      const { firstMessageId } = await this.deliverLogical(target, message);
      return { firstMessageId, state: 'sent', trackingApplied: false };
    }

    const row = await this.enqueue(target, message);
    if (row.status === OutboxStatus.SENT) {
      return {
        firstMessageId: row.firstMessageId ?? undefined,
        state: 'sent',
        trackingApplied: row.trackingApplied,
      };
    }
    return this.attempt(row.id);
  }

  private async deliverLogical(
    target: SendTarget,
    message: Omit<CompositeMessage, 'delivery'>,
    strictAttachments = false,
  ): Promise<{ firstMessageId?: string }> {
    const parts = splitText(message.text, message.label);
    const keyboardAttachment: AttachmentRequest | undefined = message.keyboard?.length
      ? { type: 'inline_keyboard', payload: { buttons: message.keyboard } }
      : undefined;

    const groups = groupAttachments(message.attachments ?? []);
    const [inlineGroup, ...trailingGroups] = groups;
    const inlineAttachments = inlineGroup ? await this.upload(inlineGroup, strictAttachments) : [];

    let firstMessageId: string | undefined;

    for (let index = 0; index < parts.length; index += 1) {
      const isLast = index === parts.length - 1;
      // Media and buttons ride along with the final chunk of text.
      const attachments = isLast
        ? [...inlineAttachments, ...(keyboardAttachment ? [keyboardAttachment] : [])]
        : [];
      const sent = await this.deliver(
        target,
        parts[index]!,
        attachments.length ? attachments : undefined,
        message.disableLinkPreview,
      );
      firstMessageId ??= sent?.body?.mid;
    }

    // Anything that could not share the first message (a file next to photos,
    // or more media than one message may carry) follows, labelled so the
    // fragment stays traceable to its incident.
    for (const group of trailingGroups) {
      const uploaded = await this.upload(group, strictAttachments);
      if (uploaded.length === 0) continue;
      await this.deliver(target, message.label ?? '', uploaded, true);
    }

    return { firstMessageId: firstMessageId ?? undefined };
  }

  /** Start the persistent outbox worker. Immediate delivery still happens in send(). */
  start(): void {
    if (!this.durable || this.timer) return;
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    void this.durable.prisma.outboundMessage
      .deleteMany({ where: { status: OutboxStatus.SENT, sentAt: { lt: cutoff } } })
      .catch((error) =>
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'outbox cleanup failed'),
      );
    this.timer = setInterval(() => void this.kick(), OUTBOX_INTERVAL_MS);
    this.timer.unref?.();
    void this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    await this.kick();
  }

  private async enqueue(target: SendTarget, message: CompositeMessage): Promise<OutboundMessage> {
    const durable = this.durable!;
    if (message.delivery?.dedupeKey) {
      const existing = await durable.prisma.outboundMessage.findUnique({ where: { dedupeKey: message.delivery.dedupeKey } });
      if (existing) return existing;
    }
    const id = randomUUID();
    const staged: StagedAttachment[] = [];

    try {
      for (const [index, attachment] of (message.attachments ?? []).entries()) {
        const storageKey = `outbox/${id}/${index}`;
        await durable.storage.save({ key: storageKey, body: attachment.body });
        staged.push({ type: attachment.type, storageKey, originalName: attachment.originalName });
      }

      const payload: StoredPayload = {
        text: message.text,
        ...(message.operation ? { operation: message.operation } : {}),
        ...(message.label === undefined ? {} : { label: message.label }),
        ...(message.keyboard === undefined ? {} : { keyboard: message.keyboard }),
        ...(message.disableLinkPreview === undefined
          ? {}
          : { disableLinkPreview: message.disableLinkPreview }),
      };
      const tracking = message.delivery?.tracking;

      try {
        return await durable.prisma.outboundMessage.create({
          data: {
            id,
            dedupeKey: message.delivery?.dedupeKey ?? null,
            targetType: 'chatId' in target ? 'chat' : 'user',
            targetId: 'chatId' in target ? target.chatId : target.userId,
            payload: payload as unknown as Prisma.InputJsonValue,
            attachments: staged as unknown as Prisma.InputJsonValue,
            trackingType: tracking ? DeliveryTrackingType[tracking.type] : null,
            incidentId: tracking?.incidentId ?? null,
            answerId: tracking && 'answerId' in tracking ? tracking.answerId : null,
            trackingApplied: tracking === undefined,
          },
        });
      } catch (error) {
        if (!message.delivery?.dedupeKey || !isUniqueViolation(error)) throw error;
        const existing = await durable.prisma.outboundMessage.findUnique({
          where: { dedupeKey: message.delivery.dedupeKey },
        });
        if (!existing) throw error;
        await this.cleanupAttachments(staged);
        return existing;
      }
    } catch (error) {
      await this.cleanupAttachments(staged);
      throw error;
    }
  }

  private async attempt(id: string): Promise<MessageSendResult> {
    const durable = this.durable!;
    const now = new Date();
    const stale = new Date(now.getTime() - OUTBOX_LEASE_MS);
    const claimed = await durable.prisma.outboundMessage.updateMany({
      where: {
        id,
        OR: [
          { status: OutboxStatus.PENDING, nextAttemptAt: { lte: now } },
          { status: OutboxStatus.SENDING, lockedAt: { lte: stale } },
        ],
      },
      data: { status: OutboxStatus.SENDING, lockedAt: now, attempts: { increment: 1 } },
    });

    if (claimed.count !== 1) {
      const existing = await durable.prisma.outboundMessage.findUnique({ where: { id } });
      return {
        firstMessageId: existing?.firstMessageId ?? undefined,
        state: existing?.status === OutboxStatus.SENT ? 'sent' : 'queued',
        trackingApplied: existing?.trackingApplied ?? false,
      };
    }

    const row = await durable.prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
    const payload = row.payload as unknown as StoredPayload;
    const staged = row.attachments as unknown as StagedAttachment[];

    try {
      const attachments: OutboundAttachment[] = [];
      for (const attachment of staged) {
        attachments.push({
          type: attachment.type,
          body: await durable.storage.load(attachment.storageKey),
          originalName: attachment.originalName,
        });
      }
      const target: SendTarget =
        row.targetType === 'chat' ? { chatId: row.targetId } : { userId: row.targetId };
      const result = payload.operation
        ? await this.refreshDeliveryCard(payload.operation)
        : await this.deliverLogical(target, { ...payload, attachments }, true);
      await this.complete(row, result.firstMessageId);
      await this.cleanupAttachments(staged);
      return { firstMessageId: result.firstMessageId, state: 'sent', trackingApplied: true };
    } catch (error) {
      const terminal = row.attempts >= OUTBOX_MAX_ATTEMPTS;
      const detail = error instanceof Error ? error.message : String(error);
      await durable.prisma.outboundMessage.update({
        where: { id: row.id },
        data: {
          status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          lockedAt: null,
          lastError: detail.slice(0, 4_000),
          nextAttemptAt: new Date(Date.now() + retryDelayMs(row.attempts)),
        },
      });
      log[terminal ? 'error' : 'warn'](
        { outboxId: row.id, attempts: row.attempts, terminal, err: detail },
        terminal ? 'outbound MAX message requires manual attention' : 'outbound MAX message queued for retry',
      );
      return { state: 'queued', trackingApplied: false };
    }
  }

  private async complete(row: OutboundMessage, firstMessageId: string | undefined): Promise<void> {
    const prisma = this.durable!.prisma;
    await prisma.$transaction(async (tx) => {
      const marked = await tx.outboundMessage.updateMany({
        where: { id: row.id, status: OutboxStatus.SENDING },
        data: {
          status: OutboxStatus.SENT,
          sentAt: new Date(),
          lockedAt: null,
          lastError: null,
          firstMessageId: firstMessageId ?? null,
          trackingApplied: true,
        },
      });
      if (marked.count !== 1 || !row.trackingType) return;

      if (row.trackingType === DeliveryTrackingType.ANSWER_TO_REQUESTER && row.answerId && row.incidentId) {
        const deliveredAt = new Date();
        const answer = await tx.incidentAnswer.updateMany({
          where: { id: row.answerId, incidentId: row.incidentId, deliveredAt: null },
          data: { deliveredAt },
        });
        if (answer.count === 1) {
          await tx.incidentHistory.create({
            data: {
              incidentId: row.incidentId,
              action: HistoryAction.ANSWER_SENT,
              metadata: {
                answerId: row.answerId,
                recipientMaxUserId: row.targetId.toString(),
                outboxId: row.id,
              },
            },
          });
        }
        await queueDeliveryStatus(tx, row.incidentId, row.answerId, true);
        return;
      }

      if (!row.incidentId || !firstMessageId) return;
      const field =
        row.trackingType === DeliveryTrackingType.DISTRIBUTION_CARD
          ? 'distributionMessageId'
          : row.trackingType === DeliveryTrackingType.SECTOR_CARD
            ? 'sectorMessageId'
            : 'reviewMessageId';
      const updated = await tx.incident.updateMany({
        where: { id: row.incidentId, [field]: null },
        data: { [field]: firstMessageId },
      });
      if (updated.count !== 1) return;
      if (row.trackingType === DeliveryTrackingType.DISTRIBUTION_CARD) {
        await tx.incidentHistory.create({
          data: {
            incidentId: row.incidentId,
            action: HistoryAction.DISTRIBUTION_CARD_SENT,
            metadata: { messageId: firstMessageId, outboxId: row.id },
          },
        });
      } else if (row.trackingType === DeliveryTrackingType.SECTOR_CARD) {
        await tx.incidentHistory.create({
          data: {
            incidentId: row.incidentId,
            action: HistoryAction.SECTOR_CARD_SENT,
            metadata: { messageId: firstMessageId, outboxId: row.id },
          },
        });
      }
    });
  }

  private async cleanupAttachments(attachments: StagedAttachment[]): Promise<void> {
    if (!this.durable) return;
    await Promise.all(
      attachments.filter(item => item.owned !== false).map((item) => this.durable!.storage.remove(item.storageKey).catch(() => undefined)),
    );
  }

  private async refreshDeliveryCard(operation: NonNullable<CompositeMessage['operation']>): Promise<{ firstMessageId?: string }> {
    const incident = await this.durable!.prisma.incident.findUnique({ where: { id: operation.incidentId }, include: INCIDENT_INCLUDE });
    const answer = incident?.answers.find(a => a.id === operation.answerId);
    if (!incident || !answer) return {};
    if (operation.card === 'distribution') {
      if (answer.deliveredAt && incident.distributionMessageId && incident.assignedGroup) {
        await this.max.editMessage(incident.distributionMessageId, distributionWorkedNotice(incident, incident.assignedGroup), []);
      }
    } else if (incident.reviewMessageId) {
      await this.max.editMessage(incident.reviewMessageId, reviewDeliveryNotice(incident, answer), []);
    }
    return {};
  }

  private async kick(): Promise<void> {
    if (!this.durable) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    const prisma = this.durable!.prisma;
    for (let processed = 0; processed < 50; processed += 1) {
      const now = new Date();
      const stale = new Date(now.getTime() - OUTBOX_LEASE_MS);
      const candidate = await prisma.outboundMessage.findFirst({
        where: {
          OR: [
            { status: OutboxStatus.PENDING, nextAttemptAt: { lte: now } },
            { status: OutboxStatus.SENDING, lockedAt: { lte: stale } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!candidate) break;
      await this.attempt(candidate.id);
    }
  }

  /**
   * Rewrite a card's text while leaving its photo and buttons in place.
   * Used when a card gains a detail but stays actionable (§22 "В работе").
   */
  async editCardText(messageId: string, text: string): Promise<boolean> {
    return this.edit(messageId, text, undefined);
  }

  /**
   * Replace a card with a closing notice: text only, no media, no buttons.
   * Used once an incident leaves a chat's responsibility (§58), so a stale
   * button cannot be pressed again.
   */
  async finalizeCard(messageId: string, text: string): Promise<boolean> {
    return this.edit(messageId, text, []);
  }

  /** Remove a temporary picker after its choice has been applied. */
  async deleteCard(messageId: string): Promise<boolean> {
    try {
      await this.max.deleteMessage(messageId);
      return true;
    } catch (error) {
      log.warn(
        { messageId, err: error instanceof Error ? error.message : String(error) },
        'failed to delete MAX card',
      );
      return false;
    }
  }

  /**
   * Swap the buttons on a message, e.g. paging the сфера picker.
   * The attachment list is replaced, so any media on that message is dropped —
   * only use this on messages that carry buttons alone.
   */
  async editCardKeyboard(messageId: string, text: string, keyboard: Button[][]): Promise<boolean> {
    return this.edit(messageId, text, [{ type: 'inline_keyboard', payload: { buttons: keyboard } }]);
  }

  /** Editing is best-effort: a refused edit must never abort the action. */
  private async edit(
    messageId: string,
    text: string,
    attachments: AttachmentRequest[] | undefined,
  ): Promise<boolean> {
    try {
      await this.max.editMessage(messageId, text, attachments);
      return true;
    } catch (error) {
      log.warn(
        { messageId, err: error instanceof Error ? error.message : String(error) },
        'failed to edit MAX card',
      );
      return false;
    }
  }

  private async deliver(
    target: SendTarget,
    text: string,
    attachments?: AttachmentRequest[],
    disableLinkPreview?: boolean,
  ): Promise<Message | undefined> {
    const extra = {
      ...(attachments?.length ? { attachments } : {}),
      ...(disableLinkPreview ? { disable_link_preview: true } : {}),
    };
    try {
      return 'chatId' in target
        ? await this.max.sendToChat(target.chatId, text, extra)
        : await this.max.sendToUser(target.userId, text, extra);
    } catch (error) {
      log.error(
        {
          target: 'chatId' in target ? target.chatId.toString() : target.userId.toString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'failed to deliver MAX message',
      );
      throw error;
    }
  }

  private async upload(group: OutboundAttachment[], strict = false): Promise<AttachmentRequest[]> {
    const uploaded: AttachmentRequest[] = [];
    for (const item of group) {
      try {
        uploaded.push(
          item.type === 'IMAGE'
            ? await this.max.uploadImage(item.body)
            : await this.max.uploadFile(item.body, item.originalName),
        );
      } catch (error) {
        if (strict) throw error;
        // A failed attachment must never swallow the answer text that was
        // already delivered; log and continue with what we have.
        log.error(
          { name: item.originalName, err: error instanceof Error ? error.message : String(error) },
          'attachment upload failed, skipping',
        );
      }
    }
    return uploaded;
  }
}

export function splitText(text: string, label?: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= MAX_TEXT_LENGTH) return [text];

  const prefix = label ? `${label}\n\n` : '';
  const prefixLength = Array.from(prefix).length;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < characters.length) {
    const budget = chunks.length === 0 ? MAX_TEXT_LENGTH : MAX_TEXT_LENGTH - prefixLength;
    const slice = characters.slice(cursor, cursor + budget).join('');
    chunks.push(chunks.length === 0 ? slice : `${prefix}${slice}`);
    cursor += budget;
  }
  return chunks;
}

function retryDelayMs(attempt: number): number {
  const schedule = [30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
  return schedule[Math.min(Math.max(attempt - 1, 0), schedule.length - 1)]!;
}

export function groupAttachments(attachments: OutboundAttachment[]): OutboundAttachment[][] {
  const groups: OutboundAttachment[][] = [];
  for (const type of ['IMAGE', 'FILE'] as const) {
    const ofType = attachments.filter((item) => item.type === type);
    for (let index = 0; index < ofType.length; index += ATTACHMENTS_PER_MESSAGE) {
      groups.push(ofType.slice(index, index + ATTACHMENTS_PER_MESSAGE));
    }
  }
  return groups;
}
