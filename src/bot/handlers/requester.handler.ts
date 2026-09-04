import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import {
  REJECTION_MESSAGES,
  normaliseRequesterName,
  normaliseRequesterPhone,
} from '../../incidents/incident.service';
import type { Message } from '../../max/max-types';
import { classifyAttachments } from '../../media/media.service';
import { ValidationError } from '../../utils/errors';
import { normaliseIncidentText, unicodeLength } from '../../utils/text';
import { legalDocumentsKeyboard, mainMenuKeyboard, requesterCategoryKeyboard } from '../keyboards';
import {
  requireCompleteIncidentDraft,
  serialiseDraftMedia,
  showIncidentDraftPreview,
} from '../requester-draft';
import {
  categoryPromptText,
  greetingText,
  incidentPromptText,
  legalGateText,
  requesterPhonePromptText,
} from '../views/cards';
import type { ResolvedActor } from './helpers';

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
      session.type === SessionType.WAITING_INCIDENT_TEXT ||
      session.type === SessionType.WAITING_INCIDENT_CONFIRMATION ||
      session.type === SessionType.WAITING_INCIDENT_EDIT_SELECTION ||
      session.type === SessionType.WAITING_INCIDENT_EDIT_VALUE) &&
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

  if (
    session.type === SessionType.WAITING_INCIDENT_CONFIRMATION ||
    session.type === SessionType.WAITING_INCIDENT_EDIT_SELECTION ||
    session.type === SessionType.WAITING_INCIDENT_SELECTION
  ) {
    await services.messages.send(target, { text: 'Продолжите кнопками в сообщении выше.' });
    return;
  }

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


  if (session.type === SessionType.WAITING_INCIDENT_EDIT_VALUE) {
    try {
      const draft = requireCompleteIncidentDraft(data);
      switch (data.draftEditField) {
        case 'name': {
          if (media.length > 0) throw new ValidationError('Отправьте ФИО обычным текстовым сообщением.');
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            requesterName: normaliseRequesterName(text),
          });
          return;
        }
        case 'phone': {
          if (media.length > 0) throw new ValidationError('Отправьте номер обычным текстовым сообщением.');
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            requesterPhone: normaliseRequesterPhone(text),
          });
          return;
        }
        case 'text': {
          if (media.length > 0) {
            throw new ValidationError('Отправьте только новый текст. Фотографии меняются отдельной кнопкой.');
          }
          const validated = services.incidents.validateSubmission(text);
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            draftText: validated.text,
          });
          return;
        }
        case 'photo': {
          if (media.length === 0 || media.some((item) => item.kind !== 'IMAGE')) {
            throw new ValidationError('Отправьте одну или несколько фотографий без других файлов.');
          }
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            draftMedia: serialiseDraftMedia(media),
          });
          return;
        }
        default:
          throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
      }
    } catch (error) {
      await services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить изменение. Попробуйте ещё раз.',
      });
      return;
    }
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
    const nextData = { ...data, problemLocality: locality };
    if (data.draftEditField === 'location') {
      await showIncidentDraftPreview(services, actor.maxUserId, chatId, nextData);
    } else {
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_INCIDENT_TEXT,
        data: nextData,
      });
      await services.messages.send(target, {
        text: [`Населённый пункт: ${locality}`, '', incidentPromptText()].join('\n'),
      });
    }
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
    const validated = services.incidents.validateSubmission(text, media);
    await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
      ...data,
      selectedCategoryId: data.selectedCategoryId ?? null,
      problemLocality: data.problemLocality ?? null,
      draftText: validated.text,
      draftMedia: serialiseDraftMedia(media),
    });
    return;
  } catch (error) {
    if (error instanceof ValidationError) {
      // Format errors do not consume the daily quota and do not create an
      // incident, so the draft session stays open for another attempt.
      await services.messages.send(target, { text: error.message });
      return;
    }
    await services.messages.send(target, {
      text: 'Не удалось сохранить черновик. Попробуйте ещё раз позже.',
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
