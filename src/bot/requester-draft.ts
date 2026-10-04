import { deliverSavedScreen, prepareScreenDelivery, DraftScreenPendingError } from './draft-screen-delivery';
import { exceedsResidentPhotoLimit, RESIDENT_PHOTO_LIMIT, RESIDENT_PHOTO_LIMIT_MESSAGE } from '../incidents/resident-photo-limit';
import { bindDraftKeyboard, sendDraftScreen, STALE_DRAFT } from './draft-screen';
import type { AppServices } from '../app/container';
import type { IncomingMedia } from '../media/media.service';
import type { OutboundAttachment } from '../max/max-message.service';
import type { SessionData } from '../sessions/operator-session.service';
import { SessionType, type OperatorSession } from '@prisma/client';
import { randomUUID } from 'node:crypto';

import { ValidationError } from '../utils/errors';
import { assertMediaSize } from '../media/media-limits';
import { isUnavailablePhoto } from '../media/max-photo-reference';
import { incidentDraftConfirmationKeyboard, incidentDraftPhotoRetryKeyboard, incidentDraftPhotoKeyboard } from './keyboards';
import { incidentDraftPreview } from './views/cards';

/** Best effort: retire obsolete draft previews and their buttons.
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
  services: AppServices, maxUserId: bigint, chatId: bigint, data: SessionData, expectedSession?: OperatorSession,
): Promise<void> {
  const { requesterName: _name, pendingPhone: _legacyPhone, ...minimal } = data;
  const draft = requireCompleteIncidentDraft(minimal);
  const tooManyPhotos = exceedsResidentPhotoLimit(draft.draftMedia);
  const { draftEditField: _field, draftPhotoRetry: _retry, phoneInputStartedAt: _phoneStarted, ...cleanDraft } = draft;
  cleanDraft.draftToken ??= randomUUID();
  cleanDraft.previewToken = randomUUID();
  cleanDraft.previewStartedAt = Date.now();
  cleanDraft.draftTouchedAt = Date.now();
  let nextType: SessionType = tooManyPhotos ? SessionType.WAITING_INCIDENT_EDIT_SELECTION : SessionType.WAITING_INCIDENT_CONFIRMATION;
  let message: import('../max/max-message.service').CompositeMessage;
  if (tooManyPhotos) {
    delete cleanDraft.previewDeliveryPending;
    message = {
      text: `${RESIDENT_PHOTO_LIMIT_MESSAGE}\n\nТекст, телефон, тема, место и прежние фотографии сохранены. Нажмите «Заменить фотографии» и отправьте только выбранные фотографии — до ${RESIDENT_PHOTO_LIMIT} фотографий — или удалите фотографии кнопкой ниже. Сообщение ещё не отправлено.`,
      keyboard: incidentDraftPhotoKeyboard(true),
    };
  } else {
    let attachments: OutboundAttachment[];
    try { attachments = await loadPreviewPhotos(draft.draftMedia); }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      // Local validation identifies unavailable photos before saving the next screen.
      cleanDraft.draftMedia = []; cleanDraft.draftEditField = 'photo'; cleanDraft.draftPhotoRetry = true;
      delete cleanDraft.previewDeliveryPending;
      nextType = SessionType.WAITING_INCIDENT_EDIT_VALUE;
      message = photoReplacement(error.message);
      attachments = [];
    }
    if (nextType === SessionType.WAITING_INCIDENT_CONFIRMATION) {
      const category = draft.selectedCategoryId ? await services.categories.findById(draft.selectedCategoryId) : null;
      cleanDraft.previewDeliveryPending = true;
      message = {
        text: incidentDraftPreview({ problemMunicipalityName: draft.problemMunicipalityName, problemLocality: draft.problemLocality,
          draftText: draft.draftText, photoCount: attachments.length, requesterPhone: draft.requesterPhone }, category?.name),
        keyboard: incidentDraftConfirmationKeyboard(cleanDraft.previewToken, !!draft.requesterPhone),
        ...(attachments.length ? { attachments } : {}),
      };
    }
  }
  message!.keyboard = bindDraftKeyboard(cleanDraft, message!.keyboard);
  prepareScreenDelivery(cleanDraft, message!, nextType === SessionType.WAITING_INCIDENT_CONFIRMATION, nextType);
  expectedSession ??= await services.sessions.find(maxUserId, chatId) ?? undefined;
  if (expectedSession) {
    if (data.draftToken && services.sessions.readData(expectedSession).draftToken !== data.draftToken) throw new ValidationError(STALE_DRAFT);
    if (!await services.sessions.replaceCurrent(expectedSession, nextType, cleanDraft)) throw new ValidationError(STALE_DRAFT);
    expectedSession = { ...expectedSession, type: nextType, data: cleanDraft as never };
  } else {
    if (data.draftToken) throw new ValidationError(STALE_DRAFT);
    expectedSession = await services.sessions.start({ maxUserId, chatId, type: nextType, data: cleanDraft });
  }
  try { await deliverSavedScreen(services, expectedSession); }
  catch (error) {
    if (error instanceof DraftScreenPendingError) return; // Persisted retry, not a replacement-photo request.
    if (!draft.draftMedia.length || !isUnavailablePhoto(error)) throw error;
    // Only an explicit MAX photo/token error permits requesting replacement.
    const live = await services.sessions.find(maxUserId, chatId);
    if (!live || services.sessions.readData(live).screenToken !== cleanDraft.screenToken) return;
    const retryData = { ...services.sessions.readData(live), draftMedia: [], draftEditField: 'photo' as const, draftPhotoRetry: true };
    delete retryData.previewDeliveryPending; delete retryData.draftScreenDelivery;
    if (!await services.sessions.replaceCurrent(live, SessionType.WAITING_INCIDENT_EDIT_VALUE, retryData)) return;
    await sendDraftScreen(services, maxUserId, chatId, photoReplacement('Фотография больше недоступна в MAX.'));
  }
}

function photoReplacement(reason: string): import('../max/max-message.service').CompositeMessage {
  return { text: `${reason}\n\nТекст сообщения и остальные данные сохранены. Отправьте до ${RESIDENT_PHOTO_LIMIT} фотографий заново, при необходимости уменьшив их размер, или нажмите «Продолжить без фотографий».`,
    keyboard: incidentDraftPhotoRetryKeyboard() };
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
