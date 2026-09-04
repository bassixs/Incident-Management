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
        text: sectorCard(incident, incident.assignedGroup),
        label: codeLabel(incident),
        keyboard: sectorKeyboard(incident.id, {
          hasTemplate: Boolean(incident.assignedGroup.answerTemplate),
        }),
        attachments: await loadOutboundAttachments(this.media, incident.attachments),
        delivery: {
          dedupeKey: `sector-card:${incident.id}`,
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
    // Text only: the incident photo and the action buttons already on the
    // card are preserved, which is what §22 asks for.
    await this.messages.editCardText(
      incident.sectorMessageId,
      sectorCard(incident, incident.assignedGroup),
    );
  }

  /**
   * "Взять в работу" (§22). Guarded so a second press, or a second person,
   * cannot silently overwrite the current responder.
   */
  async takeInWork(
    incidentId: string,
    actor: { userId: string; maxUserId: bigint; displayName: string; role: string },
  ): Promise<IncidentWithRelations> {
    const incident = await this.repository.findById(incidentId);
    if (!incident) throw new NotFoundError(`Incident ${incidentId} not found`);

    if (incident.status === IncidentStatus.IN_PROGRESS) {
      if (incident.currentResponderId === actor.userId) {
        throw new ConflictError(`${incident.publicCode} уже у вас в работе.`);
      }
      throw new ConflictError(
        `${incident.publicCode} уже в работе у сотрудника ${incident.currentResponder?.displayName ?? '—'}.`,
      );
    }

    this.state.assertTransition(incident.status, IncidentStatus.IN_PROGRESS, { incidentId });

    const claimed = await this.repository.transition(
      this.prisma,
      incidentId,
      [IncidentStatus.ASSIGNED, IncidentStatus.REVISION_REQUIRED],
      { status: IncidentStatus.IN_PROGRESS, currentResponderId: actor.userId },
    );
    if (!claimed) {
      const fresh = await this.repository.findById(incidentId);
      throw new ConflictError(
        `${incident.publicCode} уже взято в работу (${fresh?.currentResponder?.displayName ?? '—'}).`,
      );
    }

    await this.history.record({
      incidentId,
      action: HistoryAction.TAKEN_IN_WORK,
      fromStatus: incident.status,
      toStatus: IncidentStatus.IN_PROGRESS,
      actorMaxUserId: actor.maxUserId,
      actorRole: actor.role,
      metadata: { responder: actor.displayName },
    });

    await this.refreshCard(incidentId);
    log.info(
      incidentLogFields({
        incidentId,
        publicCode: incident.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.TAKEN_IN_WORK,
      }),
      'incident taken in work',
    );

    return (await this.repository.findById(incidentId))!;
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
      },
    );
  }

  /** Plain notice into the sector chat (SLA warnings, status echoes). */
  async notify(incident: Incident, text: string): Promise<void> {
    const groupId = incident.assignedGroupId;
    if (!groupId) return;
    const group = await this.groups.findById(groupId);
    if (!group?.maxChatId) return;
    await this.messages.send({ chatId: group.maxChatId }, { text, label: codeLabel(incident) });
  }
}
