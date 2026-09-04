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
  requesterContactKeyboard,
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

  if (
    CONSENT_GATED_ACTIONS.has(payload.action) &&
    !(await services.legal.hasCurrentAccess(actor.userId))
  ) {
    await services.sessions.clear(actor.maxUserId, context.chatId ?? actor.maxUserId);
    await sendLegalGate(context);
    return 'Сначала подтвердите документы';
  }

  switch (payload.action) {
    case 'menu': {
      await services.messages.send(target, { text: greetingText(), keyboard: mainMenuKeyboard() });
      return undefined;
    }

    case 'rules': {
      await services.messages.send(target, { text: rulesText(), keyboard: mainMenuKeyboard() });
      return undefined;
    }

    case 'documents': {
      const status = await services.legal.status(actor.userId);
      await services.messages.send(target, {
        text: legalDocumentsText(status),
        keyboard: legalDocumentsKeyboard(services.legal.links(), {
          showContinue: status.required && !status.ready && status.documentsAvailable,
        }),
      });
      return undefined;
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
      if (!(await services.legal.hasCurrentAccess(actor.userId))) {
        await services.sessions.clear(actor.maxUserId, context.chatId ?? actor.maxUserId);
        await sendLegalGate(context);
        return 'Требуется подтверждение документов';
      }
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
        text: `Спасибо! Вы оценили ответ по обращению ${incident.publicCode} на ${rating} из 5.`,
        keyboard: mainMenuKeyboard(),
        delivery: { dedupeKey: `rating-confirmation:${incident.id}` },
      });
      return `Оценка ${rating} из 5 сохранена`;
    }

    case 'legal-continue': {
      const status = await services.legal.status(actor.userId);
      const links = services.legal.links();
      if (!status.required) {
        await services.messages.send(target, {
          text: legalDocumentsText(status),
          keyboard: legalDocumentsKeyboard(links),
        });
        return undefined;
      }
      if (!status.agreementAccepted) {
        if (!links.userAgreement) throw new ValidationError('Документ временно недоступен.');
        await services.messages.send(target, {
          text: agreementAcceptanceText(services.config.LEGAL_DOCUMENT_VERSION),
          keyboard: agreementAcceptanceKeyboard(links.userAgreement),
        });
        return undefined;
      }
      if (!status.consentAccepted) {
        if (!links.personalDataConsent) throw new ValidationError('Документ временно недоступен.');
        await services.messages.send(target, {
          text: personalDataConsentText(services.config.LEGAL_DOCUMENT_VERSION),
          keyboard: personalDataConsentKeyboard(links.personalDataConsent),
        });
        return undefined;
      }
      await beginNewIncident(context);
      return undefined;
    }

    case 'accept-agreement': {
      const links = services.legal.links();
      if (!links.personalDataConsent) throw new ValidationError('Документ временно недоступен.');
      await services.legal.acceptUserAgreement({
        userId: actor.userId,
        maxUserId: actor.maxUserId,
        sourceCallbackId: context.callbackId,
        sourceMessageId: context.messageId,
        sourceChatId: context.chatId,
      });
      if (context.messageId) {
        await services.messages.finalizeCard(
          context.messageId,
          `Пользовательское соглашение редакции ${services.config.LEGAL_DOCUMENT_VERSION} принято.`,
        );
      }
      await services.messages.send(target, {
        text: personalDataConsentText(services.config.LEGAL_DOCUMENT_VERSION),
        keyboard: personalDataConsentKeyboard(links.personalDataConsent),
      });
      return 'Соглашение принято';
    }

    case 'accept-consent': {
      await services.legal.acceptPersonalDataConsent({
        userId: actor.userId,
        maxUserId: actor.maxUserId,
        sourceCallbackId: context.callbackId,
        sourceMessageId: context.messageId,
        sourceChatId: context.chatId,
      });
      if (context.messageId) {
        await services.messages.finalizeCard(
          context.messageId,
          `Согласие на обработку персональных данных редакции ${services.config.LEGAL_DOCUMENT_VERSION} предоставлено.`,
        );
      }
      await services.messages.send(target, { text: legalAcceptanceCompleteText() });
      await beginNewIncident(context);
      return 'Согласие сохранено';
    }

    case 'draft-confirm': {
      const chatId = context.chatId ?? actor.maxUserId;
      const data = await requireDraftForSession(
        services,
        actor.maxUserId,
        chatId,
        SessionType.WAITING_INCIDENT_CONFIRMATION,
      );
      const draft = requireCompleteIncidentDraft(data);
      let incident;
      try {
        const requester = await services.users.requireByMaxId(actor.maxUserId);
        incident = await services.incidents.create({
          requester: {
            maxUserId: actor.maxUserId,
            name: draft.requesterName,
            phone: draft.requesterPhone,
            username: requester.username,
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
          text: 'Не удалось зарегистрировать обращение. Попробуйте ещё раз позже.',
        });
        return 'Не удалось зарегистрировать';
      }
      await services.sessions.clear(actor.maxUserId, chatId);
      if (context.messageId) {
        await services.messages
          .finalizeCard(
            context.messageId,
            `✅ Данные подтверждены.\n\nОбращение зарегистрировано: ${incident.publicCode}`,
          )
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
      });
      return 'Обращение зарегистрировано';
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
          '✏️ Обращение пока не отправлено. Выберите поле для исправления ниже.',
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
        name: 'ФИО',
        phone: 'номер телефона',
        category: 'сфера обращения',
        location: 'территория и населённый пункт',
        text: 'текст обращения',
        photo: 'фотографии',
      };
      const fieldLabel = payload.argument ? fieldLabels[payload.argument] : undefined;
      if (!fieldLabel) throw new ValidationError('Кнопка устарела. Вернитесь к проверке обращения.');
      if (context.messageId) {
        await services.messages.finalizeCard(context.messageId, `Исправляется: ${fieldLabel}.`);
      }
      switch (payload.argument) {
        case 'name':
        case 'phone':
        case 'text':
          await services.sessions.start({
            maxUserId: actor.maxUserId,
            chatId,
            type: SessionType.WAITING_INCIDENT_EDIT_VALUE,
            data: { ...draft, draftEditField: payload.argument },
          });
          await services.messages.send(target, {
            text:
              payload.argument === 'name'
                ? requesterNamePromptText()
                : payload.argument === 'phone'
                  ? requesterPhonePromptText()
                  : 'Отправьте новый текст обращения одним сообщением.',
            ...(payload.argument === 'name' || payload.argument === 'phone'
              ? { keyboard: requesterContactKeyboard() }
              : {}),
          });
          return undefined;
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
          throw new ValidationError('Кнопка устарела. Вернитесь к проверке обращения.');
      }
    }

    case 'draft-photo': {
      const chatId = context.chatId ?? actor.maxUserId;
      const data = await requireDraftForSession(
        services,
        actor.maxUserId,
        chatId,
        SessionType.WAITING_INCIDENT_EDIT_SELECTION,
      );
      const draft = requireCompleteIncidentDraft(data);
      if (payload.argument !== 'remove' && payload.argument !== 'replace') {
        throw new ValidationError('Кнопка устарела. Вернитесь к проверке обращения.');
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
        await services.messages.finalizeCard(context.messageId, `Сфера обращения: ${chosenName}`);
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

async function sendLegalGate(context: UserCallbackContext): Promise<void> {
  const { services, actor } = context;
  const status = await services.legal.status(actor.userId);
  await services.messages.send(
    { userId: actor.maxUserId },
    {
      text: legalGateText(),
      keyboard: legalDocumentsKeyboard(services.legal.links(), {
        showContinue: status.required && status.documentsAvailable,
      }),
    },
  );
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
  await services.sessions.clear(actor.maxUserId, context.chatId ?? actor.maxUserId);
  const requester = await services.users.requireByMaxId(actor.maxUserId);
  if (requester.requesterName && requester.requesterPhone) {
    const categories = await services.categories.listActive();
    await services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId: context.chatId ?? actor.maxUserId,
      type: SessionType.WAITING_INCIDENT_SELECTION,
      data: {
        requesterName: requester.requesterName,
        requesterPhone: requester.requesterPhone,
      },
    });
    await services.messages.send(target, {
      text: [
        'Использую сохранённые ФИО и телефон. Их можно проверить и при необходимости изменить в итоговой карточке.',
        '',
        categoryPromptText(categories.length),
      ].join('\n'),
      keyboard: requesterCategoryKeyboard(categories, 0),
    });
    return;
  }
  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId: context.chatId ?? actor.maxUserId,
    type: requester.requesterName ? SessionType.WAITING_REQUESTER_PHONE : SessionType.WAITING_REQUESTER_NAME,
    data: {
      ...(requester.requesterName ? { requesterName: requester.requesterName } : {}),
      ...(requester.requesterPhone ? { requesterPhone: requester.requesterPhone } : {}),
    },
  });
  await services.messages.send(target, {
    text: requester.requesterName ? requesterPhonePromptText() : requesterNamePromptText(),
    keyboard: requesterContactKeyboard(),
  });
}

