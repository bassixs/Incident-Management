import { normaliseRequesterPhone } from '../incidents/incident.service';

export const OPTIONAL_PHONE_OFFER = 'Для более оперативной обработки можно поделиться телефоном. Это необязательно.';
export const OPTIONAL_PHONE_ADDED = 'Номер виден участникам рабочих чатов в карточке сообщения. Специалист сможет связаться с вами для уточнения деталей.';
export const PHONE_INPUT_PROMPT = 'Введите номер телефона для связи, например +7 900 123-45-67. Можно продолжить без номера';
export const PHONE_INPUT_ERROR = 'Не удалось распознать номер. Введите российский номер с +7 или 8, например +7 900 123-45-67, или вернитесь к карточке без добавления номера.';
export const CONTACT_REJECTION = 'Системные карточки контакта больше не используются. На итоговой карточке нажмите «📞 Поделиться контактом» и введите номер вручную. Сообщение не отправлено.';

/** Bound at inbox admission, rechecked before changing a draft. No raw input retained. */
export type DraftPhoneInput = { sessionId: string; draftToken: string; previewToken: string; screenToken?: string; phone?: string };

/** Format validation only; does not establish ownership of the number. */
export function parseManualPhone(raw: string): string | null {
  const value = raw.trim();
  if (value.length > 64 || !/^(?:\+7|8)[\d ()\t-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (!/^[78]\d{10}$/.test(digits)) return null;
  // Do not accept malformed/nested parentheses as an otherwise valid phone.
  let depth = 0;
  for (const c of value) {
    if (c === '(' && ++depth !== 1) return null;
    if (c === ')' && --depth !== 0) return null;
  }
  if (depth !== 0) return null;
  return normaliseRequesterPhone('+7' + digits.slice(1));
}
