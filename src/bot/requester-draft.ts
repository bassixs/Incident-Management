import { MaxError } from '@maxhub/max-bot-api';
import type { AppServices } from '../app/container';
import type { IncomingMedia } from '../media/media.service';
import type { OutboundAttachment } from '../max/max-message.service';
import type { SessionData } from '../sessions/operator-session.service';
import { SessionType, type OperatorSession } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { ValidationError } from '../utils/errors';
import { assertMediaSize } from '../media/media-limits';
import { isUnavailablePhoto } from '../media/max-photo-reference';
import { moduleLogger } from '../utils/logger';
import { incidentDraftConfirmationKeyboard, incidentDraftPhotoRetryKeyboard } from './keyboards';
import { incidentDraftPreview } from './views/cards';

const log = moduleLogger('requester-draft');

/** Best effort: a native contact button has no draft token, so retire old cards.
 * Only pass previewMessageId from the validated owner/chat-scoped draft session,
 * or the ID returned by sending that preview in this operation. Never fall back
 * to callback message IDs, search chat history, or touch working-chat cards.
 */
export async function retireIncidentDraftPreview(services: AppServices, messageId?: string): Promise<void> {
  if (!messageId) return;
  const deleted = await services.messages.deleteCard(messageId).catch(() => false);
  if (!deleted) await services.messages.finalizeCard(messageId, 'Карточка устарела. Используйте текущую карточку сообщения.').catch(() => false);
}

export type CompleteIncidentDraft = SessionData & {
  selectedCategoryId: string | null;
  problemMunicipalityCode: string;
  problemMunicipalityName: string;
  problemLocality: string | null;
  draftText: string;
  draftMedia: IncomingMedia[];
};

export function requireCompleteIncidentDraft(data: SessionData): CompleteIncidentDraft {
  if (
    !data.problemMunicipalityCode ||
    !data.problemMunicipalityName ||
    !data.draftText
  ) {
    throw new ValidationError('Черновик устарел. Начните создание сообщения заново.');
  }
  return {
    ...data,
    selectedCategoryId: data.selectedCategoryId ?? null,
    problemMunicipalityCode: data.problemMunicipalityCode,
    problemMunicipalityName: data.problemMunicipalityName,
    problemLocality: data.problemLocality ?? null,
    draftText: data.draftText,
    draftMedia: (data.draftMedia ?? []).filter((item) => item.kind === 'IMAGE'),
  };
}

/** Remove undefined properties before persisting MAX attachment metadata as JSON. */
export function serialiseDraftMedia(media: IncomingMedia[]): IncomingMedia[] {
  return media
    .filter((item) => item.kind === 'IMAGE')
    .map((item) => ({
      kind: 'IMAGE' as const,
      ...(item.url ? { url: item.url } : {}),
      ...(item.token ? { token: item.token } : {}),
      ...(item.filename ? { filename: item.filename } : {}),
      ...(item.size === undefined ? {} : { size: item.size }),
    }));
}

