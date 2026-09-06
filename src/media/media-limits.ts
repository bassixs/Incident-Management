import { getConfig } from '../config';
import { ValidationError } from '../utils/errors';

/** Applies to both announced size and actual downloaded (decoded) bytes. */
export function assertMediaSize(size: number): void {
  const limitMb = getConfig().MEDIA_MAX_FILE_MB;
  if (size > limitMb * 1024 * 1024) {
    throw new ValidationError(`Вложение слишком большое. Максимальный размер одного файла — ${limitMb} МБ. Уменьшите его размер и отправьте заново.`);
  }
}
