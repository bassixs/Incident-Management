import type { AppServices } from '../app/container';
import type { IncomingMedia } from '../media/media.service';
import type { SessionData } from '../sessions/operator-session.service';
import { SessionType } from '@prisma/client';

import { ValidationError } from '../utils/errors';
import { incidentDraftConfirmationKeyboard } from './keyboards';
import { incidentDraftPreview } from './views/cards';

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
  const { draftEditField: _draftEditField, ...cleanDraft } = draft;
  await services.sessions.start({
    maxUserId,
    chatId,
    type: SessionType.WAITING_INCIDENT_CONFIRMATION,
    data: cleanDraft,
  });
  const category = draft.selectedCategoryId
    ? await services.categories.findById(draft.selectedCategoryId)
    : null;
  await services.messages.send(
    { userId: maxUserId },
    {
      text: incidentDraftPreview(
        {
          requesterName: draft.requesterName,
          requesterPhone: draft.requesterPhone,
          problemMunicipalityName: draft.problemMunicipalityName,
          problemLocality: draft.problemLocality,
          draftText: draft.draftText,
          photoCount: draft.draftMedia.length,
        },
        category?.name,
      ),
      keyboard: incidentDraftConfirmationKeyboard(),
    },
  );
}
