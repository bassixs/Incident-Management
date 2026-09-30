import { ValidationError } from '../utils/errors';

export const PRIVACY_REJECTION = 'Сообщение не принято: обнаружены возможные запрещённые персональные данные. Уберите ФИО, паспортные данные, СНИЛС, банковские реквизиты, адреса электронной почты и другие запрещённые личные сведения. Телефон для связи разрешён. Исправьте текст и отправьте заново.';
export const PRIVACY_NOTICE = 'ФИО не запрашивается. Сохраняются ID в MAX, текст сообщения, фотографии и служебные сведения о его обработке. Телефон для связи можно указать в тексте или передать кнопкой «📞 Поделиться контактом». Это необязательно. Номер в тексте виден вместе с текстом сообщения. Отдельно переданный контакт доступен распределителю и текущему исполнителю по действующим правилам доступа; в следующий черновик он не переносится.\nТекст проходит автоматическую проверку, текст и фото — проверку сотрудником перед распределением.';

/** Conservative local screening, not a guarantee of anonymisation. Never return matched data. */
export function containsPersonalData(raw: string): boolean {
  const text = raw.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/\u00a0/g, ' ');
  // Explicit document/account labels must win even when their digits happen to
  // look like a phone. Mask only a complete Russian phone-shaped numeric span,
  // never a substring of a longer account/card number. Do not alter stored text.
  if (/(?:паспорт|снилс|инн|номер\s+карты|расч[её]тный\s+сч[её]т)\s*(?:номер|серия|№|:|—|-)?\s*[+\d][\d\s().-]{4,}/iu.test(text)) return true;
  if (/(?<!\d)\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{2}(?!\d)/u.test(text)) return true;
  // A sentence-ending dot separates numeric spans; dots directly between digits
  // stay in the span, so a dotted account cannot lose its phone-shaped prefix.
  // Mask only a whole span of complete phones, separated by whitespace. Never
  // cut eleven digits out of a longer digit block or leave an account suffix.
  const phones = /^(?:\+7|[78])(?:[ ()\t.-]*\d){10}(?:[ \t]+(?:\+7|[78])(?:[ ()\t.-]*\d){10})*$/u;
  const withoutPhones = text.replace(/\+?\d(?:[\d+ ()\t-]|\.(?=\d))*\d/g, span =>
    phones.test(span) ? ' ' : span);
  return [
    /(?<!\d)\d{10,}(?!\d)/u,
    /(?<!\d)\d{4}(?:[ -]\d{4}){3}(?!\d)/u,
    /(?<!\d)\d{2}\s?\d{2}\s+\d{6}(?!\d)/u,
    /(?<!\d)\d{3}[- ]\d{3}[- ]\d{3}[- ]\d{2}(?!\d)/u,
    /[\w.+-]+@[\w.-]+\.[a-zа-я]{2,}/iu,
    /(?:фио|ф\.и\.о\.|меня\s+зовут|мои\s+данные)\s*[:—-]?\s*[а-яёa-z]{2,}/iu,
    /(?<![а-яё])[а-яё]+(?:ович|евич|ич|овна|евна|ична)\s+[а-яё]+(?:ов|ев|ин|ова|ева|ина|ский|ская)(?![а-яё])/iu,
    /(?<![а-яё])[а-яё]{2,}[-а-яё]*\s+[а-яё]{2,}[-а-яё]*\s+[а-яё]+(?:ович|евич|овна|евна|ична)(?![а-яё])/iu,
    /(?<![а-яё])[А-ЯЁ][а-яё]+(?:ов|ев|ин|ова|ева|ина|ский|ская)\s+[А-ЯЁ]\s*\.\s*(?:[А-ЯЁ]\s*\.)?/u,
  ].some(pattern => pattern.test(withoutPhones));
}

export function assertNoPersonalData(text: string): void {
  if (containsPersonalData(text)) throw new ValidationError(PRIVACY_REJECTION, { reason: 'personal_data' });
}
