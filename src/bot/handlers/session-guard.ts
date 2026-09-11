import { SessionType, type OperatorSession } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { sessionConflictKeyboard } from '../keyboards';
import type { ResolvedActor } from './helpers';

export const SESSION_PROMPTS: Record<SessionType, string> = {
  WAITING_CLARIFICATION_QUESTION: 'Ожидается вопрос жителю.',
  WAITING_CLARIFICATION_REPLY: 'Ожидается уточнение по обращению.',
  [SessionType.WAITING_REQUESTER_NAME]: 'Ожидается ФИО заявителя.',
  [SessionType.WAITING_REQUESTER_PHONE]: 'Ожидается номер телефона заявителя.',
  [SessionType.WAITING_INCIDENT_SELECTION]: 'Ожидается выбор темы или территории кнопками.',
  [SessionType.WAITING_INCIDENT_TEXT]: 'Ожидается текст обращения.',
  [SessionType.WAITING_CUSTOM_LOCALITY]: 'Ожидается название населённого пункта.',
  [SessionType.WAITING_INCIDENT_CONFIRMATION]: 'Ожидается подтверждение обращения кнопкой.',
  [SessionType.WAITING_INCIDENT_EDIT_SELECTION]: 'Ожидается выбор поля для исправления.',
  [SessionType.WAITING_INCIDENT_EDIT_VALUE]: 'Ожидается новое значение поля обращения.',
  [SessionType.WAITING_REJECTION_REASON]: 'Ожидается причина отклонения.',
  [SessionType.WAITING_REVISION_REASON]: 'Ожидается причина возврата на доработку.',
  [SessionType.WAITING_FOR_ANSWER]: 'Ожидается текст ответа.',
  [SessionType.WAITING_BAN_REASON]: 'Ожидается причина блокировки.',
  [SessionType.WAITING_REPORT_PERIOD]: 'Ожидается период для отчёта.',
};

export async function discardObsoleteSession(services: AppServices, session: OperatorSession): Promise<boolean> {
  if (!session.incidentId || ![SessionType.WAITING_FOR_ANSWER, SessionType.WAITING_REVISION_REASON, SessionType.WAITING_REJECTION_REASON].some(type => type === session.type)) return false;
  const incident = await services.repository.findById(session.incidentId);
  const data = session.data as { reviewAnswerId?: string; redistribution?: boolean; assignedGroupId?: string; leaseUntil?: string; assignmentCycle?: string; distributionLeaseUntil?: string } | null;
  const sectorStage = incident && ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status);
  let valid = false;
  if (incident) {
    if (session.type === SessionType.WAITING_FOR_ANSWER) valid = !!sectorStage;
    else if (session.type === SessionType.WAITING_REVISION_REASON) {
      valid = data?.redistribution
        ? !!sectorStage && incident.assignedGroupId === data.assignedGroupId && incident.assignedGroup?.maxChatId === session.chatId
        : incident.status === 'WAITING_REVIEW' && incident.answers.at(-1)?.id === data?.reviewAnswerId;
    } else valid = incident.status === 'DISTRIBUTION' && (!data?.distributionLeaseUntil ||
      (incident.distributionClaimedBy === session.maxUserId && !!incident.distributionClaimUntil && incident.distributionClaimUntil > new Date() && incident.distributionClaimUntil.toISOString() === data.distributionLeaseUntil));
  }
  const action = session.type === SessionType.WAITING_REVISION_REASON && !data?.redistribution ? 'review-queue' : 'sector-queue';
  const leaseValid = !data?.leaseUntil || !!await services.prisma.actionLock.findFirst({ where: {
    incidentId: session.incidentId, maxUserId: session.maxUserId, action,
    lockedUntil: { gt: new Date(), equals: new Date(data.leaseUntil) },
  } });
  const sameAssignment = !data?.assignmentCycle || data.assignmentCycle === (incident?.history?.[0]?.id ?? 'initial');
  if (valid && leaseValid && sameAssignment) return false;
  await services.prisma.operatorSession.deleteMany({ where: { id: session.id, expiresAt: session.expiresAt } });
  return true;
}

/**
 * §37 — one pending text-action per (operator, chat).
 *
 * Without this an operator juggling several incidents in one chat could type a
 * rejection reason and have it attached to a different incident. When a
 * conflicting action exists we refuse to start the new one and let the person
 * choose explicitly.
 */
export async function ensureFreeSession(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  incidentId?: string,
): Promise<boolean> {
  const existing = await services.sessions.find(actor.maxUserId, chatId);
  if (!existing) return true;
  if (await discardObsoleteSession(services, existing)) return true;
  if (incidentId && existing.incidentId === incidentId) return true;

  const pending = existing.incidentId ? await services.repository.findById(existing.incidentId) : null;
  await services.messages.send(
    { chatId },
    {
      text: [
        `У вас уже есть незавершённое действие${pending ? ` с ${pending.publicCode}` : ''}.`,
        '',
        (existing.data as { redistribution?: boolean } | null)?.redistribution ? 'Ожидается причина возврата на перераспределение.' : SESSION_PROMPTS[existing.type],
        '',
        '«Продолжить» — вернуться к нему, «Отменить» — сбросить и начать заново.',
      ].join('\n'),
      keyboard: sessionConflictKeyboard(),
    },
  );
  return false;
}
