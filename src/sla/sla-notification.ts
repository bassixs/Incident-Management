import { incidentWorkday } from '../utils/work-calendar';
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

export function slaStage(incident: Incident, now: Date): SlaStage | undefined {
  if (incident.slaPausedAt) return undefined;
  if (incident.status === 'RESOLVED' || incident.status === 'REJECTED') return undefined;
  if (incident.deadlineAt <= now) return 'overdue';
  if (now >= incidentWorkday(incident.createdAt, 3).start) return 48;
  if (now >= incidentWorkday(incident.createdAt, 2).start) return 24;
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
        stage === 'overdue' ? '🚨 ПРОСРОЧЕНО' : `⚠️ Напоминание: ${stage === 24 ? 'второй' : 'третий'} рабочий день`,
        '',
        `№ ${incident.publicCode}`,
        stage === 'overdue' ? 'Срок ответа истёк. Обращение не закрыто.' : 'Обращение ещё не закрыто.',
        `Статус: ${describeStatus(incident.status)}`,
        `Ответственная группа: ${incident.assignedGroup?.name ?? 'Не назначена — требуется распределение'}`,
        `Ответственный сотрудник: ${incident.currentResponder?.displayName ?? 'Пока никто не взял в работу'}`,
        `Зарегистрировано: ${formatDateTime(incident.createdAt)}`,
        `Срок ответа: ${formatDateTime(incident.deadlineAt)}`,
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
