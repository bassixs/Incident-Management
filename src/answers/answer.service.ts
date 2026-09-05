import { queueDeliveryStatus } from '../delivery/delivery-status';
import { randomUUID } from 'node:crypto';
import { queueAnswer } from '../delivery/workflow-outbox';
import type { Tx } from '../database/prisma';
import {
  AnswerStatus,
  AttachmentType,
  type IncidentAnswer,
  IncidentStatus,
  type PrismaClient,
} from '@prisma/client';

import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentStateService } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import type { IncomingMedia, MediaService, StoredMedia } from '../media/media.service';
import type { ReviewService } from '../review/review.service';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';
import { isBlank, renderTemplate } from '../utils/text';
import type { Actor, DistributionService } from '../distribution/distribution.service';

const log = moduleLogger('answers');

/** Statuses from which a responder may submit (or resubmit) an answer. */
const SUBMITTABLE: IncidentStatus[] = [
  IncidentStatus.ASSIGNED,
  IncidentStatus.IN_PROGRESS,
  IncidentStatus.REVISION_REQUIRED,
];

export const ANSWER_REJECTIONS = {
  video: 'Видео в ответах не поддерживается.\n\nОтправьте текст ответа и, при необходимости, фото или файл.',
  empty: 'Ответ должен содержать текст.\n\nОтправьте текст ответа одним сообщением.',
} as const;

