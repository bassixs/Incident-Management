import { randomUUID } from 'node:crypto';
import { SessionType, type OperatorSession } from '@prisma/client';
import type { AppServices } from '../../app/container';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../../database/prisma';
import { CLAIM_LOCK } from '../../distribution/queue-state';
import { MAX_REJECTION_LENGTH, REJECTION_REASONS } from '../../distribution/rejection-reasons';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { incidentCallback } from '../../max/callback-payload';
import type { Button } from '../../max/max-types';
import { ConflictError, ValidationError } from '../../utils/errors';
import { formatDateTime } from '../../utils/datetime';
import type { ResolvedActor } from '../handlers/helpers';
import { ensureFreeSession } from '../handlers/session-guard';
import { assertDispatcher } from '../middleware/authorize';
import { rejectionToRequester } from '../views/cards';

export type RejectionDraft = {
  rejectionStage: 'choose' | 'text' | 'preview';
  rejectionToken: string;
  distributionLeaseUntil: string;
  employeeName: string;
  reason?: string;
  rule?: string;
};

export function rejectionDraft(session: OperatorSession): RejectionDraft {
  const data = session.data as unknown as RejectionDraft | null;
  if (!data?.rejectionToken || !data.rejectionStage) throw new ConflictError('Начните отклонение заново через карточку обращения.');
  return data;
}

const expired = () => new ConflictError('Эта карточка отклонения устарела. Откройте актуальное обращение через /queue.');

/** CAS and the distribution lock prevent editing/cancelling a draft during confirmation. */
async function replaceDraft(services: AppServices, session: OperatorSession, next: RejectionDraft | null) {
  await services.prisma.$transaction(async tx => {
    await acquireAdvisoryLock(tx, ...CLAIM_LOCK);
    const incident = await tx.incident.findUniqueOrThrow({ where: { id: session.incidentId! } });
    const data = rejectionDraft(session);
    if (incident.status !== 'DISTRIBUTION' || incident.distributionClaimedBy !== session.maxUserId ||
      !incident.distributionClaimUntil || incident.distributionClaimUntil <= new Date() ||
      incident.distributionClaimUntil.toISOString() !== data.distributionLeaseUntil) throw expired();
    const where = { id: session.id, expiresAt: { gt: new Date() }, data: { equals: session.data! } };
    const result = next
      ? await tx.operatorSession.updateMany({ where, data: { data: next } })
      : await tx.operatorSession.deleteMany({ where });
    if (!result.count) throw expired();
  }, TRANSACTION_OPTIONS);
}

async function sendDraft(services: AppServices, chatId: bigint, incident: IncidentWithRelations, data: RejectionDraft) {
  const arg = data.rejectionToken;
  let text: string;
  let keyboard: Button[][];
  if (data.rejectionStage === 'choose') {
    text = `${incident.publicCode}: выберите причину отклонения по правилам. Перед отправкой вы сможете проверить и исправить текст.`;
    keyboard = REJECTION_REASONS.map(r => [{ type: 'callback', text: r.label, payload: incidentCallback('reject-reason', incident.id, `${arg}.${r.id}`) }]);
    keyboard.push([{ type: 'callback', text: 'Иное', payload: incidentCallback('reject-reason', incident.id, `${arg}.other`) }]);
  } else if (data.rejectionStage === 'text') {
    text = `${incident.publicCode}: напишите причину отклонения одним сообщением (до ${MAX_REJECTION_LENGTH} символов). Затем бот покажет итоговый текст для проверки.`;
    if (data.reason) text += `\n\nТекущая причина:\n${data.reason}`;
    keyboard = [];
  } else {
    text = `Проверьте сообщение для жителя:\n\n${rejectionToRequester(incident, data.reason!)}\n\nОтправить этот текст?`;
    keyboard = [[{ type: 'callback', text: 'Верно', payload: incidentCallback('reject-confirm', incident.id, arg) },
      { type: 'callback', text: 'Исправить', payload: incidentCallback('reject-edit', incident.id, arg) }]];
  }
  keyboard.push([{ type: 'callback', text: 'Отмена', payload: incidentCallback('reject-cancel', incident.id, arg) }]);
  text = `👤 Готовит отклонение: ${data.employeeName}\n⏳ Закреплено до ${formatDateTime(new Date(data.distributionLeaseUntil))} (МСК)\n\n${text}`;
  await services.messages.send({ chatId }, { text, keyboard });
}

