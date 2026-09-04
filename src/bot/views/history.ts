import type { AdminAuditLog, Incident, IncidentHistory, User } from '@prisma/client';

import { describeStatus } from '../../incidents/incident-state.service';
import { formatDateTime } from '../../utils/datetime';

const ACTION_LABELS: Record<string, string> = {
  INCIDENT_CREATED: 'Обращение создано',
  DISTRIBUTION_CARD_SENT: 'Карточка отправлена диспетчеру',
  ASSIGNED: 'Обращение распределено',
  SECTOR_CARD_SENT: 'Карточка отправлена в профильный чат',
  TAKEN_IN_WORK: 'Обращение взято в работу',
  ANSWER_CREATED: 'Подготовлена версия ответа',
  SENT_TO_REVIEW: 'Ответ отправлен на согласование',
  REVISION_REQUESTED: 'Ответ возвращён на доработку',
  ANSWER_APPROVED: 'Ответ согласован',
  ANSWER_SENT_DIRECT: 'Ответ отправлен без согласования',
  ANSWER_SENT: 'Ответ доставлен заявителю',
  INCIDENT_REJECTED: 'Обращение отклонено',
  USER_BANNED: 'Автор обращения заблокирован',
  USER_UNBANNED: 'Блокировка автора снята',
  SLA_WARNING_24H: 'Отправлено предупреждение: осталось 24 часа',
  SLA_WARNING_6H: 'Отправлено предупреждение: осталось 6 часов',
  SLA_OVERDUE: 'Срок ответа истёк',
  DELIVERY_FAILED: 'Ошибка доставки ответа',
};

export function incidentHistoryText(
  incident: Pick<Incident, 'publicCode' | 'status' | 'isOverdue' | 'createdAt' | 'deadlineAt'>,
  entries: IncidentHistory[],
  users: Array<Pick<User, 'maxUserId' | 'displayName'>>,
  timeZone: string,
): string {
  const names = new Map(users.map((user) => [user.maxUserId.toString(), user.displayName]));
  const lines = [
    `История ${incident.publicCode}`,
    `Текущий статус: ${describeStatus(incident.status, incident.isOverdue)}`,
    `Создано: ${formatDateTime(incident.createdAt, timeZone)}`,
    `Срок: ${formatDateTime(incident.deadlineAt, timeZone)}`,
    '',
  ];
  if (entries.length === 0) return [...lines, 'Записей истории пока нет.'].join('\n');

  for (const [index, entry] of entries.entries()) {
    const metadata = asRecord(entry.metadata);
    const actor = actorOf(entry, metadata, names);
    lines.push(`${index + 1}. ${formatDateTime(entry.createdAt, timeZone)} — ${ACTION_LABELS[entry.action] ?? entry.action}`);
    if (entry.fromStatus || entry.toStatus) {
      lines.push(`   Статус: ${entry.fromStatus ? describeStatus(entry.fromStatus, false) : '—'} → ${entry.toStatus ? describeStatus(entry.toStatus, false) : '—'}`);
    }
    if (actor) lines.push(`   Выполнил: ${actor}`);
    for (const detail of historyDetails(entry.action, metadata)) lines.push(`   ${detail}`);
  }
  return lines.join('\n');
}

export function adminAuditText(entries: AdminAuditLog[], timeZone: string): string {
  if (entries.length === 0) {
    return 'Журнал административных действий пока пуст. Записи начнут появляться после внедрения аудита.';
  }
  return [
    'Последние административные действия:',
    '',
    ...entries.flatMap((entry, index) => [
      `${index + 1}. ${formatDateTime(entry.createdAt, timeZone)} — ${entry.summary}`,
      `   Администратор: ${entry.actorName} (${entry.actorMaxUserId.toString()})`,
      ...(entry.targetId ? [`   Объект: ${entry.targetType ?? 'объект'} ${entry.targetId}`] : []),
    ]),
  ].join('\n');
}

function actorOf(
  entry: IncidentHistory,
  metadata: Record<string, unknown>,
  names: Map<string, string>,
): string | undefined {
  if (entry.actorMaxUserId !== null) {
    const id = entry.actorMaxUserId.toString();
    return `${names.get(id) ?? stringValue(metadata.dispatcher) ?? stringValue(metadata.responder) ?? stringValue(metadata.approver) ?? 'пользователь'} (${id})`;
  }
  return stringValue(metadata.dispatcher) ?? stringValue(metadata.responder) ?? stringValue(metadata.approver);
}

function historyDetails(action: string, metadata: Record<string, unknown>): string[] {
  const details: string[] = [];
  if (metadata.categoryCode) details.push(`Сфера: ${String(metadata.categoryCode)}`);
  if (metadata.version) details.push(`Версия ответа: ${String(metadata.version)}`);
  if (metadata.reason) details.push(`Причина: ${String(metadata.reason)}`);
  if (metadata.targetMaxUserId) details.push(`Пользователь: ${String(metadata.targetMaxUserId)}`);
  if (metadata.deadlineAt) details.push(`Дедлайн: ${String(metadata.deadlineAt)}`);
  if (action === 'DELIVERY_FAILED') details.push('Подробности доступны через /delivery_errors.');
  return details;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
