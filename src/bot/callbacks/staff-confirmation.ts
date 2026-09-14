import { randomUUID } from 'node:crypto';
import { Prisma, SessionType, type OperatorSession } from '@prisma/client';
import type { AppServices } from '../../app/container';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { incidentCallback } from '../../max/callback-payload';
import type { Button, Message } from '../../max/max-types';
import { classifyAttachments } from '../../media/media.service';
import { ConflictError, ForbiddenError, ValidationError } from '../../utils/errors';
import type { ResolvedActor } from '../handlers/helpers';
import { discardObsoleteSession, ensureFreeSession } from '../handlers/session-guard';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../middleware/authorize';

type Pending = { token: string; action: 'approve' | 'assign-group' | 'input'; argument?: string; title: string;
  text: string; employee: string; body?: Message['body']; sourceMessageId?: string };
export const pendingConfirmation = (session: OperatorSession) => (session.data as { confirmation?: Pending } | null)?.confirmation;
const stale = () => new ConflictError('Подтверждение устарело или отменено. Откройте актуальную карточку обращения.');

/** Serializes confirm, edit, new preview and cancellation, including across workers. */
export async function withConfirmationLock<T>(services: AppServices, userId: bigint, chatId: bigint, operation: () => Promise<T>): Promise<T> {
  const key = `staff-confirmation:${userId}:${chatId}`;
  if (!await services.actionGuard.acquire({ key, maxUserId: userId, action: 'staff-confirmation', ttlMs: 120_000 })) throw new ConflictError('Предыдущее действие ещё выполняется. Дождитесь результата.');
  try { return await operation(); } finally { await services.actionGuard.release(key); }
}

export async function cancelStaffSession(services: AppServices, userId: bigint, chatId: bigint) {
  await withConfirmationLock(services, userId, chatId, () => services.sessions.clear(userId, chatId));
}

export async function showStaffConfirmation(services: AppServices, session: OperatorSession) {
  const pending = pendingConfirmation(session);
  if (!pending || !session.incidentId) throw stale();
  const incident = await services.repository.findById(session.incidentId);
  if (!incident) throw stale();
  const keyboard: Button[][] = [[{ type: 'callback', text: 'Подтвердить', payload: incidentCallback('action-confirm', incident.id, pending.token) }]];
  if (pending.action === 'input') keyboard[0]!.push({ type: 'callback', text: 'Исправить', payload: incidentCallback('action-edit', incident.id, pending.token) });
  keyboard.push([{ type: 'callback', text: 'Отмена', payload: incidentCallback('action-cancel', incident.id, pending.token) }]);
  await services.messages.send({ chatId: session.chatId }, { text: `ПРОВЕРЬТЕ ДЕЙСТВИЕ\n${incident.publicCode}\n👤 ${pending.employee}\n\n${pending.title}\n\n${pending.text}\n\nБот ждёт подтверждения. До него действие не выполняется.`, keyboard });
}

export async function prepareButtonConfirmation(services: AppServices, actor: ResolvedActor, chatId: bigint, incident: IncidentWithRelations, action: 'approve' | 'assign-group', argument?: string, sourceMessageId?: string): Promise<string | undefined> {
  await withConfirmationLock(services, actor.maxUserId, chatId, async () => {
    if (action === 'approve') assertApprover(services, actor, chatId); else assertDispatcher(services, actor, chatId);
    const existing = await services.sessions.find(actor.maxUserId, chatId);
    if ((existing?.data as { reviewEdit?: boolean } | null)?.reviewEdit) throw new ConflictError('Сначала сохраните или отмените правку ответа.');
    // Do not overwrite a correction, remarks or another pending action, even on this incident.
    if (!await ensureFreeSession(services, actor, chatId)) return;
    let data: Record<string, unknown>, title: string, text: string;
    if (action === 'approve') {
      const answer = incident.answers.at(-1);
      if (incident.status !== 'WAITING_REVIEW' || !answer || answer.id !== argument) throw stale();
      await services.workQueues.claimReview(actor, chatId, incident.id);
      const lease = await services.prisma.actionLock.findUniqueOrThrow({ where: { key: `review-queue:${incident.id}` } });
      data = { reviewAnswerId: answer.id, leaseUntil: lease.lockedUntil.toISOString() };
      title = 'Согласовать ответ и отправить его жителю?';
      text = `Версия ${answer.version}\n${answer.text}\n\nВложений: ${answer.attachments.length}. Проверьте их в карточке ответа.`;
    } else {
      const group = argument ? await services.prisma.responsibleGroup.findUnique({ where: { id: argument } }) : null;
      const current = await services.repository.findById(incident.id);
      if (!group?.isActive || !current || current.status !== 'DISTRIBUTION' || current.distributionClaimedBy !== actor.maxUserId || !current.distributionClaimUntil || current.distributionClaimUntil <= new Date()) throw stale();
      data = { distributionLeaseUntil: current.distributionClaimUntil.toISOString() };
      title = 'Направить обращение в выбранную организацию?'; text = `${group.name}\n\nОбращение:\n${incident.text}`;
    }
    const pending: Pending = { token: randomUUID(), action, argument, title, text, employee: actor.displayName, sourceMessageId };
    const session = await services.sessions.start({ maxUserId: actor.maxUserId, chatId, incidentId: incident.id,
      type: action === 'approve' ? SessionType.WAITING_REVISION_REASON : SessionType.WAITING_REJECTION_REASON, data: { ...data, confirmation: pending } });
    await showStaffConfirmation(services, session);
  });
  return undefined;
}

