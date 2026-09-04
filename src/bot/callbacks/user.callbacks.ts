import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import { REJECTION_MESSAGES, dailyLimitMessage } from '../../incidents/incident.service';
import {
  PROBLEM_MUNICIPALITIES,
  findProblemLocality,
  findProblemMunicipality,
} from '../../locations/problem-locations';
import { ValidationError } from '../../utils/errors';
import { moduleLogger } from '../../utils/logger';
import {
  agreementAcceptanceKeyboard,
  LOCALITY_OTHER,
  LOCALITY_SKIP,
  legalDocumentsKeyboard,
  mainMenuKeyboard,
  personalDataConsentKeyboard,
  requesterCategoryKeyboard,
  requesterLocalityKeyboard,
  requesterMunicipalityKeyboard,
} from '../keyboards';
import {
  agreementAcceptanceText,
  categoryPromptText,
  customLocalityPromptText,
  greetingText,
  incidentPromptText,
  legalAcceptanceCompleteText,
  legalDocumentsText,
  legalGateText,
  localityPromptText,
  municipalityPromptText,
  myIncidentsText,
  personalDataConsentText,
  requesterNamePromptText,
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

    case 'location-page': {
      if (!context.messageId) return undefined;
      await requireContactDraft(services, actor.maxUserId, context.chatId);
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
      await requireContactDraft(services, actor.maxUserId, context.chatId);
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
      const contact = await requireContactDraft(services, actor.maxUserId, context.chatId);
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

      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId: context.chatId ?? actor.maxUserId,
        type: SessionType.WAITING_INCIDENT_SELECTION,
        data: { ...contact, selectedCategoryId },
      });

      await services.messages.send(target, {
        text: municipalityPromptText(PROBLEM_MUNICIPALITIES.length),
        keyboard: requesterMunicipalityKeyboard(selectedCategoryId, PROBLEM_MUNICIPALITIES, 0),
      });
      log.debug({ maxUserId: actor.maxUserId.toString(), selectedCategoryId }, 'location picker opened');
      return undefined;
    }

    case 'municipality': {
      const contact = await requireContactDraft(services, actor.maxUserId, context.chatId);
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
            ...contact,
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

      await startIncidentTextSession(services, actor.maxUserId, context.chatId, {
        ...contact,
        selectedCategoryId,
        problemMunicipalityCode: municipality.code,
        problemMunicipalityName: municipality.name,
        problemLocality: null,
      });
      await services.messages.send(target, { text: incidentPromptText() });
      return undefined;
    }

    case 'locality': {
      const contact = await requireContactDraft(services, actor.maxUserId, context.chatId);
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
            ...contact,
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
      await startIncidentTextSession(services, actor.maxUserId, context.chatId, {
        ...contact,
        selectedCategoryId,
        problemMunicipalityCode: municipality.code,
        problemMunicipalityName: municipality.name,
        problemLocality: locality?.name ?? null,
      });
      await services.messages.send(target, { text: incidentPromptText() });
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
  await services.sessions.start({
    maxUserId: actor.maxUserId,
    chatId: context.chatId ?? actor.maxUserId,
    type: SessionType.WAITING_REQUESTER_NAME,
  });
  await services.messages.send(target, {
    text: requesterNamePromptText(),
  });
}

async function requireContactDraft(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
): Promise<{ requesterName: string; requesterPhone: string }> {
  const session = await services.sessions.find(maxUserId, chatId ?? maxUserId);
  const data = session ? services.sessions.readData(session) : {};
  if (!data.requesterName || !data.requesterPhone) {
    throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
  }
  return { requesterName: data.requesterName, requesterPhone: data.requesterPhone };
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
  data: {
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