export async function showIncidentDraftPreview(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint,
  data: SessionData,
  expectedSession?: OperatorSession,
): Promise<void> {
  const { requesterName: _name, pendingPhone: _legacyPhone, ...minimal } = data;
  const draft = requireCompleteIncidentDraft(minimal);
  const { draftEditField: _draftEditField, draftPhotoRetry: _draftPhotoRetry, ...cleanDraft } = draft;
  cleanDraft.draftToken ??= randomUUID();
  cleanDraft.previewToken = randomUUID();
  cleanDraft.previewStartedAt = Date.now();
  const previousMessageId = cleanDraft.previewMessageId;
  delete cleanDraft.previewMessageId;
  cleanDraft.previewDeliveryPending = true;
  expectedSession ??= await services.sessions.find(maxUserId, chatId) ?? undefined;
  if (expectedSession) {
    if (!await services.sessions.replaceCurrent(expectedSession, SessionType.WAITING_INCIDENT_CONFIRMATION, cleanDraft)) {
      throw new ValidationError('Черновик изменился. Используйте текущую карточку сообщения.');
    }
    expectedSession = { ...expectedSession, type: SessionType.WAITING_INCIDENT_CONFIRMATION, data: { ...cleanDraft } as never };
  } else expectedSession = await services.sessions.start({
    maxUserId, chatId, type: SessionType.WAITING_INCIDENT_CONFIRMATION, data: cleanDraft,
  });
  await retireIncidentDraftPreview(services, previousMessageId);
  let attachments: OutboundAttachment[];
  let validatingPhotos = true;
  try {
    attachments = await loadPreviewPhotos(draft.draftMedia);
    validatingPhotos = false;
    const category = draft.selectedCategoryId ? await services.categories.findById(draft.selectedCategoryId) : null;
    const sent = await services.messages.send({ userId: maxUserId }, {
      text: incidentDraftPreview({
        problemMunicipalityName: draft.problemMunicipalityName, problemLocality: draft.problemLocality,
        draftText: draft.draftText, photoCount: attachments.length,
        requesterPhone: draft.requesterPhone }, category?.name),
      keyboard: incidentDraftConfirmationKeyboard(cleanDraft.previewToken, !!draft.requesterPhone), immediatePreview: true,
      ...(attachments.length ? { attachments } : {}),
    });
    if (!sent?.firstMessageId || sent.state !== 'sent') throw new Error('Preview delivery not confirmed');
    cleanDraft.previewMessageId = sent.firstMessageId;
  } catch (error) {
    // Only local photo validation or an explicit MAX token error proves that
    // replacement is necessary. Network/5xx failures preserve the whole draft.
    if (!draft.draftMedia.length || !(isUnavailablePhoto(error) || (validatingPhotos && error instanceof ValidationError))) {
      log.warn({ status: error instanceof MaxError ? error.status : undefined }, 'draft preview delivery pending; resident can retry');
      const current = await services.sessions.find(maxUserId, chatId);
      if (!current || current.id !== expectedSession.id || current.type !== SessionType.WAITING_INCIDENT_CONFIRMATION) return;
      const currentData = services.sessions.readData(current);
      if (currentData.draftToken !== cleanDraft.draftToken || currentData.previewToken !== cleanDraft.previewToken) return;
      // Do not enqueue a static preview/phone or stale retry notice in the outbox.
      // If MAX is still down, /start or a plain message resumes the saved session.
      await services.messages.send({ userId: maxUserId }, {
        text: 'Не удалось показать карточку. Данные сохранены, сообщение не отправлено. Нажмите «Повторить показ карточки» или отправьте «Продолжить». Также можно использовать /start.',
        keyboard: [[{ type: 'callback', text: 'Повторить показ карточки', payload: `user:draft-retry:${cleanDraft.previewToken}` }],
          [{ type: 'callback', text: 'Отмена', payload: `user:draft-cancel:${cleanDraft.previewToken}` }]],
        immediatePreview: true,
      }).catch(() => undefined);
      return;
    }
    // The failed set must never become confirmable or be silently omitted.
    // Preserve the entered fields and let the requester replace all photos.
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'draft photos require replacement');
    const retryData = { ...cleanDraft, draftMedia: [], draftEditField: 'photo' as const, draftPhotoRetry: true };
    delete retryData.previewDeliveryPending;
    if (!await services.sessions.replaceCurrent(expectedSession, SessionType.WAITING_INCIDENT_EDIT_VALUE, retryData)) return;
    const reason = isUnavailablePhoto(error) ? 'Фотография больше недоступна в MAX.' : error instanceof ValidationError
      ? error.message
      : 'Не удалось показать фотографии через MAX.';
    await services.messages.send({ userId: maxUserId }, {
      text: `${reason}\n\nТекст сообщения и остальные данные сохранены. Отправьте все нужные фотографии заново, при необходимости уменьшив их размер, или нажмите «Продолжить без фотографий».`,
      keyboard: incidentDraftPhotoRetryKeyboard(),
    });
    return;
  }
  delete cleanDraft.previewDeliveryPending;
  if (!await services.sessions.replaceCurrent(expectedSession, SessionType.WAITING_INCIDENT_CONFIRMATION, cleanDraft)) {
    await retireIncidentDraftPreview(services, cleanDraft.previewMessageId);
  }
}

async function loadPreviewPhotos(
  media: IncomingMedia[],
): Promise<OutboundAttachment[]> {
  const attachments: OutboundAttachment[] = [];
  for (const photo of media) {
    if (!photo.token) throw new ValidationError('Не удалось получить фотографию из MAX.');
    if (photo.size !== undefined) assertMediaSize(photo.size);
    attachments.push({ type: 'IMAGE', maxToken: photo.token, originalName: photo.filename });
  }
  return attachments;
}
