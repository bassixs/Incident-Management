import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import {
  REJECTION_MESSAGES,
  normaliseRequesterName,
  normaliseRequesterPhone,
} from '../../incidents/incident.service';
import type { Message } from '../../max/max-types';
import { classifyAttachments } from '../../media/media.service';
import { RateLimitError, ValidationError } from '../../utils/errors';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { normaliseIncidentText, unicodeLength } from '../../utils/text';
import { legalDocumentsKeyboard, mainMenuKeyboard, requesterCategoryKeyboard } from '../keyboards';
import {
  categoryPromptText,
  greetingText,
  incidentPromptText,
  legalGateText,
  registrationConfirmation,
  requesterPhonePromptText,
} from '../views/cards';
import type { ResolvedActor } from './helpers';

const log = moduleLogger('bot-requester');

const NO_SESSION_HINT = 'Чтобы создать новое обращение, нажмите «Создать обращение».';

/** §7-§12, §56 — everything a requester does in their private dialog. */
export async function handleRequesterMessage(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  message: Message,
): Promise<void> {
  const target = { userId: actor.maxUserId } as const;

  if (await services.bans.isBanned(actor.maxUserId)) {
    // §20: no technical details, no hint about how long it lasts.
    await services.messages.send(target, { text: REJECTION_MESSAGES.banned });
    return;
  }

  const session = await services.sessions.find(actor.maxUserId, chatId);
  if (!session) {
    await services.messages.send(target, { text: NO_SESSION_HINT, keyboard: mainMenuKeyboard() });
    return;
  }

  if (
    (session.type === SessionType.WAITING_REQUESTER_NAME ||
      session.type === SessionType.WAITING_REQUESTER_PHONE ||
      session.type === SessionType.WAITING_INCIDENT_SELECTION ||
      session.type === SessionType.WAITING_CUSTOM_LOCALITY ||
      session.type === SessionType.WAITING_INCIDENT_TEXT) &&
    !(await services.legal.hasCurrentAccess(actor.userId))
  ) {
    await services.sessions.clear(actor.maxUserId, chatId);
    const legalStatus = await services.legal.status(actor.userId);
    await services.messages.send(target, {
      text: legalGateText(),
      keyboard: legalDocumentsKeyboard(services.legal.links(), {
        showContinue: legalStatus.required && legalStatus.documentsAvailable,
      }),
    });
    return;
  }

  const data = services.sessions.readData(session);
  const media = classifyAttachments(message.body.attachments);
  const text = message.body.text ?? '';

  if (session.type === SessionType.WAITING_REQUESTER_NAME) {
    try {
      if (media.length > 0) throw new ValidationError('Отправьте ФИО обычным текстовым сообщением.');
      const requesterName = normaliseRequesterName(text);
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_REQUESTER_PHONE,
        data: { requesterName },
      });
      await services.messages.send(target, { text: requesterPhonePromptText() });
    } catch (error) {
      await services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить ФИО. Попробуйте ещё раз.',
      });
    }
    return;
  }

  if (session.type === SessionType.WAITING_REQUESTER_PHONE) {
    try {
      if (!data.requesterName) throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
      if (media.length > 0) throw new ValidationError('Отправьте номер обычным текстовым сообщением.');
      const requesterPhone = normaliseRequesterPhone(text);
      const categories = await services.categories.listActive();
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_SELECTION,
        data: { requesterName: data.requesterName, requesterPhone },
      });
      await services.messages.send(target, {
        text: categoryPromptText(categories.length),
        keyboard: requesterCategoryKeyboard(categories, 0),
      });
    } catch (error) {
      await services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить номер. Попробуйте ещё раз.',
      });
    }
    return;
  }

  if (session.type === SessionType.WAITING_INCIDENT_SELECTION) {
    await services.messages.send(target, { text: 'Продолжите создание обращения кнопками выше.' });
    return;
  }

  if (session.type === SessionType.WAITING_CUSTOM_LOCALITY) {
    const locality = normaliseIncidentText(text).replace(/\n+/g, ' ');
    if (media.length > 0 || locality.length === 0) {
      await services.messages.send(target, {
        text: 'Напишите только название населённого пункта. Фотографию можно будет приложить к описанию проблемы следующим сообщением.',
      });
      return;
    }
    if (unicodeLength(locality) > 100) {
      await services.messages.send(target, { text: 'Название слишком длинное. Укажите не более 100 символов.' });
      return;
    }
    if (
      !data.requesterName ||
      !data.requesterPhone ||
      !data.problemMunicipalityCode ||
      !data.problemMunicipalityName
    ) {
      await services.sessions.clear(actor.maxUserId, chatId);
      await services.messages.send(target, {
        text: 'Черновик устарел. Начните создание обращения заново.',
        keyboard: mainMenuKeyboard(),
      });
      return;
    }
    await services.sessions.start({
      maxUserId: actor.maxUserId,
      chatId,
      type: SessionType.WAITING_INCIDENT_TEXT,
      data: { ...data, problemLocality: locality },
    });
    await services.messages.send(target, {
      text: [`Населённый пункт: ${locality}`, '', incidentPromptText()].join('\n'),
    });
    return;
  }

  if (session.type !== SessionType.WAITING_INCIDENT_TEXT) {
    await services.messages.send(target, { text: NO_SESSION_HINT, keyboard: mainMenuKeyboard() });
    return;
  }

  if (!data.requesterName || !data.requesterPhone) {
    await services.sessions.clear(actor.maxUserId, chatId);
    await services.messages.send(target, {
      text: 'Черновик устарел. Начните создание обращения заново.',
      keyboard: mainMenuKeyboard(),
    });
    return;
  }

  try {
    const incident = await services.incidents.create({
      requester: {
        maxUserId: actor.maxUserId,
        name: data.requesterName,
        phone: data.requesterPhone,
        username: message.sender?.username ?? null,
      },
      text,
      userSelectedCategoryId: data.selectedCategoryId ?? null,
      problemMunicipalityCode: data.problemMunicipalityCode ?? null,
      problemMunicipalityName: data.problemMunicipalityName ?? null,
      problemLocality: data.problemLocality ?? null,
      media,
    });

    await services.sessions.clear(actor.maxUserId, chatId);

    // A failure to publish the card must never hide the fact that the incident
    // exists: the registration is already committed and the number is final.
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
    return;
  } catch (error) {
    if (error instanceof ValidationError) {
      // Format errors do not consume the daily quota and do not create an
      // incident, so the draft session stays open for another attempt.
      await services.messages.send(target, { text: error.message });
      return;
    }
    if (error instanceof RateLimitError) {
      await services.sessions.clear(actor.maxUserId, chatId);
      await services.messages.send(target, { text: error.message, keyboard: mainMenuKeyboard() });
      return;
    }
    log.error(
      incidentLogFields({ maxUserId: actor.maxUserId, chatId, action: 'INCIDENT_CREATED' }),
      `incident registration failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await services.messages.send(target, {
      text: 'Не удалось зарегистрировать обращение. Попробуйте ещё раз позже.',
      keyboard: mainMenuKeyboard(),
    });
  }
}

/** `/start` and `bot_started`. */
export async function sendMainMenu(services: AppServices, actor: ResolvedActor): Promise<void> {
  if (await services.bans.isBanned(actor.maxUserId)) {
    await services.messages.send({ userId: actor.maxUserId }, { text: REJECTION_MESSAGES.banned });
    return;
  }
  await services.messages.send(
    { userId: actor.maxUserId },
    { text: greetingText(), keyboard: mainMenuKeyboard() },
  );
}
