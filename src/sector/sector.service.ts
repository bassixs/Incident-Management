import { randomUUID } from 'node:crypto';
import { leaseView, SECTOR_LEASE_ACTION, LEASE_MS, assertSectorReservation } from '../work-queues/leases';
import { acquireAdvisoryLock } from '../database/prisma';
import { CLAIM_LOCK } from '../distribution/queue-state';
import { queueDistributionRefresh, queueMessage, queueStaffRefresh } from '../delivery/workflow-outbox';
import { assertResponder } from '../bot/middleware/authorize';
import type { ResolvedActor } from '../bot/handlers/helpers';
import { TRANSACTION_OPTIONS } from '../database/prisma';
import { queueSectorRefresh } from '../delivery/workflow-outbox';
import {
  type Incident,
  IncidentStatus,
  type PrismaClient,
  type ResponsibleGroup,
} from '@prisma/client';

import { revisionKeyboard, sectorKeyboard } from '../bot/keyboards';
import { codeLabel, revisionCard, sectorCard } from '../bot/views/cards';
import { getConfig } from '../config';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentStateService } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import type { IncidentService } from '../incidents/incident.service';
import { loadOutboundAttachments } from '../media/attachment-loader';
import type { MediaService } from '../media/media.service';
import type { MaxMessageService } from '../max/max-message.service';
import type { ResponsibleGroupService } from '../responsible-groups/responsible-group.service';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';

const log = moduleLogger('sector');

