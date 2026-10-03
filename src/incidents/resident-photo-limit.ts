import type { IncomingMedia } from '../media/media.service';
import { ValidationError } from '../utils/errors';

/** Admission limit for resident drafts only, not a delivery or staff-answer limit. */
export const RESIDENT_PHOTO_LIMIT = 4;
export const RESIDENT_PHOTO_LIMIT_MESSAGE = `К одному сообщению можно приложить не более ${RESIDENT_PHOTO_LIMIT} фотографий. Выберите до ${RESIDENT_PHOTO_LIMIT} фото и отправьте заново`;

export function exceedsResidentPhotoLimit(media: readonly IncomingMedia[]): boolean {
  return media.filter(item => item.kind === 'IMAGE').length > RESIDENT_PHOTO_LIMIT;
}

export function assertResidentPhotoLimit(media: readonly IncomingMedia[], input?: 'initial' | 'replacement'): void {
  if (!exceedsResidentPhotoLimit(media)) return;
  const hint = input === 'initial'
    ? `Повторно отправьте текст сообщения вместе с выбранными фото — до ${RESIDENT_PHOTO_LIMIT} фотографий.`
    : input === 'replacement' ? `Повторно отправьте только выбранные фотографии — до ${RESIDENT_PHOTO_LIMIT} фотографий.` : '';
  throw new ValidationError([RESIDENT_PHOTO_LIMIT_MESSAGE, hint].filter(Boolean).join('\n\n'), { reason: 'too_many_photos' });
}
