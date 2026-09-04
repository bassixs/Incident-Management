import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { sessionConflictKeyboard } from '../keyboards';
import type { ResolvedActor } from './helpers';

export const SESSION_PROMPTS: Record<SessionType, string> = {
  [SessionType.WAITING_INCIDENT_TEXT]: 'Ожидается текст обращения.',
  [SessionType.WAITING_CUSTOM_LOCALITY]: 'Ожидается название населённого пункта.',
  [SessionType.WAITING_REJECTION_REASON]: 'Ожидается причина отклонения.',
  [SessionType.WAITING_REVISION_REASON]: 'Ожидается причина возврата на доработку.',
  [SessionType.WAITING_FOR_ANSWER]: 'Ожидается текст ответа.',
  [SessionType.WAITING_BAN_REASON]: 'Ожидается причина блокировки.',
  [SessionType.WAITING_REPORT_PERIOD]: 'Ожидается период для отчёта.',
};

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
  if (incidentId && existing.incidentId === incidentId) return true;

  const pending = existing.incidentId ? await services.repository.findById(existing.incidentId) : null;
  await services.messages.send(
    { chatId },
    {
      text: [
        `У вас уже есть незавершённое действие${pending ? ` с ${pending.publicCode}` : ''}.`,
        '',
        SESSION_PROMPTS[existing.type],
        '',
        '«Продолжить» — вернуться к нему, «Отменить» — сбросить и начать заново.',
      ].join('\n'),
      keyboard: sessionConflictKeyboard(),
    },
  );
  return false;
}
