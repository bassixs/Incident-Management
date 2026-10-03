import { exceedsResidentPhotoLimit, RESIDENT_PHOTO_LIMIT } from '../../incidents/resident-photo-limit';
import { exitPersonalWork } from '../../work-queues/private-workspace';
import { consumeDraftButton, isDraftAction, saveDraftStep, sendDraftScreen, STALE_DRAFT, withResidentDraftLock } from '../draft-screen';
import { isResidentDraft } from '../../sessions/operator-session.service';
import type { CompositeMessage } from '../../max/max-message.service';
import { sendPhoneInputPrompt } from '../requester-phone';
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
  incidentDraftEditKeyboard,
  incidentDraftPhotoKeyboard,
  LOCALITY_OTHER,
  LOCALITY_SKIP,
  mainMenuKeyboard,
  requesterCategoryKeyboard,
  requesterLocalityKeyboard,
  requesterMunicipalityKeyboard,
} from '../keyboards';
import { requireCompleteIncidentDraft, showIncidentDraftPreview, retireIncidentDraftPreview } from '../requester-draft';
import {
  categoryPromptText,
  customLocalityPromptText,
  greetingText,
  incidentPromptText,
  incidentDraftEditPrompt,
  incidentDraftPhotoPrompt,
  localityPromptText,
  municipalityPromptText,
  myIncidentsText,
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

export async function handleUserCallback(context: UserCallbackContext, payload: Extract<CallbackPayload, { kind: 'user' }>): Promise<string | undefined> {
  return withResidentDraftLock(context.services, context.actor.maxUserId, context.chatId ?? context.actor.maxUserId, async () => {
    if (isDraftAction(payload.action)) payload = await consumeDraftButton(context.services, context.actor.maxUserId, context.chatId ?? context.actor.maxUserId, payload);
    await exitPersonalWork(context.services, context.actor.maxUserId);
    return dispatchUserCallback(context, payload);
  });
}

async function sendResidentResponse(context: UserCallbackContext, message: CompositeMessage): Promise<void> {
  const { services, actor } = context;
  const chatId = context.chatId ?? actor.maxUserId;
  const current = await services.sessions.find(actor.maxUserId, chatId);
  const menu = message.keyboard?.flat().some(b => b.type === 'callback' && b.payload === 'user:new');
  if (current && isResidentDraft(current.type) && !menu) await sendDraftScreen(services, actor.maxUserId, chatId, message);
  else await services.messages.send({ userId: actor.maxUserId }, message);
}

/** Requester-side buttons (§53, §7, §54, §55). Never touches other people's data. */
async function dispatchUserCallback(
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
      await services.messages.send(target, { text: greetingText(), keyboard: mainMenuKeyboard() });
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
      await services.messages.send(target, { text: greetingText(), keyboard: mainMenuKeyboard() });
      return;

    case 'draft-resume': {
      const current = await services.sessions.find(actor.maxUserId, context.chatId ?? actor.maxUserId);
      if (!current) throw new ValidationError(STALE_DRAFT);
      await resumeResidentDraft(context, current);
      return;
    }
    case 'draft-reset': {
      const current = await services.sessions.find(actor.maxUserId, context.chatId ?? actor.maxUserId);
      if (!current || !await services.sessions.clearCurrent(current)) throw new ValidationError(STALE_DRAFT);
      await retireIncidentDraftPreview(services, services.sessions.readData(current).previewMessageId);
      await beginNewIncident(context);
      return;
    }
    case 'draft-retry': {
      const chatId = context.chatId ?? actor.maxUserId;
      const current = await services.sessions.find(actor.maxUserId, chatId);
      if (!current || current.type !== SessionType.WAITING_INCIDENT_CONFIRMATION) throw new ValidationError('Кнопка устарела.');
      const data = services.sessions.readData(current);
      assertPreviewToken(data, payload.argument);
      if (!data.previewDeliveryPending) throw new ValidationError('Используйте текущую карточку сообщения.');
      await showIncidentDraftPreview(services, actor.maxUserId, chatId, data, current);
      return;
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
      assertPreviewToken(data, payload.argument);
      if (exceedsResidentPhotoLimit(draft.draftMedia)) {
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, draft);
        return 'Замените или удалите фотографии';
      }
      if (data.previewDeliveryPending) throw new ValidationError('Сначала восстановите карточку сообщения.');
      if (draft.pendingPhone) {
        // Do not silently attach an unconfirmed contact left by the old release.
        const current = await services.sessions.find(actor.maxUserId, chatId);
        if (!current) throw new ValidationError('Черновик устарел.');
        assertPreviewToken(services.sessions.readData(current), data.previewToken);
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, draft, current);
        return 'Проверьте обновлённую карточку';
      }
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
          await services.messages.send(target, { text: error.message });
          await offerResidentDraft(context);
          return 'Дневной лимит исчерпан';
        }
        if (error instanceof ValidationError) {
          await sendResidentResponse(context, { text: error.message });
          return 'Проверьте данные';
        }
        log.error(
          incidentLogFields({ maxUserId: actor.maxUserId, chatId, action: 'INCIDENT_CREATED' }),
          `incident registration failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await sendResidentResponse(context, {
          text: 'Не удалось зарегистрировать сообщение. Попробуйте ещё раз позже.',
        });
        return 'Не удалось зарегистрировать';
      }
      // create() atomically consumed this session; never clear a newer draft.
      await retireIncidentDraftPreview(services, data.previewMessageId);
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
      await sendResidentResponse(context, {
        text: registrationConfirmation(incident),
        keyboard: mainMenuKeyboard(),
        delivery: { dedupeKey: `registration:${incident.id}` },
      });
      return 'Сообщение зарегистрировано';
    }

    case 'draft-phone-enter':
    case 'draft-phone-back': {
      const chatId = context.chatId ?? actor.maxUserId;
      const current = await services.sessions.find(actor.maxUserId, chatId);
      if (!current) throw new ValidationError('Кнопка устарела. Используйте текущую карточку сообщения.');
      const data = services.sessions.readData(current);
      assertPreviewToken(data, payload.argument);
      if (payload.action === 'draft-phone-back') {
        if (current.type !== SessionType.WAITING_INCIDENT_EDIT_VALUE || data.draftEditField !== 'phone') throw new ValidationError('Кнопка устарела.');
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, data, current);
        return;
      }
      if (![SessionType.WAITING_INCIDENT_CONFIRMATION, SessionType.WAITING_INCIDENT_EDIT_SELECTION].includes(current.type as never) || data.previewDeliveryPending) throw new ValidationError('Используйте текущую карточку сообщения.');
      const draft = { ...requireCompleteIncidentDraft(data), draftEditField: 'phone' as const, previewToken: randomUUID(), phoneInputStartedAt: Date.now() };
      delete draft.pendingPhone;
      delete draft.previewMessageId;
      if (!await services.sessions.replaceCurrent(current, SessionType.WAITING_INCIDENT_EDIT_VALUE, draft)) throw new ValidationError('Черновик изменился.');
      await retireIncidentDraftPreview(services, data.previewMessageId);
      await sendPhoneInputPrompt(services, actor.maxUserId, draft, undefined, chatId);
      return;
    }

    case 'draft-phone-use':
      throw new ValidationError('Кнопка устарела. Используйте текущую карточку сообщения.');
    case 'draft-phone-remove':
    case 'draft-cancel': {
      const chatId = context.chatId ?? actor.maxUserId;
      const current = await services.sessions.find(actor.maxUserId, chatId);
      const requiredType = payload.action === 'draft-phone-remove' ? SessionType.WAITING_INCIDENT_EDIT_SELECTION : SessionType.WAITING_INCIDENT_CONFIRMATION;
      if (!current || (payload.action === 'draft-cancel' ? !isResidentDraft(current.type) : current.type !== requiredType)) throw new ValidationError('Кнопка устарела. Используйте текущую карточку сообщения.');
      const data = { ...services.sessions.readData(current) };
      assertPreviewToken(data, payload.argument);
      if (payload.action === 'draft-cancel') {
        if (!await services.sessions.clearCurrent(current)) throw new ValidationError('Черновик изменился. Используйте текущую карточку сообщения.');
        await retireIncidentDraftPreview(services, data.previewMessageId);
        await sendResidentResponse(context, { text: 'Черновик и номер удалены. Сообщение не отправлено.', keyboard: mainMenuKeyboard() });
        return;
      }
      delete data.requesterPhone;
      delete data.pendingPhone;
      await showIncidentDraftPreview(services, actor.maxUserId, chatId, data, current);
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
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, draft);
        return undefined;
      }
      await retireIncidentDraftPreview(services, data.previewMessageId);
      delete draft.previewMessageId;
      draft.previewToken = randomUUID();
      await saveDraftStep(services, {
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_EDIT_SELECTION,
        data: draft,
      });
      await sendResidentResponse(context, {
        text: incidentDraftEditPrompt(),
        keyboard: incidentDraftEditKeyboard(draft.draftMedia.length > 0, !!draft.requesterPhone, draft.previewToken),
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
      switch (payload.argument) {
        case 'text':
          await saveDraftStep(services, { maxUserId: actor.maxUserId, chatId, type: SessionType.WAITING_INCIDENT_EDIT_VALUE, data: { ...draft, draftEditField: 'text' } });
          await sendResidentResponse(context, { text: 'Отправьте новый текст сообщения. Телефон для связи можно указать; ФИО, документы и другие запрещённые личные сведения указывать нельзя.' });
          return;
        case 'category': {
          const categories = await services.categories.listActive();
          await saveDraftStep(services, {
            maxUserId: actor.maxUserId,
            chatId,
            type: SessionType.WAITING_INCIDENT_SELECTION,
            data: { ...draft, draftEditField: 'category', draftStage: 'category' },
          });
          await sendResidentResponse(context, {
            text: categoryPromptText(),
            keyboard: requesterCategoryKeyboard(categories, 0),
          });
          return undefined;
        }
        case 'location':
          await saveDraftStep(services, {
            maxUserId: actor.maxUserId,
            chatId,
            type: SessionType.WAITING_INCIDENT_SELECTION,
            data: { ...draft, draftEditField: 'location', draftStage: 'municipality' },
          });
          await sendResidentResponse(context, {
            text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
            keyboard: requesterMunicipalityKeyboard(
              draft.selectedCategoryId,
              PROBLEM_MUNICIPALITIES,
              0,
            ),
          });
          return undefined;
        case 'photo':
          await sendResidentResponse(context, {
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
      if (payload.argument === 'remove') {
        await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
          ...draft,
          draftMedia: [],
        });
        return 'Фотографии удалены';
      }
      await saveDraftStep(services, {
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_EDIT_VALUE,
        data: { ...draft, draftEditField: 'photo' },
      });
      await sendResidentResponse(context, {
        text: `Отправьте только выбранные фотографии — до ${RESIDENT_PHOTO_LIMIT} фотографий. Они заменят ранее приложенные.`,
      });
      return undefined;
    }

    case 'location-page': {
      await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const [categoryToken, pageToken] = parseLocationArgument(payload.argument, 2);
      const selectedCategoryId = await requireActiveCategory(services, categoryToken);
      const page = Number.parseInt(pageToken, 10);
      await sendDraftScreen(services, actor.maxUserId, context.chatId ?? actor.maxUserId, {
        text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
        keyboard: requesterMunicipalityKeyboard(
          selectedCategoryId,
          PROBLEM_MUNICIPALITIES,
          Number.isFinite(page) ? page : 0,
        ),
      });
      return undefined;
    }

    /** Paging publishes a new version; previous keyboards fail closed. */
    case 'page': {
      await requireSelectionDraft(services, actor.maxUserId, context.chatId);
      const categories = await services.categories.listActive();
      const page = Number.parseInt(payload.argument ?? '0', 10);
      await sendDraftScreen(services, actor.maxUserId, context.chatId ?? actor.maxUserId, {
        text: categoryPromptText(),
        keyboard: requesterCategoryKeyboard(categories, Number.isFinite(page) ? page : 0),
      });
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
          await sendResidentResponse(context, {
            text: 'Эта сфера больше недоступна. Выберите другую.',
            keyboard: requesterCategoryKeyboard(categories, 0),
          });
          return 'Сфера недоступна';
        }
        selectedCategoryId = category.id;
        chosenName = category.name;
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

      await saveDraftStep(services, {
        maxUserId: actor.maxUserId,
        chatId: context.chatId ?? actor.maxUserId,
        type: SessionType.WAITING_INCIDENT_SELECTION,
        data: { ...draft, selectedCategoryId, draftStage: 'municipality' },
      });

      await sendResidentResponse(context, {
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


      if (municipality.localities.length > 0) {
        await saveDraftStep(services, {
          maxUserId: actor.maxUserId,
          chatId: context.chatId ?? actor.maxUserId,
          type: SessionType.WAITING_INCIDENT_SELECTION,
          data: {
            ...draft,
            draftStage: 'locality',
            selectedCategoryId,
            problemMunicipalityCode: municipality.code,
            problemMunicipalityName: municipality.name,
          },
        });
        await sendResidentResponse(context, {
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
        await sendResidentResponse(context, { text: incidentPromptText() });
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
        await saveDraftStep(services, {
          maxUserId: actor.maxUserId,
          chatId: context.chatId ?? actor.maxUserId,
          type: SessionType.WAITING_CUSTOM_LOCALITY,
          data: {
            ...draft,
            draftStage: 'locality',
            selectedCategoryId,
            problemMunicipalityCode: municipality.code,
            problemMunicipalityName: municipality.name,
          },
        });
        await sendResidentResponse(context, { text: customLocalityPromptText(municipality.name) });
        return undefined;
      }

      const locality =
        localityCode === LOCALITY_SKIP ? null : findProblemLocality(municipality, localityCode);
      if (localityCode !== LOCALITY_SKIP && !locality) {
        throw new ValidationError('Этот населённый пункт больше недоступен. Выберите его заново.');
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
        await sendResidentResponse(context, { text: incidentPromptText() });
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
  const existing = await services.sessions.find(actor.maxUserId, context.chatId ?? actor.maxUserId);
  if (existing && isResidentDraft(existing.type)) { await offerResidentDraft(context); return; }
  const remaining = await services.incidents.remainingDailyQuota(actor.maxUserId);
  if (remaining <= 0) {
    await sendResidentResponse(context, {
      text: dailyLimitMessage(services.config.DAILY_INCIDENT_LIMIT),
      keyboard: mainMenuKeyboard(),
    });
    return;
  }
  const previous = await services.sessions.find(actor.maxUserId, context.chatId ?? actor.maxUserId);
  if (previous && isResidentDraft(previous.type)) { await offerResidentDraft(context); return; }
  if (previous) throw new ValidationError('Сначала завершите текущее действие.');
  const categories = await services.categories.listActive();
  await services.sessions.start({ maxUserId: actor.maxUserId, chatId: context.chatId ?? actor.maxUserId,
    type: SessionType.WAITING_INCIDENT_SELECTION,
    data: { draftToken: randomUUID(), draftStage: 'category', draftTouchedAt: Date.now() } });
  await sendResidentResponse(context, { text: categoryPromptText(), keyboard: requesterCategoryKeyboard(categories, 0) });
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
  await saveDraftStep(services, {
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

/** Called under the resident lock (or personal mode lock when returning to the menu). */
export async function offerResidentDraft(context: UserCallbackContext): Promise<void> {
  const { services, actor } = context;
  await sendDraftScreen(services, actor.maxUserId, context.chatId ?? actor.maxUserId, {
    text: 'У вас есть незавершённое сообщение. Продолжить черновик или начать заново? При выборе «Начать заново» сохранённый черновик будет удалён. Черновик хранится 24 часа после последнего действия.',
    keyboard: [[{ type: 'callback', text: 'Продолжить черновик', payload: 'user:draft-resume' }],
      [{ type: 'callback', text: 'Начать заново', payload: 'user:draft-reset' }]],
  });
}

async function resumeResidentDraft(context: UserCallbackContext, current: import('@prisma/client').OperatorSession): Promise<void> {
  const { services, actor } = context;
  const chatId = context.chatId ?? actor.maxUserId;
  const data = services.sessions.readData(current);
  // A complete draft resumes at its actual preview, never the last stale edit keyboard.
  if (data.draftText && data.problemMunicipalityCode) {
    await showIncidentDraftPreview(services, actor.maxUserId, chatId, data, current); return;
  }
  if (current.type === SessionType.WAITING_INCIDENT_TEXT) {
    await sendDraftScreen(services, actor.maxUserId, chatId, { text: incidentPromptText() }); return;
  }
  if (current.type === SessionType.WAITING_CUSTOM_LOCALITY) {
    await sendDraftScreen(services, actor.maxUserId, chatId, { text: customLocalityPromptText(data.problemMunicipalityName ?? '') }); return;
  }
  const municipality = findProblemMunicipality(data.problemMunicipalityCode ?? '');
  if (data.draftStage === 'locality' && municipality) {
    await sendDraftScreen(services, actor.maxUserId, chatId, { text: localityPromptText(municipality.name), keyboard: requesterLocalityKeyboard(data.selectedCategoryId ?? null, municipality) }); return;
  }
  if (data.draftStage === 'municipality') {
    await sendDraftScreen(services, actor.maxUserId, chatId, { text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length), keyboard: requesterMunicipalityKeyboard(data.selectedCategoryId ?? null, PROBLEM_MUNICIPALITIES, 0) }); return;
  }
  await sendDraftScreen(services, actor.maxUserId, chatId, { text: categoryPromptText(), keyboard: requesterCategoryKeyboard(await services.categories.listActive(), 0) });
}
