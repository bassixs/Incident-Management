import { deliveryTrace, latency, withDeliveryTrace, type DeliveryTrace } from '../utils/latency';
import { leaseView, leaseText, SECTOR_LEASE_ACTION } from '../work-queues/leases';
import { AsyncActivity } from '../utils/async-activity';
import { workingHours } from '../utils/work-calendar';
import { isPhotoReference, photoReference, photoToken, isUnavailablePhoto } from '../media/max-photo-reference';
import { ValidationError } from '../utils/errors';
import { getConfig } from '../config';
import { distributionAlertsAllowed, panelSettingKey, queueKeyboard, queuePanelText, queueSnapshot } from '../distribution/queue-state';
import { createHash, randomUUID } from 'node:crypto';
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
import { distributionCard, distributionResolvedNotice, distributionStatus, sectorCard, finalAnswerToRequester } from '../bot/views/cards';
import { omitsRequesterSignature } from '../responsible-groups/answer-signature';
import { distributionKeyboard } from '../bot/keyboards';
import { queueDistributionRefresh, queueSectorRefresh, queueStaffRefresh } from '../delivery/workflow-outbox';
import { workPanelKey, workPanelText, workButtons } from '../work-queues/state';
import { reviewCard } from '../bot/views/cards';
import { PinnedPanelService } from './pinned-panel.service';
import { reviewKeyboard, revisionKeyboard } from '../bot/keyboards';
import { sectorKeyboard } from '../bot/keyboards';
import { slaNotification, slaStage, type SlaStage } from '../sla/sla-notification';
import { incidentCallback } from './callback-payload';
import { botStatusDeliveryText, type BotStatusOperation } from '../monitoring/bot-status.service';

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
  /** Resident screens only: revalidate after recipient/rate waits and before each MAX attempt. Never persisted in outbox. */
  beforeImmediateSend?: () => Promise<void>;
  operation?: { type: 'delivery-card'; incidentId: string; answerId: string; card: 'review' | 'distribution' }
    | { type: 'superseded-answer' }
    | { type: 'sla-reminder'; incidentId: string; stage: SlaStage }
    | { type: 'clarification-question' | 'clarification-reply'; incidentId: string; clarificationId: string }
    | { type: 'sector-refresh'; incidentId: string; textOnly?: boolean }
    | { type: 'distribution-panel' }
    | BotStatusOperation
    | { type: 'work-panel' }
    | { type: 'staff-refresh'; incidentId: string }
    | { type: 'distribution-refresh'; incidentId: string; refreshActive?: boolean; messageIds?: string[] }
    | { type: 'distribution-alert'; level: 'normal' | 'escalation'; hour: number };
  replyToMessageId?: string;
  /** Prefix repeated on every follow-up part, e.g. `№ INC-000001`. */
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
  /** Confirmed MAX acknowledgements only. See docs/delivery-reliability.md before rollback. */
  deliveryProgress?: { version: 1; planHash: string; totalParts: number; mids: string[] };
  trace?: DeliveryTrace;
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
// Local state refusal must not enter MaxClient's network retry loop.
class StaleDeliveryError extends ValidationError {}
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
  private panelService?: PinnedPanelService;
  private stopping = false;
  private readonly activity = new AsyncActivity();
  private timer?: NodeJS.Timeout;
  private drainPromise?: Promise<void>;
  private wakeScheduled?: NodeJS.Immediate;
  private wakeAfterDrain = false;
  private signalWake!: () => void;
  private wakeSignal = this.newWakeSignal();
  private newWakeSignal(): Promise<void> { return new Promise(resolve => { this.signalWake = resolve; }); }
  private readonly waitingTargets = new Set<string>();
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
  get persistsDelivery(): boolean { return !!this.durable; }

  /** Explicit /resend only. Ordinary deduplication must never revive FAILED jobs. */
  async retryFailedAnswer(incidentId: string, answerId: string, actorMaxUserId?: bigint): Promise<void> {
    if (!this.durable) return;
    await this.durable.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Incident" WHERE id=${incidentId} FOR UPDATE`;
      const incident = await tx.incident.findUnique({ where: { id: incidentId }, include: { answers: { orderBy: { version: 'desc' }, take: 1 } } });
      const answer = incident?.answers[0];
      if (incident?.status !== 'RESOLVED' || answer?.id !== answerId || answer.status !== 'APPROVED') throw new ValidationError('Ответ больше не является актуальным согласованным ответом.');
      if (answer.deliveredAt) return;
      const row = await tx.outboundMessage.findUnique({ where: { dedupeKey: `answer:${answerId}` } });
      if (!row || row.status !== 'FAILED') return;
      if (row.incidentId !== incidentId || row.answerId !== answerId || row.trackingType !== 'ANSWER_TO_REQUESTER'
        || row.targetType !== 'user' || row.targetId !== incident.requesterMaxUserId
        || (row.payload as unknown as StoredPayload).operation
        || row.lastError?.startsWith('MANUALLY_RETIRED_')) throw new ValidationError('Это задание нельзя возобновить командой /resend.');
      const claimed = await tx.outboundMessage.updateMany({ where: { id: row.id, status: 'FAILED', attempts: row.attempts, payload: { equals: row.payload! } },
        data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lockedAt: null } });
      if (claimed.count) await tx.incidentHistory.create({ data: { incidentId, action: HistoryAction.ANSWER_DELIVERY_RETRY_REQUESTED, actorMaxUserId,
        metadata: { answerId, outboxId: row.id, previousAttempts: row.attempts, previousError: row.lastError, requestedAt: new Date().toISOString() } } });
    });
  }

  private async assertCurrentAnswer(row: OutboundMessage, db: Pick<PrismaClient, 'incident'> = this.durable!.prisma): Promise<void> {
    if (row.trackingType !== 'ANSWER_TO_REQUESTER') return;
    const incident = row.incidentId && await db.incident.findUnique({ where: { id: row.incidentId }, include: { answers: { orderBy: { version: 'desc' }, take: 1 } } });
    const answer = incident && incident.answers[0];
    if (!incident || incident.status !== 'RESOLVED' || !answer || answer.id !== row.answerId || answer.status !== 'APPROVED'
      || row.targetType !== 'user' || row.targetId !== incident.requesterMaxUserId) throw new StaleDeliveryError('STALE_ANSWER_VERSION');
    if (answer.deliveredAt) throw new StaleDeliveryError('ANSWER_ALREADY_DELIVERED');
  }

  /** Upgrade only an untouched legacy answer, before its first possible MAX send.
   * Never reinterpret partial/uncertain delivery, including a manual retry whose
   * attempts were reset: lastError remains evidence of its earlier attempt.
   */
  private async prepareRequesterSignature(row: OutboundMessage, payload: StoredPayload): Promise<void> {
    if (row.trackingType !== 'ANSWER_TO_REQUESTER' || payload.operation || row.attempts !== 1
      || row.lastError !== null || row.firstMessageId !== null || row.sentAt !== null
      || payload.deliveryProgress !== undefined || payload.keyboardMessageId !== undefined) return;
    const incident = await this.durable!.prisma.incident.findUnique({ where: { id: row.incidentId! },
      include: { assignedGroup: true, answers: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!omitsRequesterSignature(incident?.assignedGroup?.code)) return;
    const answer = incident?.answers[0];
    if (!incident || incident.status !== 'RESOLVED' || answer?.id !== row.answerId || answer.status !== 'APPROVED'
      || answer.deliveredAt || row.targetType !== 'user' || row.targetId !== incident.requesterMaxUserId) {
      throw new StaleDeliveryError('STALE_ANSWER_VERSION');
    }
    const at = incident.answeredAt ?? answer.approvedAt;
    if (!at) throw new StaleDeliveryError('REQUESTER_SIGNATURE_REVIEW_REQUIRED');
    const text = finalAnswerToRequester(incident, answer, at, incident.assignedGroup?.authorityName, incident.assignedGroup?.code);
    if (payload.text === text) return;
    // Compare the entire old rendering, never strip matching phrases from user text.
    const legacy = finalAnswerToRequester(incident, answer, at, incident.assignedGroup?.authorityName);
    if (payload.text !== legacy) throw new StaleDeliveryError('REQUESTER_SIGNATURE_REVIEW_REQUIRED');
    const updated = { ...payload, text };
    const saved = await this.durable!.prisma.outboundMessage.updateMany({
      where: { id: row.id, status: 'SENDING', attempts: row.attempts, lockedAt: row.lockedAt,
        payload: { equals: row.payload! }, firstMessageId: null, sentAt: null, lastError: null },
      data: { payload: updated as unknown as Prisma.InputJsonValue },
    });
    if (!saved.count) throw new StaleDeliveryError('DELIVERY_PROGRESS_OWNERSHIP_LOST');
    row.payload = updated as unknown as Prisma.JsonValue;
    payload.text = text;
  }

  private async sendNow(target: SendTarget, message: CompositeMessage): Promise<MessageSendResult> {
    if (!this.durable || message.immediatePreview) {
      const destination = 'chatId' in target ? { targetType: 'chat', targetId: target.chatId } : { targetType: 'user', targetId: target.userId };
      const key = targetKey(destination);
      while (this.activeTargets.has(key)) await this.activeTargets.get(key)!.done.catch(() => undefined);
      return this.withTarget(destination, async () => {
        await message.beforeImmediateSend?.();
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
    latency('screen-created', { outboxId: row.id, ageMs: Date.now() - row.createdAt.getTime() });
    const result = await this.attemptInOrder(row);
    if (result.state === 'queued') this.wake();
    return result;
  }

  private async withTarget<T>(target: OutboxTarget, work: () => Promise<T>): Promise<T> {
    const key = targetKey(target);
    const done = this.activity.run(work);
    this.activeTargets.set(key, { target, done });
    try { return await done; }
    finally {
      if (this.activeTargets.get(key)?.done === done) {
        this.activeTargets.delete(key);
        if (this.waitingTargets.delete(key)) this.wake();
      }
    }
  }

  /** Deferred business reminders do not block a chat; an actual failed send does. */
  private async attemptInOrder(row: OutboundMessage): Promise<MessageSendResult> {
    if (this.stopping) return { state: 'queued', trackingApplied: false };
    if (this.activeTargets.has(targetKey(row))) {
      this.waitingTargets.add(targetKey(row));
      return { state: 'queued', trackingApplied: false };
    }
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
      const trace = (row.payload as unknown as StoredPayload).trace ?? {};
      const result = await withDeliveryTrace({ ...trace, outboxId: row.id }, () => this.attempt(row.id));
      // Completion can transactionally create more jobs (tracking/status cards).
      // A successful transition is a finite wake source; a blocked/backoff row is not.
      if (result.state === 'sent') this.wake();
      return result;
    });
  }

  private async deliverLogical(
    target: SendTarget,
    message: Omit<CompositeMessage, 'delivery'>,
    strictAttachments = true,
    durableRow?: OutboundMessage,
  ): Promise<{ firstMessageId?: string; keyboardMessageId?: string }> {
    const parts = splitText(message.text, message.label);
    const keyboardAttachment: AttachmentRequest | undefined = message.keyboard?.length
      ? { type: 'inline_keyboard', payload: { buttons: message.keyboard } }
      : undefined;

    const groups = groupAttachments(message.attachments ?? []);
    const [inlineGroup, ...trailingGroups] = groups;
    const totalParts = parts.length + trailingGroups.length;
    const planHash = createHash('sha256').update(JSON.stringify({ parts, label: message.label, keyboard: message.keyboard,
      replyTo: message.replyToMessageId, disableLinkPreview: message.disableLinkPreview,
      target: 'chatId' in target ? `chat:${target.chatId}` : `user:${target.userId}`, attachments: durableRow?.attachments })).digest('hex');
    const saved = (durableRow?.payload as unknown as StoredPayload | undefined)?.deliveryProgress;
    if (saved && (saved.version !== 1 || saved.planHash !== planHash || saved.totalParts !== totalParts
      || !Array.isArray(saved.mids) || saved.mids.length > totalParts || saved.mids.some(mid => typeof mid !== 'string' || !mid))) {
      throw new StaleDeliveryError('DELIVERY_PROGRESS_MISMATCH: требуется проверка сохранённого плана, повтор с начала запрещён.');
    }
    const mids: string[] = [...(saved?.mids ?? [])];
    const keyboardPart = parts.length - 1;
    for (let index = mids.length; index < totalParts; index += 1) {
      await message.beforeImmediateSend?.();
      const isText = index < parts.length;
      const group = isText ? index === keyboardPart ? inlineGroup : undefined : trailingGroups[index - parts.length];
      const uploaded = group ? await this.upload(group, strictAttachments) : [];
      const attachments = [...uploaded, ...(index === keyboardPart && keyboardAttachment ? [keyboardAttachment] : [])];
      const sent = await this.deliver(target, isText ? parts[index]! : message.label ?? '', attachments.length ? attachments : undefined,
        isText ? message.disableLinkPreview : true, index === 0 ? message.replyToMessageId : undefined, message.beforeImmediateSend);
      const mid = sent?.body?.mid;
      if (durableRow && !mid) throw new Error('MAX_SEND_ACK_WITHOUT_MID: результат отправки неоднозначен.');
      mids.push(mid ?? '');
      if (durableRow) {
        const payload: StoredPayload = { ...(durableRow.payload as unknown as StoredPayload),
          deliveryProgress: { version: 1, planHash, totalParts, mids: [...mids] },
          ...(keyboardAttachment && mids[keyboardPart] ? { keyboardMessageId: mids[keyboardPart] } : {}) };
        const nextLease = new Date();
        const savedPart = await this.durable!.prisma.outboundMessage.updateMany({
          where: { id: durableRow.id, status: 'SENDING', attempts: durableRow.attempts, lockedAt: durableRow.lockedAt, payload: { equals: durableRow.payload! } },
          data: { payload: payload as unknown as Prisma.InputJsonValue, firstMessageId: mids[0], lockedAt: nextLease },
        });
        if (!savedPart.count) throw new StaleDeliveryError('DELIVERY_PROGRESS_OWNERSHIP_LOST');
        durableRow.payload = payload as unknown as Prisma.JsonValue; durableRow.lockedAt = nextLease; durableRow.firstMessageId = mids[0]!;
      }
    }
    return { firstMessageId: mids[0] || undefined, ...(keyboardAttachment && mids[keyboardPart] ? { keyboardMessageId: mids[keyboardPart] } : {}) };
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
    if (this.wakeScheduled) clearImmediate(this.wakeScheduled);
    this.wakeScheduled = undefined;
    this.wakeAfterDrain = false;
  }

  async waitForIdle(): Promise<void> {
    await this.drainPromise;
    await this.activity.waitForIdle();
  }

  /** Notify the durable worker AFTER committing business changes. No delivery is
   * held only by this signal: restart and the existing sweep recover missed wakes.
   * Coalesced, event-driven, and never starts a second global drain. */
  wake(): void {
    if (!this.durable || this.stopping) return;
    if (this.drainPromise) { this.wakeAfterDrain = true; this.signalWake(); return; }
    if (this.wakeScheduled) return;
    withDeliveryTrace({}, () => {
      this.wakeScheduled = setImmediate(() => {
        this.wakeScheduled = undefined;
        void this.kick().catch(() => log.error({ code: 'OUTBOX_WAKE_FAILED' }, 'outbox wake failed; sweep will retry'));
      });
    });
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
    let insertAttempted = false;

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
        trace: deliveryTrace(),
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
        insertAttempted = true;
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
        // A transport failure does not prove INSERT rolled back. First reconcile the
        // UUID generated before staging, even when the caller has no dedupe key.
        // Failed reads (or absence after an ambiguous write) never authorize deletion.
        const committed = await durable.prisma.outboundMessage.findUnique({ where: { id } });
        if (committed) return committed;
        if (message.delivery?.dedupeKey) {
          const existing = await durable.prisma.outboundMessage.findUnique({ where: { dedupeKey: message.delivery.dedupeKey } });
          if (existing) {
            // P2002 is a confirmed rejection, unlike a lost commit acknowledgement.
            if (isUniqueViolation(error)) await this.cleanupAttachments(staged);
            return existing;
          }
        }
        if (isUniqueViolation(error)) await this.cleanupAttachments(staged);
        else log.error({ outboxId: id, code: 'ENQUEUE_RESULT_UNCERTAIN' }, 'retaining staged files; reconcile by outbox ID before retry without a dedupe key');
        throw error;
      }
    } catch (error) {
      // Only pre-INSERT staging failures are known not to have a database owner.
      if (!insertAttempted) await this.cleanupAttachments(staged);
      else log.error({ outboxId: id, code: 'ENQUEUE_RECONCILIATION_REQUIRED' }, 'enqueue failed; preserve files if commit cannot be excluded');
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
    const payload = structuredClone(row.payload) as unknown as StoredPayload;
    latency('outbox-start', { attempt: row.attempts, waitMs: Math.max(0, now.getTime() - Math.max(row.createdAt.getTime(), row.nextAttemptAt.getTime())), ageMs: now.getTime() - row.createdAt.getTime() });
    const staged = row.attachments as unknown as StagedAttachment[];
    // Retired questions from older releases must never reach a resident.
    if (payload.operation?.type === 'clarification-question' || row.dedupeKey?.startsWith('clarification-preview:')) {
      await durable.prisma.outboundMessage.delete({ where: { id: row.id } });
      return { state: 'sent', trackingApplied: false };
    }
    if (row.trackingType === 'SECTOR_CARD' && row.incidentId) {
      const current = await durable.prisma.incident.findUnique({ where: { id: row.incidentId }, include: INCIDENT_INCLUDE });
      if (!await this.currentSectorPublication(row, current)) {
        await durable.prisma.outboundMessage.update({ where: { id }, data: { status: 'FAILED', trackingApplied: false, lockedAt: null, lastError: 'STALE_SECTOR_ASSIGNMENT: карточка относится к прежнему назначению.' } });
        if (row.firstMessageId) await durable.prisma.$transaction(tx => queueStaffRefresh(tx, row.incidentId!, `stale:${row.id}`));
        return { state: 'queued', trackingApplied: false };
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
      await this.assertCurrentAnswer(row);
      await this.prepareRequesterSignature(row, payload);
      if (payload.operation?.type === 'bot-status') {
        const text = botStatusDeliveryText(payload.operation, payload.text, row.targetId, getConfig(), new Date());
        if (text === undefined) {
          // Keep the dedupe marker but never send yesterday's or disabled report.
          await durable.prisma.outboundMessage.update({ where: { id }, data: {
            status: OutboxStatus.SENT, lockedAt: null, trackingApplied: true,
            lastError: 'Плановый отчёт пропущен: истёк срок доставки или получатель отключён.',
          } });
          return { state: 'sent', trackingApplied: true };
        }
        payload.text = text;
      }
      if (payload.operation?.type === 'sla-reminder') {
        // Retire notifications queued by the old multi-stage policy, retaining its marks.
        if (payload.operation.stage !== 24) {
          await durable.prisma.outboundMessage.update({ where: { id: row.id }, data: {
            status: OutboxStatus.SENT, lockedAt: null, lastError: null,
          } });
          return { state: 'sent', trackingApplied: false };
        }
        if (!workingHours(new Date())) {
          // Re-arm the stage for the next working sweep. Holding this job until
          // morning would block unrelated cards/answers in the same chat.
          const operation = payload.operation;
          await durable.prisma.$transaction(async tx => {
            await tx.incident.updateMany({ where: { id: operation.incidentId }, data: { slaReminder24SentAt: null } });
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
          ? sectorKeyboard(incident.id, { hasPhone: !!incident.requesterPhone, hasTemplate: Boolean(incident.assignedGroup.answerTemplate) })
          : [];
      }
      const result = payload.operation?.type === 'distribution-panel'
        ? await this.refreshDistributionPanel(row.targetId, row.id)
        : payload.operation?.type === 'work-panel'
        ? await this.refreshWorkPanel(row.targetId, row.id)
        : payload.operation?.type === 'staff-refresh'
        ? await this.refreshStaffCards(payload.operation.incidentId)
        : payload.operation?.type === 'distribution-refresh'
        ? await this.refreshDistributionCards(payload.operation.incidentId, payload.operation.refreshActive, payload.operation.messageIds)
        : payload.operation?.type === 'distribution-alert'
        ? await this.deliverDistributionAlert(row.targetId, payload.operation)
        : payload.operation?.type === 'sla-reminder'
        ? await this.deliverSlaReminder(payload.operation)
        : payload.operation?.type === 'sector-refresh'
        ? await this.refreshSectorCard(payload.operation.incidentId, payload.operation.textOnly)
        : payload.operation?.type === 'delivery-card'
        ? await this.refreshDeliveryCard(payload.operation)
        : await this.deliverLogical(target, { ...payload, attachments, beforeImmediateSend: async () => {
          const lease = await durable.prisma.outboundMessage.findUnique({ where: { id: row.id }, select: { status: true, attempts: true, payload: true } });
          if (lease?.status !== 'SENDING' || lease.attempts !== row.attempts || (lease.payload as unknown as StoredPayload).operation?.type === 'superseded-answer') throw new StaleDeliveryError('DELIVERY_PROGRESS_OWNERSHIP_LOST');
          await this.assertCurrentAnswer(row);
          const progress = (row.payload as unknown as StoredPayload).deliveryProgress;
          if (progress?.mids.length && (row.trackingType === 'REVIEW_CARD' || row.dedupeKey?.startsWith('work-copy:review:'))) {
            const current = await durable.prisma.incident.findUnique({ where: { id: row.incidentId! }, include: { answers: { orderBy: { version: 'desc' }, take: 1 } } });
            if (current?.status !== 'WAITING_REVIEW' || current.answers[0]?.id !== row.answerId || current.answers[0]?.status !== 'WAITING_REVIEW') {
              throw new StaleDeliveryError('STALE_PARTIAL_REVIEW_CARD');
            }
          }
          if (progress?.mids.length && row.dedupeKey?.startsWith('work-copy:sector:')) {
            const current = await durable.prisma.incident.findUnique({ where: { id: row.incidentId! }, include: INCIDENT_INCLUDE });
            if (!current?.assignedGroup || current.assignedGroup.maxChatId !== row.targetId
              || !['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(current.status)
              || (current.history[0] && !row.dedupeKey.endsWith(`:cycle:${current.history[0].id}`))) {
              throw new StaleDeliveryError('STALE_PARTIAL_SECTOR_COPY');
            }
          }
          if (row.trackingType === 'SECTOR_CARD') {
            const current = await durable.prisma.incident.findUnique({ where: { id: row.incidentId! }, include: INCIDENT_INCLUDE });
            if (!await this.currentSectorPublication(row, current)) throw new StaleDeliveryError('STALE_SECTOR_ASSIGNMENT');
          }
        } }, true, row);
      const trackingApplied = await this.complete(row, result.firstMessageId, 'keyboardMessageId' in result ? result.keyboardMessageId as string | undefined : undefined);
      latency('outbox-sent', { attempt: row.attempts, durationMs: Date.now() - now.getTime(), ageMs: Date.now() - row.createdAt.getTime() });
      await this.cleanupAttachments(staged);
      return { firstMessageId: result.firstMessageId, state: 'sent', trackingApplied };
    } catch (error) {
      const unavailablePhoto = staged.some(item => isPhotoReference(item.storageKey)) && isUnavailablePhoto(error);
      const terminal = error instanceof StaleDeliveryError || unavailablePhoto || row.attempts >= OUTBOX_MAX_ATTEMPTS;
      const detail = unavailablePhoto
        ? 'Фотография недоступна в MAX. Полное сообщение не доставлено; требуется проверка сотрудником.'
        : payload.operation?.type === 'bot-status' ? 'Не удалось доставить плановый отчёт MAX.'
        : error instanceof Error ? error.message : String(error);
      if (unavailablePhoto) await this.queuePhotoRecovery(row, payload);
      await durable.prisma.outboundMessage.updateMany({
        where: { id: row.id, status: 'SENDING', attempts: row.attempts, lockedAt: row.lockedAt },
        data: {
          status: terminal ? OutboxStatus.FAILED : OutboxStatus.PENDING,
          lockedAt: null,
          lastError: detail.slice(0, 4_000),
          nextAttemptAt: new Date(Date.now() + retryDelayMs(row.attempts)),
        },
      });
      if (error instanceof StaleDeliveryError && row.incidentId && row.firstMessageId
        && (row.trackingType === 'SECTOR_CARD' || row.trackingType === 'REVIEW_CARD' || row.dedupeKey?.startsWith('work-copy:'))) {
        await durable.prisma.$transaction(tx => queueStaffRefresh(tx, row.incidentId!, `stale:${row.id}`));
      }
      log[terminal ? 'error' : 'warn'](
        { outboxId: row.id, attempts: row.attempts, terminal, err: detail },
        terminal ? 'outbound MAX message requires manual attention' : 'outbound MAX message queued for retry',
      );
      return { state: 'queued', trackingApplied: false };
    }
  }

  private async complete(row: OutboundMessage, firstMessageId: string | undefined, keyboardMessageId?: string): Promise<boolean> {
    const prisma = this.durable!.prisma;
    let trackingApplied = true;
    await prisma.$transaction(async (tx) => {
      // Match the lock order of manual retry and answer revision transactions.
      if (row.trackingType === 'ANSWER_TO_REQUESTER' && row.incidentId) await tx.$queryRaw`SELECT id FROM "Incident" WHERE id=${row.incidentId} FOR UPDATE`;
      const marked = await tx.outboundMessage.updateMany({
        where: { id: row.id, status: OutboxStatus.SENDING, attempts: row.attempts, lockedAt: row.lockedAt },
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
      if (marked.count !== 1) throw new StaleDeliveryError('DELIVERY_COMPLETION_OWNERSHIP_LOST');
      // Panel identity is committed before activation by PinnedPanelService.
      // Retrying completion must not replace a newer reconciled identity.
      if (row.incidentId && firstMessageId && (row.trackingType === 'REVIEW_CARD' || row.trackingType === 'SECTOR_CARD' || row.dedupeKey?.startsWith('work-copy:') || row.dedupeKey?.startsWith('revision:'))) {
        await queueStaffRefresh(tx, row.incidentId, `published:${firstMessageId}:attempt:${row.attempts}`);
      }
      if (row.incidentId && firstMessageId && (row.dedupeKey?.startsWith('distribution-claim:') || row.dedupeKey?.startsWith('redistribution-notice:'))) {
        // The assignment may have happened while MAX was delivering this copy.
        await queueDistributionRefresh(tx, row.incidentId, `copy-sent:${row.id}`, true);
      }
      if (!row.trackingType) return;

      if (row.trackingType === DeliveryTrackingType.ANSWER_TO_REQUESTER && row.answerId && row.incidentId) {
        try { await this.assertCurrentAnswer(row, tx); }
        catch (error) {
          if (!(error instanceof StaleDeliveryError)) throw error;
          await tx.outboundMessage.update({ where: { id: row.id }, data: { trackingApplied: false, lastError: 'STALE_ANSWER_AFTER_SEND: версия изменилась во время доставки.' } });
          trackingApplied = false;
          return;
        }
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
        if (!await this.currentSectorPublication(row, current, tx)) {
          await tx.outboundMessage.update({ where: { id: row.id }, data: { trackingApplied: false } });
          trackingApplied = false;
          return;
        }
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
        await queueSectorRefresh(tx, row.incidentId, `sector-status:${row.id}:published:${firstMessageId}:attempt:${row.attempts}`, true);
        await tx.incidentHistory.create({
          data: {
            incidentId: row.incidentId,
            action: HistoryAction.SECTOR_CARD_SENT,
            metadata: { messageId: firstMessageId, outboxId: row.id },
          },
        });
      }
    });
    return trackingApplied;
  }

  private async cleanupAttachments(attachments: StagedAttachment[]): Promise<void> {
    if (!this.durable) return;
    await Promise.all(
      attachments.filter(item => item.owned !== false && !isPhotoReference(item.storageKey)).map((item) => this.durable!.storage.remove(item.storageKey).catch(() => undefined)),
    );
  }

  /** A recovery is tied to the original publication/cycle, never merely its chat. */
  private async sectorPublicationKey(row: OutboundMessage, db: Pick<PrismaClient, 'outboundMessage'> = this.durable!.prisma): Promise<string | null> {
    if (!row.dedupeKey?.startsWith('photo-recovery:')) return row.dedupeKey;
    const original = await db.outboundMessage.findUnique({ where: { id: row.dedupeKey.slice('photo-recovery:'.length) } });
    return original?.trackingType === 'SECTOR_CARD' && original.incidentId === row.incidentId
      && original.targetType === row.targetType && original.targetId === row.targetId
      && original.dedupeKey?.startsWith(`sector-card:${row.incidentId}`) ? original.dedupeKey : null;
  }

  private async currentSectorPublication(row: OutboundMessage, current: import('../incidents/incident.repository').IncidentWithRelations | null,
    db: Pick<PrismaClient, 'outboundMessage'> = this.durable!.prisma): Promise<boolean> {
    const expected = current && `sector-card:${current.id}${current.history[0] ? ':return:' + current.history[0].id : ''}`;
    return !!current?.assignedGroup && current.assignedGroup.maxChatId === row.targetId
      && await this.sectorPublicationKey(row, db) === expected;
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

  private async refreshDistributionPanel(chatId: bigint, jobId: string): Promise<{ firstMessageId?: string }> {
    const config = getConfig();
    if (chatId !== config.DISTRIBUTION_CHAT_ID) return {};
    return this.refreshPinnedPanel(chatId, panelSettingKey(chatId), queuePanelText(await queueSnapshot(this.durable!.prisma, new Date())), queueKeyboard(), jobId);
  }

  private async refreshWorkPanel(chatId: bigint, jobId: string): Promise<{ firstMessageId?: string }> {
    return this.refreshPinnedPanel(chatId, workPanelKey(chatId), await workPanelText(this.durable!.prisma, chatId), workButtons(), jobId);
  }

  private async refreshPinnedPanel(chatId: bigint, key: string, text: string, keyboard: Button[][], jobId: string): Promise<{ firstMessageId?: string }> {
    this.panelService ??= new PinnedPanelService(this.durable!.prisma, this.max);
    return this.panelService.refresh(chatId, key, text, keyboard, jobId);
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
      const fragments = stored && splitText(stored.text, stored.label);
      // firstMessageId is now saved before the keyboard-bearing text part arrives.
      // Refresh only an acknowledged text tail, even for PENDING/FAILED jobs.
      const progress = stored?.deliveryProgress;
      const messageId = progress
        ? progress.version === 1 && Array.isArray(progress.mids) ? progress.mids[(fragments?.length ?? 1) - 1] : undefined
        : stored?.keyboardMessageId ?? row.firstMessageId;
      if (!messageId || seen.has(messageId)) continue;
      seen.add(messageId);
      const review = row.trackingType === 'REVIEW_CARD' || row.dedupeKey?.startsWith('work-copy:review:');
      const oldSector = !review && (row.targetId !== incident.assignedGroup?.maxChatId || (incident.history?.[0] && (row.trackingType === 'SECTOR_CARD' ? await this.sectorPublicationKey(row) !== `sector-card:${incidentId}:return:${incident.history[0].id}` : row.dedupeKey?.startsWith('work-copy:sector:') ? !row.dedupeKey.endsWith(`:cycle:${incident.history[0].id}`) : row.createdAt < incident.history[0].createdAt)));
      let text: string; let buttons: Button[][] = [];
      if (oldSector) {
        text = `↩️ ${incident.publicCode}: сообщение возвращено на перераспределение. Работа по этой карточке завершена.\nПричина: ${(incident.history?.[0]?.metadata as { reason?: string })?.reason ?? 'Организация изменена'}`;
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
        if (active) buttons = revisionKeyboard(incidentId, !!incident.requesterPhone);
      } else {
        text = sectorCard(incident, incident.assignedGroup!, sectorLease);
        buttons = sectorKeyboard(incidentId, { hasPhone: !!incident.requesterPhone, status: incident.status, hasTemplate: !!incident.assignedGroup?.answerTemplate });
      }
      if (stored && messageId !== row.firstMessageId) {
        // Keep every original text fragment; only the final fragment carries actions.
        const tail = fragments!.at(-1)!;
        const banner = buttons.length ? 'Закрепление — рядом с кнопками.' : 'Действия по карточке завершены.';
        const head = fragments![0]!.replace(/^👤 Закреплено за:.*\n⏳ До[^\n]*|^🟢 Свободно[^\n]*/m, banner);
        if (head !== fragments![0]) {
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
      text: [operation.level === 'normal' ? '⚠️ Очередь распределения требует внимания' : '🚨 Нужна помощь с распределением сообщений', '',
        `Ожидают: ${snapshot.total}. Более часа: ${snapshot.delayed60}. Более двух часов: ${snapshot.delayed120}.`,
        ...(overloaded ? [`Очередь достигла порога ${config.DISTRIBUTION_OVERLOAD_COUNT} сообщений — проверьте, нужен ли резервный оператор.`] : []),
        'Откройте панель очереди в чате распределения и разберите старейшие сообщения.',
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
        sectorKeyboard(incident.id, { hasPhone: !!incident.requesterPhone, hasTemplate: Boolean(incident.assignedGroup.answerTemplate), status: incident.status }));
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
        ? [{ type: 'inline_keyboard' as const, payload: { buttons: sectorKeyboard(incident.id, { hasPhone: !!incident.requesterPhone, hasTemplate: Boolean(incident.assignedGroup.answerTemplate), status: incident.status }) } }] : []),
    ]);
    return {};
  }

  private async refreshDistributionCards(incidentId: string, refreshActive = false, messageIds: string[] = []): Promise<{ firstMessageId?: string }> {
    const prisma = this.durable!.prisma;
    const incident = await prisma.incident.findUnique({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
    if (!incident) return {};
    const copies = await prisma.outboundMessage.findMany({ where: {
      incidentId, targetType: 'chat', targetId: getConfig().DISTRIBUTION_CHAT_ID,
      OR: [{ dedupeKey: { startsWith: `distribution-claim:${incidentId}:` } }, { dedupeKey: { startsWith: 'redistribution-notice:' } }], firstMessageId: { not: null },
    }, select: { firstMessageId: true, dedupeKey: true } });
    const cards = [...copies];
    if (incident.distributionMessageId) cards.push({ firstMessageId: incident.distributionMessageId, dedupeKey: null });
    // Rejection erases delivery payloads. Its durable refresh retains only IDs,
    // so retries can retire the published copies without restoring their content.
    for (const mid of messageIds) {
      if (!cards.some(card => card.firstMessageId === mid)) cards.push({ firstMessageId: mid, dedupeKey: null });
    }
    const activeKey = incident.distributionClaimUntil && incident.distributionClaimUntil > new Date()
      ? `distribution-claim:${incidentId}:${incident.distributionClaimedBy}:${incident.distributionClaimUntil.getTime()}` : null;
    for (const card of cards) {
      let text: string;
      if (incident.status === 'DISTRIBUTION') {
        // The original stays actionable; only obsolete queue copies are retired.
        if (!card.dedupeKey || card.dedupeKey === activeKey || card.dedupeKey === `redistribution-notice:${incident.history?.[0]?.id}`) {
          if (refreshActive) {
            const keyboard = distributionKeyboard(incidentId, !!incident.requesterPhone);
            const currentText = distributionCard(incident);
            try { await this.max.editCardWithKeyboard(card.firstMessageId!, currentText, keyboard); }
            catch (error) { if (!(error instanceof MaxError) || error.status !== 404) throw error; }
          }
          continue;
        }
        text = `🔴 НЕ РАСПРЕДЕЛЕНО\n\n${incident.publicCode}: закрепление по этой карточке завершено.\n\nСообщение остаётся в очереди. Откройте /queue, чтобы увидеть его текущее состояние и взять в работу.`;
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
    if (this.wakeScheduled) clearImmediate(this.wakeScheduled);
    this.wakeScheduled = undefined;
    this.drainPromise = (async () => {
      do {
        this.wakeAfterDrain = false;
        await this.drain();
      } while (this.wakeAfterDrain && !this.stopping);
    })().finally(() => { this.drainPromise = undefined; });
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
          // An immediate send can acquire this lane during the database read.
          // Do not keep it deferred after its owner releases and signals us.
          const occupied = this.activeTargets.has(targetKey(candidate));
          const task = this.attemptInOrder(candidate)
            .then(async result => {
              if (result.state !== 'queued' || occupied) return;
              const current = await prisma.outboundMessage.findUnique({ where: { id: candidate.id } });
              if (!current || current.status === 'SENT' || current.status === 'FAILED') return;
              // A business hold (rating/SLA) must let later ready messages pass.
              if (current?.status === 'PENDING' && current.attempts === 0 && current.nextAttemptAt > new Date()) return;
              deferred.set(targetKey(candidate), candidate);
            })
            .catch(error => { failure = error; })
            .finally(() => { active.delete(task); });
          active.add(task);
        }
        if (!active.size) break;
        await Promise.race([...active, this.wakeSignal]);
        this.wakeSignal = this.newWakeSignal();
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

  /** Known resident screen only; preserve photos while disabling obsolete controls. */
  async retireDraftScreen(messageId: string, text: string): Promise<boolean> {
    try { await this.max.editCardWithKeyboard(messageId, text, []); return true; }
    catch { return false; }
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
    beforeAttempt?: () => Promise<void>,
  ): Promise<Message | undefined> {
    const extra = {
      ...(attachments?.length ? { attachments } : {}),
      ...(disableLinkPreview ? { disable_link_preview: true } : {}),
      ...(replyToMessageId ? { link: { type: 'reply' as const, mid: replyToMessageId } } : {}),
    };
    try {
      await beforeAttempt?.();
      return 'chatId' in target
        ? await this.max.sendToChat(target.chatId, text, extra, beforeAttempt)
        : await this.max.sendToUser(target.userId, text, extra, beforeAttempt);
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
    const text = row.targetType === 'user' ? `${payload.label ?? 'Сообщение по вашему сообщению'}\n\n${notice}` : `${payload.text}\n\n${notice}`;
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
