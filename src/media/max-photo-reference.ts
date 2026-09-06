import { MaxError } from '@maxhub/max-bot-api';
import { ValidationError } from '../utils/errors';

// A tagged reference, never a path in local/S3 storage. Legacy paths stay valid.
const PREFIX = 'max-photo:';
export function photoReference(token: string): string {
  if (!token.trim()) throw new ValidationError('Не удалось получить фотографию из MAX. Прикрепите её заново.');
  return PREFIX + encodeURIComponent(token);
}
export function isPhotoReference(key: string): boolean { return key.startsWith(PREFIX); }
export function photoToken(key: string): string | undefined {
  return isPhotoReference(key) ? decodeURIComponent(key.slice(PREFIX.length)) : undefined;
}
export function isUnavailablePhoto(error: unknown): boolean {
  if (!(error instanceof MaxError) || ![400, 404, 410].includes(error.status)) return false;
  const detail = `${error.code} ${error.description}`;
  // Processing/temporary failures must retry; a token is not necessarily lost.
  return !/not[._ ]?ready|processing|temporar/i.test(detail)
    && /token|attachment|photo|image/i.test(detail)
    && /invalid|expired|not[._ ]?found|unavailable|revoked|deleted/i.test(detail);
}
