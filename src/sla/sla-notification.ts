import type { Incident, ResponsibleGroup, User } from '@prisma/client';

import { getConfig } from '../config';
import { describeStatus } from '../incidents/incident-state.service';
import type { CompositeMessage, SendTarget } from '../max/max-message.service';
import { formatDateTime } from '../utils/datetime';
import { AppError } from '../utils/errors';

export type SlaStage = 24 | 48 | 'overdue';
type SlaIncident = Incident & {
  assignedGroup: ResponsibleGroup | null;
  currentResponder: User | null;
};

export function slaStage(incident: Incident, now: Date): 24 | undefined {
  if (incident.slaPausedAt) return undefined;
  if (incident.status === 'RESOLVED' || incident.status === 'REJECTED') return undefined;
  // Legacy marks count too: an upgrade must not remind previously notified staff again.
  if (incident.slaWarn24SentAt || incident.slaWarn6SentAt || incident.overdueNotifiedAt) return undefined;
  if (now.getTime() - incident.createdAt.getTime() >= 86_400_000) return 24;
  return undefined;
}

export function slaNotification(incident: SlaIncident, stage: SlaStage): { target: SendTarget; message: CompositeMessage } {
  const chatId = incident.assignedGroupId ? incident.assignedGroup?.maxChatId : getConfig().DISTRIBUTION_CHAT_ID;
  if (chatId == null) throw new AppError('Рабочий чат для SLA не настроен.', 'CONFIG_MISSING');
  const replyToMessageId = incident.assignedGroupId ? incident.sectorMessageId : incident.distributionMessageId;
  return {
    target: { chatId },
    message: {
      text: [
        '🔔 Напоминание об обращении',
        '',
        `№ ${incident.publicCode}`,
        'Обращение ещё не закрыто. Проверьте, требуется ли ваше действие.',
        `Статус: ${describeStatus(incident.status)}`,
        `Ответственная группа: ${incident.assignedGroup?.name ?? 'Не назначена — требуется распределение'}`,
        `Ответственный сотрудник: ${incident.currentResponder?.displayName ?? 'Пока никто не взял в работу'}`,
        `Зарегистрировано: ${formatDateTime(incident.createdAt)}`,
        '',
        'Нажмите на цитату над сообщением, чтобы перейти к карточке обращения.',
      ].join('\n'),
      label: `№ ${incident.publicCode}`,
      ...(replyToMessageId ? { replyToMessageId } : {}),
      operation: { type: 'sla-reminder', incidentId: incident.id, stage },
      // Keep the legacy 48h-stage key/mark: it used to mean 24h remaining.
      delivery: { dedupeKey: `sla:${incident.id}:${stage === 24 ? 'elapsed24' : stage === 48 ? '24' : 'overdue'}` },
    },
  };
}
