import type { IncidentAnswer } from '@prisma/client';
import type { Tx } from '../database/prisma';
import { INCIDENT_INCLUDE, type IncidentWithRelations } from '../incidents/incident.repository';
import { getConfig } from '../config';
import { queueMessage } from './workflow-outbox';

export function answerDeliveredNotice(incident: Pick<IncidentWithRelations, 'publicCode'>, answer: Pick<IncidentAnswer, 'version'>): string {
  return `✅ ${incident.publicCode}: ответ (версия ${answer.version}) доставлен пользователю.`;
}

export function reviewDeliveryNotice(incident: IncidentWithRelations, answer: IncidentAnswer): string {
  return [
    answer.deliveredAt ? answerDeliveredNotice(incident, answer) : `⏳ ${incident.publicCode}: ответ согласован, ожидает доставки пользователю.`,
    '', 'Согласовал:', incident.approvedBy?.displayName ?? '—', '', 'Версия ответа:', String(answer.version),
  ].join('\n');
}

/** Card updates are durable too, and render current delivery state at execution time. */
export async function queueDeliveryStatus(tx: Tx, incidentId: string, answerId: string, delivered: boolean): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  const answer = incident.answers.find(a => a.id === answerId);
  if (!answer || (delivered && !answer.deliveredAt)) return;
  if (delivered && incident.status === 'RESOLVED' && answer.status === 'APPROVED') {
    await queueMessage(tx, { userId: incident.requester.maxUserId }, {
      text: 'Ответы на волнующие вас вопросы можно также узнать в этих каналах. Подпишитесь:',
      keyboard: [
        [{ type: 'link', text: 'Владислав Шапша', url: 'https://max.ru/Shapsha_VV' }],
        [{ type: 'link', text: 'Правительство Калужской области', url: 'https://max.ru/pravitelstvo40' }],
      ],
      delivery: { dedupeKey: `subscription-invite:${incidentId}` },
    }, incidentId);
  }
  const stage = delivered ? 'delivered' : 'pending';
  for (const card of ['review', 'distribution'] as const) {
    const messageId = card === 'review' ? incident.reviewMessageId : incident.distributionMessageId;
    const chatId = card === 'review' ? getConfig().REVIEW_CHAT_ID : getConfig().DISTRIBUTION_CHAT_ID;
    if (!messageId || chatId == null || (card === 'distribution' && !delivered) || (card === 'review' && incident.assignedGroup?.bypassReview)) continue;
    await queueMessage(tx, { chatId }, {
      text: `Обновление карточки ${incident.publicCode}: ${stage}`,
      operation: { type: 'delivery-card', incidentId, answerId, card },
      delivery: { dedupeKey: `delivery-status:${answerId}:${stage}:${card}` },
    }, incidentId);
  }
  if (delivered && incident.assignedGroup?.maxChatId != null) {
    await queueMessage(tx, { chatId: incident.assignedGroup.maxChatId }, {
      text: answerDeliveredNotice(incident, answer),
      delivery: { dedupeKey: `answer-delivered:${answerId}:sector` },
    }, incidentId);
  }
}
