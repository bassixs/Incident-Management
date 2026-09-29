import { PRIVACY_NOTICE } from '../../privacy/personal-data';
import { randomUUID } from 'node:crypto';
import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { isUuid, type CallbackPayload } from '../../max/callback-payload';
import { REJECTION_MESSAGES, dailyLimitMessage } from '../../incidents/incident.service';
import {
  PROBLEM_MUNICIPALITIES,
  findProblemLocality,
  findProblemMunicipality,
} from '../../locations/problem-locations';
import type { SessionData } from '../../sessions/operator-session.service';
import { RateLimitError, ValidationError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import {
  agreementAcceptanceKeyboard,
  incidentDraftEditKeyboard,
  incidentDraftPhotoKeyboard,
  LOCALITY_OTHER,
  LOCALITY_SKIP,
  legalDocumentsKeyboard,
  mainMenuKeyboard,
  personalDataConsentKeyboard,
  requesterCategoryKeyboard,
  requesterLocalityKeyboard,
  requesterMunicipalityKeyboard,
} from '../keyboards';
import { requireCompleteIncidentDraft, showIncidentDraftPreview } from '../requester-draft';
import {
  agreementAcceptanceText,
  categoryPromptText,
  customLocalityPromptText,
  greetingText,
  incidentPromptText,
  incidentDraftEditPrompt,
  incidentDraftPhotoPrompt,
  legalAcceptanceCompleteText,
  legalDocumentsText,
  legalGateText,
  localityPromptText,
  municipalityPromptText,
  myIncidentsText,
  personalDataConsentText,
  requesterNamePromptText,
  requesterPhonePromptText,
  registrationConfirmation,
  rulesText,
} from '../views/cards';
import type { ResolvedActor } from '../handlers/helpers';

const log = moduleLogger('bot-user');

export type UserCallbackContext = {
  services: AppServices;
  actor: ResolvedActor;
  chatId: bigint | undefined;
  /** The message the button sits on, so the picker can be paged in place. */
  messageId: string | undefined;
  /** Evidence id of the physical confirmation action in MAX. */
  callbackId: string;
};

const CONSENT_GATED_ACTIONS = new Set([
  'category',
  'page',
  'location-page',
  'municipality',
  'locality',
  'draft-confirm',
  'draft-edit',
  'draft-field',
  'draft-photo',
]);

/** Requester-side buttons (§53, §7, §54, §55). Never touches other people's data. */
export async function handleUserCallback(
  context: UserCallbackContext,
  payload: Extract<CallbackPayload, { kind: 'user' }>,
): Promise<string | undefined> {
  const { services, actor } = context;
  const target = { userId: actor.maxUserId } as const;

  if (await services.bans.isBanned(actor.maxUserId)) {
    await services.messages.send(target, { text: REJECTION_MESSAGES.banned });
    return 'Действие недоступно';
  }

  switch (payload.action) {
    case 'clarify-reply':
      return 'Ответ на уточнение больше не требуется. Статус сообщения доступен в разделе «Мои сообщения».';
    case 'menu': {
      await services.messages.send(target, { text: greetingText(), keyboard: mainMenuKeyboard() });
      return undefined;
    }

    case 'rules': {
      await services.messages.send(target, { text: rulesText(), keyboard: mainMenuKeyboard() });
      return undefined;
    }

    case 'documents': {
      await services.messages.send(target, { text: PRIVACY_NOTICE, keyboard: mainMenuKeyboard() });
      return;
    }

    case 'my-incidents': {
      // Scoped by requesterMaxUserId — a user can only ever see their own.
      const incidents = await services.incidents.listForRequester(actor.maxUserId);
      await services.messages.send(target, {
        text: myIncidentsText(incidents),
        keyboard: mainMenuKeyboard(),
      });
      return undefined;
    }

    case 'new': {
      await beginNewIncident(context);
      return undefined;
    }

    case 'rate-answer': {
      const [incidentId, rawRating, extra] = (payload.argument ?? '').split('~');
      const rating = Number(rawRating);
      if (!incidentId || !isUuid(incidentId) || extra !== undefined || !Number.isInteger(rating)) {
        throw new ValidationError('Кнопка оценки устарела.');
      }
      const incident = await services.incidents.rateAnswer(incidentId, actor.maxUserId, rating);
      await services.messages.send(target, {
        text: `Спасибо! Вы оценили ответ по сообщению ${incident.publicCode} на ${rating} из 5.`,
        keyboard: mainMenuKeyboard(),
        delivery: { dedupeKey: `rating-confirmation:${incident.id}` },
      });
      return `Оценка ${rating} из 5 сохранена`;
    }

    case 'legal-continue':
    case 'accept-agreement':
    case 'accept-consent':
      await services.messages.send(target, { text: 'Подтверждать документы больше не нужно. '+PRIVACY_NOTICE, keyboard: mainMenuKeyboard() });
      return;

    case 'draft-confirm': {
      const chatId = context.chatId ?? actor.maxUserId;
      const data = await requireDraftForSession(
        services,
        actor.maxUserId,
        chatId,
        SessionType.WAITING_INCIDENT_CONFIRMATION,
      );
      const draft = requireCompleteIncidentDraft(data);
      assertPreviewToken(data, payload.argument);
      if (draft.pendingPhone) throw new ValidationError('Сначала добавьте номер к сообщению или уберите его.');
      let incident;
      try {
        const draftSession = await services.sessions.find(actor.maxUserId, chatId);
        if (!draftSession) throw new ValidationError('Черновик устарел.');
        incident = await services.incidents.create({
          draftSessionId: draftSession.id,
          draftPreviewToken: data.previewToken,
          requester: {
            maxUserId: actor.maxUserId,
          },
          text: draft.draftText,
          userSelectedCategoryId: draft.selectedCategoryId,
          problemMunicipalityCode: draft.problemMunicipalityCode,
          problemMunicipalityName: draft.problemMunicipalityName,
          problemLocality: draft.problemLocality,
          media: draft.draftMedia,
        });
      } catch (error) {
        if (error instanceof RateLimitError) {
          await services.sessions.clear(actor.maxUserId, chatId);
          await services.messages.send(target, { text: error.message, keyboard: mainMenuKeyboard() });
          return 'Дневной лимит исчерпан';
        }
        if (error instanceof ValidationError) {
          await services.messages.send(target, { text: error.message });
          return 'Проверьте данные';
        }
        log.error(
          incidentLogFields({ maxUserId: actor.maxUserId, chatId, action: 'INCIDENT_CREATED' }),
          `incident registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await services.messages.send(target, {
          text: 'Не удалось зарегистрировать сообщение. Попробуйте ещё раз позже.',
        });
        return 'Не удалось зарегистрировать';
      }
      await services.sessions.clear(actor.maxUserId, chatId);
      if (context.messageId) {
        // Registration confirmation is already durable. Remove its draft
        // preview instead of turning it into a second confirmation message.
        await services.messages
          .deleteCard(context.messageId)
          .catch(() => false);
      }
      await services.distribution.publishCard(incident.id).catch((error) =>
        log.error(
          incidentLogFields({
            incidentId: incident.id,
            publicCode: incident.publicCode,
            action: 'DISTRIBUTION_CARD_SENT',
          }),
          `failed to publish distribution card: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      await services.messages.send(target, {
        text: registrationConfirmation(incident),
        keyboard: mainMenuKeyboard(),
        delivery: { dedupeKey: `registration:${incident.id}` },
      });
      return 'Сообщение зарегистрировано';
    }

    case 'draft-phone-use':
    case 'draft-phone-remove':
    case 'draft-cancel': {
      const chatId = context.chatId ?? actor.maxUserId;
      const data = await requireDraftForSession(services, actor.maxUserId, chatId, SessionType.WAITING_INCIDENT_CONFIRMATION);
      assertPreviewToken(data, payload.argument);
      if (payload.action === 'draft-cancel') {
        await services.sessions.clear(actor.maxUserId, chatId);
        if (data.previewMessageId) await services.messages.deleteCard(data.previewMessageId).catch(() => false);
        await services.messages.send(target, { text: 'Черновик и номер удалены. Сообщение не отправлено.', keyboard: mainMenuKeyboard() });
        return;
      }
      if (payload.action === 'draft-phone-use') {
        if (!data.pendingPhone) throw new ValidationError('Запрос контакта устарел.');
        data.requesterPhone = data.pendingPhone;
      } else delete data.requesterPhone;
      delete data.pendingPhone;
      // Commit removal before any MAX call; a transport failure must not keep the old phone.
      if (payload.action === 'draft-phone-remove') {
        data.previewToken = randomUUID();
        await services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_INCIDENT_CONFIRMATION, data });
      }
      await showIncidentDraftPreview(services, actor.maxUserId, chatId, data);
      return;
    }

    case 'draft-edit': {
      const chatId = context.chatId ?? actor.maxUserId;
      const allowed =
        payload.argument === 'back'
          ? [SessionType.WAITING_INCIDENT_EDIT_SELECTION]
          : [
              SessionType.WAITING_INCIDENT_CONFIRMATION,
              SessionType.WAITING_INCIDENT_EDIT_SELECTION,
            ];
      const data = await requireDraftForSession(services, actor.maxUserId, chatId, ...allowed);
      const current = await services.sessions.find(actor.maxUserId, chatId);
      if (current?.type === SessionType.WAITING_INCIDENT_CONFIRMATION) assertPreviewToken(data, payload.argument);
      // An unconfirmed contact cannot follow the user into a different preview.
      delete data.pendingPhone;
      const draft = requireCompleteIncidentDraft(data);
      if (payload.argument === 'back') {
        if (context.messageId) {
          await services.messages.finalizeCard(context.messageId, 'Исправление завершено. Проверьте карточку ниже.');
        }
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, draft);
        return undefined;
      }
      if (context.messageId && allowed.includes(SessionType.WAITING_INCIDENT_CONFIRMATION)) {
        await services.messages.finalizeCard(
          context.messageId,
          '✏️ Сообщение пока не отправлено. Выберите поле для исправления ниже.',
        );
      }
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_EDIT_SELECTION,
        data: draft,
      });
      await services.messages.send(target, {
        text: incidentDraftEditPrompt(),
        keyboard: incidentDraftEditKeyboard(draft.draftMedia.length > 0),
      });
      return undefined;
    }

    case 'draft-field': {
      const chatId = context.chatId ?? actor.maxUserId;
      const data = await requireDraftForSession(
        services,
        actor.maxUserId,
        chatId,
        SessionType.WAITING_INCIDENT_EDIT_SELECTION,
      );
      const draft = requireCompleteIncidentDraft(data);
      const fieldLabels: Record<string, string> = {
        category: 'сфера сообщения',
        location: 'территория и населённый пункт',
        text: 'текст сообщения',
        photo: 'фотографии',
      };
      const fieldLabel = payload.argument ? fieldLabels[payload.argument] : undefined;
      if (!fieldLabel) throw new ValidationError('Кнопка устарела. Вернитесь к проверке сообщения.');
      if (context.messageId) {
        await services.messages.finalizeCard(context.messageId, `Исправляется: ${fieldLabel}.`);
      }
      switch (payload.argument) {
        case 'text':
          await services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_INCIDENT_EDIT_VALUE, data: { ...draft, draftEditField: 'text' } });
          await services.messages.send(target, { text: 'Отправьте новый текст сообщения без персональных данных.' });
          return;
        case 'category': {
          const categories = await services.categories.listActive();
          await services.sessions.start({
            maxUserId: actor.maxUserId,
            chatId,
            type: SessionType.WAITING_INCIDENT_SELECTION,
            data: { ...draft, draftEditField: 'category' },
          });
          await services.messages.send(target, {
            text: categoryPromptText(categories.length),
            keyboard: requesterCategoryKeyboard(categories, 0),
          });
          return undefined;
        }
        case 'location':
          await services.sessions.start({
            maxUserId: actor.maxUserId,
            chatId,
            type: SessionType.WAITING_INCIDENT_SELECTION,
            data: { ...draft, draftEditField: 'location' },
          });
          await services.messages.send(target, {
            text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
            keyboard: requesterMunicipalityKeyboard(
              draft.selectedCategoryId,
              PROBLEM_MUNICIPALITIES,
              0,
            ),
          });
          return undefined;
        case 'photo':
          await services.messages.send(target, {
            text: incidentDraftPhotoPrompt(draft.draftMedia.length > 0),
            keyboard: incidentDraftPhotoKeyboard(draft.draftMedia.length > 0),
          });
          return undefined;
        default:
          throw new ValidationError('Кнопка устарела. Вернитесь к проверке сообщения.');
      }
    }

    case 'draft-photo': {
      const chatId = context.chatId ?? actor.maxUserId;
      const session = await services.sessions.find(actor.maxUserId, chatId);
      const data = session ? services.sessions.readData(session) : {};
      const retryingPhotos = session?.type === SessionType.WAITING_INCIDENT_EDIT_VALUE &&
        data.draftEditField === 'photo' && data.draftPhotoRetry === true;
      if (!session || (session.type !== SessionType.WAITING_INCIDENT_EDIT_SELECTION && !retryingPhotos)) {
        throw new ValidationError('Кнопка устарела. Вернитесь к проверке сообщения.');
      }
      const draft = requireCompleteIncidentDraft(data);
      if (payload.argument !== 'remove' && payload.argument !== 'replace') {
        throw new ValidationError('Кнопка устарела. Вернитесь к проверке сообщения.');
      }
      if (context.messageId) {
        await services.messages.finalizeCard(
          context.messageId,
          payload.argument === 'remove' ? 'Фотографии удаляются.' : 'Ожидаются новые фотографии.',
        );
      }
      if (payload.argument === 'remove') {
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
          ...draft,
          draftMedia: [],
        });
        return 'Фотографии удалены';
      }
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_EDIT_VALUE,
        data: { ...draft, draftEditField: 'photo' },
      });
      await services.messages.send(target, {
        text: 'Отправьте одну или несколько новых фотографий. Они заменят ранее приложенные.',
      });
      return undefined;
    }

    case 'location-page': {
      if (!context.messageId) return undefined;
      await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const [categoryToken, pageToken] = parseLocationArgument(payload.argument, 2);
      const selectedCategoryId = await requireActiveCategory(services, categoryToken);
      const page = Number.parseInt(pageToken, 10);
      await services.messages.editCardKeyboard(
        context.messageId,
        municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
        requesterMunicipalityKeyboard(
          selectedCategoryId,
          PROBLEM_MUNICIPALITIES,
          Number.isFinite(page) ? page : 0,
        ),
      );
      return undefined;
    }

    /** Paging the сфера picker: rewrite the same message, no new ones. */
    case 'page': {
      if (!context.messageId) return undefined;
      await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const categories = await services.categories.listActive();
      const page = Number.parseInt(payload.argument ?? '0', 10);
      await services.messages.editCardKeyboard(
        context.messageId,
        categoryPromptText(categories.length),
        requesterCategoryKeyboard(categories, Number.isFinite(page) ? page : 0),
      );
      return undefined;
    }

    case 'category': {
      const draft = await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const raw = payload.argument;
      let selectedCategoryId: string | null = null;
      let chosenName = 'не указана';
      if (raw && raw !== 'none') {
        const category = await services.categories.findById(raw);
        if (!category?.isActive) {
          const categories = await services.categories.listActive();
          await services.messages.send(target, {
            text: 'Эта сфера больше недоступна. Выберите другую.',
            keyboard: requesterCategoryKeyboard(categories, 0),
          });
          return 'Сфера недоступна';
        }
        selectedCategoryId = category.id;
        chosenName = category.name;
      }

      // Retire the picker so a stale page cannot be tapped again later.
      if (context.messageId) {
        await services.messages.finalizeCard(context.messageId, `Сфера сообщения: ${chosenName}`);
      }

      if (draft.draftEditField === 'category') {
        await showIncidentDraftPreview(
          services,
          actor.maxUserId,
          context.chatId ?? actor.maxUserId,
          { ...draft, selectedCategoryId },
        );
        return undefined;
      }

      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId: context.chatId ?? actor.maxUserId,
        type: SessionType.WAITING_INCIDENT_SELECTION,
        data: { ...draft, selectedCategoryId },
      });

      await services.messages.send(target, {
        text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
        keyboard: requesterMunicipalityKeyboard(selectedCategoryId, PROBLEM_MUNICIPALITIES, 0),
      });
      log.debug({ maxUserId: actor.maxUserId.toString(), selectedCategoryId }, 'location picker opened');
      return undefined;
    }

    case 'municipality': {
      const draft = await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const [categoryToken, municipalityCode] = parseLocationArgument(payload.argument, 2);
      const selectedCategoryId = await requireActiveCategory(services, categoryToken);
      const municipality = findProblemMunicipality(municipalityCode);
      if (!municipality) throw new ValidationError('Эта территория больше недоступна. Выберите её заново.');

      if (context.messageId) {
        await services.messages.finalizeCard(
          context.messageId,
          `Территория проблемы: ${municipality.name}`,
        );
      }

      if (municipality.localities.length > 0) {
        await services.sessions.start({
          maxUserId: actor.maxUserId,
          chatId: context.chatId ?? actor.maxUserId,
          type: SessionType.WAITING_INCIDENT_SELECTION,
          data: {
            ...draft,
            selectedCategoryId,
            problemMunicipalityCode: municipality.code,
            problemMunicipalityName: municipality.name,
          },
        });
        await services.messages.send(target, {
          text: localityPromptText(municipality.name),
          keyboard: requesterLocalityKeyboard(selectedCategoryId, municipality),
        });
        return undefined;
      }

      const nextData = {
        ...draft,
        selectedCategoryId,
        problemMunicipalityCode: municipality.code,
        problemMunicipalityName: municipality.name,
        problemLocality: null,
      };
      if (draft.draftEditField === 'location') {
        await showIncidentDraftPreview(
          services,
          actor.maxUserId,
          context.chatId ?? actor.maxUserId,
          nextData,
        );
      } else {
        await startIncidentTextSession(services, actor.maxUserId, context.chatId, nextData);
        await services.messages.send(target, { text: incidentPromptText() });
      }
      return undefined;
    }

    case 'locality': {
      const draft = await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const [categoryToken, municipalityCode, localityCode] = parseLocationArgument(payload.argument, 3);
      const selectedCategoryId = await requireActiveCategory(services, categoryToken);
      const municipality = findProblemMunicipality(municipalityCode);
      if (!municipality?.localities.length) {
        throw new ValidationError('Эта территория больше недоступна. Выберите её заново.');
      }

      if (localityCode === LOCALITY_OTHER) {
        if (context.messageId) {
          await services.messages.finalizeCard(
            context.messageId,
            `Территория проблемы: ${municipality.name} → другой населённый пункт`,
          );
        }
        await services.sessions.start({
          maxUserId: actor.maxUserId,
          chatId: context.chatId ?? actor.maxUserId,
          type: SessionType.WAITING_CUSTOM_LOCALITY,
          data: {
            ...draft,
            selectedCategoryId,
            problemMunicipalityCode: municipality.code,
            problemMunicipalityName: municipality.name,
          },
        });
        await services.messages.send(target, { text: customLocalityPromptText(municipality.name) });
        return undefined;
      }

      const locality =
        localityCode === LOCALITY_SKIP ? null : findProblemLocality(municipality, localityCode);
      if (localityCode !== LOCALITY_SKIP && !locality) {
        throw new ValidationError('Этот населённый пункт больше недоступен. Выберите его заново.');
      }

      if (context.messageId) {
        await services.messages.finalizeCard(
          context.messageId,
          `Территория проблемы: ${municipality.name}${locality ? ` → ${locality.name}` : ''}`,
        );
      }
      const nextData = {
        ...draft,
        selectedCategoryId,
        problemMunicipalityCode: municipality.code,
        problemMunicipalityName: municipality.name,
        problemLocality: locality?.name ?? null,
      };
      if (draft.draftEditField === 'location') {
        await showIncidentDraftPreview(
          services,
          actor.maxUserId,
          context.chatId ?? actor.maxUserId,
          nextData,
        );
      } else {
        await startIncidentTextSession(services, actor.maxUserId, context.chatId, nextData);
        await services.messages.send(target, { text: incidentPromptText() });
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

async function beginNewIncident(context: UserCallbackContext): Promise<void> {
  const { services, actor } = context;
  const target = { userId: actor.maxUserId } as const;
  const remaining = await services.incidents.remainingDailyQuota(actor.maxUserId);
  if (remaining <= 0) {
    await services.messages.send(target, {
      text: dailyLimitMessage(services.config.DAILY_INCIDENT_LIMIT),
      keyboard: mainMenuKeyboard(),
    });
    return;
  }
  const previous = await services.sessions.find(actor.maxUserId, context.chatId ?? actor.maxUserId);
  const preview = previous && services.sessions.readData(previous).previewMessageId;
  if (preview) await services.messages.deleteCard(preview).catch(() => false);
  await services.sessions.clear(actor.maxUserId, context.chatId ?? actor.maxUserId);
  const categories = await services.categories.listActive();
  await services.sessions.start({ maxUserId: actor.maxUserId, chatId: context.chatId ?? actor.maxUserId, type: SessionType.WAITING_INCIDENT_SELECTION, data: {} });
  await services.messages.send(target, { text: PRIVACY_NOTICE+'\n\n'+categoryPromptText(categories.length), keyboard: requesterCategoryKeyboard(categories, 0) });
}

function assertPreviewToken(data: SessionData, token: string | undefined): void {
  if (!data.previewToken || token !== data.previewToken) throw new ValidationError('Кнопка устарела. Используйте текущую карточку сообщения.');
}

async function requireSelectionDraft(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
): Promise<SessionData> {
  const data = await requireDraftForSession(
    services,
    maxUserId,
    chatId ?? maxUserId,
    SessionType.WAITING_INCIDENT_SELECTION,
  );
  return data;
}

async function requireDraftForSession(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint,
  ...allowedTypes: SessionType[]
): Promise<SessionData> {
  const session = await services.sessions.find(maxUserId, chatId);
  if (!session || !allowedTypes.includes(session.type)) {
    throw new ValidationError('Кнопка устарела. Начните создание сообщения заново.');
  }
  return services.sessions.readData(session);
}

function parseLocationArgument(raw: string | undefined, expectedParts: 2): [string, string];
function parseLocationArgument(raw: string | undefined, expectedParts: 3): [string, string, string];
function parseLocationArgument(raw: string | undefined, expectedParts: 2 | 3): string[] {
  const parts = raw?.split('~') ?? [];
  if (parts.length !== expectedParts || parts.some((part) => part.length === 0)) {
    throw new ValidationError('Кнопка устарела. Начните создание сообщения заново.');
  }
  return parts;
}

async function requireActiveCategory(services: AppServices, token: string): Promise<string | null> {
  if (token === 'none') return null;
  const category = await services.categories.findById(token);
  if (!category?.isActive) {
    throw new ValidationError('Выбранная тема больше недоступна. Начните создание сообщения заново.');
  }
  return category.id;
}

async function startIncidentTextSession(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
  data: SessionData & {
    selectedCategoryId: string | null;
    problemMunicipalityCode: string;
    problemMunicipalityName: string;
    problemLocality: string | null;
  },
): Promise<void> {
  await services.sessions.start({
    maxUserId,
    chatId: chatId ?? maxUserId,
    type: SessionType.WAITING_INCIDENT_TEXT,
    data,
  });
  log.debug(
    { maxUserId: maxUserId.toString(), municipalityCode: data.problemMunicipalityCode },
    'incident text requested',
  );
}
