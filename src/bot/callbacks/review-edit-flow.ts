import { randomUUID } from 'node:crypto';
import { SessionType, type OperatorSession } from '@prisma/client';
import type { AppServices } from '../../app/container';
import { TRANSACTION_OPTIONS } from '../../database/prisma';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { incidentCallback } from '../../max/callback-payload';
import type { Button } from '../../max/max-types';
import { assertReviewEdit, reviewEditDraft, staleReviewEdit, type ReviewEditDraft } from '../../review/review-edit';
import { formatDateTime } from '../../utils/datetime';
import { ConflictError, ValidationError } from '../../utils/errors';
import type { ResolvedActor } from '../handlers/helpers';
import { ensureFreeSession } from '../handlers/session-guard';
import { assertApprover } from '../middleware/authorize';
import { reviewKeyboard } from '../keyboards';

async function replace(services: AppServices, session: OperatorSession, next: ReviewEditDraft | null) {
  await services.prisma.$transaction(async tx => {
    await assertReviewEdit(tx, session);
    if (next) await tx.operatorSession.update({ where: { id: session.id }, data: { data: next } });
    else {
      await tx.operatorSession.delete({ where: { id: session.id } });
      const data = reviewEditDraft(session);
      if (data.privateWorkspaceId) {
        const incident = (await services.repository.findById(session.incidentId!, tx))!;
        await tx.privateWorkItem.updateMany({ where: { id: data.privateWorkspaceId, maxUserId: session.maxUserId, incidentId: session.incidentId! },
          data: { data: { cycle: `${incident.history[0]?.id ?? 'initial'}:${data.reviewAnswerId}`, leaseUntil: data.leaseUntil } } });
      }
    }
  }, TRANSACTION_OPTIONS);
}

export async function resumeReviewEdit(services: AppServices, session: OperatorSession) {
  const data = reviewEditDraft(session);
  const incident = await services.repository.findById(session.incidentId!);
  if (!incident) throw staleReviewEdit();
  const preview = data.editStage === 'preview';
  const keyboard: Button[][] = preview ? [[
    { type: 'callback', text: 'Сохранить правку', payload: incidentCallback('review-edit-save', incident.id, data.editToken) },
    { type: 'callback', text: 'Исправить', payload: incidentCallback('review-edit-back', incident.id, data.editToken) },
  ]] : [];
  keyboard.push([{ type: 'callback', text: 'Отмена', payload: incidentCallback('review-edit-cancel', incident.id, data.editToken) }]);
  await services.messages.send({ chatId: session.chatId }, { text: [
    `✏️ ${incident.publicCode} · Правка ответа`, `👤 ${data.employeeName}`, `⏳ Закреплено до ${formatDateTime(new Date(data.leaseUntil))} (МСК)`, '',
    preview ? 'Проверьте исправленный ответ:' : 'Бот ждёт полный исправленный текст одним сообщением (до 12 000 символов). Можно скопировать текст ниже и поправить его.',
    '', data.text, '', `Вложений сохранится: ${incident.answers.at(-1)?.attachments.length ?? 0}.`,
    'Сохранение правки не отправляет ответ жителю. После сохранения нажмите «Согласовать».',
  ].join('\n'), keyboard });
}

export async function startReviewEdit(services: AppServices, actor: ResolvedActor, chatId: bigint, incident: IncidentWithRelations, answerId: string): Promise<string | undefined> {
  assertApprover(services, actor, chatId);
  if (incident.status !== 'WAITING_REVIEW' || incident.answers.at(-1)?.id !== answerId) throw staleReviewEdit();
  if (!await ensureFreeSession(services, actor, chatId, incident.id)) return;
  const existing = await services.sessions.find(actor.maxUserId, chatId);
  if (existing) {
    if ((existing.data as { reviewEdit?: boolean } | null)?.reviewEdit) { await resumeReviewEdit(services, existing); return; }
    throw new ConflictError('Сначала завершите или отмените текущее действие с обращением.');
  }
  await services.workQueues.claimReview(actor, chatId, incident.id);
  const owned = await services.prisma.actionLock.findUniqueOrThrow({ where: { key: `review-queue:${incident.id}` } });
  const data: ReviewEditDraft = { reviewEdit: true, reviewAnswerId: answerId, leaseUntil: owned.lockedUntil.toISOString(),
    editStage: 'text', editToken: randomUUID(), employeeName: actor.displayName, text: incident.answers.at(-1)!.text };
  const session = await services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_REVISION_REASON, incidentId: incident.id, data });
  await services.prisma.$transaction(tx => assertReviewEdit(tx, session), TRANSACTION_OPTIONS);
  await resumeReviewEdit(services, session);
}

export async function acceptReviewEditText(services: AppServices, actor: ResolvedActor, chatId: bigint, session: OperatorSession, text: string) {
  assertApprover(services, actor, chatId);
  const data = reviewEditDraft(session);
  if (data.editStage !== 'text') throw new ValidationError('Проверьте правку кнопками «Сохранить правку», «Исправить» или «Отмена».');
  if (!text.trim() || text.length > 12000) throw new ValidationError('Отправьте полный исправленный текст: от 1 до 12 000 символов.');
  const next: ReviewEditDraft = { ...data, text: text.trim(), editStage: 'preview', editToken: randomUUID() };
  await replace(services, session, next);
  await resumeReviewEdit(services, { ...session, data: next });
}

export async function handleReviewEditAction(services: AppServices, actor: ResolvedActor, chatId: bigint, incident: IncidentWithRelations, action: string, token?: string, messageId?: string): Promise<string | undefined> {
  assertApprover(services, actor, chatId);
  const session = await services.sessions.find(actor.maxUserId, chatId);
  if (!session || session.incidentId !== incident.id) throw staleReviewEdit();
  const data = reviewEditDraft(session);
  if (token !== data.editToken) throw staleReviewEdit();
  if (action === 'review-edit-back' && data.editStage === 'preview') {
    const next: ReviewEditDraft = { ...data, editStage: 'text', editToken: randomUUID() };
    await replace(services, session, next);
    if (messageId) await services.messages.finalizeCard(messageId, `${incident.publicCode}: правка продолжена ниже.`);
    await resumeReviewEdit(services, { ...session, data: next }); return;
  }
  if (action === 'review-edit-cancel') {
    await replace(services, session, null);
    if (messageId) await services.messages.finalizeCard(messageId, `${incident.publicCode}: правка отменена.`);
    await services.messages.send({ chatId }, { text: `${incident.publicCode}: правка отменена. Сохранён прежний ответ.`,
      ...(data.privateWorkspaceId ? { keyboard: reviewKeyboard(incident.id, data.reviewAnswerId) } : {}) }); return;
  }
  if (action !== 'review-edit-save' || data.editStage !== 'preview') throw staleReviewEdit();
  const answer = await services.review.saveCorrection(session, actor);
  if (messageId) await services.messages.finalizeCard(messageId, `${incident.publicCode}: правка сохранена. Версия ${answer.version}.`);
  await services.messages.send({ chatId }, { text: `${incident.publicCode}: правка сохранена.${data.privateWorkspaceId ? `\n\n${answer.text}` : '\nНовая карточка поставлена в очередь доставки в чат согласования.'}\n\nТеперь можно согласовать ответ и отправить его жителю.`,
    ...(data.privateWorkspaceId ? { keyboard: reviewKeyboard(incident.id, answer.id) } : {}) });
}
