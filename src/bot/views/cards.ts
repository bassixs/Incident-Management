import type { Incident, IncidentAnswer, ResponsibleGroup } from '@prisma/client';

import { getConfig } from '../../config';
import { describeStatus } from '../../incidents/incident-state.service';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import type { LegalAccessStatus } from '../../legal/legal-acceptance.service';
import { formatDate, formatDateTime } from '../../utils/datetime';
import { pluralRu } from '../../utils/text';

/** `№ INC-20260823-0001` — the label repeated on every fragment of a message. */
export function codeLabel(incident: Pick<Incident, 'publicCode'>): string {
  return `№ ${incident.publicCode}`;
}

function attachmentLine(photoCount: number, fileCount = 0): string[] {
  const lines: string[] = [];
  if (photoCount > 0) lines.push(`📎 Фото: ${photoCount}`);
  if (fileCount > 0) lines.push(`📎 Файлы: ${fileCount}`);
  return lines;
}

function slaDaysPhrase(): string {
  const hours = getConfig().INCIDENT_SLA_HOURS;
  const days = Math.max(1, Math.round(hours / 24));
  return `${days} ${pluralRu(days, 'дня', 'дней', 'дней')}`;
}

export function problemLocationText(
  incident: Pick<Incident, 'problemMunicipalityName' | 'problemLocality'>,
): string {
  if (!incident.problemMunicipalityName) return 'Не указана';
  return incident.problemLocality
    ? `${incident.problemMunicipalityName} → ${incident.problemLocality}`
    : incident.problemMunicipalityName;
}

/** §12 — confirmation sent to the requester right after registration. */
export function registrationConfirmation(incident: Incident): string {
  return [
    '✅ Обращение зарегистрировано.',
    '',
    `Номер: ${incident.publicCode}`,
    `Дата: ${formatDate(incident.createdAt)}`,
    '',
    `Ответ будет предоставлен не позднее ${slaDaysPhrase()}.`,
    '',
    'Сохраните номер обращения.',
  ].join('\n');
}

/** §16 — the card every new incident gets in the distribution chat. */
export function distributionCard(incident: IncidentWithRelations): string {
  const photoCount = incident.attachments.filter((item) => item.type === 'IMAGE').length;

  return [
    '🔴 НЕ РАСПРЕДЕЛЕНО',
    '',
    '🆕 НОВОЕ ОБРАЩЕНИЕ',
    '',
    codeLabel(incident),
    '',
    'Дата:',
    formatDateTime(incident.createdAt),
    '',
    'Пользователь:',
    incident.requesterName,
    '',
    'Телефон:',
    incident.requesterPhone ?? 'не указан',
    '',
    'Сфера пользователя:',
    incident.userSelectedCategory?.name ?? 'Не знаю',
    '',
    'Территория проблемы:',
    problemLocationText(incident),
    '',
    'Обращение:',
    incident.text,
    ...(photoCount > 0 ? ['', ...attachmentLine(photoCount)] : []),
    '',
    '⏱ Срок:',
    `до ${formatDateTime(incident.deadlineAt)}`,
  ].join('\n');
}

/** §58 — replaces the distribution card once a dispatcher has routed it. */
export function distributionResolvedNotice(
  incident: Incident,
  group: ResponsibleGroup,
  dispatcherName: string,
): string {
  return [
    '🟡 РАСПРЕДЕЛЕНО',
    '',
    incident.publicCode,
    '',
    'Ответственная группа:',
    group.name,
    '',
    'Заявитель:',
    incident.requesterName,
    '',
    'Телефон:',
    incident.requesterPhone ?? 'не указан',
    '',
    'Распределил:',
    dispatcherName,
  ].join('\n');
}

