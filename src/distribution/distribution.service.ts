import { type Category, IncidentStatus, type PrismaClient } from '@prisma/client';

import type { IncidentClassifier } from '../ai/classifier.interface';
import type { ModerationService } from '../ai/moderation.interface';
import { distributionKeyboard } from '../bot/keyboards';
import { codeLabel, distributionCard, distributionResolvedNotice, rejectionToRequester } from '../bot/views/cards';
import type { CategoryService } from '../categories/category.service';
import { getConfig } from '../config';
import type { RequesterDeliveryService } from '../delivery/requester-delivery.service';
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

const log = moduleLogger('distribution');

export type Actor = {
  userId: string;
  maxUserId: bigint;
  displayName: string;
  role: string;
};

/** The чат распределения: every incident lands here first (§16-§19). */
export class DistributionService {
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
    private readonly classifier: IncidentClassifier,
    private readonly moderation: ModerationService,
  ) {}

  chatId(): bigint {
    const chatId = getConfig().DISTRIBUTION_CHAT_ID;
    if (chatId === undefined) {
      throw new AppError('DISTRIBUTION_CHAT_ID не настроен.', 'CONFIG_MISSING');
    }
    return chatId;
  }

  /**
   * Run classification + moderation, then publish the card.
   *
   * AI failures are swallowed inside the services themselves, so a dead LLM
   * simply produces a card with "AI-подсказка: нет предположений".
   */
  async processNewIncident(incidentId: string): Promise<void> {
    const categories = await this.categories.listActive();

    if (this.classifier.enabled) {
      const incident = await this.repository.findById(incidentId);
      if (incident) {
        const result = await this.classifier.classify(incident.text, categories);
        if (result.suggestions.length > 0) {
          await this.incidents.applyClassification(incidentId, result);
        }
      }
    }

    if (this.moderation.enabled) {
      const incident = await this.repository.findById(incidentId);
      if (incident) {
        await this.incidents.applyModeration(incidentId, await this.moderation.analyze(incident.text));
      }
    }

    await this.publishCard(incidentId);
  }

  async publishCard(incidentId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    const categoriesById = new Map((await this.categories.listAll()).map((item) => [item.id, item]));

    const { firstMessageId } = await this.messages.send(
      { chatId: this.chatId() },
      {
        text: distributionCard(incident, { categoriesById, aiEnabled: getConfig().AI_ENABLED }),
        label: codeLabel(incident),
        keyboard: distributionKeyboard(incident.id),
        attachments: await loadOutboundAttachments(this.media, incident.attachments),
      },
    );

    await this.incidents.setDistributionMessageId(incident.id, firstMessageId);
    await this.history.record({
      incidentId: incident.id,
      action: HistoryAction.DISTRIBUTION_CARD_SENT,
      metadata: { messageId: firstMessageId ?? null },
    });
    log.info(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        chatId: this.chatId(),
        action: HistoryAction.DISTRIBUTION_CARD_SENT,
      }),
      'distribution card published',
    );
  }

  /**
   * Sector list for the "Распределить" step, with the AI pick highlighted.
   *
   * Only сферы with a configured chat are offered: routing into a сфера with
   * nowhere to publish would fail after the click, which is worse than not
   * showing it. `hiddenCount` lets the caller say so out loud.
   */
  async assignmentOptions(
    incident: IncidentWithRelations,
  ): Promise<{ categories: Category[]; recommendedId: string | null; hiddenCount: number }> {
    const [routable, active] = await Promise.all([
      this.categories.listRoutable(),
      this.categories.listActive(),
    ]);
    return {
      categories: routable,
      recommendedId: incident.aiSuggestedCategoryId,
      hiddenCount: active.length - routable.length,
    };
  }

  /**
   * Route the incident to a сфера (§17-§18).
   *
   * The status check lives inside the UPDATE predicate, so if two dispatchers
   * press the button at the same moment exactly one UPDATE matches a row and
   * the loser is told who won. One incident can never reach two sectors.
   */
  async assign(incidentId: string, categoryId: string, actor: Actor): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    if (incident.status !== IncidentStatus.DISTRIBUTION) {
      throw new ConflictError(this.alreadyHandledMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.ASSIGNED, { incidentId });

    const category = await this.categories.requireActiveById(categoryId);
    this.categories.requireChatId(category);

    const now = new Date();
    const claimed = await this.repository.transition(this.prisma, incidentId, IncidentStatus.DISTRIBUTION, {
      status: IncidentStatus.ASSIGNED,
      assignedCategoryId: category.id,
      assignedByUserId: actor.userId,
      assignedAt: now,
    });
    if (!claimed) {
      const fresh = await this.repository.findById(incidentId);
      throw new ConflictError(this.alreadyHandledMessage(fresh ?? incident));
    }

    await this.history.record({
      incidentId,
      action: HistoryAction.ASSIGNED,
      fromStatus: IncidentStatus.DISTRIBUTION,
      toStatus: IncidentStatus.ASSIGNED,
      actorMaxUserId: actor.maxUserId,
      actorRole: actor.role,
      metadata: { categoryId: category.id, categoryCode: category.code, dispatcher: actor.displayName },
    });

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.ASSIGNED,
      }),
      'incident assigned to sector',
    );

    // §58: the distribution card stops offering buttons once it is routed.
    if (incident.distributionMessageId) {
      await this.messages.finalizeCard(
        incident.distributionMessageId,
        distributionResolvedNotice(incident, category, actor.displayName),
      );
    }

    await this.sector.publishCard(incidentId);
    return (await this.repository.findById(incidentId))!;
  }

  /** §19 — reject with a mandatory reason and tell the requester. */
  async reject(incidentId: string, reason: string, actor: Actor): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    if (incident.status !== IncidentStatus.DISTRIBUTION) {
      throw new ConflictError(this.alreadyHandledMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.REJECTED, { incidentId });

    const claimed = await this.repository.transition(this.prisma, incidentId, IncidentStatus.DISTRIBUTION, {
      status: IncidentStatus.REJECTED,
      rejectionReason: reason,
      answeredAt: new Date(),
    });
    if (!claimed) {
      const fresh = await this.repository.findById(incidentId);
      throw new ConflictError(this.alreadyHandledMessage(fresh ?? incident));
    }

    await this.history.record({
      incidentId,
      action: HistoryAction.INCIDENT_REJECTED,
      fromStatus: IncidentStatus.DISTRIBUTION,
      toStatus: IncidentStatus.REJECTED,
      actorMaxUserId: actor.maxUserId,
      actorRole: actor.role,
      metadata: { reason, dispatcher: actor.displayName },
    });

    await this.delivery.notify(incidentId, rejectionToRequester(incident, reason));

    if (incident.distributionMessageId) {
      await this.messages.finalizeCard(
        incident.distributionMessageId,
        [
          `❌ ${incident.publicCode} отклонено`,
          '',
          'Причина:',
          reason,
          '',
          'Отклонил:',
          actor.displayName,
        ].join('\n'),
      );
    }

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.INCIDENT_REJECTED,
      }),
      'incident rejected',
    );
    return (await this.repository.findById(incidentId))!;
  }

  /** Plain notice into the distribution chat. */
  async notify(text: string): Promise<void> {
    await this.messages.send({ chatId: this.chatId() }, { text });
  }

  private alreadyHandledMessage(incident: IncidentWithRelations): string {
    if (incident.status === IncidentStatus.REJECTED) {
      return `Обращение ${incident.publicCode} уже отклонено.`;
    }
    const who = incident.assignedBy?.displayName;
    const where = incident.assignedCategory?.name;
    if (who || where) {
      return `Обращение ${incident.publicCode} уже распределено${where ? ` в «${where}»` : ''}${
        who ? ` пользователем ${who}` : ''
      }.`;
    }
    return `Обращение ${incident.publicCode} уже обработано.`;
  }
}