export async function startRejectionFlow(services: AppServices, actor: ResolvedActor, chatId: bigint, incident: IncidentWithRelations): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  if (incident.status !== 'DISTRIBUTION') throw expired();
  if (!await ensureFreeSession(services, actor, chatId, incident.id)) return;
  const current = await services.repository.findById(incident.id);
  if (!current?.distributionClaimUntil || current.distributionClaimedBy !== actor.maxUserId) throw expired();
  const existing = await services.sessions.find(actor.maxUserId, chatId);
  if (existing?.type === SessionType.WAITING_REJECTION_REASON && (existing.data as { rejectionToken?: string } | null)?.rejectionToken) {
    await resumeRejection(services, existing);
    return undefined;
  }
  const data: RejectionDraft = { rejectionStage: 'choose', rejectionToken: randomUUID(), distributionLeaseUntil: current.distributionClaimUntil.toISOString(), employeeName: actor.displayName };
  await services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_REJECTION_REASON, incidentId: incident.id, data });
  await sendDraft(services, chatId, incident, data);
  return undefined;
}

export async function handleRejectionAction(services: AppServices, actor: ResolvedActor, chatId: bigint, incident: IncidentWithRelations,
  action: string, argument?: string, messageId?: string): Promise<string | undefined> {
  assertDispatcher(services, actor, chatId);
  const session = await services.sessions.find(actor.maxUserId, chatId);
  if (!session || session.type !== SessionType.WAITING_REJECTION_REASON || session.incidentId !== incident.id) throw expired();
  const data = rejectionDraft(session);
  const [token, rule] = (argument ?? '').split('.');
  if (token !== data.rejectionToken) throw expired();
  if (action === 'reject-confirm') {
    if (data.rejectionStage !== 'preview' || !data.reason) throw expired();
    await services.distribution.reject(incident.id, data.reason, actor, { sessionId: session.id, token, chatId });
    if (messageId) await services.messages.finalizeCard(messageId, `${rejectionToRequester(incident, data.reason)}\n\nОтклонил: ${actor.displayName}`);
    return `${incident.publicCode} отклонено. Уведомление жителю сохранено в очереди доставки.`;
  }
  if (action === 'reject-cancel') {
    await replaceDraft(services, session, null);
    if (messageId) await services.messages.finalizeCard(messageId, `${incident.publicCode}: отклонение отменено. Обращение остаётся в работе.`);
    return 'Отклонение отменено';
  }
  let next: RejectionDraft = { ...data, rejectionToken: randomUUID() };
  if (action === 'reject-edit' && data.rejectionStage === 'preview') next.rejectionStage = 'text';
  else if (action === 'reject-reason' && data.rejectionStage === 'choose') {
    const selected = REJECTION_REASONS.find(r => r.id === rule);
    if (!selected && rule !== 'other') throw expired();
    next = { ...next, rejectionStage: selected ? 'preview' : 'text', rule: rule!, ...(selected ? { reason: selected.reason } : {}) };
  } else throw expired();
  await replaceDraft(services, session, next);
  if (messageId) await services.messages.finalizeCard(messageId, `${incident.publicCode}: подготовка отклонения продолжена ниже.`);
  await sendDraft(services, chatId, incident, next);
}

export async function acceptRejectionText(services: AppServices, actor: ResolvedActor, chatId: bigint, session: OperatorSession, reason: string) {
  assertDispatcher(services, actor, chatId);
  const data = rejectionDraft(session);
  if (data.rejectionStage !== 'text') throw new ValidationError('Выберите причину кнопкой или нажмите «Исправить» в итоговой карточке.');
  if (!reason.trim() || Array.from(reason).length > MAX_REJECTION_LENGTH) throw new ValidationError(`Укажите причину отклонения: от 1 до ${MAX_REJECTION_LENGTH} символов.`);
  const next: RejectionDraft = { ...data, rejectionStage: 'preview', reason: reason.trim(), rejectionToken: randomUUID() };
  await replaceDraft(services, session, next);
  await sendDraft(services, chatId, (await services.repository.findById(session.incidentId!))!, next);
}

export async function resumeRejection(services: AppServices, session: OperatorSession) {
  const incident = await services.repository.findById(session.incidentId!);
  if (!incident) throw expired();
  await sendDraft(services, session.chatId, incident, rejectionDraft(session));
}
