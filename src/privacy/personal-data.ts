import { ValidationError } from '../utils/errors';

export const PRIVACY_REJECTION = 'Сообщение не принято: обнаружены возможные персональные данные. Уберите ФИО, телефоны, паспортные данные, СНИЛС, банковские реквизиты и личные контакты. Опишите только проблему и её местоположение, затем отправьте заново.';
export const PRIVACY_NOTICE = "Персональные данные указывать не нужно. Сохраняются ID в MAX, текст сообщения и служебные сведения о его обработке.\nТекст проходит автоматическую проверку, текст и фото — проверку сотрудником перед распределением.";

/** Conservative local screening, not a guarantee of anonymisation. Never return matched data. */
export function containsPersonalData(raw: string): boolean {
  const text = raw.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/\u00a0/g, ' ');
  return [
    /(?<!\d)(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s.-]*\d{2}[\s.-]*\d{2}(?!\d)/u,
    /(?<!\d)\d{10,19}(?!\d)/u,
    /(?<!\d)\d{2}\s?\d{2}\s+\d{6}(?!\d)/u,
    /(?<!\d)\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{2}(?!\d)/u,
    /[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/iu,
    /(?:паспорт|снилс|инн|номер\s+карты|расч[её]тный\s+сч[её]т|телефон|тел\.|моб\.)\s*(?:номер|серия|№|:|—|-)?\s*[+\d][\d\s().-]{4,}/iu,
    /(?:фио|ф\.и\.о\.|меня\s+зовут|мои\s+данные)\s*[:—-]?\s*[а-яёa-z]{2,}/iu,
    /(?<![а-яё])[а-яё]+(?:ович|евич|ич|овна|евна|ична)\s+[а-яё]+(?:ов|ев|ин|ова|ева|ина|ский|ская)(?![а-яё])/iu,
    /(?<![а-яё])[а-яё]{2,}[-а-яё]*\s+[а-яё]{2,}[-а-яё]*\s+[а-яё]+(?:ович|евич|овна|евна|ична)(?![а-яё])/iu,
    /(?<![а-яё])[А-ЯЁ][а-яё]+(?:ов|ев|ин|ова|ева|ина|ский|ская)\s+[А-ЯЁ]\s*\.\s*(?:[А-ЯЁ]\s*\.)?/u,
  ].some(pattern => pattern.test(text));
}

export function assertNoPersonalData(text: string): void {
  if (containsPersonalData(text)) throw new ValidationError(PRIVACY_REJECTION, { reason: 'personal_data' });
}
