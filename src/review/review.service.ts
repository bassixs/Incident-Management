import { queueDeliveryStatus, reviewDeliveryNotice, answerDeliveredNotice } from '../delivery/delivery-status';
import type { DeliveryOutcome } from '../delivery/requester-delivery.service';
import { TRANSACTION_OPTIONS } from '../database/prisma';
import { assertReviewReservation } from '../work-queues/state';
import { queueAnswer, queueRevision, queueStaffRefresh } from '../delivery/workflow-outbox';
import { AnswerStatus, type IncidentAnswer, IncidentStatus, type PrismaClient, type OperatorSession } from '@prisma/client';
import { assertReviewEdit, assertNoReviewEdit, reviewEditDraft, staleReviewEdit } from './review-edit';

import { reviewKeyboard } from '../bot/keyboards';
import { codeLabel, finalAnswerToRequester, reviewCard } from '../bot/views/cards';
import { getConfig } from '../config';
import type { RequesterDeliveryService } from '../delivery/requester-delivery.service';
import type { Actor, DistributionService } from '../distribution/distribution.service';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentStateService } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import type { IncidentService } from '../incidents/incident.service';
import { loadOutboundAttachments } from '../media/attachment-loader';
import type { MediaService } from '../media/media.service';
import type { MaxMessageService } from '../max/max-message.service';
import type { ResponsibleGroupService } from '../responsible-groups/responsible-group.service';
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
    private readonly groups: ResponsibleGroupService,
    private readonly messages: MaxMessageService,
    private readonly media: MediaService,
    private readonly sector: SectorService,
    private readonly delivery: RequesterDeliveryService,
    private readonly distribution: DistributionService,
  ) {}

  chatId(): bigint {
    const chatId = getConfig().REVIEW_CHAT_ID;
    if (chatId === undefined) {
      throw new AppError('REVIEW_CHAT_ID не настроен.', 'CONFIG_MISSING');
    }
    return chatId;
  }

  /** Preserve the executor's original answer and attachments as an immutable version. */
  async saveCorrection(session: OperatorSession, actor: Actor): Promise<IncidentAnswer> {
    if (session.maxUserId !== actor.maxUserId || session.chatId !== this.chatId()) throw staleReviewEdit();
    const data = reviewEditDraft(session);
    if (data.editStage !== 'preview' || !data.text.trim() || data.text.length > 12000) throw staleReviewEdit();
    return this.prisma.$transaction(async tx => {
      const previous = await assertReviewEdit(tx, session);
      if (!await this.repository.transition(tx, session.incidentId!, IncidentStatus.WAITING_REVIEW, { status: IncidentStatus.WAITING_REVIEW })) throw staleReviewEdit();
      const answer = await tx.incidentAnswer.create({ data: {
        incidentId: previous.incidentId, version: previous.version + 1, text: data.text.trim(),
        createdByUserId: previous.createdByUserId, status: AnswerStatus.WAITING_REVIEW,
        attachments: { create: previous.attachments.map(a => ({ type: a.type, storageKey: a.storageKey, mimeType: a.mimeType,
          originalName: a.originalName, size: a.size, sourceUrl: a.sourceUrl, maxToken: a.maxToken })) },
      } });
      // Approval and correction use the same lock; a consumed preview cannot be saved twice.
      const consumed = await tx.operatorSession.deleteMany({ where: { id: session.id, data: { equals: session.data! } } });
      if (!consumed.count) throw staleReviewEdit();
      await this.history.record({ incidentId: previous.incidentId, action: HistoryAction.ANSWER_EDITED_BY_REVIEWER,
        actorMaxUserId: actor.maxUserId, actorRole: actor.role,
        metadata: { previousAnswerId: previous.id, answerId: answer.id, version: answer.version, approver: actor.displayName },
      }, tx);
      await queueAnswer(tx, previous.incidentId, answer.id, false);
      await queueStaffRefresh(tx, previous.incidentId);
      if (data.privateWorkspaceId) {
        const fresh = (await this.repository.findById(previous.incidentId, tx))!;
        await tx.privateWorkItem.updateMany({ where: { id: data.privateWorkspaceId, maxUserId: actor.maxUserId, incidentId: previous.incidentId, originChatId: session.chatId },
          data: { data: { cycle: `${fresh.history[0]?.id ?? 'initial'}:${answer.id}`, leaseUntil: data.leaseUntil } } });
      }
      return answer;
    }, TRANSACTION_OPTIONS);
  }

  /** Shared delivery path for reviewed and explicitly review-free answers. */
  async deliverApprovedAnswer(
    incident: IncidentWithRelations,
    answer: IncidentAnswer,
  ): Promise<DeliveryOutcome> {
    return this.delivery.deliverAnswer(
      incident.id,
      answer.id,
      finalAnswerToRequester(
        incident,
        answer,
        incident.answeredAt ?? answer.approvedAt ?? new Date(),
        incident.assignedGroup?.authorityName,
      ),
    );
  }

  async publishCard(incidentId: string, answerId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    const answer = incident.answers.find((item) => item.id === answerId);
    if (!answer) throw new NotFoundError(`Answer ${answerId} not found on ${incidentId}`);

    const result = await this.messages.send(
      { chatId: this.chatId() },
      {
        text: reviewCard(incident, answer, incident.assignedGroup),
        label: codeLabel(incident),
        keyboard: reviewKeyboard(incident.id, answer.id),
        attachments: await loadOutboundAttachments(this.media, answer.attachments),
        delivery: {
          dedupeKey: `review-card:${answer.id}`,
          tracking: { type: 'REVIEW_CARD', incidentId: incident.id, answerId: answer.id },
        },
      },
    );

    if (result.state === 'sent' && !result.trackingApplied) {
      await this.incidents.setReviewMessageId(incident.id, result.firstMessageId);
    }
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
  async approve(incidentId: string, actor: Actor, expectedAnswerId?: string): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (incident.status !== IncidentStatus.WAITING_REVIEW) {
      throw new ConflictError(this.alreadyReviewedMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.RESOLVED, { incidentId });

    const answer = incident.answers.at(-1);
    if (!answer) throw new ConflictError(`Для ${incident.publicCode} нет подготовленного ответа.`);
    if (expectedAnswerId !== undefined && answer.id !== expectedAnswerId) {
      throw new ConflictError('Эта версия ответа устарела. Откройте последнюю карточку согласования.');
    }

    const answeredAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await assertReviewReservation(tx, incidentId, actor.maxUserId);
      await assertNoReviewEdit(tx, incidentId, actor.maxUserId);
      const claimed = await this.repository.transition(tx, incidentId, IncidentStatus.WAITING_REVIEW, {
        status: IncidentStatus.RESOLVED,
        answeredAt,
        approvedByUserId: actor.userId,
        // deadlineAt untouched — see §33.
      });
      if (!claimed) {
        const fresh = await this.repository.findById(incidentId, tx);
        throw new ConflictError(this.alreadyReviewedMessage(fresh ?? incident));
      }

      const latest = await this.repository.latestAnswer(incidentId, tx);
      if (latest?.id !== answer.id || latest.status !== AnswerStatus.WAITING_REVIEW) {
        throw new ConflictError('Версия ответа изменилась. Откройте последнюю карточку согласования.');
      }
      await tx.incidentAnswer.update({
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
      }, tx);
      await queueAnswer(tx, incidentId, answer.id, true);
      await queueDeliveryStatus(tx, incidentId, answer.id, false);
    }, TRANSACTION_OPTIONS);

    let outcome: DeliveryOutcome;
    try {
      outcome = await this.deliverApprovedAnswer({ ...incident, answeredAt }, { ...answer, approvedAt: answeredAt });
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

    const fresh = (await this.repository.findById(incidentId))!;
    const deliveredAnswer = fresh.answers.find(a => a.id === answer.id)!;
    if (outcome !== 'queued') {
      if (fresh.reviewMessageId) await this.messages.finalizeStaffCard(fresh.reviewMessageId, `${reviewDeliveryNotice(fresh, deliveredAnswer)}\n\n${deliveredAnswer.text}`);
      await this.distribution.markWorked(fresh);
      await this.sector.notify(fresh, answerDeliveredNotice(fresh, deliveredAnswer), `answer-delivered:${answer.id}:sector`);
    } else {
      await this.sector.notify(fresh, `⏳ ${incident.publicCode}: ответ согласован, ожидает доставки пользователю.`, `answer-queued:${answer.id}:sector`);
    }

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.ANSWER_APPROVED,
      }),
      outcome === 'queued' ? 'answer approved and queued' : 'answer approved and delivered',
    );

    return (await this.repository.findById(incidentId))!;
  }

  /** "↩️ На доработку" (§32). The deadline is explicitly left alone. */
  async requestRevision(incidentId: string, reason: string, actor: Actor, expectedAnswerId?: string): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (incident.status !== IncidentStatus.WAITING_REVIEW) {
      throw new ConflictError(this.alreadyReviewedMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.REVISION_REQUIRED, { incidentId });

    const answer = incident.answers.at(-1);
    if (!answer) throw new ConflictError(`Для ${incident.publicCode} нет подготовленного ответа.`);
    if (expectedAnswerId !== undefined && answer.id !== expectedAnswerId) {
      throw new ConflictError('Эта версия ответа устарела. Откройте последнюю карточку согласования.');
    }

    await this.prisma.$transaction(async (tx) => {
      await assertReviewReservation(tx, incidentId, actor.maxUserId);
      await assertNoReviewEdit(tx, incidentId, actor.maxUserId);
      const claimed = await this.repository.transition(tx, incidentId, IncidentStatus.WAITING_REVIEW, {
        status: IncidentStatus.REVISION_REQUIRED,
        revisionReason: reason,
        revisionCount: { increment: 1 },
        // deadlineAt untouched — rework never extends the SLA (§13, §33).
      });
      if (!claimed) {
        const fresh = await this.repository.findById(incidentId, tx);
        throw new ConflictError(this.alreadyReviewedMessage(fresh ?? incident));
      }

      const latest = await this.repository.latestAnswer(incidentId, tx);
      if (latest?.id !== answer.id || latest.status !== AnswerStatus.WAITING_REVIEW) {
        throw new ConflictError('Версия ответа изменилась. Откройте последнюю карточку согласования.');
      }
      await tx.incidentAnswer.update({
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
      }, tx);
      await queueRevision(tx, incidentId, answer.version, reason);
    }, TRANSACTION_OPTIONS);

    const updated = (await this.repository.findById(incidentId))!;
    if (updated.assignedGroup) {
      await this.sector.publishRevision(updated, updated.assignedGroup, answer.version, reason);
    }
    if (incident.reviewMessageId) {
      await this.messages.finalizeStaffCard(
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
          '⚠️ Срок ответа НЕ изменён.',
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
  async resend(incidentId: string): Promise<DeliveryOutcome> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    const answer = [...incident.answers].reverse().find((item) => item.status === AnswerStatus.APPROVED);
    if (!answer) throw new ConflictError(`У ${incident.publicCode} нет согласованного ответа.`);
    return this.deliverApprovedAnswer(incident, answer);
  }

  private alreadyReviewedMessage(incident: IncidentWithRelations): string {
    switch (incident.status) {
      case IncidentStatus.RESOLVED:
        return `Ответ по ${incident.publicCode} уже согласован${
          incident.approvedBy ? ` пользователем ${incident.approvedBy.displayName}` : ''
        }${incident.answers.some(a => a.deliveredAt) ? ' и доставлен.' : ', ожидает доставки.'}`;
      case IncidentStatus.REVISION_REQUIRED:
        return `${incident.publicCode} уже возвращено на доработку.`;
      default:
        return `${incident.publicCode} сейчас не находится на согласовании (статус: ${incident.status}).`;
    }
  }
}
