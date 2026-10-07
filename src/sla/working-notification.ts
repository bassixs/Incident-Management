import type { Incident } from '@prisma/client';
import { getConfig } from '../config';
import { formatMoscowDateTime } from '../utils/datetime';
import { policyDeliveryState } from './policy';

export function workingDeadlineTargets(): bigint[] {
  const config = getConfig();
  return [...new Set([config.DISTRIBUTION_CHAT_ID, config.REVIEW_CHAT_ID].filter((id): id is bigint => id !== undefined))];
}
export function workingDeadlineNotification(incident: Incident): string {
  return ['⏱ Общий срок ответа истёк (24 рабочих часа)', `№ ${incident.publicCode}`,
    `Срок: ${formatMoscowDateTime(incident.deadlineAt)} МСК`, policyDeliveryState(incident),
    'Ошибка доставки не является просрочкой подготовки проекта.'].join('\n');
}
