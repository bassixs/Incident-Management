import { randomUUID } from 'node:crypto';
import { type IncidentStatus, type PrismaClient } from '@prisma/client';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import { queueMessage, queueSectorRefresh } from '../delivery/workflow-outbox';
import { incidentCallback, userCallback } from '../max/callback-payload';
import type { MaxMessageService } from '../max/max-message.service';
import type { IncomingMedia, MediaService } from '../media/media.service';
import type { IncidentRepository } from '../incidents/incident.repository';
import type { ResolvedActor } from '../bot/handlers/helpers';
import { assertResponder } from '../bot/middleware/authorize';
import { ConflictError, ForbiddenError, ValidationError } from '../utils/errors';
import { formatDateTime } from '../utils/datetime';
import { mainMenuKeyboard, sectorKeyboard } from '../bot/keyboards';

const OPEN: IncidentStatus[] = ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'];

export class ClarificationService {
  constructor(private readonly prisma: PrismaClient, private readonly repository: IncidentRepository,
    private readonly messages: MaxMessageService, private readonly media: MediaService) {}

  async assertCanAsk(incidentId: string, actor: ResolvedActor, chatId: bigint) {
    const incident = await this.repository.findById(incidentId);
    if (!incident || incident.assignedGroup?.maxChatId !== chatId || !incident.assignedGroup.isActive) {
      throw new ForbiddenError('Уточнение доступно только в профильном чате этого обращения.');
    }
    assertResponder(actor, incident, chatId);
    if (!OPEN.includes(incident.status)) throw new ConflictError('Уточнение сейчас недоступно: обращение закрыто или на согласовании.');
    if (incident.activeClarificationId) throw new ConflictError('По этому обращению уже ожидается уточнение от жителя.');
    return incident;
  }

