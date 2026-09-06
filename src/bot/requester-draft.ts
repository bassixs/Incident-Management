import type { AppServices } from '../app/container';
import type { IncomingMedia } from '../media/media.service';
import type { OutboundAttachment } from '../max/max-message.service';
import type { SessionData } from '../sessions/operator-session.service';
import { SessionType } from '@prisma/client';

import { ValidationError } from '../utils/errors';
import { assertMediaSize } from '../media/media-limits';
import { isUnavailablePhoto } from '../media/max-photo-reference';
import { moduleLogger } from '../utils/logger';
import { incidentDraftConfirmationKeyboard, incidentDraftPhotoRetryKeyboard } from './keyboards';
import { incidentDraftPreview } from './views/cards';

const log = moduleLogger('requester-draft');

export type CompleteIncidentDraft = SessionData & {
  requesterName: string;
  requesterPhone: string;
  selectedCategoryId: string | null;
  problemMunicipalityCode: string;
  problemMunicipalityName: string;
  problemLocality: string | null;
  draftText: string;
  draftMedia: IncomingMedia[];
};

export function requireCompleteIncidentDraft(data: SessionData): CompleteIncidentDraft {
  if (
    !data.requesterName ||
    !data.requesterPhone ||
    !data.problemMunicipalityCode ||
    !data.problemMunicipalityName ||
    !data.draftText
  ) {
    throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
  }
  return {
    ...data,
    requesterName: data.requesterName,
    requesterPhone: data.requesterPhone,
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
): Promise<void> {
  const draft = requireCompleteIncidentDraft(data);
  const { draftEditField: _draftEditField, draftPhotoRetry: _draftPhotoRetry, ...cleanDraft } = draft;
  const category = draft.selectedCategoryId
    ? await services.categories.findById(draft.selectedCategoryId)
    : null;
  let attachments: OutboundAttachment[];
  try {
    attachments = await loadPreviewPhotos(services, draft.draftMedia);
    await services.messages.send({ userId: maxUserId }, {
      text: incidentDraftPreview({ requesterName: draft.requesterName, requesterPhone: draft.requesterPhone,
        problemMunicipalityName: draft.problemMunicipalityName, problemLocality: draft.problemLocality,
        draftText: draft.draftText, photoCount: attachments.length }, category?.name),
      keyboard: incidentDraftConfirmationKeyboard(), immediatePreview: true,
      ...(attachments.length ? { attachments } : {}),
    });
  } catch (error) {
    if (!draft.draftMedia.length) throw error;
    // The failed set must never become confirmable or be silently omitted.
    // Preserve the entered fields and let the requester replace all photos.
    log.warn({ err: error instanceof Error ? error.message : String(error) }, 'draft photos require replacement');
    await services.sessions.start({
      maxUserId, chatId,
      type: SessionType.WAITING_INCIDENT_EDIT_VALUE,
      data: { ...cleanDraft, draftMedia: [], draftEditField: 'photo', draftPhotoRetry: true },
    });
    const reason = isUnavailablePhoto(error) ? 'Фотография больше недоступна в MAX.' : error instanceof ValidationError
      ? error.message
      : 'Не удалось показать фотографии через MAX.';
    await services.messages.send({ userId: maxUserId }, {
      text: `${reason}\n\nТекст обращения и остальные данные сохранены. Отправьте все нужные фотографии заново, при необходимости уменьшив их размер, или нажмите «Продолжить без фотографий».`,
      keyboard: incidentDraftPhotoRetryKeyboard(),
    });
    return;
  }
  await services.sessions.start({
    maxUserId,
    chatId,
    type: SessionType.WAITING_INCIDENT_CONFIRMATION,
    data: cleanDraft,
  });
}

async function loadPreviewPhotos(
  services: AppServices,
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
