import { randomUUID } from 'node:crypto';
import { queueDistribution, queueSubscriptionInvite } from '../delivery/workflow-outbox';
import type { Tx } from '../database/prisma';
import { AttachmentType, type Incident, IncidentStatus, type PrismaClient } from '@prisma/client';

import type { BanService } from '../bans/ban.service';
import { getConfig } from '../config';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import type { IncomingMedia, MediaService, StoredMedia } from '../media/media.service';
import type { UserService } from '../users/user.service';
import { computeDeadline, dayBoundaries } from '../utils/datetime';
import { ConflictError, RateLimitError, ValidationError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';
import { normaliseIncidentText, unicodeLength } from '../utils/text';
import { HistoryAction, type IncidentHistoryService } from './incident-history.service';
import type { IncidentRepository, IncidentWithRelations } from './incident.repository';

const log = moduleLogger('incidents');

export type CreateIncidentInput = {
  draftSessionId?: string;
  requester: { maxUserId: bigint; name: string; phone: string; username?: string | null };
  text: string;
  userSelectedCategoryId?: string | null;
  problemMunicipalityCode?: string | null;
  problemMunicipalityName?: string | null;
  problemLocality?: string | null;
  media?: IncomingMedia[];
};

export function normaliseRequesterName(raw: string): string {
  const value = normaliseIncidentText(raw).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = value.split(' ').filter(Boolean);
  if (
    unicodeLength(value) < 5 ||
    unicodeLength(value) > 150 ||
    parts.length < 2 ||
    !/^[\p{L}\s'\-’]+$/u.test(value)
  ) {
    throw new ValidationError(
      'Укажите фамилию и имя текстом. Отчество — если оно есть.',
      { reason: 'requester_name' },
    );
  }
  return value;
}

export function normaliseRequesterPhone(raw: string): string {
  const value = raw.trim();
  if (!/^[+\d\s().-]+$/.test(value)) {
    throw new ValidationError('Укажите номер телефона, например: +7 900 123-45-67.', {
      reason: 'requester_phone',
    });
  }
  let digits = value.replace(/\D/g, '');
  if (!value.startsWith('+')) {
    if (digits.length === 10) digits = `7${digits}`;
    else if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  }
  if (digits.length < 10 || digits.length > 15) {
    throw new ValidationError('Укажите номер телефона, например: +7 900 123-45-67.', {
      reason: 'requester_phone',
    });
  }
  return digits.length === 11 && digits.startsWith('7')
    ? `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`
    : `+${digits}`;
}

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
    if (media.some(item => item.kind !== 'IMAGE')) {
      throw new ValidationError('К обращению можно приложить только фотографии. Удалите другие вложения и повторите отправку.');
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
    const requesterName = normaliseRequesterName(input.requester.name);
    const requesterPhone = normaliseRequesterPhone(input.requester.phone);
    await this.assertNotBanned(input.requester.maxUserId);

    const now = new Date();
    const { start, end } = dayBoundaries(now, config.APP_TIMEZONE);

    const incidentId = randomUUID();
    const stored = await this.media.ingestAll(`incidents/${incidentId}`, (input.media ?? []).filter(m => m.kind === 'IMAGE'));
    let transactionBodyCompleted = false;
    const incident = await this.prisma.$transaction(async (tx) => {
      await acquireAdvisoryLock(tx, 'incident-quota', input.requester.maxUserId.toString());

      if (input.draftSessionId) {
        const consumed = await tx.operatorSession.deleteMany({ where: { id: input.draftSessionId, maxUserId: input.requester.maxUserId, type: 'WAITING_INCIDENT_CONFIRMATION' } });
        if (consumed.count !== 1) throw new ConflictError('Черновик уже подтверждён или устарел.');
      }
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
      await this.users.saveRequesterProfile(user.maxUserId, requesterName, requesterPhone, tx);

      const publicCode = await this.repository.nextPublicCode(tx, now, config.APP_TIMEZONE);
      const created = await this.repository.create(tx, {
        id: incidentId,
        publicCode,
        requesterId: user.id,
        requesterMaxUserId: user.maxUserId,
        requesterName,
        requesterPhone,
        text,
        userSelectedCategoryId: input.userSelectedCategoryId ?? null,
        problemMunicipalityCode: input.problemMunicipalityCode ?? null,
        problemMunicipalityName: input.problemMunicipalityName ?? null,
        problemLocality: input.problemLocality ?? null,
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
            problemMunicipalityCode: input.problemMunicipalityCode ?? null,
            problemMunicipalityName: input.problemMunicipalityName ?? null,
            problemLocality: input.problemLocality ?? null,
            attachmentCount: (input.media ?? []).filter((item) => item.kind === 'IMAGE').length,
          },
        },
        tx,
      );

      await this.attachMedia(tx, created.id, stored);
      await queueDistribution(tx, created.id);
      transactionBodyCompleted = true;
      return created;
    }, TRANSACTION_OPTIONS).catch(async error => {
      // Never remove files after an ambiguous COMMIT/network failure.
      if (stored.length && !transactionBodyCompleted) {
        try {
          if (!(await this.prisma.incident.findUnique({ where: { id: incidentId }, select: { id: true } }))) await this.media.discard(stored);
        } catch { log.warn({ incidentId }, 'unable to verify attachment ownership after transaction failure; retaining files'); }
      }
      throw error;
    });

    log.info(
      incidentLogFields({
        incidentId: incident.id,
        publicCode: incident.publicCode,
        maxUserId: incident.requesterMaxUserId,
        action: HistoryAction.INCIDENT_CREATED,
      }),
      'incident registered',
    );

    return incident;
  }

  private async attachMedia(tx: Tx, incidentId: string, stored: StoredMedia[]): Promise<void> {
    if (stored.length === 0) return;
    await tx.incidentAttachment.createMany({
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

  /**
   * Store the requester's first score for a delivered final answer.
   *
   * The guarded UPDATE is intentionally atomic: two rapid button presses can
   * never overwrite each other, and a forged callback cannot rate somebody
   * else's incident or an answer that has not actually been delivered.
   */
  async rateAnswer(incidentId: string, requesterMaxUserId: bigint, rating: number): Promise<Incident> {
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      throw new ValidationError('Оценка должна быть целым числом от 1 до 5.');
    }

    const ratedAt = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      const result = await tx.incident.updateMany({
        where: {
          id: incidentId,
          requesterMaxUserId,
          status: IncidentStatus.RESOLVED,
          responseRating: null,
          answers: { some: { deliveredAt: { not: null } } },
        },
        data: { responseRating: rating, ratedAt },
      });
      if (result.count !== 1) return false;

      await this.history.record(
        {
          incidentId,
          action: HistoryAction.ANSWER_RATED,
          actorMaxUserId: requesterMaxUserId,
          actorRole: 'REQUESTER',
          metadata: { rating },
        },
        tx,
      );
      await queueSubscriptionInvite(tx, incidentId);
      return true;
    });

    if (!saved) {
      const incident = await this.prisma.incident.findFirst({
        where: { id: incidentId, requesterMaxUserId },
        select: { responseRating: true },
      });
      if (incident?.responseRating !== null && incident?.responseRating !== undefined) {
        throw new ConflictError(`Вы уже оценили этот ответ на ${incident.responseRating} из 5.`);
      }
      throw new ValidationError('Оценить можно только полученный ответ по своему обращению.');
    }

    return this.prisma.incident.findUniqueOrThrow({ where: { id: incidentId } });
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