export class AnswerService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly history: IncidentHistoryService,
    private readonly state: IncidentStateService,
    private readonly media: MediaService,
    private readonly review: ReviewService,
    private readonly distribution: DistributionService,
  ) {}

  validate(text: string, media: IncomingMedia[] = []): { text: string } {
    if (media.some((item) => item.kind === 'VIDEO')) {
      throw new ValidationError(ANSWER_REJECTIONS.video, { reason: 'video' });
    }
    if (isBlank(text)) {
      throw new ValidationError(ANSWER_REJECTIONS.empty, { reason: 'empty' });
    }
    return { text: text.trim() };
  }

  /** Pre-fill offered by "Использовать шаблон" (§27). */
  templateFor(incident: IncidentWithRelations): string | null {
    const template = incident.assignedGroup?.answerTemplate;
    if (!template) return null;
    return renderTemplate(template, { incidentCode: incident.publicCode });
  }

  /**
   * Store a new answer version. Ordinary groups send it to review; the
   * regional group completes and delivers it immediately.
   *
   * Versioning and the status change happen in one transaction under an
   * advisory lock on the incident, so two responders finishing at the same
   * moment cannot both create version N or both move the incident to review.
   * Previous versions are never overwritten or deleted (§67).
   */
  async submit(
    incidentId: string,
    actor: Actor,
    rawText: string,
    media: IncomingMedia[] = [],
  ): Promise<{
    incident: IncidentWithRelations;
    answer: IncidentAnswer;
    sentDirectly: boolean;
    deliveryFailed: boolean;
    deliveryQueued: boolean;
  }> {
    const { text } = this.validate(rawText, media);

    const before = await this.repository.findById(incidentId);
    if (!before) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (!SUBMITTABLE.includes(before.status)) {
      throw new ConflictError(
        `Для ${before.publicCode} сейчас нельзя подготовить ответ (статус: ${before.status}).`,
      );
    }
    const direct = Boolean(before.assignedGroup?.bypassReview);
    const targetStatus = direct ? IncidentStatus.RESOLVED : IncidentStatus.WAITING_REVIEW;
    this.state.assertTransition(before.status, targetStatus, { incidentId });
    const answeredAt = direct ? new Date() : null;

    const answerId = randomUUID();
    const stored = await this.media.ingestAll(`answers/${answerId}`, media.filter(m => m.kind === 'IMAGE' || m.kind === 'FILE'));
    const answer = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, 'incident-answer', incidentId);

      const current = await tx.incident.findUnique({ where: { id: incidentId } });
      if (!current) throw new NotFoundError(`Incident ${incidentId} not found`);
      if (!SUBMITTABLE.includes(current.status)) {
        throw new ConflictError(
          `Для ${current.publicCode} сейчас нельзя подготовить ответ (статус: ${current.status}).`,
        );
      }

      const latest = await tx.incidentAnswer.findFirst({
        where: { incidentId },
        orderBy: { version: 'desc' },
      });
      const version = (latest?.version ?? 0) + 1;

      const created = await tx.incidentAnswer.create({
        data: {
          id: answerId,
          incidentId,
          version,
          text,
          createdByUserId: actor.userId,
          status: direct ? AnswerStatus.APPROVED : AnswerStatus.WAITING_REVIEW,
          approvedAt: answeredAt,
        },
      });

      const moved = await this.repository.transition(tx, incidentId, SUBMITTABLE, {
        status: targetStatus,
        reviewMessageId: null,
        currentResponderId: actor.userId,
        answeredAt,
        // deadlineAt is deliberately absent here and everywhere else after
        // creation: rework must never extend the SLA (§13, §33).
      });
      if (!moved) {
        throw new ConflictError(`Статус ${current.publicCode} изменился, ответ не сохранён. Повторите попытку.`);
      }

      await this.history.record(
        {
          incidentId,
          action: HistoryAction.ANSWER_CREATED,
          actorMaxUserId: actor.maxUserId,
          actorRole: actor.role,
          metadata: { answerId: created.id, version },
        },
        tx,
      );
      await this.history.record(
        direct
          ? {
              incidentId,
              action: HistoryAction.ANSWER_SENT_DIRECT,
              fromStatus: current.status,
              toStatus: IncidentStatus.RESOLVED,
              actorMaxUserId: actor.maxUserId,
              actorRole: actor.role,
              metadata: { answerId: created.id, version, bypassReview: true },
            }
          : {
              incidentId,
              action: HistoryAction.SENT_TO_REVIEW,
              fromStatus: current.status,
              toStatus: IncidentStatus.WAITING_REVIEW,
              actorMaxUserId: actor.maxUserId,
              actorRole: actor.role,
              metadata: { answerId: created.id, version },
            },
        tx,
      );

      await this.attachMedia(tx, created.id, stored);
      await queueAnswer(tx, incidentId, created.id, direct);
      if (direct) await queueDeliveryStatus(tx, incidentId, created.id, false);
      return created;
    }, TRANSACTION_OPTIONS);


    log.info(
      incidentLogFields({
        incidentId,
        publicCode: before.publicCode,
        maxUserId: actor.maxUserId,
        action: direct ? HistoryAction.ANSWER_SENT_DIRECT : HistoryAction.SENT_TO_REVIEW,
      }),
      direct ? 'regional answer completed without review' : 'answer submitted for review',
    );

    const incident = (await this.repository.findById(incidentId))!;
    let deliveryFailed = false;
    let deliveryQueued = false;
    if (direct) {
      try {
        deliveryQueued = (await this.review.deliverApprovedAnswer(incident, answer)) === 'queued';
      } catch (error) {
        await this.history.record({
          incidentId,
          action: HistoryAction.DELIVERY_FAILED,
          actorMaxUserId: actor.maxUserId,
          metadata: { answerId: answer.id, error: error instanceof Error ? error.message : String(error) },
        });
        deliveryFailed = true;
      }
      if (!deliveryFailed && !deliveryQueued) {
        await this.distribution.markWorked((await this.repository.findById(incidentId))!);
      }
    } else {
      await this.review.publishCard(incidentId, answer.id);
    }

    return { incident, answer, sentDirectly: direct, deliveryFailed, deliveryQueued };
  }

  private async attachMedia(tx: Tx, answerId: string, stored: StoredMedia[]): Promise<void> {
    if (stored.length === 0) return;
    await tx.answerAttachment.createMany({
      data: stored.map((item) => ({
        answerId,
        type: item.type === 'IMAGE' ? AttachmentType.IMAGE : AttachmentType.FILE,
        storageKey: item.storageKey,
        mimeType: item.mimeType ?? null,
        originalName: item.originalName ?? null,
        size: item.size,
        sourceUrl: item.sourceUrl ?? null,
        maxToken: item.maxToken ?? null,
      })),
    });
  }
}