/** §21 — the card published in the sector chat after distribution. */
export function sectorCard(incident: IncidentWithRelations, group: ResponsibleGroup): string {
  const photoCount = incident.attachments.filter((item) => item.type === 'IMAGE').length;
  return [
    '📥 НОВОЕ ОБРАЩЕНИЕ',
    '',
    codeLabel(incident),
    '',
    'Ответственная группа:',
    group.name,
    '',
    'Заявитель:',
    incident.requesterName,
    '',
    'Телефон:',
    incident.requesterPhone ?? 'не указан',
    '',
    'Территория проблемы:',
    problemLocationText(incident),
    '',
    'Обращение:',
    incident.text,
    '',
    'Дата:',
    formatDateTime(incident.createdAt),
    '',
    'Срок:',
    formatDateTime(incident.deadlineAt),
    ...(photoCount > 0 ? ['', ...attachmentLine(photoCount)] : []),
    ...(incident.currentResponder ? ['', '👤 В работе:', incident.currentResponder.displayName] : []),
  ].join('\n');
}

/** §29 — the card sent to the review chat with a prepared answer. */
export function reviewCard(
  incident: IncidentWithRelations,
  answer: IncidentAnswer & { attachments: Array<{ type: string }> },
  group: ResponsibleGroup | null,
): string {
  const photoCount = answer.attachments.filter((item) => item.type === 'IMAGE').length;
  const fileCount = answer.attachments.filter((item) => item.type === 'FILE').length;
  const attachmentLines = attachmentLine(photoCount, fileCount);
  return [
    '📝 ОТВЕТ НА СОГЛАСОВАНИЕ',
    '',
    codeLabel(incident),
    '',
    'Ответственная группа:',
    group?.name ?? '—',
    '',
    'Заявитель:',
    incident.requesterName,
    '',
    'Телефон:',
    incident.requesterPhone ?? 'не указан',
    '',
    'Территория проблемы:',
    problemLocationText(incident),
    '',
    'Обращение:',
    incident.text,
    '',
    'Ответ:',
    answer.text,
    // The approver must see the signature the requester will get, since it is
    // added automatically and is not part of the text under review.
    ...(group?.authorityName
      ? ['', 'Уйдёт за подписью:', group.authorityName]
      : ['', '⚠️ Ведомство для подписи не задано — ответ уйдёт без подписи.']),
    ...(attachmentLines.length ? ['', '📎 Вложения ответа:', ...attachmentLines] : []),
    '',
    'Первоначальная дата:',
    formatDateTime(incident.createdAt),
    '',
    'Дедлайн:',
    formatDateTime(incident.deadlineAt),
    ...(incident.isOverdue ? ['', '🚨 Срок ответа истёк.'] : []),
    '',
    'Версия ответа:',
    String(answer.version),
  ].join('\n');
}

/** §32 — the "returned for rework" card sent back to the sector chat. */
export function revisionCard(incident: Incident, answerVersion: number, reason: string): string {
  return [
    '↩️ ОТВЕТ ВОЗВРАЩЁН НА ДОРАБОТКУ',
    '',
    codeLabel(incident),
    '',
    'Причина:',
    reason,
    '',
    'Версия ответа:',
    String(answerVersion),
    '',
    'Первоначальный дедлайн:',
    formatDateTime(incident.deadlineAt),
    '',
    '⚠️ Дедлайн НЕ изменён.',
  ].join('\n');
}

/**
 * §31 — the final answer, delivered to the incident's own requester.
 *
 * The authority signature is filled in from the сфера, never typed by the
 * responder: it cannot be forgotten, mistyped or attributed to the wrong body.
 * When a сфера has no authority set yet, the block is omitted entirely rather
 * than falling back to the topic name — «Ответ подготовлен Здравоохранением»
 * would read as nonsense.
 */
export function finalAnswerToRequester(
  incident: Incident,
  answer: IncidentAnswer,
  answeredAt: Date,
  authorityName?: string | null,
): string {
  return [
    '✅ Получен ответ по вашему обращению.',
    '',
    codeLabel(incident),
    '',
    'Ваше обращение:',
    incident.text,
    '',
    'Ответ:',
    answer.text,
    ...(authorityName ? ['', 'Ответ подготовлен:', authorityName] : []),
    '',
    'Дата ответа:',
    formatDate(answeredAt),
  ].join('\n');
}