/** Everything that happens inside a профильный чат (§21, §22, §32). */
export class SectorService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly incidents: IncidentService,
    private readonly history: IncidentHistoryService,
    private readonly state: IncidentStateService,
    private readonly groups: ResponsibleGroupService,
    private readonly messages: MaxMessageService,
    private readonly media: MediaService,
  ) {}

  /** Publish the incident card into the sector chat right after distribution. */
  async publishCard(incidentId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (!incident.assignedGroup) {
      throw new ValidationError('Обращение ещё не распределено.');
    }
    const chatId = this.groups.requireChatId(incident.assignedGroup);
    const config = getConfig();

    const result = await this.messages.send(
      { chatId },
      {
        text: sectorCard(incident, incident.assignedGroup, await leaseView(this.prisma, incidentId, SECTOR_LEASE_ACTION)),
        label: codeLabel(incident),
        keyboard: sectorKeyboard(incident.id, {
          hasTemplate: Boolean(incident.assignedGroup.answerTemplate),
          status: incident.status,
        }),
        attachments: await loadOutboundAttachments(this.media, incident.attachments),
        delivery: {
          dedupeKey: `sector-card:${incident.id}${incident.history?.[0] ? ':return:' + incident.history[0].id : ''}`,
          tracking: { type: 'SECTOR_CARD', incidentId: incident.id },
        },
      },
    );

    if (result.state === 'sent' && !result.trackingApplied) {
      await this.incidents.setSectorMessageId(incident.id, result.firstMessageId);
      await this.history.record({
        incidentId: incident.id,
        action: HistoryAction.SECTOR_CARD_SENT,
        metadata: { chatId: chatId.toString(), messageId: result.firstMessageId ?? null },
      });
    }
    log.info(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        chatId,
        action: HistoryAction.SECTOR_CARD_SENT,
      }),
      'sector card published',
    );
  }

  /** Rewrite the sector card, e.g. after someone takes the incident (§22). */
  async refreshCard(incidentId: string): Promise<void> {
    const incident = await this.repository.findById(incidentId);
    if (!incident?.sectorMessageId || !incident.assignedGroup) return;
    await this.prisma.$transaction(tx => queueSectorRefresh(tx, incidentId,
      `sector-status:${incidentId}:refresh:${incident.updatedAt.getTime()}`, true), TRANSACTION_OPTIONS);
    await this.messages.flush();
  }

  /**
   * "Взять в работу" (§22). Guarded so a second press, or a second person,
   * cannot silently overwrite the current responder.
   */
  async takeInWork(
    incidentId: string,
    actor: { userId: string; maxUserId: bigint; displayName: string; role: string },
  ): Promise<IncidentWithRelations> {
    await this.prisma.$transaction(async tx => {
      await assertSectorReservation(tx, incidentId, actor.maxUserId);
      const incident = await this.repository.findById(incidentId, tx);
      if (!incident) throw new NotFoundError('Обращение не найдено.');
      if (!['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) throw new ConflictError('Обращение уже перешло на другой этап.');
      const active = await tx.actionLock.findFirst({ where: { incidentId, action: SECTOR_LEASE_ACTION, lockedUntil: { gt: new Date() } } });
      if (active) throw new ConflictError(`${incident.publicCode} уже у вас в работе.`);
      const key = `sector-queue:${incidentId}`;
      const until = new Date(Date.now() + LEASE_MS);
      const data = { incidentId, action: SECTOR_LEASE_ACTION, maxUserId: actor.maxUserId, lockedUntil: until };
      await tx.actionLock.upsert({ where: { key }, create: { key, ...data }, update: data });
      await tx.incident.update({ where: { id: incidentId }, data: { status: 'IN_PROGRESS', currentResponderId: actor.userId } });
      await this.history.record({ incidentId, action: HistoryAction.TAKEN_IN_WORK, fromStatus: incident.status,
        toStatus: 'IN_PROGRESS', actorMaxUserId: actor.maxUserId, actorRole: actor.role,
        metadata: { responder: actor.displayName, until: until.toISOString() } }, tx);
      await queueSectorRefresh(tx, incidentId, `sector-claim:${randomUUID()}`, true);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
    return (await this.repository.findById(incidentId))!;
  }

  async release(incidentId: string, actor: ResolvedActor, chatId: bigint): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await assertSectorReservation(tx, incidentId, actor.maxUserId);
      const incident = await this.repository.findById(incidentId, tx);
      if (!incident) throw new NotFoundError('Обращение не найдено.');
      if (incident.assignedGroup?.maxChatId !== chatId) throw new ConflictError('Откройте текущий профильный чат обращения.');
      assertResponder(actor, incident, chatId);
      if (!['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) throw new ConflictError('Обращение уже перешло на другой этап.');
      const removed = await tx.actionLock.deleteMany({ where: { incidentId, action: SECTOR_LEASE_ACTION, maxUserId: actor.maxUserId } });
      if (!removed.count) throw new ConflictError('Обращение уже свободно или закреплено за другим сотрудником.');
      await tx.incident.update({ where: { id: incidentId }, data: { currentResponderId: null, status: incident.revisionReason ? 'REVISION_REQUIRED' : 'ASSIGNED' } });
      await tx.operatorSession.deleteMany({ where: { incidentId, maxUserId: actor.maxUserId, chatId } });
      await this.history.record({ incidentId, action: 'SECTOR_RELEASED', actorMaxUserId: actor.maxUserId, actorRole: actor.role }, tx);
      await queueSectorRefresh(tx, incidentId, `sector-release:${randomUUID()}`, true);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
  }

  async returnToDistribution(incidentId: string, actor: ResolvedActor, chatId: bigint, reason: string, expectedGroupId?: string): Promise<void> {
    if (!reason.trim() || Array.from(reason).length > 1000) throw new ValidationError('Укажите причину возврата: от 1 до 1000 символов.');
    await this.prisma.$transaction(async tx => {
      // Same order as assignment: distribution lock before the incident answer lock.
      await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
      await assertSectorReservation(tx, incidentId, actor.maxUserId);
      const incident = await this.repository.findById(incidentId, tx);
      if (!incident) throw new NotFoundError('Обращение не найдено.');
      if (incident.assignedGroup?.maxChatId !== chatId) throw new ConflictError('Откройте текущий профильный чат обращения.');
      assertResponder(actor, incident, chatId);
      if (!['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status) || (expectedGroupId && expectedGroupId !== incident.assignedGroupId)) throw new ConflictError('Обращение уже перешло на другой этап или в другую организацию.');
      this.state.assertTransition(incident.status, 'DISTRIBUTION');
      const event = await tx.incidentHistory.create({ data: { incidentId, action: 'REDISTRIBUTION_REQUESTED', fromStatus: incident.status,
        toStatus: 'DISTRIBUTION', actorMaxUserId: actor.maxUserId, actorRole: actor.role,
        metadata: { reason: reason.trim(), groupId: incident.assignedGroupId, groupName: incident.assignedGroup!.name, operator: actor.displayName } } });
      await tx.incident.update({ where: { id: incidentId }, data: { status: 'DISTRIBUTION', assignedGroupId: null, assignedAt: null,
        assignedByUserId: null, currentResponderId: null, sectorMessageId: null, reviewMessageId: null, revisionReason: null,
        distributionClaimedBy: null, distributionClaimedName: null, distributionClaimUntil: null } });
      await tx.actionLock.deleteMany({ where: { incidentId, action: { in: ['sector-queue', 'review-queue'] } } });
      await tx.operatorSession.deleteMany({ where: { incidentId } });
      await queueDistributionRefresh(tx, incidentId, event.id, true);
      await queueStaffRefresh(tx, incidentId, event.id);
      await queueMessage(tx, { chatId: getConfig().DISTRIBUTION_CHAT_ID! }, {
        text: `↩️ ВОЗВРАЩЕНО НА ПЕРЕРАСПРЕДЕЛЕНИЕ\n${incident.publicCode}\nОт: ${incident.assignedGroup!.name}\nСотрудник: ${actor.displayName}\nПричина: ${reason.trim()}\n\nОбращение в общей очереди по первоначальной дате. Срок ответа сохранён.`,
        keyboard: [[{ type: 'callback', text: 'Взять на распределение', payload: `queue:open:${incidentId}` }]],
        delivery: { dedupeKey: `redistribution-notice:${event.id}` },
      }, incidentId);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
  }

  /** §32 — send the rework request back to the sector chat. */
  async publishRevision(
    incident: Incident,
    group: ResponsibleGroup,
    answerVersion: number,
    reason: string,
  ): Promise<void> {
    const chatId = this.groups.requireChatId(group);
    await this.messages.send(
      { chatId },
      {
        text: revisionCard(incident, answerVersion, reason),
        label: codeLabel(incident),
        keyboard: revisionKeyboard(incident.id),
        delivery: { dedupeKey: `revision:${incident.id}:${answerVersion}` },
      },
    );
  }

  /** Plain notice into the sector chat (SLA warnings, status echoes). */
  async notify(incident: Incident, text: string, dedupeKey?: string): Promise<void> {
    const groupId = incident.assignedGroupId;
    if (!groupId) return;
    const group = await this.groups.findById(groupId);
    if (!group?.maxChatId) return;
    await this.messages.send({ chatId: group.maxChatId }, { text, label: codeLabel(incident), ...(dedupeKey ? { delivery: { dedupeKey } } : {}) });
  }
}