export async function prepareInputConfirmation(services: AppServices, actor: ResolvedActor, chatId: bigint, session: OperatorSession, message: Message) {
  await withConfirmationLock(services, actor.maxUserId, chatId, async () => {
    if (pendingConfirmation(session)) throw new ValidationError('Бот ждёт подтверждения кнопкой. Для изменения текста нажмите «Исправить», для остановки — «Отмена».');
    const incident = await services.repository.findById(session.incidentId!);
    if (!incident) throw stale();
    const text = (message.body.text ?? '').trim(), media = classifyAttachments(message.body.attachments);
    const data = (session.data ?? {}) as Record<string, unknown>;
    let title: string;
    if (session.type === 'WAITING_FOR_ANSWER') {
      assertResponder(actor, incident, chatId); services.answers.validate(text, media);
      title = incident.assignedGroup?.bypassReview ? 'Отправить ответ жителю без согласования?' : 'Отправить ответ на согласование?';
    } else {
      if (media.length || !text || text.length > 12000) throw new ValidationError('Нужен непустой текст без вложений, до 12 000 символов.');
      if (session.type === 'WAITING_BAN_REASON') {
        requirePermission(actor, 'user.ban'); assertDispatcher(services, actor, chatId);
        title = `Заблокировать жителя ${incident.requesterName}?\nПричина:`;
      } else if (data.redistribution) {
        assertResponder(actor, incident, chatId);
        if (text.length > 1000) throw new ValidationError('Причина перераспределения должна быть не длиннее 1000 символов.');
        title = 'Вернуть обращение в очередь распределения?\nСрок ответа не изменится. Причина:';
      } else { assertApprover(services, actor, chatId); title = 'Вернуть ответ исполнителю на доработку?\nСрок ответа не изменится. Замечания:'; }
    }
    const body = { ...message.body, text, attachments: (message.body.attachments ?? []).filter(a => ['image', 'file'].includes(a.type)) };
    const pending: Pending = { token: randomUUID(), action: 'input', title, text: `${text}${media.length ? `\n\nВложений: ${media.length}.` : ''}`, body, employee: actor.displayName };
    const next = JSON.parse(JSON.stringify({ ...data, confirmation: pending })) as Prisma.InputJsonValue;
    const changed = await services.prisma.operatorSession.updateMany({ where: { id: session.id, expiresAt: { gt: new Date() }, data: { equals: session.data ?? Prisma.DbNull } }, data: { data: next } });
    if (!changed.count) throw stale();
    await showStaffConfirmation(services, { ...session, data: next as Prisma.JsonValue });
  });
}

export async function handleStaffConfirmation(services: AppServices, actor: ResolvedActor, chatId: bigint, incidentId: string, action: string, token?: string, messageId?: string, privateExecution = false): Promise<string | undefined> {
  return withConfirmationLock(services, actor.maxUserId, chatId, async () => {
    const session = await services.sessions.find(actor.maxUserId, chatId);
    if (!session || session.incidentId !== incidentId) throw stale();
    const pending = pendingConfirmation(session);
    if (!pending || pending.token !== token) throw stale();
    const code = (await services.repository.findById(incidentId))?.publicCode ?? 'Обращение';
    if ((session.data as { privateWorkspaceId?: string } | null)?.privateWorkspaceId && !privateExecution) throw new ForbiddenError('Продолжите действие в личном диалоге с ботом.');
    if (action === 'action-cancel') {
      await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
      if (messageId) await services.messages.finalizeCard(messageId, `${code}: действие отменено. Обращение не изменено.`);
      return `${code}: действие отменено. Обращение не изменено.`;
    }
    if (await discardObsoleteSession(services, session)) throw stale();
    if (action === 'action-edit' && pending.action === 'input') {
      const data = { ...(session.data as Prisma.JsonObject) }; delete data.confirmation;
      await services.prisma.operatorSession.update({ where: { id: session.id }, data: { data } });
      if (messageId) await services.messages.finalizeCard(messageId, `${code}: ввод продолжен. Старое подтверждение недействительно.`);
      await services.messages.send({ chatId }, { text: `${code}\n👤 ${actor.displayName}\n\nОтправьте полный исправленный текст одним сообщением` + (session.type === 'WAITING_FOR_ANSWER' ? ' и приложите все нужные фото или файлы.' : '.'),
        keyboard: [[{ type: 'callback', text: 'Отмена', payload: 'session:cancel' }]] }); return;
    }
    if (action !== 'action-confirm') throw stale();
    let result: string | undefined;
    if (pending.action === 'input') {
      const { handleOperatorMessage } = await import('../handlers/operator.handler');
      await handleOperatorMessage(services, actor, chatId, { body: pending.body! } as Message, session, { confirmed: true });
      // A validation/delivery failure can leave the session for retry. Do not claim success.
      if (await services.sessions.find(actor.maxUserId, chatId)) return;
    } else {
      const { handleIncidentCallback } = await import('./incident.callbacks');
      result = await handleIncidentCallback({ services, actor, chatId, confirmed: true, messageId: pending.sourceMessageId }, { kind: 'incident', action: pending.action, incidentId, argument: pending.argument });
      await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
    }
    if (messageId) await services.messages.finalizeCard(messageId, result ?? `${code}: действие подтверждено и выполнено.`);
    return result;
  });
}