/** §19 — rejection notice for the requester. */
export function rejectionToRequester(incident: Incident, reason: string): string {
  return [`❌ Обращение ${incident.publicCode} отклонено.`, '', 'Причина:', reason].join('\n');
}

/** §41 — /incident lookup result for staff. */
export function incidentLookupCard(incident: IncidentWithRelations): string {
  const lastAnswer = incident.answers.at(-1);
  return [
    codeLabel(incident),
    '',
    'Статус:',
    `${incident.status} — ${describeStatus(incident.status, incident.isOverdue)}`,
    '',
    'Создано:',
    formatDateTime(incident.createdAt),
    '',
    'Дедлайн:',
    formatDateTime(incident.deadlineAt),
    ...(incident.answeredAt ? ['', 'Отвечено:', formatDateTime(incident.answeredAt)] : []),
    '',
    'Ответственная группа:',
    incident.assignedGroup?.name ?? 'не определена',
    '',
    'Территория проблемы:',
    problemLocationText(incident),
    '',
    'Ответственный:',
    incident.currentResponder?.displayName ?? 'не назначен',
    '',
    'Правок:',
    String(incident.revisionCount),
    ...(lastAnswer ? ['', 'Последняя версия ответа:', String(lastAnswer.version)] : []),
    ...(incident.rejectionReason ? ['', 'Причина отклонения:', incident.rejectionReason] : []),
    ...(incident.revisionReason ? ['', 'Последняя причина возврата:', incident.revisionReason] : []),
    '',
    'Автор:',
    `${incident.requesterName} (${incident.requesterMaxUserId.toString()})`,
    '',
    'Телефон:',
    incident.requesterPhone ?? 'не указан',
  ].join('\n');
}

/** §55 */
export function rulesText(): string {
  const config = getConfig();
  return [
    'Правила подачи обращения:',
    '',
    '• фамилия, имя и номер телефона обязательны;',
    '• одно сообщение = одно обращение;',
    `• максимум ${config.INCIDENT_MAX_LENGTH} символов;`,
    `• не более ${config.DAILY_INCIDENT_LIMIT} обращений в день;`,
    '• можно приложить фото;',
    '• видео не принимается;',
    `• срок ответа — до ${slaDaysPhrase()}.`,
  ].join('\n');
}

/** §7 */
export function greetingText(): string {
  return [
    'Здравствуйте!',
    '',
    'Здесь можно сообщить о проблеме или инциденте.',
    '',
    'Выберите нужное действие.',
  ].join('\n');
}

/** Final state shown only on the original card in the distribution chat. */
export function distributionWorkedNotice(incident: Incident, group: ResponsibleGroup): string {
  return [
    '🟢 ОТРАБОТАНО',
    '',
    incident.publicCode,
    '',
    'Ответственная группа:',
    group.name,
    '',
    'Ответ отправлен пользователю.',
  ].join('\n');
}

export function legalDocumentsText(status: LegalAccessStatus): string {
  if (!status.documentsAvailable) {
    return [
      'Юридические документы готовятся к публикации.',
      '',
      'До заполнения сведений об Операторе обязательное подтверждение отключено.',
    ].join('\n');
  }
  return [
    'Документы чат-бота «Искра»',
    '',
    'Откройте документы кнопками ниже. Они всегда доступны из главного меню.',
    ...(status.required
      ? [
          '',
          `Пользовательское соглашение: ${status.agreementAccepted ? 'принято' : 'не подтверждено'}.`,
          `Согласие на обработку персональных данных: ${status.consentAccepted ? 'предоставлено' : 'не подтверждено'}.`,
        ]
      : []),
  ].join('\n');
}

