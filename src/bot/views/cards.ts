import type { Incident, IncidentAnswer, ResponsibleGroup } from '@prisma/client';

import { leaseText, type LeaseView } from '../../work-queues/leases';
import { getConfig } from '../../config';
import { describeStatus } from '../../incidents/incident-state.service';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import type { LegalAccessStatus } from '../../legal/legal-acceptance.service';
import { formatDate, formatDateTime } from '../../utils/datetime';
import { answerSignature } from '../../responsible-groups/answer-signature';

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
    'Сохраните номер обращения. Статус можно посмотреть в разделе «Мои обращения».',
  ].join('\n');
}

/** §16 — the card every new incident gets in the distribution chat. */
export function distributionCard(incident: IncidentWithRelations): string {
  const photoCount = incident.attachments.filter((item) => item.type === 'IMAGE').length;

  return [
    '🔴 НЕ РАСПРЕДЕЛЕНО',
    leaseText(incident.distributionClaimUntil && incident.distributionClaimUntil > new Date() ? { name: incident.distributionClaimedName ?? 'Сотрудник', until: incident.distributionClaimUntil } : null),
    ...(incident.history?.length ? ['↩️ ВОЗВРАЩЕНО НА ПЕРЕРАСПРЕДЕЛЕНИЕ', `Причина: ${(incident.history[0]!.metadata as { reason?: string })?.reason ?? '—'}`] : []),
    '',
    incident.history?.length ? 'ОБРАЩЕНИЕ НА ПЕРЕРАСПРЕДЕЛЕНИЕ' : '🆕 НОВОЕ ОБРАЩЕНИЕ',
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
    'Тема обращения:',
    incident.userSelectedCategory?.name ?? 'Иное',
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
function sectorStatus(incident: IncidentWithRelations): string {
  switch (incident.status) {
    case 'ASSIGNED': return '🔴 СВОБОДНОЕ';
    case 'IN_PROGRESS': return '🟡 В РАБОТЕ';
    case 'WAITING_REVIEW': return '🔵 НА СОГЛАСОВАНИИ';
    case 'REVISION_REQUIRED': return '🟠 НА ДОРАБОТКЕ';
    case 'RESOLVED': return incident.answers.at(-1)?.deliveredAt
      ? '🟢 ОТРАБОТАНО' : '⏳ ОЖИДАЕТ ДОСТАВКИ';
    case 'REJECTED': return '⛔ ОТКЛОНЕНО';
    default: return '⚪ НА РАСПРЕДЕЛЕНИИ';
  }
}

export function sectorCard(incident: IncidentWithRelations, group: ResponsibleGroup, lease?: LeaseView): string {
  const photoCount = incident.attachments.filter((item) => item.type === 'IMAGE').length;
  return [
    sectorStatus(incident),
    '',
    '📥 ОБРАЩЕНИЕ',
    '',
    codeLabel(incident),
    ...(['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status) && lease !== undefined ? [leaseText(lease)] : []),
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
    incident.slaPausedAt ? 'Приостановлен до получения уточнения' : formatDateTime(incident.deadlineAt),
    ...(photoCount > 0 ? ['', ...attachmentLine(photoCount)] : []),
    ...(incident.currentResponder && (lease === undefined || lease || !['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) ? ['', '👤 Исполнитель:', incident.currentResponder.displayName] : []),
  ].join('\n');
}

/** §29 — the card sent to the review chat with a prepared answer. */
export function reviewCard(
  incident: IncidentWithRelations,
  answer: IncidentAnswer & { attachments: Array<{ type: string }> },
  group: ResponsibleGroup | null,
  lease: LeaseView = null,
): string {
  const photoCount = answer.attachments.filter((item) => item.type === 'IMAGE').length;
  const fileCount = answer.attachments.filter((item) => item.type === 'FILE').length;
  const attachmentLines = attachmentLine(photoCount, fileCount);
  const signature = answerSignature(group?.authorityName);
  return [
    '📝 ОТВЕТ НА СОГЛАСОВАНИЕ',
    leaseText(lease),
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
    ...(signature
      ? ['', 'Подпись в ответе жителю:', signature]
      : ['', '⚠️ Ведомство для подписи не задано — ответ уйдёт без подписи.']),
    ...(attachmentLines.length ? ['', '📎 Вложения ответа:', ...attachmentLines] : []),
    '',
    'Первоначальная дата:',
    formatDateTime(incident.createdAt),
    '',
    'Срок ответа:',
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
    'Первоначальный срок ответа:',
    formatDateTime(incident.deadlineAt),
    '',
    '⚠️ Срок ответа НЕ изменён.',
  ].join('\n');
}

/**
 * §31 — the final answer, delivered to the incident's own requester.
 *
 * The signature comes from the actual responsible group's authority, never
 * from the incident topic. Review and delivery use the same formatter.
 */
export function finalAnswerToRequester(
  incident: Incident,
  answer: IncidentAnswer,
  answeredAt: Date,
  authorityName?: string | null,
): string {
  const signature = answerSignature(authorityName);
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
    ...(signature ? ['', signature] : []),
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
export function incidentLookupCard(incident: IncidentWithRelations, lease?: LeaseView): string {
  const lastAnswer = incident.answers.at(-1);
  return [
    codeLabel(incident),
    ...(lease !== undefined ? [leaseText(lease)] : []),
    '',
    'Статус:',
    incident.slaPausedAt ? 'Ожидаем уточнение от жителя — срок приостановлен' : `${incident.status} — ${describeStatus(incident.status, incident.isOverdue)}`,
    '',
    'Создано:',
    formatDateTime(incident.createdAt),
    '',
    'Срок ответа:',
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

const MESSAGE_LEGAL_NOTICE = 'При работе с сообщениями, поданными через чат-бот «Искра», не применяются положения Федерального закона «О порядке рассмотрения обращений граждан Российской Федерации» от 02.05.2006 № 59-ФЗ.';

/** §55 */
export function rulesText(): string {
  const config = getConfig();
  return [
    '📋 Правила подачи сообщения через бота Калужской области по организации обратной связи с жителями:',
    '',
    'Подача сообщения через бот означает согласие с данными правилами.',
    '',
    MESSAGE_LEGAL_NOTICE,
    '',
    'Сообщения, нарушающие данные правила, останутся без рассмотрения, а автор может быть заблокирован.',
    '',
    // Published rules stay at 3 even when the runtime quota is raised for testing.
    'К рассмотрению принимается не более трех сообщений одного автора в сутки.',
    '',
    'Сообщение может быть не рассмотрено по существу в следующих случаях:',
    '',
    '1. Сообщение содержит рекламу и ссылки на сторонние каналы, сайты и приложения, коммерческие предложения, платные ресурсы и вредоносные ресурсы любого типа.',
    '',
    '2. Сообщение содержит нецензурные и оскорбительные выражения в адрес должностных лиц, органов власти, других граждан.',
    '',
    '3. Сообщение содержит недостоверную информацию, распространяемую под видом достоверной (фейки).',
    '',
    '4. В сообщении присутствует пропаганда ненависти, порнографии, сведений о способах совершения преступлений, информации о нежелательных организациях и другой информации, нарушающей Законодательство Калужской области и Российской Федерации.',
    '',
    '5. Текст обращения или сообщения не позволяет определить суть предложения, заявления или жалобы.',
    '',
    '6. В сообщении содержится вопрос, на который неоднократно давались ответы по существу в связи с ранее направляемыми сообщениями, и при этом в сообщении не приводятся новые обстоятельства.',
    '',
    '7. Сообщения, несущие урон чести и достоинству других граждан.',
    '',
    '8. В сообщении отсутствует адрес проблемы.',
    '',
    'Как подать сообщение:',
    '',
    '1. Перед первым обращением ознакомьтесь с документами и подтвердите согласие.',
    '2. При первом обращении укажите фамилию, имя и действующий номер телефона — это обязательные поля.',
    '   Номер можно ввести вручную или передать кнопкой «Поделиться контактом» в MAX.',
    '3. Выберите сферу. Если не уверены, нажмите «Иное».',
    '4. Укажите город или округ, где возникла проблема, и при необходимости населённый пункт.',
    `5. Опишите одну проблему понятным текстом — не более ${config.INCIDENT_MAX_LENGTH} символов. Укажите адрес (улицу, номер дома) или точное место, если адреса нет.`,
    '6. При необходимости приложите фотографии из галереи. Документы и изображения, отправленные как файл, не принимаются.',
    '7. Проверьте итоговую карточку. Любое поле и фотографии можно исправить до отправки.',
    '8. Нажмите «Всё верно». Только после этого обращение будет зарегистрировано.',
    '',
    'Важно:',
    '',
    '• одно обращение должно относиться к одной проблеме;',
    '• видео, аудиосообщения и другие файлы не принимаются;',
    '• после регистрации бот выдаст номер обращения;',
    '• состояние обращения доступно в разделе «Мои обращения»;',
    '• итоговый ответ придёт в этот личный чат;',
    '• ФИО и телефон сохраняются для следующих обращений; перед отправкой их всегда можно исправить.',
  ].join('\n');
}

/** §7 */
export function greetingText(): string {
  return [
    '✨ Добро пожаловать в чат-бот «Искра»!',
    '',
    'Я помогу вам сообщить о проблеме в Калужской области и направить сообщение органам исполнительной власти и местного самоуправления региона.',
    '',
    'Перед первым обращением ознакомьтесь с документами и отдельно подтвердите согласие на обработку персональных данных и их передачу в органы исполнительной власти и местного самоуправления.',
    '',
    MESSAGE_LEGAL_NOTICE,
    '',
    'Как это работает:',
    '',
    '1. При первом обращении вы укажете ФИО и номер телефона. Бот сохранит их для следующих обращений.',
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
    categoryName ?? 'Иное',
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
export function distributionWorkedNotice(incident: Incident, group: ResponsibleGroup, lease?: LeaseView): string {
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
    'Прочитайте пользовательское соглашение. Если согласны с его условиями, нажмите «Принимаю пользовательское соглашение».',
    'На следующем шаге бот отдельно попросит согласие на обработку персональных данных.',
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
    'Нажмите «Поделиться контактом» или введите номер текстом, например: +7 900 123-45-67.',
    '',
    'Это обязательное поле.',
  ].join('\n');
}

/** §7 — heading above the paged сфера picker. */
export function categoryPromptText(total: number): string {
  return [
    'Шаг 3. Выберите сферу обращения.',
    'Если вы не уверены — нажмите «Иное», сферу определит специалист.',
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
    'Укажите адрес проблемы (улицу, номер дома) или точное место, если адреса нет.',
    '',
    `Максимальная длина — ${config.INCIDENT_MAX_LENGTH} символов.`,
    '',
    'К сообщению можно приложить фотографию из галереи. Файлы не принимаются — отправляйте изображение как фото.',
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
      ['RESOLVED', 'REJECTED'].includes(incident.status) ? 'Закрыто' : 'В работе',
      '',
    ]),
  ]
    .join('\n')
    .trimEnd();
}
