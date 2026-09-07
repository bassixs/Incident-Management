import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { distributionKeyboard, mainMenuKeyboard, reviewKeyboard, sectorKeyboard, revisionKeyboard, answerRatingKeyboard } from '../bot/keyboards';
import { codeLabel, distributionCard, sectorCard, reviewCard, revisionCard, finalAnswerToRequester, registrationConfirmation, rejectionToRequester } from '../bot/views/cards';
import { getConfig } from '../config';
import type { Tx } from '../database/prisma';
import { INCIDENT_INCLUDE } from '../incidents/incident.repository';
import type { CompositeMessage, SendTarget } from '../max/max-message.service';
import type { StoredAttachmentRecord } from '../media/attachment-loader';
import { AppError } from '../utils/errors';

/** Only database writes: no MAX or file I/O may happen inside a business transaction.
 * Borrowed attachment references remain owned by the incident/answer retention policy.
 */
export async function queueMessage(
  tx: Tx, target: SendTarget, message: CompositeMessage, incidentId: string,
  attachments: StoredAttachmentRecord[] = [],
): Promise<void> {
  const dedupeKey = message.delivery?.dedupeKey;
  if (!dedupeKey) throw new Error('Transactional messages require a dedupe key');
  const tracking = message.delivery?.tracking;
  const { delivery: _delivery, attachments: _attachments, ...payload } = message;
  await tx.outboundMessage.createMany({
    skipDuplicates: true,
    data: [{
      dedupeKey,
      targetType: 'chatId' in target ? 'chat' : 'user',
      targetId: 'chatId' in target ? target.chatId : target.userId,
      incidentId,
      answerId: tracking && 'answerId' in tracking ? tracking.answerId : null,
      trackingType: tracking?.type ?? null,
      trackingApplied: !tracking,
      payload: payload as unknown as Prisma.InputJsonValue,
      attachments: attachments.map(a => ({ type: a.type, storageKey: a.storageKey, originalName: a.originalName, owned: false })) as unknown as Prisma.InputJsonValue,
    }],
  });
}

function requiredChat(chatId: bigint | null | undefined): bigint {
  if (chatId == null) throw new AppError('Рабочий чат не настроен.', 'CONFIG_MISSING');
  return chatId;
}

/** Persist the invitation with the rating, and release any pre-upgrade queued invitation. */
export async function queueSubscriptionInvite(tx: Tx, incidentId: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: { requester: true } });
  if (incident.responseRating === null) throw new Error('A subscription invitation requires a saved rating');
  const dedupeKey = `subscription-invite:${incidentId}`;
  await queueMessage(tx, { userId: incident.requester.maxUserId }, {
    text: 'Ответы на волнующие вас вопросы можно также узнать в этих каналах. Подпишитесь:',
    keyboard: [
      [{ type: 'link', text: 'Владислав Шапша', url: 'https://max.ru/Shapsha_VV' }],
      [{ type: 'link', text: 'Правительство Калужской области', url: 'https://max.ru/pravitelstvo40' }],
    ],
    delivery: { dedupeKey },
  }, incidentId);
  await tx.outboundMessage.updateMany({
    where: { dedupeKey, status: { in: ['PENDING', 'FAILED'] } },
    data: { status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lastError: null, lockedAt: null },
  });
}

export async function queueDistribution(tx: Tx, incidentId: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  await queueMessage(tx, { chatId: requiredChat(getConfig().DISTRIBUTION_CHAT_ID) }, {
    text: distributionCard(incident), label: codeLabel(incident), keyboard: distributionKeyboard(incidentId),
    delivery: { dedupeKey: `distribution-card:${incidentId}`, tracking: { type: 'DISTRIBUTION_CARD', incidentId } },
  }, incidentId, incident.attachments);
  await queueMessage(tx, { userId: incident.requester.maxUserId }, {
    text: registrationConfirmation(incident), keyboard: mainMenuKeyboard(),
    delivery: { dedupeKey: `registration:${incidentId}` },
  }, incidentId);
}

export async function queueSector(tx: Tx, incidentId: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  const group = incident.assignedGroup;
  if (!group) throw new Error('Incident has no responsible group');
  await queueMessage(tx, { chatId: requiredChat(group.maxChatId) }, {
    text: sectorCard(incident, group), label: codeLabel(incident),
    keyboard: sectorKeyboard(incidentId, { hasTemplate: Boolean(group.answerTemplate) }),
    delivery: { dedupeKey: `sector-card:${incidentId}`, tracking: { type: 'SECTOR_CARD', incidentId } },
  }, incidentId, incident.attachments);
}

/** Refresh every distribution card, including copies issued by the queue. */
export async function queueDistributionRefresh(tx: Tx, incidentId: string, event: string = randomUUID()): Promise<void> {
  await queueMessage(tx, { chatId: requiredChat(getConfig().DISTRIBUTION_CHAT_ID) }, {
    text: 'Обновление карточек распределения',
    operation: { type: 'distribution-refresh', incidentId },
    delivery: { dedupeKey: `distribution-refresh:${incidentId}:${event}` },
  }, incidentId);
}

export async function queueSectorRefresh(tx: Tx, incidentId: string, key: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: { assignedGroup: true } });
  if (!incident.assignedGroup?.maxChatId || !incident.sectorMessageId) return;
  await queueMessage(tx, { chatId: incident.assignedGroup.maxChatId }, {
    text: `Обновление карточки ${incident.publicCode}`, operation: { type: 'sector-refresh', incidentId },
    delivery: { dedupeKey: key },
  }, incidentId);
}

export async function queueAnswer(tx: Tx, incidentId: string, answerId: string, direct: boolean): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  const answer = incident.answers.find(a => a.id === answerId);
  if (!answer) throw new Error('Answer does not belong to incident');
  await queueMessage(tx,
    direct ? { userId: incident.requester.maxUserId } : { chatId: requiredChat(getConfig().REVIEW_CHAT_ID) },
    {
      text: direct ? finalAnswerToRequester(incident, answer, incident.answeredAt ?? answer.approvedAt ?? new Date(), incident.assignedGroup?.authorityName)
        : reviewCard(incident, answer, incident.assignedGroup),
      label: codeLabel(incident),
      keyboard: direct ? answerRatingKeyboard(incidentId) : reviewKeyboard(incidentId, answerId),
      delivery: { dedupeKey: `${direct ? 'answer' : 'review-card'}:${answerId}`,
        tracking: { type: direct ? 'ANSWER_TO_REQUESTER' : 'REVIEW_CARD', incidentId, answerId } },
    }, incidentId, answer.attachments,
  );
}

export async function queueRevision(tx: Tx, incidentId: string, version: number, reason: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  await queueMessage(tx, { chatId: requiredChat(incident.assignedGroup?.maxChatId) }, {
    text: revisionCard(incident, version, reason), label: codeLabel(incident), keyboard: revisionKeyboard(incidentId),
    delivery: { dedupeKey: `revision:${incidentId}:${version}` },
  }, incidentId);
}

export async function queueRejection(tx: Tx, incidentId: string, reason: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  await queueMessage(tx, { userId: incident.requester.maxUserId }, {
    text: rejectionToRequester(incident, reason), label: codeLabel(incident),
    delivery: { dedupeKey: `rejection:${incidentId}` },
  }, incidentId);
}