  async prepare(incidentId: string, actor: ResolvedActor, chatId: bigint, text: string, sourceId: string) {
    const incident = await this.assertCanAsk(incidentId, actor, chatId);
    const question = text.trim();
    if (!question || Array.from(question).length > 1500) throw new ValidationError('Напишите вопрос длиной от 1 до 1500 символов.');
    const draft = await this.prisma.$transaction(async tx => {
      const prepared = await tx.clarification.upsert({
        where: { questionSourceId: sourceId }, update: {},
        create: { incidentId, question, askedByUserId: actor.userId, askedByMaxUserId: actor.maxUserId, chatId, questionSourceId: sourceId },
      });
      if (prepared.askedByMaxUserId !== actor.maxUserId || prepared.incidentId !== incidentId || prepared.chatId !== chatId) throw new ForbiddenError('Это чужой вопрос.');
      await queueMessage(tx, { chatId }, {
        text: `💬 Уточнение по ${incident.publicCode}\n\n${prepared.question}\n\nОтправить этот вопрос жителю? Срок будет приостановлен после доставки вопроса.`,
        keyboard: [[{ type: 'callback', text: 'Отправить', payload: incidentCallback('clarify-send', incidentId, prepared.id) }],
          [{ type: 'callback', text: 'Отмена', payload: incidentCallback('clarify-cancel', incidentId, prepared.id) }]],
        delivery: { dedupeKey: `clarification-preview:${prepared.id}` },
      }, incidentId);
      return prepared;
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
    return draft;
  }

  async confirm(incidentId: string, id: string, actor: ResolvedActor, chatId: bigint) {
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, 'incident-answer', incidentId);
      const draft = await tx.clarification.findUnique({ where: { id } });
      if (!draft || draft.incidentId !== incidentId || draft.askedByMaxUserId !== actor.maxUserId || draft.chatId !== chatId) {
        throw new ForbiddenError('Отправить вопрос может только его автор в профильном чате.');
      }
      const incident = await this.repository.findById(incidentId, tx);
      if (!incident || incident.assignedGroup?.maxChatId !== chatId || !incident.assignedGroup.isActive) throw new ForbiddenError('Профильный чат изменился.');
      assertResponder(actor, incident, chatId);
      if (draft.status === 'PENDING_DELIVERY' || draft.status === 'WAITING_REPLY') return;
      if (draft.status !== 'DRAFT') throw new ConflictError('Этот вопрос уже обработан.');
      const claimed = await tx.incident.updateMany({
        where: { id: incidentId, status: { in: OPEN }, activeClarificationId: null },
        data: { activeClarificationId: id },
      });
      if (claimed.count !== 1) throw new ConflictError('Уже ожидается уточнение либо статус обращения изменился.');
      await tx.clarification.update({ where: { id }, data: { status: 'PENDING_DELIVERY' } });
      await tx.incidentHistory.create({ data: { incidentId, action: 'CLARIFICATION_REQUESTED', actorMaxUserId: actor.maxUserId,
        metadata: { clarificationId: id, question: draft.question } } });
      await queueMessage(tx, { userId: incident.requester.maxUserId }, {
        text: `💬 Нужны дополнительные сведения по обращению ${incident.publicCode}\n\nВаше обращение:\n${incident.text}\n\nВопрос специалиста:\n${draft.question}\n\nНажмите «Ответить на уточнение» и отправьте текст или фотографии.`,
        keyboard: [[{ type: 'callback', text: 'Ответить на уточнение', payload: userCallback('clarify-reply', id) }]],
        operation: { type: 'clarification-question', incidentId, clarificationId: id },
        delivery: { dedupeKey: `clarification-question:${id}` },
      }, incidentId);
      await queueSectorRefresh(tx, incidentId, `clarification:${id}:pending`);
    }, TRANSACTION_OPTIONS);
    await this.messages.flush();
  }

  async cancel(incidentId: string, id: string, actor: ResolvedActor, chatId: bigint) {
    const cancelled = await this.prisma.clarification.updateMany({
      where: { id, incidentId, askedByMaxUserId: actor.maxUserId, chatId, status: 'DRAFT' }, data: { status: 'CANCELLED' },
    });
    if (!cancelled.count) throw new ConflictError('Вопрос уже отправлен, отменён или создан другим сотрудником.');
  }

  async requireReply(id: string, userId: bigint) {
    const question = await this.prisma.clarification.findUnique({ where: { id }, include: { incident: true } });
    if (!question || question.incident.requesterMaxUserId !== userId) throw new ForbiddenError('Это уточнение недоступно.');
    if (question.status !== 'WAITING_REPLY' || question.incident.activeClarificationId !== id) throw new ConflictError('Этот вопрос уже обработан или ещё не доставлен.');
    return question;
  }

  async reply(id: string, userId: bigint, text: string, incoming: IncomingMedia[], sourceId: string, sessionId?: string) {
    const previous = await this.prisma.clarification.findUnique({ where: { id }, include: { incident: true } });
    if (previous?.incident.requesterMaxUserId === userId && previous.status === 'ANSWERED' && previous.replySourceId === sourceId) return;
    const question = await this.requireReply(id, userId);
    if (incoming.some(item => item.kind !== 'IMAGE')) throw new ValidationError('Для уточнения можно отправить текст и фотографии. Видео и другие файлы не принимаются.');
    if ((!text.trim() && !incoming.length) || Array.from(text.trim()).length > 3000 || incoming.length > 4) {
      throw new ValidationError('Отправьте текст до 3000 символов или до 4 фотографий одним сообщением.');
    }
    const uploadId = randomUUID();
    const stored = await this.media.ingestAll(`clarifications/${id}/${uploadId}`, incoming);
    let bodyCompleted = false;
    await this.prisma.$transaction(async tx => {
      await acquireAdvisoryLock(tx, 'incident-answer', question.incidentId);
      const incident = await this.repository.findById(question.incidentId, tx);
      if (!incident || incident.activeClarificationId !== id || !incident.slaPausedAt || !OPEN.includes(incident.status)) throw new ConflictError('Уточнение уже получено либо обращение закрыто.');
      const now = new Date();
      const pausedMs = Math.max(0, now.getTime() - incident.slaPausedAt.getTime());
      const deadlineAt = new Date(incident.deadlineAt.getTime() + pausedMs);
      const updated = await tx.clarification.updateMany({ where: { id, status: 'WAITING_REPLY' },
        data: { status: 'ANSWERED', replyText: text.trim(), replySourceId: sourceId, answeredAt: now } });
      if (updated.count !== 1) throw new ConflictError('Уточнение уже получено.');
      await tx.incident.update({ where: { id: incident.id }, data: {
        activeClarificationId: null, slaPausedAt: null, slaPausedMs: { increment: BigInt(pausedMs) },
        deadlineAt, isOverdue: deadlineAt <= now,
      } });
      if (stored.length) await tx.clarificationAttachment.createMany({ data: stored.map(item => ({
        clarificationId: id, type: item.type, storageKey: item.storageKey, originalName: item.originalName, size: item.size,
      })) });
      await tx.incidentHistory.create({ data: { incidentId: incident.id, action: 'CLARIFICATION_RECEIVED', actorMaxUserId: userId,
        metadata: { clarificationId: id, replyText: text.trim(), photos: stored.length, pausedMs, deadlineAt: deadlineAt.toISOString() } } });
      const chatId = incident.assignedGroup?.maxChatId;
      if (chatId == null) throw new ConflictError('Профильный чат временно недоступен. Попробуйте позже.');
      await queueMessage(tx, { chatId }, {
        text: `💬 Получено уточнение по ${incident.publicCode}\n\nВопрос:\n${question.question}\n\nОтвет жителя:\n${text.trim() || 'Приложены фотографии.'}\n\nСрок возобновлён. Дедлайн: ${formatDateTime(deadlineAt)}`,
        label: `№ ${incident.publicCode}`, operation: { type: 'clarification-reply', incidentId: incident.id, clarificationId: id },
        keyboard: sectorKeyboard(incident.id, { hasTemplate: Boolean(incident.assignedGroup?.answerTemplate) }),
        delivery: { dedupeKey: `clarification-reply:${id}` },
      }, incident.id, stored.map(item => ({ ...item, originalName: item.originalName ?? null })));
      await queueSectorRefresh(tx, incident.id, `clarification:${id}:answered`);
      await queueMessage(tx, { userId }, { text: `Спасибо! Уточнение по ${incident.publicCode} принято. Специалисты получат его в этом обращении.`, keyboard: mainMenuKeyboard(),
        delivery: { dedupeKey: `clarification-thanks:${id}` } }, incident.id);
      if (sessionId) await tx.operatorSession.deleteMany({ where: { id: sessionId, maxUserId: userId } });
      bodyCompleted = true;
    }, TRANSACTION_OPTIONS).catch(async error => {
      // Retain files after ambiguous COMMIT; discard only verified unowned uploads.
      if (stored.length && !bodyCompleted) {
        try {
          const owned = await this.prisma.clarificationAttachment.count({ where: { storageKey: { in: stored.map(item => item.storageKey) } } });
          if (!owned) await this.media.discard(stored);
        } catch { /* Keep files if ownership cannot be established. */ }
      }
      throw error;
    });
    await this.messages.flush();
  }
}
