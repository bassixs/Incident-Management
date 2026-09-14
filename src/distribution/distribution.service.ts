import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { randomUUID } from 'node:crypto';
import { assertClaimOwner, CLAIM_LOCK } from './queue-state';
import { queueSector, queueRejection, queueDistributionRefresh } from '../delivery/workflow-outbox';
import {
  IncidentStatus,
  type PrismaClient,
  type ResponsibleGroup,
  ResponsibleGroupKind,
} from '@prisma/client';

import { distributionKeyboard } from '../bot/keyboards';
import {
  codeLabel,
  distributionCard,
  distributionResolvedNotice,
  distributionWorkedNotice,
  rejectionToRequester,
} from '../bot/views/cards';
import { getConfig } from '../config';
import type { RequesterDeliveryService } from '../delivery/requester-delivery.service';
import type { ResponsibleGroupService } from '../responsible-groups/responsible-group.service';
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
import { MAX_REJECTION_LENGTH } from './rejection-reasons';

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
    private readonly groups: ResponsibleGroupService,
    private readonly messages: MaxMessageService,
    private readonly media: MediaService,
    private readonly sector: SectorService,
    private readonly delivery: RequesterDeliveryService,
  ) {}

  chatId(): bigint {
    const chatId = getConfig().DISTRIBUTION_CHAT_ID;
    if (chatId === undefined) {
      throw new AppError('DISTRIBUTION_CHAT_ID не настроен.', 'CONFIG_MISSING');
    }
    return chatId;
  }

  async publishCard(incidentId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    const result = await this.messages.send(
      { chatId: this.chatId() },
      {
        text: distributionCard(incident),
        label: codeLabel(incident),
        keyboard: distributionKeyboard(incident.id),
        attachments: await loadOutboundAttachments(this.media, incident.attachments),
        delivery: {
          dedupeKey: `distribution-card:${incident.id}`,
          tracking: { type: 'DISTRIBUTION_CARD', incidentId: incident.id },
        },
      },
    );

    if (result.state === 'sent' && !result.trackingApplied) {
      await this.incidents.setDistributionMessageId(incident.id, result.firstMessageId);
      await this.history.record({
        incidentId: incident.id,
        action: HistoryAction.DISTRIBUTION_CARD_SENT,
        metadata: { messageId: result.firstMessageId ?? null },
      });
    }
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
   * Sector list for the "Распределить" step.
   *
   * Only сферы with a configured chat are offered: routing into a сфера with
   * nowhere to publish would fail after the click, which is worse than not
   * showing it. `hiddenCount` lets the caller say so out loud.
   */
  async assignmentOptions(
    kind: ResponsibleGroupKind,
  ): Promise<{ groups: ResponsibleGroup[]; hiddenCount: number }> {
    const [routable, activeCount] = await Promise.all([
      this.groups.listRoutable(kind),
      this.groups.countActive(kind),
    ]);
    return { groups: routable, hiddenCount: activeCount - routable.length };
  }

  async recommendedGroup(municipalityCode: string | null): Promise<ResponsibleGroup | null> {
    const group = await this.groups.findByMunicipalityCode(municipalityCode);
    return group?.isActive && group.maxChatId !== null ? group : null;
  }

  async changeTopic(incidentId: string, categoryId: string | null, actor: Actor): Promise<IncidentWithRelations> {
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const incident = await this.repository.findById(incidentId, tx);
      if (!incident) throw new NotFoundError('Обращение не найдено.');
      if (incident.status !== 'DISTRIBUTION') throw new ConflictError('Тему можно изменить только до распределения обращения.');
      assertClaimOwner(incident, actor.maxUserId);
      const category = categoryId ? await tx.category.findFirst({ where: { id: categoryId, isActive: true } }) : null;
      if (categoryId && !category) throw new NotFoundError('Выбранная тема больше недоступна. Откройте список заново.');
      if (incident.userSelectedCategoryId === categoryId) return;
      await tx.incident.update({ where: { id: incidentId }, data: { userSelectedCategoryId: categoryId } });
      await this.history.record({ incidentId, action: 'TOPIC_CHANGED', actorMaxUserId: actor.maxUserId, actorRole: actor.role,
        metadata: { previousCategoryId: incident.userSelectedCategoryId, previousCategoryName: incident.userSelectedCategory?.name ?? 'Иное', categoryId, categoryName: category?.name ?? 'Иное' } }, tx);
      await queueDistributionRefresh(tx, incidentId, `topic:${randomUUID()}`, true);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
    return (await this.repository.findById(incidentId))!;
  }

  /**
   * Route the incident to a сфера (§17-§18).
   *
   * The status check lives inside the UPDATE predicate, so if two dispatchers
   * press the button at the same moment exactly one UPDATE matches a row and
   * the loser is told who won. One incident can never reach two sectors.
   */
  async assign(incidentId: string, groupId: string, actor: Actor): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    if (incident.status !== IncidentStatus.DISTRIBUTION) {
      throw new ConflictError(this.alreadyHandledMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.ASSIGNED, { incidentId });

    const group = await this.groups.requireActiveById(groupId);
    this.groups.requireChatId(group);

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      assertClaimOwner(await tx.incident.findUniqueOrThrow({ where: { id: incidentId } }), actor.maxUserId);
      const claimed = await this.repository.transition(tx, incidentId, IncidentStatus.DISTRIBUTION, {
        status: IncidentStatus.ASSIGNED,
        assignedGroupId: group.id,
        assignedByUserId: actor.userId,
        assignedAt: now,
        distributionClaimedBy: null, distributionClaimedName: null, distributionClaimUntil: null,
      });
      if (!claimed) {
        const fresh = await this.repository.findById(incidentId, tx);
        throw new ConflictError(this.alreadyHandledMessage(fresh ?? incident));
      }

      await this.history.record({
        incidentId,
        action: HistoryAction.ASSIGNED,
        fromStatus: IncidentStatus.DISTRIBUTION,
        toStatus: IncidentStatus.ASSIGNED,
        actorMaxUserId: actor.maxUserId,
        actorRole: actor.role,
        metadata: { groupId: group.id, groupCode: group.code, dispatcher: actor.displayName },
      }, tx);
      await queueSector(tx, incidentId);
      await queueDistributionRefresh(tx, incidentId, `assigned:${randomUUID()}`);
    }, TRANSACTION_OPTIONS);

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
        distributionResolvedNotice(incident, group, actor.displayName),
      );
    }

    await this.sector.publishCard(incidentId);
    await this.messages.flush();
    return (await this.repository.findById(incidentId))!;
  }

  /** Keep the routing indicator unchanged when the answer reaches the requester. */
  async markWorked(incident: IncidentWithRelations): Promise<void> {
    if (!incident.distributionMessageId || !incident.assignedGroup || !incident.answers.some(a => a.deliveredAt)) return;
    await this.messages.finalizeCard(
      incident.distributionMessageId,
      distributionWorkedNotice(incident, incident.assignedGroup),
    );
  }

  /** §19 — reject with a mandatory reason and tell the requester. */
  async reject(incidentId: string, reason: string, actor: Actor, draft?: { sessionId: string; token: string; chatId: bigint }): Promise<IncidentWithRelations> {
    if (!reason.trim() || Array.from(reason).length > MAX_REJECTION_LENGTH) throw new ConflictError(`Причина отклонения должна содержать от 1 до ${MAX_REJECTION_LENGTH} символов.`);
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    if (incident.status !== IncidentStatus.DISTRIBUTION) {
      throw new ConflictError(this.alreadyHandledMessage(incident));
    }
    this.state.assertTransition(incident.status, IncidentStatus.REJECTED, { incidentId });

    await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      const current = await tx.incident.findUniqueOrThrow({ where: { id: incidentId } });
      assertClaimOwner(current, actor.maxUserId);
      if (draft) {
        const session = await tx.operatorSession.findUnique({ where: { id: draft.sessionId } });
        const data = session?.data as { rejectionToken?: string; rejectionStage?: string; reason?: string; distributionLeaseUntil?: string } | null;
        if (!session || session.type !== 'WAITING_REJECTION_REASON' || session.maxUserId !== actor.maxUserId || session.chatId !== draft.chatId ||
          session.incidentId !== incidentId || session.expiresAt <= new Date() || data?.rejectionToken !== draft.token || data.rejectionStage !== 'preview' || data.reason !== reason ||
          current.distributionClaimedBy !== actor.maxUserId || !current.distributionClaimUntil || current.distributionClaimUntil <= new Date() ||
          current.distributionClaimUntil.toISOString() !== data.distributionLeaseUntil) throw new ConflictError('Карточка отклонения устарела. Откройте обращение через /queue.');
        await tx.operatorSession.delete({ where: { id: session.id } });
      }
      const claimed = await this.repository.transition(tx, incidentId, IncidentStatus.DISTRIBUTION, {
        status: IncidentStatus.REJECTED,
        rejectionReason: reason,
        distributionClaimedBy: null, distributionClaimedName: null, distributionClaimUntil: null,
        answeredAt: new Date(),
      });
      if (!claimed) {
        const fresh = await this.repository.findById(incidentId, tx);
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
      }, tx);
      await queueRejection(tx, incidentId, reason);
      await queueDistributionRefresh(tx, incidentId, 'rejected', true);
    }, TRANSACTION_OPTIONS);

    await this.delivery.notify(
      incidentId,
      rejectionToRequester(incident, reason),
      [],
      `rejection:${incident.id}`,
    );

    if (incident.distributionMessageId) {
      await this.messages.finalizeCard(
        incident.distributionMessageId,
        [
          '🔴 НЕ РАСПРЕДЕЛЕНО',
          `${incident.publicCode} отклонено`,
          '',
          'Причина:',
          reason,
          '',
          'Отклонил:',
          actor.displayName,
        ].join('\n'),
      );
    }
    await this.messages.flush();

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
  async notify(text: string, dedupeKey?: string): Promise<void> {
    await this.messages.send({ chatId: this.chatId() }, { text, ...(dedupeKey ? { delivery: { dedupeKey } } : {}) });
  }

  private alreadyHandledMessage(incident: IncidentWithRelations): string {
    if (incident.status === IncidentStatus.REJECTED) {
      return `Обращение ${incident.publicCode} уже отклонено.`;
    }
    const who = incident.assignedBy?.displayName;
    const where = incident.assignedGroup?.name;
    if (who || where) {
      return `Обращение ${incident.publicCode} уже распределено${where ? ` в «${where}»` : ''}${
        who ? ` пользователем ${who}` : ''
      }.`;
    }
    return `Обращение ${incident.publicCode} уже обработано.`;
  }
}
