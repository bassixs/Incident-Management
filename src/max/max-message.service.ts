import { leaseView, leaseText, SECTOR_LEASE_ACTION } from '../work-queues/leases';
import { AsyncActivity } from '../utils/async-activity';
import { workingHours } from '../utils/work-calendar';
import { isPhotoReference, photoReference, photoToken, isUnavailablePhoto } from '../media/max-photo-reference';
import { ValidationError } from '../utils/errors';
import { getConfig } from '../config';
import { distributionAlertsAllowed, panelSettingKey, queueKeyboard, queuePanelText, queueSnapshot } from '../distribution/queue-state';
import { randomUUID } from 'node:crypto';
import { MaxError } from '@maxhub/max-bot-api';

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
import { distributionCard, distributionResolvedNotice, distributionStatus, sectorCard } from '../bot/views/cards';
import { distributionKeyboard } from '../bot/keyboards';
import { queueDistributionRefresh, queueSectorRefresh, queueStaffRefresh } from '../delivery/workflow-outbox';
import { workPanelKey, workPanelText, workButtons } from '../work-queues/state';
import { reviewCard } from '../bot/views/cards';
import { reviewKeyboard, revisionKeyboard } from '../bot/keyboards';
import { sectorKeyboard } from '../bot/keyboards';
import { slaNotification, slaStage, type SlaStage } from '../sla/sla-notification';
import { incidentCallback } from './callback-payload';

const log = moduleLogger('max-message');

/** Conservative MAX text ceiling; long cards are split rather than truncated. */
const MAX_TEXT_LENGTH = 3800;
/** Attachments of one kind per outgoing message. */
const ATTACHMENTS_PER_MESSAGE = 4;

export type OutboundAttachment = {
  type: 'IMAGE' | 'FILE';
  originalName?: string | null;
} & ({ body: Buffer; maxToken?: never } | { type: 'IMAGE'; maxToken: string; body?: never });

export type SendTarget = { chatId: bigint } | { userId: bigint };

