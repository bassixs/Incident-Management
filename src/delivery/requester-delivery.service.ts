import type { PrismaClient } from '@prisma/client';

import { codeLabel } from '../bot/views/cards';
import { answerRatingKeyboard } from '../bot/keyboards';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import { loadOutboundAttachments } from '../media/attachment-loader';
import type { MediaService } from '../media/media.service';
import type { MaxMessageService, OutboundAttachment } from '../max/max-message.service';
import { NotFoundError, ConflictError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';

const log = moduleLogger('delivery');
export type DeliveryOutcome = 'sent' | 'queued' | 'already-sent' | 'failed';

/**
 * The single place allowed to send anything to a requester.
 *
 * The recipient is ALWAYS derived as incident → requester → maxUserId, read
 * fresh from the database inside this service. No caller may pass a user id,
 * a chat id, a callback author or "the last active dialog" — that is exactly
 * the mistake that would deliver one person's answer to another person, and
 * the API of this class makes it impossible to make.
 */
export class RequesterDeliveryService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly history: IncidentHistoryService,
    private readonly messages: MaxMessageService,
    private readonly media: MediaService,
  ) {}

  private async loadIncident(incidentId: string): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    return incident;
  }

  /**
   * Resolve the recipient. Deliberately reads `incident.requester.maxUserId`
   * (the relation), falling back to the denormalised column only if the
   * relation is somehow missing.
   */
  private recipientOf(incident: IncidentWithRelations): bigint {
    return incident.requester?.maxUserId ?? incident.requesterMaxUserId;
  }

  /** Status notices: rejection, informational updates. */
  async notify(
    incidentId: string,
    text: string,
    attachments: OutboundAttachment[] = [],
    dedupeKey?: string,
  ): Promise<void> {
    const incident = await this.loadIncident(incidentId);
    const userId = this.recipientOf(incident);
    const result = await this.messages.send(
      { userId },
      {
        text,
        label: codeLabel(incident),
        attachments,
        ...(dedupeKey ? { delivery: { dedupeKey } } : {}),
      },
    );
    log.info(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        maxUserId: userId,
        action: 'REQUESTER_NOTIFIED',
      }),
      result.state === 'sent' ? 'requester notified' : 'requester notification queued',
    );
  }

  /**
   * Deliver an approved answer and its attachments (§31).
   * Idempotent per answer version: a second call is a no-op.
   */
  async deliverAnswer(incidentId: string, answerId: string, text: string, manualRetry?: { actorMaxUserId?: bigint }): Promise<DeliveryOutcome> {
    const incident = await this.loadIncident(incidentId);
    const answer = incident.answers.find((item) => item.id === answerId);
    if (!answer) throw new NotFoundError(`Answer ${answerId} does not belong to incident ${incidentId}`);
    if (manualRetry && (incident.status !== 'RESOLVED' || incident.answers.at(-1)?.id !== answerId || answer.status !== 'APPROVED')) {
      throw new ConflictError('Ответ больше не является актуальным согласованным ответом.');
    }
    if (answer.deliveredAt) {
      log.warn(
        incidentLogFields({ incidentId, publicCode: incident.publicCode, action: HistoryAction.ANSWER_SENT }),
        'answer already delivered, skipping duplicate send',
      );
      return 'already-sent';
    }

    if (manualRetry) await this.messages.retryFailedAnswer(incidentId, answerId, manualRetry.actorMaxUserId);

    const userId = this.recipientOf(incident);
    const attachments = await loadOutboundAttachments(this.media, answer.attachments);

    const result = await this.messages.send(
      { userId },
      {
        text,
        label: codeLabel(incident),
        attachments,
        keyboard: answerRatingKeyboard(incident.id),
        delivery: {
          dedupeKey: `answer:${answer.id}`,
          tracking: { type: 'ANSWER_TO_REQUESTER', incidentId, answerId: answer.id },
        },
      },
    );

    if (result.state === 'sent' && !result.trackingApplied && !this.messages.persistsDelivery) {
      await this.prisma.incidentAnswer.update({
        where: { id: answer.id },
        data: { deliveredAt: new Date() },
      });
      await this.history.record({
        incidentId,
        action: HistoryAction.ANSWER_SENT,
        metadata: {
          answerId: answer.id,
          version: answer.version,
          recipientMaxUserId: userId.toString(),
          attachments: attachments.length,
        },
      });
    }

    let outcome: DeliveryOutcome = result.state;
    if (this.messages.persistsDelivery) {
      const job = await this.prisma.outboundMessage.findUnique({ where: { dedupeKey: `answer:${answerId}` } });
      if (job?.status === 'FAILED' || (job?.status === 'SENT' && !job.trackingApplied)) outcome = 'failed';
      if (job?.status === 'SENT' && !(await this.prisma.incidentAnswer.findUnique({ where: { id: answerId } }))?.deliveredAt) outcome = 'failed';
    }
    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: userId,
        action: HistoryAction.ANSWER_SENT,
      }),
      outcome === 'failed' ? 'answer delivery requires attention' : outcome === 'sent' ? 'answer delivered to requester' : 'answer queued for requester delivery',
    );
    return outcome;
  }
}