async function requireSelectionDraft(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
): Promise<SessionData & { requesterName: string; requesterPhone: string }> {
  const data = await requireDraftForSession(
    services,
    maxUserId,
    chatId ?? maxUserId,
    SessionType.WAITING_INCIDENT_SELECTION,
  );
  if (!data.requesterName || !data.requesterPhone) {
    throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
  }
  return { ...data, requesterName: data.requesterName, requesterPhone: data.requesterPhone };
}

async function requireDraftForSession(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint,
  ...allowedTypes: SessionType[]
): Promise<SessionData> {
  const session = await services.sessions.find(maxUserId, chatId);
  if (!session || !allowedTypes.includes(session.type)) {
    throw new ValidationError('Кнопка устарела. Начните создание обращения заново.');
  }
  return services.sessions.readData(session);
}

function parseLocationArgument(raw: string | undefined, expectedParts: 2): [string, string];
function parseLocationArgument(raw: string | undefined, expectedParts: 3): [string, string, string];
function parseLocationArgument(raw: string | undefined, expectedParts: 2 | 3): string[] {
  const parts = raw?.split('~') ?? [];
  if (parts.length !== expectedParts || parts.some((part) => part.length === 0)) {
    throw new ValidationError('Кнопка устарела. Начните создание обращения заново.');
  }
  return parts;
}

async function requireActiveCategory(services: AppServices, token: string): Promise<string | null> {
  if (token === 'none') return null;
  const category = await services.categories.findById(token);
  if (!category?.isActive) {
    throw new ValidationError('Выбранная тема больше недоступна. Начните создание обращения заново.');
  }
  return category.id;
}

async function startIncidentTextSession(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
  data: SessionData & {
    requesterName: string;
    requesterPhone: string;
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
