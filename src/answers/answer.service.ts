import {
  AnswerStatus,
  AttachmentType,
  type IncidentAnswer,
  IncidentStatus,
  type PrismaClient,
} from '@prisma/client';

import { acquireAdvisoryLock } from '../database/prisma';
import { HistoryAction, type IncidentHistoryService } from '../incidents/incident-history.service';
import type { IncidentStateService } from '../incidents/incident-state.service';
import type { IncidentRepository, IncidentWithRelations } from '../incidents/incident.repository';
import type { IncomingMedia, MediaService } from '../media/media.service';
import type { SectorService } from '../sector/sector.service';
import type { ReviewService } from '../review/review.service';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { incidentLogFields, moduleLogger } from '../utils/logger';
import { isBlank, renderTemplate } from '../utils/text';
import type { Actor } from '../distribution/distribution.service';

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
    private readonly sector: SectorService,
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
    const template = incident.assignedCategory?.answerTemplate;
    if (!template) return null;
    return renderTemplate(template, { incidentCode: incident.publicCode });
  }

  /**
   * Store a new answer version and push it to the review chat (§24, §28).
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
  ): Promise<{ incident: IncidentWithRelations; answer: IncidentAnswer }> {
    const { text } = this.validate(rawText, media);

    const before = await this.repository.findById(incidentId);
    if (!before) throw new NotFoundError(`Incident ${incidentId} not found`);
    if (!SUBMITTABLE.includes(before.status)) {
      throw new ConflictError(
        `Для ${before.publicCode} сейчас нельзя подготовить ответ (статус: ${before.status}).`,
      );
    }
    this.state.assertTransition(before.status, IncidentStatus.WAITING_REVIEW, { incidentId });

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
          incidentId,
          version,
          text,
          createdByUserId: actor.userId,
          status: AnswerStatus.WAITING_REVIEW,
        },
      });

      const moved = await this.repository.transition(tx, incidentId, SUBMITTABLE, {
        status: IncidentStatus.WAITING_REVIEW,
        currentResponderId: actor.userId,
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
        {
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

      return created;
    });

    await this.attachMedia(answer.id, media);

    log.info(
      incidentLogFields({
        incidentId,
        publicCode: before.publicCode,
        maxUserId: actor.maxUserId,
        action: HistoryAction.SENT_TO_REVIEW,
      }),
      'answer submitted for review',
    );

    const incident = (await this.repository.findById(incidentId))!;
    await this.review.publishCard(incidentId, answer.id);
    await this.sector.notify(incident, `📝 ${incident.publicCode} отправлено на согласование.`);

    return { incident, answer };
  }

  private async attachMedia(answerId: string, media: IncomingMedia[]): Promise<void> {
    const usable = media.filter((item) => item.kind === 'IMAGE' || item.kind === 'FILE');
    if (usable.length === 0) return;
    const stored = await this.media.ingestAll(`answers/${answerId}`, usable);
    if (stored.length === 0) return;
    await this.prisma.answerAttachment.createMany({
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