export type CompositeMessage = {
  text: string;
  /** Draft previews must either reach MAX or let the user replace the photos. */
  immediatePreview?: boolean;
  operation?: { type: 'delivery-card'; incidentId: string; answerId: string; card: 'review' | 'distribution' }
    | { type: 'superseded-answer' }
    | { type: 'sla-reminder'; incidentId: string; stage: SlaStage }
    | { type: 'clarification-question' | 'clarification-reply'; incidentId: string; clarificationId: string }
    | { type: 'sector-refresh'; incidentId: string; textOnly?: boolean }
    | { type: 'distribution-panel' }
    | { type: 'work-panel' }
    | { type: 'staff-refresh'; incidentId: string }
    | { type: 'distribution-refresh'; incidentId: string; refreshActive?: boolean }
    | { type: 'distribution-alert'; level: 'normal' | 'escalation'; hour: number };
  replyToMessageId?: string;
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
  keyboardMessageId?: string;
  operation?: CompositeMessage['operation'];
  replyToMessageId?: string;
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
type OutboxTarget = Pick<OutboundMessage, 'targetType' | 'targetId'>;
const targetKey = (target: OutboxTarget): string => `${target.targetType}:${target.targetId}`;

/**
 * Delivers a logical message that may not fit into a single MAX message.
 *
 * MAX will not accept arbitrary mixes of attachments in one message, and long
 * text has a hard ceiling, so we split. Every part after the first repeats the
 * incident label so an operator scrolling a busy chat can still see which
 * incident the fragment belongs to.
 */
export class MaxMessageService {
  private stopping = false;
  private readonly activity = new AsyncActivity();
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;
  // Shared by immediate sends and background retries, including long messages.
  private readonly activeTargets = new Map<string, { target: OutboxTarget; done: Promise<unknown> }>();

  constructor(
    private readonly max: MaxClient,
    private readonly durable?: DurableMessageDependencies,
    private readonly concurrency = getConfig().OUTBOX_CONCURRENCY,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Outbox concurrency must be between 1 and 32');
  }

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
    return this.activity.run(() => this.sendNow(target, message));
  }

  private async sendNow(target: SendTarget, message: CompositeMessage): Promise<MessageSendResult> {
    if (!this.durable || message.immediatePreview) {
      const destination = 'chatId' in target ? { targetType: 'chat', targetId: target.chatId } : { targetType: 'user', targetId: target.userId };
      const key = targetKey(destination);
      while (this.activeTargets.has(key)) await this.activeTargets.get(key)!.done.catch(() => undefined);
      return this.withTarget(destination, async () => {
        const { firstMessageId } = await this.deliverLogical(target, message);
        return { firstMessageId, state: 'sent' as const, trackingApplied: false };
      });
    }

    const row = await this.enqueue(target, message);
    if (row.status === OutboxStatus.SENT) {
      return {
        firstMessageId: row.firstMessageId ?? undefined,
        state: 'sent',
        trackingApplied: row.trackingApplied,
      };
    }
    if (this.stopping) return { state: 'queued', trackingApplied: false };
    return this.attemptInOrder(row);
  }

  private async withTarget<T>(target: OutboxTarget, work: () => Promise<T>): Promise<T> {
    const key = targetKey(target);
    const done = this.activity.run(work);
    this.activeTargets.set(key, { target, done });
    try { return await done; }
    finally { if (this.activeTargets.get(key)?.done === done) this.activeTargets.delete(key); }
  }

  /** Deferred business reminders do not block a chat; an actual failed send does. */
  private async attemptInOrder(row: OutboundMessage): Promise<MessageSendResult> {
    if (this.stopping || this.activeTargets.has(targetKey(row))) return { state: 'queued', trackingApplied: false };
    return this.withTarget(row, async () => {
      const predecessor = await this.durable!.prisma.outboundMessage.findFirst({
        where: {
          targetType: row.targetType, targetId: row.targetId, id: { not: row.id },
          OR: [
            { status: 'SENDING', OR: [{ sequence: { lt: row.sequence } }, { lockedAt: { gt: new Date(Date.now() - OUTBOX_LEASE_MS) } }] },
            { status: 'PENDING', sequence: { lt: row.sequence }, OR: [{ nextAttemptAt: { lte: new Date() } }, { attempts: { gt: 0 } }] },
          ],
        }, select: { id: true },
      });
      if (predecessor) return { state: 'queued', trackingApplied: false };
      if (this.stopping) return { state: 'queued', trackingApplied: false };
      return this.attempt(row.id);
    });
  }

  private async deliverLogical(
    target: SendTarget,
    message: Omit<CompositeMessage, 'delivery'>,
    strictAttachments = true,
  ): Promise<{ firstMessageId?: string; keyboardMessageId?: string }> {
    const parts = splitText(message.text, message.label);
    const keyboardAttachment: AttachmentRequest | undefined = message.keyboard?.length
      ? { type: 'inline_keyboard', payload: { buttons: message.keyboard } }
      : undefined;

    const groups = groupAttachments(message.attachments ?? []);
    const [inlineGroup, ...trailingGroups] = groups;
    const inlineAttachments = inlineGroup ? await this.upload(inlineGroup, strictAttachments) : [];

    let firstMessageId: string | undefined;
    let keyboardMessageId: string | undefined;

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
        index === 0 ? message.replyToMessageId : undefined,
      );
      firstMessageId ??= sent?.body?.mid;
      if (isLast && keyboardAttachment) keyboardMessageId = sent?.body?.mid;
    }

    // Anything that could not share the first message (a file next to photos,
    // or more media than one message may carry) follows, labelled so the
    // fragment stays traceable to its incident.
    for (const group of trailingGroups) {
      const uploaded = await this.upload(group, strictAttachments);
      if (uploaded.length === 0) continue;
      await this.deliver(target, message.label ?? '', uploaded, true);
    }

    return { firstMessageId: firstMessageId ?? undefined, ...(keyboardMessageId ? { keyboardMessageId } : {}) };
  }

  /** Start the persistent outbox worker. Immediate delivery still happens in send(). */
  start(): void {
    if (!this.durable || this.timer) return;
    this.stopping = false;
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    void this.activity.run(() => this.durable!.prisma.outboundMessage
      .deleteMany({ where: { status: OutboxStatus.SENT, sentAt: { lt: cutoff } } }))
      .catch((error) =>
        log.warn({ err: error instanceof Error ? error.message : String(error) }, 'outbox cleanup failed'),
      );
    this.timer = setInterval(() => void this.kick().catch(error => log.error({ err: String(error) }, 'outbox sweep failed')), OUTBOX_INTERVAL_MS);
    this.timer.unref?.();
    void this.kick().catch(error => log.error({ err: String(error) }, 'outbox startup failed'));
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
        if (attachment.maxToken !== undefined) {
          staged.push({ type: 'IMAGE', storageKey: photoReference(attachment.maxToken), originalName: attachment.originalName, owned: false });
          continue;
        }
        // Newly generated photo buffers also go to MAX, never to the disk outbox.
        if (attachment.type === 'IMAGE') {
          const uploaded = await this.max.uploadImage(attachment.body);
          if (uploaded.type !== 'image') throw new Error('MAX returned a non-image upload');
          const payload = uploaded.payload as { token?: string; photos?: Record<string, { token: string }> };
          const token = payload.token ?? Object.values(payload.photos ?? {})[0]?.token;
          if (!token) throw new ValidationError('MAX не вернул идентификатор фотографии. Отправьте её заново.');
          staged.push({ type: 'IMAGE', storageKey: photoReference(token), originalName: attachment.originalName, owned: false });
          continue;
        }
        const storageKey = `outbox/${id}/${index}`;
        await durable.storage.save({ key: storageKey, body: attachment.body });
        staged.push({ type: attachment.type, storageKey, originalName: attachment.originalName });
      }

      const payload: StoredPayload = {
        text: message.text,
        ...(message.operation ? { operation: message.operation } : {}),
        ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
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
    // Retired questions from older releases must never reach a resident.
    if (payload.operation?.type === 'clarification-question' || row.dedupeKey?.startsWith('clarification-preview:')) {
      await durable.prisma.outboundMessage.delete({ where: { id: row.id } });
      return { state: 'sent', trackingApplied: false };
    }
    if (row.trackingType === 'SECTOR_CARD' && row.incidentId) {
      const current = await durable.prisma.incident.findUnique({ where: { id: row.incidentId }, include: INCIDENT_INCLUDE });
      const expected = current && `sector-card:${current.id}${current.history?.[0] ? ':return:' + current.history[0].id : ''}`;
      if (!current?.assignedGroup || current.assignedGroup.maxChatId !== row.targetId || row.dedupeKey !== expected) {
        await durable.prisma.outboundMessage.update({ where: { id }, data: { status: 'SENT', trackingApplied: true, lockedAt: null } });
        return { state: 'sent', trackingApplied: true };
      }
    }
    if (payload.keyboard) payload.keyboard = payload.keyboard.map(buttons => buttons.filter(button =>
      button.type !== 'callback' || !/:clarify(?:-|:)/.test(button.payload))).filter(buttons => buttons.length);

    if (payload.operation?.type === 'superseded-answer') {
      await durable.prisma.outboundMessage.update({ where: { id }, data: { status: OutboxStatus.FAILED, lockedAt: null,
        lastError: 'Ответ возвращён на доработку. Отправка старой версии запрещена.' } });
      return { state: 'queued', trackingApplied: false };
    }

    try {
      if (payload.operation?.type === 'sla-reminder') {
        if (!workingHours(new Date())) {
          // Re-arm the stage for the next working sweep. Holding this job until
          // morning would block unrelated cards/answers in the same chat.
          const operation = payload.operation;
          const field = operation.stage === 24 ? 'slaReminder24SentAt' : operation.stage === 48 ? 'slaWarn24SentAt' : 'overdueNotifiedAt';
          await durable.prisma.$transaction(async tx => {
            await tx.incident.updateMany({ where: { id: operation.incidentId }, data: { [field]: null } });
            await tx.outboundMessage.delete({ where: { id: row.id } });
          });
          return { state: 'sent', trackingApplied: false };
        }
        const incident = await durable.prisma.incident.findUnique({ where: { id: payload.operation.incidentId }, select: { slaPausedAt: true } });
        if (incident?.slaPausedAt) {
          await durable.prisma.outboundMessage.update({ where: { id: row.id }, data: {
            status: OutboxStatus.PENDING, lockedAt: null, attempts: { decrement: 1 }, nextAttemptAt: new Date(Date.now() + 60_000),
          } });
          return { state: 'queued', trackingApplied: false };
        }
      }
      // Includes invitations queued by older releases: never deliver before a rating.
      if (row.dedupeKey?.startsWith('subscription-invite:') && row.incidentId) {
        const incident = await durable.prisma.incident.findUnique({
          where: { id: row.incidentId }, select: { responseRating: true },
        });
        if (incident?.responseRating == null) {
          await durable.prisma.outboundMessage.update({ where: { id: row.id }, data: {
            status: OutboxStatus.PENDING, lockedAt: null, attempts: { decrement: 1 },
            nextAttemptAt: new Date(Date.now() + OUTBOX_INTERVAL_MS),
          } });
          return { state: 'queued', trackingApplied: false };
        }
      }
      const attachments: OutboundAttachment[] = [];
      for (const attachment of staged) {
        const token = photoToken(attachment.storageKey);
        if (token) {
          attachments.push({ type: 'IMAGE', maxToken: token, originalName: attachment.originalName });
          continue;
        }
        attachments.push({
          type: attachment.type,
          body: await durable.storage.load(attachment.storageKey),
          originalName: attachment.originalName,
        });
      }
      let target: SendTarget =
        row.targetType === 'chat' ? { chatId: row.targetId } : { userId: row.targetId };
      if (payload.operation?.type === 'clarification-reply') {
        const incident = await durable.prisma.incident.findUniqueOrThrow({ where: { id: payload.operation.incidentId }, include: { assignedGroup: true } });
        if (!incident.sectorMessageId || !incident.assignedGroup?.maxChatId) throw new Error('Clarification reply is waiting for the sector card');
        payload.replyToMessageId = incident.sectorMessageId;
        target = { chatId: incident.assignedGroup.maxChatId };
        // Also upgrades older queued replies. A delayed clarification must not
        // offer work buttons after the incident closes or another question starts.
        payload.keyboard = ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status) && !incident.activeClarificationId
          ? sectorKeyboard(incident.id, { hasTemplate: Boolean(incident.assignedGroup.answerTemplate) })
          : [];
      }
      const result = payload.operation?.type === 'distribution-panel'
        ? await this.refreshDistributionPanel(row.targetId)
        : payload.operation?.type === 'work-panel'
        ? await this.refreshWorkPanel(row.targetId)
        : payload.operation?.type === 'staff-refresh'
        ? await this.refreshStaffCards(payload.operation.incidentId)
        : payload.operation?.type === 'distribution-refresh'
        ? await this.refreshDistributionCards(payload.operation.incidentId, payload.operation.refreshActive)
        : payload.operation?.type === 'distribution-alert'
        ? await this.deliverDistributionAlert(row.targetId, payload.operation)
        : payload.operation?.type === 'sla-reminder'
        ? await this.deliverSlaReminder(payload.operation)
        : payload.operation?.type === 'sector-refresh'
        ? await this.refreshSectorCard(payload.operation.incidentId, payload.operation.textOnly)
        : payload.operation?.type === 'delivery-card'
        ? await this.refreshDeliveryCard(payload.operation)
        : await this.deliverLogical(target, { ...payload, attachments }, true);
      await this.complete(row, result.firstMessageId, 'keyboardMessageId' in result ? result.keyboardMessageId as string | undefined : undefined);
      await this.cleanupAttachments(staged);
      return { firstMessageId: result.firstMessageId, state: 'sent', trackingApplied: true };
    } catch (error) {
      const unavailablePhoto = staged.some(item => isPhotoReference(item.storageKey)) && isUnavailablePhoto(error);
      const terminal = unavailablePhoto || row.attempts >= OUTBOX_MAX_ATTEMPTS;
      const detail = unavailablePhoto
        ? 'Фотография недоступна в MAX. Полное сообщение не доставлено; требуется проверка сотрудником.'
        : error instanceof Error ? error.message : String(error);
      if (unavailablePhoto) await this.queuePhotoRecovery(row, payload);
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

  private async complete(row: OutboundMessage, firstMessageId: string | undefined, keyboardMessageId?: string): Promise<void> {
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
          ...(keyboardMessageId ? { payload: { ...(row.payload as Prisma.JsonObject), keyboardMessageId } } : {}),
          trackingApplied: true,
        },
      });
      if (marked.count !== 1) return;
      const operation = (row.payload as unknown as StoredPayload).operation;
      if (operation?.type === 'distribution-panel' && firstMessageId) {
        const key = panelSettingKey(row.targetId);
        await tx.systemSetting.upsert({ where: { key }, create: { key, value: firstMessageId }, update: { value: firstMessageId } });
      }
      if (operation?.type === 'work-panel' && firstMessageId) {
        const key = workPanelKey(row.targetId);
        await tx.systemSetting.upsert({ where: { key }, create: { key, value: firstMessageId }, update: { value: firstMessageId } });
      }
      if (row.incidentId && firstMessageId && (row.trackingType === 'REVIEW_CARD' || row.trackingType === 'SECTOR_CARD' || row.dedupeKey?.startsWith('work-copy:') || row.dedupeKey?.startsWith('revision:'))) {
        await queueStaffRefresh(tx, row.incidentId, `published:${firstMessageId}`);
      }
      if (row.incidentId && firstMessageId && (row.dedupeKey?.startsWith('distribution-claim:') || row.dedupeKey?.startsWith('redistribution-notice:'))) {
        // The assignment may have happened while MAX was delivering this copy.
        await queueDistributionRefresh(tx, row.incidentId, `copy-sent:${row.id}`, true);
      }
      if (!row.trackingType) return;

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
      if (row.trackingType === DeliveryTrackingType.REVIEW_CARD) {
        const answer = await tx.incidentAnswer.findUnique({ where: { id: row.answerId! } });
        if (answer) await tx.incident.updateMany({
          where: { id: row.incidentId, answers: { none: { version: { gt: answer.version } } } },
          data: { reviewMessageId: firstMessageId },
        });
        return;
      }
      if (row.trackingType === 'SECTOR_CARD') {
        const current = await tx.incident.findUnique({ where: { id: row.incidentId }, include: INCIDENT_INCLUDE });
        const expected = current && `sector-card:${current.id}${current.history?.[0] ? ':return:' + current.history[0].id : ''}`;
        if (!current?.assignedGroup || current.assignedGroup.maxChatId !== row.targetId || row.dedupeKey !== expected) return;
      }
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
        await queueDistributionRefresh(tx, row.incidentId, `original-sent:${row.id}`, true);
        await tx.incidentHistory.create({
          data: {
            incidentId: row.incidentId,
            action: HistoryAction.DISTRIBUTION_CARD_SENT,
            metadata: { messageId: firstMessageId, outboxId: row.id },
          },
        });
      } else if (row.trackingType === DeliveryTrackingType.SECTOR_CARD) {
        // A status can change while the original card is still being delivered.
        await queueSectorRefresh(tx, row.incidentId, `sector-status:${row.id}:published:${firstMessageId}`, true);
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
      attachments.filter(item => item.owned !== false && !isPhotoReference(item.storageKey)).map((item) => this.durable!.storage.remove(item.storageKey).catch(() => undefined)),
    );
  }

  private async deliverSlaReminder(operation: Extract<CompositeMessage['operation'], { type: 'sla-reminder' }>): Promise<{ firstMessageId?: string }> {
    const incident = await this.durable!.prisma.incident.findUnique({
      where: { id: operation.incidentId }, include: { assignedGroup: true, currentResponder: true },
    });
    // A delayed retry must not send a reminder after closure or after a later stage is due.
    if (!incident || slaStage(incident, new Date()) !== operation.stage) return {};
    const { target, message } = slaNotification(incident, operation.stage);
    // The card itself may still be retrying. Keep the reminder queued until it exists.
    if (!message.replyToMessageId) throw new Error('SLA reminder is waiting for the incident card');
    return this.deliverLogical(target, message);
  }

  private async refreshDistributionPanel(chatId: bigint): Promise<{ firstMessageId?: string }> {
    const config = getConfig();
    if (chatId !== config.DISTRIBUTION_CHAT_ID) return {};
    return this.refreshPinnedPanel(chatId, panelSettingKey(chatId), queuePanelText(await queueSnapshot(this.durable!.prisma, new Date())), queueKeyboard());
  }

  private async refreshWorkPanel(chatId: bigint): Promise<{ firstMessageId?: string }> {
    return this.refreshPinnedPanel(chatId, workPanelKey(chatId), await workPanelText(this.durable!.prisma, chatId), workButtons());
  }

  private async refreshPinnedPanel(chatId: bigint, key: string, text: string, keyboard: Button[][]): Promise<{ firstMessageId?: string }> {
    const setting = await this.durable!.prisma.systemSetting.findUnique({ where: { key } });
    let firstMessageId = setting?.value;
    if (firstMessageId) {
      try {
        // MAX can acknowledge editing a deleted id; verify existence first.
        const current = await this.max.getMessage(firstMessageId);
        if (String(current.recipient.chat_id) !== String(chatId)) throw new Error('Queue panel belongs to another chat');
        await this.max.editMessage(firstMessageId, text, [{ type: 'inline_keyboard', payload: { buttons: keyboard } }]);
      } catch (error) {
        // Recreate only a confirmed missing message, never on transient MAX failures.
        if (!(error instanceof MaxError) || error.status !== 404) throw error;
        firstMessageId = undefined;
      }
    }
    if (!firstMessageId) {
      const result = await this.deliverLogical({ chatId }, { text, keyboard });
      firstMessageId = result.firstMessageId;
      if (!firstMessageId) throw new Error('MAX did not return a queue panel message id');
    }
    try {
      const pinned = await this.max.getPinnedMessage(chatId).catch(error => {
        if (error instanceof MaxError && error.status === 404) return { message: null };
        throw error;
      });
      if (pinned.message?.body.mid !== firstMessageId) {
        const result = await this.max.pinMessage(chatId, firstMessageId);
        if (!result.success) throw new Error('Queue panel pin was not confirmed');
      }
    } catch (error) {
      log.warn({ err: String(error) }, 'queue panel is available but automatic pin failed');
    }
    return { firstMessageId };
  }

  private async refreshStaffCards(incidentId: string): Promise<{ firstMessageId?: string }> {
    const db = this.durable!.prisma;
    const incident = await db.incident.findUnique({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
    if (!incident) return {};
    const latest = incident.answers.at(-1);
    const rows = await db.outboundMessage.findMany({ where: { incidentId, targetType: 'chat', firstMessageId: { not: null }, OR: [
      { trackingType: 'REVIEW_CARD' }, { trackingType: 'SECTOR_CARD' }, { dedupeKey: { startsWith: 'work-copy:' } }, { dedupeKey: { startsWith: `revision:${incidentId}:` } },
    ] } });
    if (incident.reviewMessageId && !rows.some(r => r.firstMessageId === incident.reviewMessageId)) {
      // Legacy original card not linked to a durable publication.
      rows.push({ firstMessageId: incident.reviewMessageId, answerId: latest?.id ?? null, targetId: getConfig().REVIEW_CHAT_ID!, trackingType: 'REVIEW_CARD', dedupeKey: null } as OutboundMessage);
    }
    const reviewLease = await leaseView(db, incidentId, 'review-queue');
    const sectorLease = await leaseView(db, incidentId, SECTOR_LEASE_ACTION);
    const seen = new Set<string>();
    for (const row of rows) {
      const stored = row.payload as unknown as StoredPayload | undefined;
      const messageId = stored?.keyboardMessageId ?? row.firstMessageId;
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      const review = row.trackingType === 'REVIEW_CARD' || row.dedupeKey?.startsWith('work-copy:review:');
      const oldSector = !review && (row.targetId !== incident.assignedGroup?.maxChatId || (incident.history?.[0] && (row.trackingType === 'SECTOR_CARD' ? row.dedupeKey !== `sector-card:${incidentId}:return:${incident.history[0].id}` : row.dedupeKey?.startsWith('work-copy:sector:') ? !row.dedupeKey.endsWith(`:cycle:${incident.history[0].id}`) : row.createdAt < incident.history[0].createdAt)));
      let text: string; let buttons: Button[][] = [];
      if (oldSector) {
        text = `↩️ ${incident.publicCode}: обращение возвращено на перераспределение. Работа по этой карточке завершена.\nПричина: ${(incident.history?.[0]?.metadata as { reason?: string })?.reason ?? 'Организация изменена'}`;
      } else if (review) {
        const answer = incident.answers.find(a => a.id === row.answerId);
        if (!answer) continue;
        const active = incident.status === 'WAITING_REVIEW' && latest?.id === answer.id && answer.status === 'WAITING_REVIEW';
        text = active ? reviewCard(incident, answer, incident.assignedGroup, reviewLease)
          : latest?.id === answer.id && answer.status === 'APPROVED' ? `${reviewDeliveryNotice(incident, answer)}\n\n${answer.text}`
          : `ℹ️ ${incident.publicCode}: ${answer.status === 'REVISION_REQUIRED' ? 'ответ возвращён на доработку' : 'архивная версия ответа'}.\n\n${answer.text}`;
        if (active) buttons = reviewKeyboard(incidentId, answer.id);
      } else if (row.dedupeKey?.startsWith('revision:')) {
        const active = incident.status === 'REVISION_REQUIRED' && row.dedupeKey === `revision:${incidentId}:${latest?.version}`;
        text = `${active ? leaseText(sectorLease) + '\n\n' : ''}↩️ ${incident.publicCode}: ${active ? 'на доработке' : 'доработка по этой карточке завершена'}.\n\n${incident.revisionReason ?? ''}`;
        if (active) buttons = revisionKeyboard(incidentId);
      } else {
        text = sectorCard(incident, incident.assignedGroup!, sectorLease);
        buttons = sectorKeyboard(incidentId, { status: incident.status, hasTemplate: !!incident.assignedGroup?.answerTemplate });
      }
      if (stored?.keyboardMessageId && stored.keyboardMessageId !== row.firstMessageId) {
        // Keep every original text fragment; only the final fragment carries actions.
        const fragments = splitText(stored.text, stored.label);
        const tail = fragments.at(-1)!;
        const banner = buttons.length ? 'Закрепление — рядом с кнопками.' : 'Действия по карточке завершены.';
        const head = fragments[0]!.replace(/^👤 Закреплено за:.*\n⏳ До[^\n]*|^🟢 Свободно[^\n]*/m, banner);
        if (head !== fragments[0]) {
          try { await this.max.editCardWithKeyboard(row.firstMessageId!, head, []); }
          catch (error) { if (!(error instanceof MaxError) || error.status !== 404) throw error; }
        }
        const notice = buttons.length ? `${leaseText(review ? reviewLease : sectorLease)}\n\n` : `ℹ️ ${incident.publicCode}: действия по этой карточке завершены.\n\n`;
        if (Array.from(notice + tail).length <= MAX_TEXT_LENGTH) text = notice + tail;
        else {
          text = tail;
          if (buttons.length) buttons.unshift(...leaseText(review ? reviewLease : sectorLease).split('\n').map(line =>
            [{ type: 'callback' as const, text: Array.from(line).slice(0, 64).join(''), payload: 'noop' }]));
        }
      }
      try { await this.max.editCardWithKeyboard(messageId, text, buttons); }
      catch (error) { if (!(error instanceof MaxError) || error.status !== 404) throw error; }
    }
    return {};
  }

  private async deliverDistributionAlert(chatId: bigint, operation: Extract<CompositeMessage['operation'], { type: 'distribution-alert' }>): Promise<{ firstMessageId?: string }> {
    const config = getConfig();
    const now = new Date();
    if (!distributionAlertsAllowed(now, config) || operation.hour !== Math.floor(now.getTime() / 3_600_000)) return {};
    if (chatId !== (operation.level === 'normal' ? config.DISTRIBUTION_CHAT_ID : config.DELIVERY_ALERT_CHAT_ID)) return {};
    const snapshot = await queueSnapshot(this.durable!.prisma, now);
    const overloaded = snapshot.total >= config.DISTRIBUTION_OVERLOAD_COUNT;
    if (!overloaded && !(operation.level === 'normal' ? snapshot.delayed60 : snapshot.delayed120)) return {};
    return this.deliverLogical({ chatId }, {
      text: [operation.level === 'normal' ? '⚠️ Очередь распределения требует внимания' : '🚨 Нужна помощь с распределением обращений', '',
        `Ожидают: ${snapshot.total}. Более часа: ${snapshot.delayed60}. Более двух часов: ${snapshot.delayed120}.`,
        ...(overloaded ? [`Очередь достигла порога ${config.DISTRIBUTION_OVERLOAD_COUNT} обращений — проверьте, нужен ли резервный оператор.`] : []),
        'Откройте панель очереди в чате распределения и разберите старейшие обращения.',
      ].join('\n'),
      ...(operation.level === 'normal' ? { keyboard: queueKeyboard() } : {}),
    });
  }

  private async refreshSectorCard(incidentId: string, textOnly = false): Promise<{ firstMessageId?: string }> {
    const incident = await this.durable!.prisma.incident.findUnique({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
    if (!incident?.sectorMessageId || !incident.assignedGroup) return {};
    if (textOnly) {
      // Existing status jobs also refresh controls after this upgrade. MAX media
      // is retained from the actual message, without downloading or re-uploading.
      await this.max.editCardWithKeyboard(incident.sectorMessageId, sectorCard(incident, incident.assignedGroup, await leaseView(this.durable!.prisma, incidentId, SECTOR_LEASE_ACTION)),
        sectorKeyboard(incident.id, { hasTemplate: Boolean(incident.assignedGroup.answerTemplate), status: incident.status }));
      return {};
    }
    const attachments: OutboundAttachment[] = [];
    for (const item of incident.attachments.slice(0, ATTACHMENTS_PER_MESSAGE)) {
      const token = photoToken(item.storageKey);
      if (token) {
        attachments.push({ type: 'IMAGE', maxToken: token, originalName: item.originalName });
        continue;
      }
      attachments.push({ type: item.type, originalName: item.originalName, body: await this.durable!.storage.load(item.storageKey) });
    }
    await this.max.editMessage(incident.sectorMessageId, sectorCard(incident, incident.assignedGroup, await leaseView(this.durable!.prisma, incidentId, SECTOR_LEASE_ACTION)), [
      ...await this.upload(attachments, true),
      ...(['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)
        ? [{ type: 'inline_keyboard' as const, payload: { buttons: sectorKeyboard(incident.id, { hasTemplate: Boolean(incident.assignedGroup.answerTemplate), status: incident.status }) } }] : []),
    ]);
    return {};
  }

  private async refreshDistributionCards(incidentId: string, refreshActive = false): Promise<{ firstMessageId?: string }> {
    const prisma = this.durable!.prisma;
    const incident = await prisma.incident.findUnique({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
    if (!incident) return {};
    const copies = await prisma.outboundMessage.findMany({ where: {
      incidentId, targetType: 'chat', targetId: getConfig().DISTRIBUTION_CHAT_ID,
      OR: [{ dedupeKey: { startsWith: `distribution-claim:${incidentId}:` } }, { dedupeKey: { startsWith: 'redistribution-notice:' } }], firstMessageId: { not: null },
    }, select: { firstMessageId: true, dedupeKey: true } });
    const cards = [...copies];
    if (incident.distributionMessageId) cards.push({ firstMessageId: incident.distributionMessageId, dedupeKey: null });
    const activeKey = incident.distributionClaimUntil && incident.distributionClaimUntil > new Date()
      ? `distribution-claim:${incidentId}:${incident.distributionClaimedBy}:${incident.distributionClaimUntil.getTime()}` : null;
    for (const card of cards) {
      let text: string;
      if (incident.status === 'DISTRIBUTION') {
        // The original stays actionable; only obsolete queue copies are retired.
        if (!card.dedupeKey || card.dedupeKey === activeKey || card.dedupeKey === `redistribution-notice:${incident.history?.[0]?.id}`) {
          if (refreshActive) {
            const keyboard = distributionKeyboard(incidentId);
            const currentText = distributionCard(incident);
            try { await this.max.editCardWithKeyboard(card.firstMessageId!, currentText, keyboard); }
            catch (error) { if (!(error instanceof MaxError) || error.status !== 404) throw error; }
          }
          continue;
        }
        text = `🔴 НЕ РАСПРЕДЕЛЕНО\n\n${incident.publicCode}: закрепление по этой карточке завершено.\n\nОбращение остаётся в очереди. Откройте /queue, чтобы увидеть его текущее состояние и взять в работу.`;
      } else if (incident.status === 'REJECTED') {
        text = `🔴 НЕ РАСПРЕДЕЛЕНО\n\n${incident.publicCode} отклонено\n\nПричина:\n${incident.rejectionReason ?? '—'}`;
      } else if (incident.assignedGroup) {
        text = distributionResolvedNotice(incident, incident.assignedGroup, incident.assignedBy?.displayName ?? '—');
      } else {
        text = `${distributionStatus(incident)}\n\n${incident.publicCode}\nПодробности: /incident ${incident.publicCode}`;
      }
      // Unlike best-effort edits, a MAX failure here remains in the durable retry queue.
      try {
        await this.max.editMessage(card.firstMessageId!, text, []);
      } catch (error) {
        // A deleted copy cannot leave the remaining live cards stale.
        if (!(error instanceof MaxError) || error.status !== 404) throw error;
      }
    }
    return {};
  }

  private async refreshDeliveryCard(operation: Extract<CompositeMessage['operation'], { type: 'delivery-card' }>): Promise<{ firstMessageId?: string }> {
    const incident = await this.durable!.prisma.incident.findUnique({ where: { id: operation.incidentId }, include: INCIDENT_INCLUDE });
    const answer = incident?.answers.find(a => a.id === operation.answerId);
    if (!incident || !answer || incident.answers.at(-1)?.id !== answer.id) return {};
    if (operation.card === 'distribution') {
      if (answer.deliveredAt) await this.refreshDistributionCards(incident.id);
    } else if (incident.reviewMessageId) {
      await this.refreshStaffCards(incident.id);
    }
    return {};
  }

  private async kick(): Promise<void> {
    if (!this.durable || this.stopping) return;
    if (this.drainPromise) return this.drainPromise;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    const prisma = this.durable!.prisma;
    const active = new Set<Promise<void>>();
    const deferred = new Map<string, OutboxTarget>();
    let failure: unknown;
    try {
      // Keep refilling free lanes: a slow request must not stall the next batch.
      while (!this.stopping && !failure) {
        while (active.size < this.concurrency && !this.stopping && !failure) {
          const now = new Date();
          const blocked = [...deferred.values(), ...[...this.activeTargets.values()].map(item => item.target)];
          const candidate = await prisma.outboundMessage.findFirst({
            where: {
              NOT: blocked.map(({ targetType, targetId }) => ({ targetType, targetId })),
              OR: [
                { status: OutboxStatus.PENDING, nextAttemptAt: { lte: now } },
                { status: OutboxStatus.SENDING, lockedAt: { lte: new Date(now.getTime() - OUTBOX_LEASE_MS) } },
              ],
            },
            orderBy: { sequence: 'asc' },
          });
          if (this.stopping) break;
          if (!candidate) {
            // A lane may finish while this database read excludes it. Read again
            // with fresh exclusions before concluding that the queue is empty.
            if (blocked.some(target => !deferred.has(targetKey(target)) && !this.activeTargets.has(targetKey(target)))) continue;
            break;
          }
          const task = this.attemptInOrder(candidate)
            .then(async result => {
              if (result.state !== 'queued') return;
              const current = await prisma.outboundMessage.findUnique({ where: { id: candidate.id } });
              // A business hold (rating/SLA) must let later ready messages pass.
              if (current?.status === 'PENDING' && current.attempts === 0 && current.nextAttemptAt > new Date()) return;
              deferred.set(targetKey(candidate), candidate);
            })
            .catch(error => { failure = error; })
            .finally(() => { active.delete(task); });
          active.add(task);
        }
        if (!active.size) break;
        await Promise.race(active);
      }
    } finally {
      await Promise.all(active);
    }
    if (failure) throw failure;
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

  /** Final staff notices retain the answer's photos and files. Durable refresh retries failures. */
  async finalizeStaffCard(messageId: string, text: string): Promise<boolean> {
    if (Array.from(text).length > MAX_TEXT_LENGTH) return false;
    const publication = await this.durable?.prisma.outboundMessage.findFirst({ where: { firstMessageId: messageId } });
    const payload = publication?.payload as unknown as StoredPayload | undefined;
    if (payload?.keyboardMessageId && payload.keyboardMessageId !== messageId) return false;
    try { await this.max.editCardWithKeyboard(messageId, text, []); return true; }
    catch (error) { log.warn({ err: String(error), messageId }, 'staff card finalization deferred'); return false; }
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
    replyToMessageId?: string,
  ): Promise<Message | undefined> {
    const extra = {
      ...(attachments?.length ? { attachments } : {}),
      ...(disableLinkPreview ? { disable_link_preview: true } : {}),
      ...(replyToMessageId ? { link: { type: 'reply' as const, mid: replyToMessageId } } : {}),
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
        if (item.maxToken !== undefined) {
          uploaded.push({ type: 'image', payload: { token: item.maxToken } });
          continue;
        }
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

  /** Publish an explicitly incomplete card so staff can request replacement.
   * The failed original stays FAILED; an incomplete answer never sets deliveredAt.
   */
  private async queuePhotoRecovery(row: OutboundMessage, payload: StoredPayload): Promise<void> {
    const card = row.trackingType === 'DISTRIBUTION_CARD' || row.trackingType === 'SECTOR_CARD';
    const notice = row.targetType === 'chat'
      ? '⚠️ Фотография недоступна в MAX. Для ответа сотрудника подготовьте новую версию с доступными вложениями. По фотографии жителя требуется проверка сотрудником.'
      : '⚠️ Фотография к этому сообщению недоступна в MAX. Специалисты уведомлены: требуется повторная отправка фотографии. Полный ответ пока не доставлен.';
    const text = row.targetType === 'user' ? `${payload.label ?? 'Сообщение по вашему обращению'}\n\n${notice}` : `${payload.text}\n\n${notice}`;
    await this.durable!.prisma.outboundMessage.createMany({ skipDuplicates: true, data: [{
      dedupeKey: `photo-recovery:${row.id}`, targetType: row.targetType, targetId: row.targetId,
      incidentId: row.incidentId, attachments: [],
      payload: { text, ...(card && payload.keyboard ? { keyboard: payload.keyboard } : {}) } as unknown as Prisma.InputJsonValue,
      trackingType: card ? row.trackingType : null, trackingApplied: !card,
    }] });
    if (row.incidentId && row.answerId && ['ANSWER_TO_REQUESTER', 'REVIEW_CARD'].includes(row.trackingType ?? '')) {
      const incident = await this.durable!.prisma.incident.findUnique({ where: { id: row.incidentId }, include: { assignedGroup: true } });
      if (incident?.assignedGroup?.maxChatId) await this.durable!.prisma.outboundMessage.createMany({ skipDuplicates: true, data: [{
        dedupeKey: `photo-repair-prompt:${row.id}`, targetType: 'chat', targetId: incident.assignedGroup.maxChatId,
        incidentId: incident.id, attachments: [], trackingApplied: true,
        payload: { text: `⚠️ ${incident.publicCode}: фотография ответа недоступна в MAX. Полный ответ не доставлен.\n\nНажмите кнопку, чтобы вернуть ответ на доработку, затем отправьте текст ответа и фотографии заново. Новый ответ пройдёт обычный порядок согласования.`,
          keyboard: [[{ type: 'callback', text: 'Заменить недоступное фото', payload: incidentCallback('repair-photo', incident.id, row.id) }]],
        } as unknown as Prisma.InputJsonValue,
      }] });
    }
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
