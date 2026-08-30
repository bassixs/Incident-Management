import { AnswerStatus, IncidentStatus, type PrismaClient } from '@prisma/client';

import { reviewKeyboard } from '../bot/keyboards';
import { codeLabel, finalAnswerToRequester, reviewCard } from '../bot/views/cards';
import type { CategoryService } from '../categories/category.service';
import { getConfig } from '../config';
import type { RequesterDeliveryService } from '../delivery/requester-delivery.service';
import type { Actor } from '../distribution/distribution.service';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentStateService } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import type { IncidentService } from '../incidents/incident.service';
import { loadOutboundAttachments } from '../media/attachment-loader';
import type { MediaService } from '../media/media.service';
import type { MaxMessageService } from '../max/max-message.service';
import type { SectorService } from '../sector/sector.service';
import { AppError, ConflictError, NotFoundError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';

const log = moduleLogger('review');

/** The чат согласования (§28-§32). */
export class ReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly incidents: IncidentService,
    private readonly history: IncidentHistoryService,
    private readonly state: IncidentStateService,
    private readonly categories: CategoryService,
    private readonly messages: MaxMessageService,
    private readonly media: MediaService,
    private readonly sector: SectorService,
    private readonly delivery: RequesterDeliveryService,
  ) {}

  chatId(): bigint {
    const chatId = getConfig().REVIEW_CHAT_ID;
    if (chatId === undefined) {
      throw new AppError('REVIEW_CHAT_ID не настроен.', 'CONFIG_MISSING');
    }
    return chatId;
  }

  async publishCard(incidentId: string, answerId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    const answer = incident.answers.find((item) => item.id === answerId);
    if (!answer) throw new NotFoundError(`Answer ${answerId} not found on ${incidentId}`);

    const { firstMessageId } = await this.messages.send(
      { chatId: this.chatId() },
      {
        text: reviewCard(incident, answer, incident.assignedCategory),
        label: codeLabel(incident),
        keyboard: reviewKeyboard(incident.id),
        attachments: await loadOutboundAttachments(this.media, answer.attachments),
      },
    );

    await this.incidents.setReviewMessageId(incident.id, firstMessageId);
    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        chatId: this.chatId(),
        action: HistoryAction.SENT_TO_REVIEW,
      }),
      'review card published',
    );
  }

  /**
   * "✅ Согласовать" (§30).
   *
   * The status claim happens first and atomically, so a second approver (or a
   * double tap) cannot cause a second delivery. Delivery itself is separately
   * idempotent through IncidentAnswer.deliveredAt.
   */
  async approve(incidentId: string, actor: Actor): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (incident.status !== IncidentStatus.WAITING_REVIEW) {
      throw new ConflictError(this.alreadyReviewedMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.RESOLVED, { incidentId });

    const answer = incident.answers.at(-1);
    if (!answer) throw new ConflictError(`Для ${incident.publicCode} нет подготовленного ответа.`);

    const answeredAt = new Date();
    const claimed = await this.repository.transition(this.prisma, incidentId, IncidentStatus.WAITING_REVIEW, {
      status: IncidentStatus.RESOLVED,
      answeredAt,
      approvedByUserId: actor.userId,
      // deadlineAt untouched — see §33.
    });
    if (!claimed) {
      const fresh = await this.repository.findById(incidentId);
      throw new ConflictError(this.alreadyReviewedMessage(fresh ?? incident));
    }

    await this.prisma.incidentAnswer.update({
      where: { id: answer.id },
      data: { status: AnswerStatus.APPROVED, approvedAt: answeredAt, approvedByUserId: actor.userId },
    });
    await this.history.record({
      incidentId,
      action: HistoryAction.ANSWER_APPROVED,
      fromStatus: IncidentStatus.WAITING_REVIEW,
      toStatus: IncidentStatus.RESOLVED,
      actorMaxUserId: actor.maxUserId,
      actorRole: actor.role,
      metadata: { answerId: answer.id, version: answer.version, approver: actor.displayName },
    });

    try {
      await this.delivery.deliverAnswer(
        incidentId,
        answer.id,
        finalAnswerToRequester(incident, answer, answeredAt),
      );
    } catch (error) {
      // The incident stays RESOLVED (it was approved), but the answer is not
      // marked delivered, so /resend can retry without touching the workflow.
      await this.history.record({
        incidentId,
        action: HistoryAction.DELIVERY_FAILED,
        actorMaxUserId: actor.maxUserId,
        metadata: { answerId: answer.id, error: error instanceof Error ? error.message : String(error) },
      });
      await this.messages.send(
        { chatId: this.chatId() },
        {
          text: `⚠️ ${incident.publicCode}: ответ согласован, но доставить его пользователю не удалось.\n\nПовторите отправку командой /resend ${incident.publicCode}.`,
        },
      );
      throw error;
    }

    if (incident.reviewMessageId) {
      await this.messages.finalizeCard(
        incident.reviewMessageId,
        [
          `✅ ${incident.publicCode} согласовано и отправлено пользователю.`,
          '',
          'Согласовал:',
          actor.displayName,
          '',
          'Версия ответа:',
          String(answer.version),
        ].join('\n'),
      );
    }
    await this.sector.notify(incident, `✅ ${incident.publicCode} согласовано и отправлено пользователю.`);

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.ANSWER_APPROVED,
      }),
      'answer approved and delivered',
    );

    return (await this.repository.findById(incidentId))!;
  }

  /** "↩️ На доработку" (§32). The deadline is explicitly left alone. */
  async requestRevision(incidentId: string, reason: string, actor: Actor): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (incident.status !== IncidentStatus.WAITING_REVIEW) {
      throw new ConflictError(this.alreadyReviewedMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.REVISION_REQUIRED, { incidentId });

    const answer = incident.answers.at(-1);
    if (!answer) throw new ConflictError(`Для ${incident.publicCode} нет подготовленного ответа.`);

    const claimed = await this.repository.transition(this.prisma, incidentId, IncidentStatus.WAITING_REVIEW, {
      status: IncidentStatus.REVISION_REQUIRED,
      revisionReason: reason,
      revisionCount: { increment: 1 },
      // deadlineAt untouched — rework never extends the SLA (§13, §33).
    });
    if (!claimed) {
      const fresh = await this.repository.findById(incidentId);
      throw new ConflictError(this.alreadyReviewedMessage(fresh ?? incident));
    }

    await this.prisma.incidentAnswer.update({
      where: { id: answer.id },
      data: { status: AnswerStatus.REVISION_REQUIRED, revisionReason: reason },
    });
    await this.history.record({
      incidentId,
      action: HistoryAction.REVISION_REQUESTED,
      fromStatus: IncidentStatus.WAITING_REVIEW,
      toStatus: IncidentStatus.REVISION_REQUIRED,
      actorMaxUserId: actor.maxUserId,
      actorRole: actor.role,
      metadata: { reason, answerId: answer.id, version: answer.version, approver: actor.displayName },
    });

    const updated = (await this.repository.findById(incidentId))!;
    if (updated.assignedCategory) {
      await this.sector.publishRevision(updated, updated.assignedCategory, answer.version, reason);
    }
    if (incident.reviewMessageId) {
      await this.messages.finalizeCard(
        incident.reviewMessageId,
        [
          `↩️ ${incident.publicCode} возвращено на доработку.`,
          '',
          'Причина:',
          reason,
          '',
          'Вернул:',
          actor.displayName,
          '',
          '⚠️ Дедлайн НЕ изменён.',
        ].join('\n'),
      );
    }

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.REVISION_REQUESTED,
      }),
      'answer returned for revision',
    );

    return updated;
  }

  /** Manual retry for an approved-but-undelivered answer. */
  async resend(incidentId: string): Promise<boolean> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    const answer = [...incident.answers].reverse().find((item) => item.status === AnswerStatus.APPROVED);
    if (!answer) throw new ConflictError(`У ${incident.publicCode} нет согласованного ответа.`);
    return this.delivery.deliverAnswer(
      incidentId,
      answer.id,
      finalAnswerToRequester(incident, answer, incident.answeredAt ?? answer.approvedAt ?? new Date()),
    );
  }

  private alreadyReviewedMessage(incident: IncidentWithRelations): string {
    switch (incident.status) {
      case IncidentStatus.RESOLVED:
        return `Ответ по ${incident.publicCode} уже согласован${
          incident.approvedBy ? ` пользователем ${incident.approvedBy.displayName}` : ''
        } и отправлен.`;
      case IncidentStatus.REVISION_REQUIRED:
        return `${incident.publicCode} уже возвращено на доработку.`;
      default:
        return `${incident.publicCode} сейчас не находится на согласовании (статус: ${incident.status}).`;
    }
  }
}
