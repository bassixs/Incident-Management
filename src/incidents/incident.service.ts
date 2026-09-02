import { AttachmentType, type Incident, IncidentStatus, type PrismaClient } from '@prisma/client';

import type { BanService } from '../bans/ban.service';
import { getConfig } from '../config';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import type { IncomingMedia, MediaService, StoredMedia } from '../media/media.service';
import type { UserService } from '../users/user.service';
import { computeDeadline, dayBoundaries } from '../utils/datetime';
import { RateLimitError, ValidationError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';
import { normaliseIncidentText, unicodeLength } from '../utils/text';
import { HistoryAction, type IncidentHistoryService } from './incident-history.service';
import type { IncidentRepository, IncidentWithRelations } from './incident.repository';

const log = moduleLogger('incidents');

export type CreateIncidentInput = {
  requester: { maxUserId: bigint; name: string; username?: string | null };
  text: string;
  userSelectedCategoryId?: string | null;
  media?: IncomingMedia[];
};

export const REJECTION_MESSAGES = {
  banned: 'Отправка обращений для вашей учётной записи временно недоступна.',
  video:
    'Видео к обращениям прикреплять нельзя.\n\n' +
    'Отправьте описание проблемы текстом и, при необходимости, приложите фотографию.',
  audio:
    'Аудиосообщения не принимаются как обращение.\n\n' +
    'Отправьте описание проблемы текстом и, при необходимости, приложите фотографию.',
  empty:
    'Обращение должно содержать текст.\n\n' +
    'Опишите проблему одним сообщением — при необходимости можно приложить фотографию.',
} as const;

export function tooLongMessage(maxLength: number): string {
  return (
    'Сообщение слишком длинное.\n\n' +
    `Максимальная длина обращения — ${maxLength} символов.\n` +
    'Сократите текст и отправьте его ещё раз.'
  );
}

export function dailyLimitMessage(limit: number): string {
  return (
    `Вы уже отправили ${limit} обращения сегодня.\n\n` + 'Новый запрос можно будет отправить завтра.'
  );
}

export class IncidentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly repository: IncidentRepository,
    private readonly history: IncidentHistoryService,
    private readonly users: UserService,
    private readonly bans: BanService,
    private readonly media: MediaService,
  ) {}

  /**
   * Validate the raw user message *before* anything is created.
   *
   * Format errors must not consume the daily quota, so every rejection here
   * happens before the transaction that reserves a slot.
   */
  validateSubmission(text: string, media: IncomingMedia[] = []): { text: string } {
    const config = getConfig();
    if (media.some((item) => item.kind === 'VIDEO')) {
      throw new ValidationError(REJECTION_MESSAGES.video, { reason: 'video' });
    }
    if (media.some((item) => item.kind === 'AUDIO')) {
      throw new ValidationError(REJECTION_MESSAGES.audio, { reason: 'audio' });
    }
    const normalised = normaliseIncidentText(text ?? '');
    if (normalised.length === 0) {
      throw new ValidationError(REJECTION_MESSAGES.empty, { reason: 'empty' });
    }
    if (unicodeLength(normalised) > config.INCIDENT_MAX_LENGTH) {
      throw new ValidationError(tooLongMessage(config.INCIDENT_MAX_LENGTH), { reason: 'too_long' });
    }
    return { text: normalised };
  }

  async assertNotBanned(maxUserId: bigint): Promise<void> {
    if (await this.bans.isBanned(maxUserId)) {
      throw new ValidationError(REJECTION_MESSAGES.banned, { reason: 'banned' });
    }
  }

  async remainingDailyQuota(maxUserId: bigint, now = new Date()): Promise<number> {
    const config = getConfig();
    const { start, end } = dayBoundaries(now, config.APP_TIMEZONE);
    const used = await this.repository.countCreatedBetween(this.prisma, maxUserId, start, end);
    return Math.max(0, config.DAILY_INCIDENT_LIMIT - used);
  }

  /**
   * Register an incident.
   *
   * The quota check, the publicCode reservation and the INSERT all happen in
   * one transaction under a per-user advisory lock, so parallel submissions
   * from the same account cannot both slip past the daily limit.
   */
  async create(input: CreateIncidentInput): Promise<Incident> {
    const config = getConfig();
    const { text } = this.validateSubmission(input.text, input.media ?? []);
    await this.assertNotBanned(input.requester.maxUserId);

    const now = new Date();
    const { start, end } = dayBoundaries(now, config.APP_TIMEZONE);

    const incident = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, 'incident-quota', input.requester.maxUserId.toString());

      const used = await this.repository.countCreatedBetween(tx, input.requester.maxUserId, start, end);
      if (used >= config.DAILY_INCIDENT_LIMIT) {
        throw new RateLimitError(dailyLimitMessage(config.DAILY_INCIDENT_LIMIT), {
          used,
          limit: config.DAILY_INCIDENT_LIMIT,
        });
      }

      const user = await this.users.upsertFromMax(
        {
          user_id: Number(input.requester.maxUserId),
          name: input.requester.name,
          username: input.requester.username ?? null,
        },
        tx,
      );

      const publicCode = await this.repository.nextPublicCode(tx, now, config.APP_TIMEZONE);
      const created = await this.repository.create(tx, {
        publicCode,
        requesterId: user.id,
        requesterMaxUserId: user.maxUserId,
        requesterName: user.displayName,
        text,
        userSelectedCategoryId: input.userSelectedCategoryId ?? null,
        status: IncidentStatus.DISTRIBUTION,
        createdAt: now,
        deadlineAt: computeDeadline(now, config.INCIDENT_SLA_HOURS),
      });

      await this.history.record(
        {
          incidentId: created.id,
          action: HistoryAction.INCIDENT_CREATED,
          toStatus: IncidentStatus.DISTRIBUTION,
          actorMaxUserId: user.maxUserId,
          actorRole: 'REQUESTER',
          metadata: {
            publicCode,
            userSelectedCategoryId: input.userSelectedCategoryId ?? null,
            attachmentCount: (input.media ?? []).filter((item) => item.kind === 'IMAGE').length,
          },
        },
        tx,
      );

      return created;
    }, TRANSACTION_OPTIONS);

    log.info(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        maxUserId: incident.requesterMaxUserId,
        action: HistoryAction.INCIDENT_CREATED,
      }),
      'incident registered',
    );

    // Media is copied out of MAX after the incident exists: a failed download
    // must not roll back a registration the user has already been charged for.
    await this.attachMedia(incident.id, input.media ?? []);

    return incident;
  }

  private async attachMedia(incidentId: string, media: IncomingMedia[]): Promise<void> {
    const images = media.filter((item) => item.kind === 'IMAGE');
    if (images.length === 0) return;
    const stored = await this.media.ingestAll(`incidents/${incidentId}`, images);
    if (stored.length === 0) return;
    await this.prisma.incidentAttachment.createMany({
      data: stored.map((item: StoredMedia) => ({
        incidentId,
        type: AttachmentType.IMAGE,
        storageKey: item.storageKey,
        mimeType: item.mimeType ?? null,
        originalName: item.originalName ?? null,
        size: item.size,
        sourceUrl: item.sourceUrl ?? null,
        maxToken: item.maxToken ?? null,
      })),
    });
  }

  async findById(id: string): Promise<IncidentWithRelations | null> {
    return this.repository.findById(id);
  }

  async findByPublicCode(publicCode: string): Promise<IncidentWithRelations | null> {
    return this.repository.findByPublicCode(publicCode);
  }

  async listForRequester(maxUserId: bigint, take = getConfig().MY_INCIDENTS_LIMIT): Promise<Incident[]> {
    return this.repository.listForRequester(maxUserId, take);
  }

  async setDistributionMessageId(incidentId: string, messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    await this.prisma.incident.update({ where: { id: incidentId }, data: { distributionMessageId: messageId } });
  }

  async setSectorMessageId(incidentId: string, messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    await this.prisma.incident.update({ where: { id: incidentId }, data: { sectorMessageId: messageId } });
  }

  async setReviewMessageId(incidentId: string, messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    await this.prisma.incident.update({ where: { id: incidentId }, data: { reviewMessageId: messageId } });
  }
}
