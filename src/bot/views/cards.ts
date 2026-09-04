import type { Incident, IncidentAnswer, ResponsibleGroup } from '@prisma/client';

import { getConfig } from '../../config';
import { describeStatus } from '../../incidents/incident-state.service';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import type { LegalAccessStatus } from '../../legal/legal-acceptance.service';
import { formatDate, formatDateTime } from '../../utils/datetime';

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
    'Обращение принято и направлено на рассмотрение.',
    '',
    'Сохраните номер обращения. Ход обработки можно посмотреть в разделе «Мои обращения».',
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
    '',
    'Оцените ответ по шкале от 1 до 5, где 1 — совсем не помог, а 5 — полностью помог.',
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
    '📋 Как подать обращение',
    '',
    '1. Перед первым обращением ознакомьтесь с документами и подтвердите согласие.',
    '2. Укажите фамилию, имя и действующий номер телефона — это обязательные поля.',
    '3. Выберите сферу. Если не уверены, нажмите «Не знаю».',
    '4. Укажите город или округ, где возникла проблема, и при необходимости населённый пункт.',
    `5. Опишите одну проблему понятным текстом — не более ${config.INCIDENT_MAX_LENGTH} символов.`,
    '6. При необходимости приложите фотографии.',
    '7. Проверьте итоговую карточку. Любое поле и фотографии можно исправить до отправки.',
    '8. Нажмите «Всё верно». Только после этого обращение будет зарегистрировано.',
    '',
    'Важно:',
    '',
    '• одно обращение должно относиться к одной проблеме;',
    '• видео, аудиосообщения и другие файлы не принимаются;',
    `• можно зарегистрировать не более ${config.DAILY_INCIDENT_LIMIT} обращений в сутки;`,
    '• после регистрации бот выдаст номер обращения;',
    '• состояние обращения доступно в разделе «Мои обращения»;',
    '• итоговый ответ придёт в этот личный чат.',
  ].join('\n');
}

/** §7 */
export function greetingText(): string {
  return [
    '✨ Добро пожаловать в чат-бот «Искра»!',
    '',
    'Здесь можно сообщить о проблеме в городе или районе Калужской области и направить обращение ответственным специалистам.',
    '',
    'Как это работает:',
    '',
    '1. Вы укажете ФИО и номер телефона.',
    '2. Выберете сферу и место, где возникла проблема.',
    '3. Опишете ситуацию и при необходимости приложите фотографии.',
    '4. Проверите итоговую карточку и сможете исправить любое поле.',
    '5. После подтверждения бот зарегистрирует обращение и выдаст его номер.',
    '',
    'Состояние зарегистрированных обращений можно посмотреть в разделе «Мои обращения». Ответ поступит в этот чат.',
    '',
    'Выберите нужное действие ниже.',
  ].join('\n');
}

export type IncidentDraftView = {
  requesterName: string;
  requesterPhone: string;
  problemMunicipalityName: string;
  problemLocality?: string | null;
  draftText: string;
  photoCount: number;
};

/** Requester-only preview. Nothing has been registered or routed yet. */
export function incidentDraftPreview(draft: IncidentDraftView, categoryName?: string | null): string {
  return [
    '🔎 ПРОВЕРЬТЕ ОБРАЩЕНИЕ',
    '',
    'ФИО:',
    draft.requesterName,
    '',
    'Телефон:',
    draft.requesterPhone,
    '',
    'Сфера обращения:',
    categoryName ?? 'Не знаю',
    '',
    'Территория проблемы:',
    draft.problemLocality
      ? `${draft.problemMunicipalityName} → ${draft.problemLocality}`
      : draft.problemMunicipalityName,
    '',
    'Обращение:',
    draft.draftText,
    '',
    `Фотографии: ${draft.photoCount > 0 ? draft.photoCount : 'нет'}`,
    '',
    'Обращение ещё не отправлено. Если всё указано правильно, нажмите «Всё верно».',
  ].join('\n');
}

export function incidentDraftEditPrompt(): string {
  return ['Что нужно исправить?', '', 'Выберите одно поле. Остальные данные сохранятся.'].join('\n');
}

export function incidentDraftPhotoPrompt(hasPhoto: boolean): string {
  return hasPhoto
    ? 'Вы можете заменить все приложенные фотографии или удалить их.'
    : 'Фотографий пока нет. Нажмите кнопку ниже, чтобы добавить.';
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
    'Шаг 3. Выберите сферу обращения.',
    'Если вы не уверены — нажмите «Не знаю», сферу определит специалист.',
    ...(total > 0 ? ['', `Всего сфер: ${total}. Листайте стрелками.`] : []),
  ].join('\n');
}

export function municipalityPromptText(total: number): string {
  return [
    'Шаг 4. Где произошла проблема?',
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
    'Шаг 5. Опишите проблему одним сообщением.',
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
      // Overdue is an internal SLA signal for staff, not a requester-facing status.
      describeStatus(incident.status, false),
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
}
