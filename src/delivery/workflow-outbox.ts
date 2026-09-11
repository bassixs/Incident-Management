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
import { publicChannelFor } from '../responsible-groups/public-channels';

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
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: {
    requester: true, assignedGroup: { select: { code: true } }, answers: { select: { deliveredAt: true } },
  } });
  if (incident.status !== 'RESOLVED' || incident.responseRating === null || !incident.answers.some(answer => answer.deliveredAt)) {
    throw new Error('A subscription invitation requires a resolved incident, delivered answer and saved rating');
  }
  const channel = publicChannelFor(incident.assignedGroup?.code);
  const dedupeKey = `subscription-invite:${incidentId}`;
  const message: CompositeMessage = {
    text: 'Подписывайтесь на наши каналы в MAX',
    keyboard: [
      [{ type: 'link', text: 'Владислав Шапша', url: 'https://max.ru/Shapsha_VV' }],
      [{ type: 'link', text: 'Правительство Калужской области', url: 'https://max.ru/pravitelstvo40' }],
      ...(channel ? [[{ type: 'link' as const, text: channel.name, url: channel.url }]] : []),
    ],
  };
  await queueMessage(tx, { userId: incident.requester.maxUserId }, { ...message, delivery: { dedupeKey } }, incidentId);
  await tx.outboundMessage.updateMany({
    where: { dedupeKey, status: { in: ['PENDING', 'FAILED'] } },
    data: { payload: message as unknown as Prisma.InputJsonValue, status: 'PENDING', nextAttemptAt: new Date(), attempts: 0, lastError: null, lockedAt: null },
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
    keyboard: sectorKeyboard(incidentId, { hasTemplate: Boolean(group.answerTemplate), status: incident.status }),
    delivery: { dedupeKey: `sector-card:${incidentId}${incident.history?.[0] ? ':return:' + incident.history[0].id : ''}`, tracking: { type: 'SECTOR_CARD', incidentId } },
  }, incidentId, incident.attachments);
}

/** Refresh every distribution card, including copies issued by the queue. */
export async function queueDistributionRefresh(tx: Tx, incidentId: string, event: string = randomUUID(), refreshActive = false): Promise<void> {
  await queueMessage(tx, { chatId: requiredChat(getConfig().DISTRIBUTION_CHAT_ID) }, {
    text: 'Обновление карточек распределения',
    operation: { type: 'distribution-refresh', incidentId, refreshActive },
    delivery: { dedupeKey: `distribution-refresh:${incidentId}:${event}` },
  }, incidentId);
}

export async function queueSectorRefresh(tx: Tx, incidentId: string, key: string, textOnly = false): Promise<void> {
  await queueStaffRefresh(tx, incidentId, key);
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: { assignedGroup: true } });
  if (!incident.assignedGroup?.maxChatId || !incident.sectorMessageId) return;
  await queueMessage(tx, { chatId: incident.assignedGroup.maxChatId }, {
    text: `Обновление карточки ${incident.publicCode}`, operation: { type: 'sector-refresh', incidentId, textOnly },
    delivery: { dedupeKey: key },
  }, incidentId);
}

/** Retire actions on all durable review/revision cards and queue copies. */
export async function queueStaffRefresh(tx: Tx, incidentId: string, event: string = randomUUID()): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: { assignedGroup: true } });
  const chatId = getConfig().REVIEW_CHAT_ID ?? incident.assignedGroup?.maxChatId;
  if (chatId == null) return;
  await queueMessage(tx, { chatId }, { text: 'Обновление действий в рабочих карточках',
    operation: { type: 'staff-refresh', incidentId }, delivery: { dedupeKey: `staff-refresh:${incidentId}:${event}` } }, incidentId);
  if (!['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) await tx.operatorSession.deleteMany({ where: { incidentId, type: 'WAITING_FOR_ANSWER' } });
  if (incident.status !== 'WAITING_REVIEW') {
    await tx.operatorSession.deleteMany({ where: { incidentId, type: 'WAITING_REVISION_REASON', NOT: { data: { path: ['redistribution'], equals: true } } } });
    await tx.actionLock.deleteMany({ where: { incidentId, action: 'review-queue' } });
  }
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
  await queueSectorRefresh(tx, incidentId, `sector-status:${incidentId}:revision:${incident.revisionCount}`, true);
}

export async function queueRejection(tx: Tx, incidentId: string, reason: string): Promise<void> {
  const incident = await tx.incident.findUniqueOrThrow({ where: { id: incidentId }, include: INCIDENT_INCLUDE });
  await queueMessage(tx, { userId: incident.requester.maxUserId }, {
    text: rejectionToRequester(incident, reason), label: codeLabel(incident),
    delivery: { dedupeKey: `rejection:${incidentId}` },
  }, incidentId);
}
