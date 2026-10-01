import { ValidationError } from '../utils/errors';

export const PRIVACY_REJECTION = 'Сообщение не принято: обнаружены возможные запрещённые персональные данные. Уберите ФИО, паспортные данные, СНИЛС, банковские реквизиты, адреса электронной почты и другие запрещённые личные сведения. Телефон для связи разрешён. Исправьте текст и отправьте заново.';
export const PRIVACY_NOTICE = 'ФИО не запрашивается. Сохраняются ID в MAX, текст сообщения, фотографии и служебные сведения о его обработке. Телефон можно указать в тексте или ввести вручную после кнопки «📞 Поделиться контактом». Это необязательно. Номер виден участникам рабочих чатов в карточке сообщения, включая распределение, исполнение и согласование; в следующий черновик он не переносится. Проверяется формат, а не принадлежность номера.\nАвтоматическая проверка текста сохраняется. При обнаружении запрещённых данных сотрудник может отклонить сообщение. Отдельное подтверждение проверки перед распределением не требуется.';

/** Exempt only a locally matched proper name immediately after an address/object
 * designator. The remainder of the message is still screened, including labels.
 * This is a spelling heuristic, not a registry of streets or proof of anonymity.
 */
function maskAddressNames(text: string): string {
  const word = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?';
  const initials = '[А-ЯЁ]\\s*\\.\\s*(?:[А-ЯЁ]\\s*\\.)?';
  const patronymic = '[А-ЯЁ][а-яё]+(?:ович|евич|овна|евна|ична)';
  const name = `(?:${word}\\s+${word}\\s+${patronymic}|${word}\\s+${patronymic}\\s+${word}|${word}\\s+${initials}|${initials}\\s*${word})`;
  const street = '(?:[Уу]лиц[аыуе]|[Уу]л\\.|[Пп]роспект(?:а|е|у)?|[Пп]ереул(?:ок|ка|ке)|[Пп]лощад[ьи]|[Нн]абережн(?:ая|ой|ую))\\s+(?:(?:имени|им\\.)\\s+)?';
  const object = '(?:[Шш]кол[аыеу]|[Лл]ице[йяе]|[Гг]имнази[яию]|[Пп]арк(?:а|е)?|[Сс]квер(?:а|е)?|[Бб]иблиотек[аиеу]|[Мм]узе[йяе])(?:\\s+(?:№|No)?\\s*\\d{1,4})?\\s+(?:имени|им\\.)\\s+';
  return text.replace(new RegExp(`(?<![а-яёА-ЯЁ])(?:${street}|${object})${name}(?![а-яёА-ЯЁ])`, 'gu'), ' [название] ');
}

/** Conservative local screening, not a guarantee of anonymisation. Never return matched data. */
export function containsPersonalData(raw: string): boolean {
  const text = raw.normalize('NFKC').replace(/[\u200B-\u200F\u2060\uFEFF]/g, '').replace(/\u00a0/g, ' ');
  if (/(?:фио|ф\.и\.о\.|меня\s+зовут|мои\s+данные)\s*[:—-]?\s*[а-яёa-z]{2,}/iu.test(text)) return true;
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
  const withoutPhones = maskAddressNames(text).replace(/\+?\d(?:[\d+ ()\t-]|\.(?=\d))*\d/g, span =>
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