export function legalGateText(): string {
  return [
    'Перед созданием первого обращения ознакомьтесь с документами.',
    '',
    'Пользовательское соглашение и согласие на обработку персональных данных подтверждаются отдельно.',
    'Если вы не согласны, вернитесь в главное меню — обращение создано не будет.',
  ].join('\n');
}

export function agreementAcceptanceText(version: string): string {
  return [
    'Шаг 1 из 2. Пользовательское соглашение',
    '',
    `Откройте и прочитайте документ редакции ${version}.`,
    'Если принимаете его условия, нажмите отдельную кнопку подтверждения.',
  ].join('\n');
}

export function personalDataConsentText(version: string): string {
  return [
    'Шаг 2 из 2. Согласие на обработку персональных данных',
    '',
    `Откройте и прочитайте согласие редакции ${version}.`,
    'Нажмите кнопку ниже, только если добровольно даёте согласие на указанных условиях.',
  ].join('\n');
}

export function legalAcceptanceCompleteText(): string {
  return [
    'Спасибо. Оба подтверждения сохранены.',
    '',
    'Теперь можно создать обращение. Если документы существенно изменятся, бот попросит подтвердить новую редакцию.',
  ].join('\n');
}

export function requesterNamePromptText(): string {
  return [
    'Шаг 1. Укажите ваши фамилию и имя.',
    '',
    'Отчество — если оно есть.',
    'Отправьте ФИО одним текстовым сообщением.',
    '',
    'Это обязательное поле.',
  ].join('\n');
}

export function requesterPhonePromptText(): string {
  return [
    'Шаг 2. Укажите номер телефона.',
    '',
    'Например: +7 900 123-45-67.',
    '',
    'Это обязательное поле.',
  ].join('\n');
}

/** §7 — heading above the paged сфера picker. */
export function categoryPromptText(total: number): string {
  return [
    'Здравствуйте!',
    '',
    'Здесь можно сообщить о проблеме или инциденте.',
    '',
    'Выберите сферу обращения.',
    'Если вы не уверены — нажмите «Не знаю», сферу определит специалист.',
    ...(total > 0 ? ['', `Всего сфер: ${total}. Листайте стрелками.`] : []),
  ].join('\n');
}

export function municipalityPromptText(total: number): string {
  return [
    'Где произошла проблема?',
    '',
    'Выберите город или округ.',
    'Если вопрос относится ко всей области, выберите общий вариант.',
    ...(total > 0 ? ['', `Всего вариантов: ${total}. Листайте стрелками.`] : []),
  ].join('\n');
}

export function localityPromptText(municipalityName: string): string {
  return [
    `Уточните населённый пункт: ${municipalityName}.`,
    '',
    'Если нужного варианта нет — нажмите «Другой» и напишите название.',
    'Если уточнение не требуется — нажмите «Пропустить».',
  ].join('\n');
}

export function customLocalityPromptText(municipalityName: string): string {
  return [
    `Напишите название населённого пункта в территории «${municipalityName}».`,
    '',
    'Только название, без описания проблемы. Описание бот попросит следующим сообщением.',
  ].join('\n');
}

/** §9 */
export function incidentPromptText(): string {
  const config = getConfig();
  return [
    'Опишите проблему одним сообщением.',
    '',
    `Максимальная длина — ${config.INCIDENT_MAX_LENGTH} символов.`,
    '',
    'К сообщению можно приложить фотографию.',
    'Видео не поддерживается.',
  ].join('\n');
}

/** §54 */
export function myIncidentsText(incidents: Incident[]): string {
  if (incidents.length === 0) {
    return 'У вас пока нет обращений.\n\nЧтобы создать новое, нажмите «Создать обращение».';
  }
  return [
    'Ваши последние обращения:',
    '',
    ...incidents.flatMap((incident) => [
      incident.publicCode,
      describeStatus(incident.status, incident.isOverdue),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
}
