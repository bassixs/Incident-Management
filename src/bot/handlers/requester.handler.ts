import { reportActionError } from '../../utils/errors';
import { hasPrivateWorkAccess } from '../../users/private-work-access';
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
import {
  legalDocumentsKeyboard,
  mainMenuKeyboard,
  requesterCategoryKeyboard,
  requesterContactKeyboard,
} from '../keyboards';
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
  personalDataConsentText,
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
  contactInfo?: { tel?: string; fullName?: string },
): Promise<void> {
  const target = { userId: actor.maxUserId } as const;
  const sharedContact = message.body.attachments?.find((attachment) => attachment.type === 'contact');
  const sharedMaxUserId = sharedContact?.type === 'contact' ? sharedContact.payload.tam_info?.user_id : undefined;
  if (sharedMaxUserId !== undefined && BigInt(sharedMaxUserId) !== actor.maxUserId) {
    // A manually forwarded contact may belong to someone else. Only the
    // account owner's own contact is allowed to fill their profile.
    contactInfo = undefined;
  }

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

  if (session.type === SessionType.WAITING_CLARIFICATION_REPLY) {
    await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
    await services.messages.send(target, { text: 'Ответ на уточнение больше не требуется. Статус обращения доступен в разделе «Мои обращения».', keyboard: mainMenuKeyboard() });
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
      text: legalStatus.agreementAccepted
        ? personalDataConsentText(services.config.LEGAL_DOCUMENT_VERSION)
        : legalGateText(),
      keyboard: legalDocumentsKeyboard(services.legal.links(), {
        acceptance: legalStatus.required && !legalStatus.ready && legalStatus.documentsAvailable
          ? (legalStatus.agreementAccepted ? 'consent' : 'agreement') : undefined,
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
      if (sharedContact || contactInfo || media.length > 0) {
        throw new ValidationError('Сначала отправьте фамилию, имя и отчество (если есть) обычным текстом. Телефон укажете на следующем шаге.');
      }
      const requesterName = normaliseRequesterName(text);
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId,
        type: SessionType.WAITING_REQUESTER_PHONE,
        data: { requesterName },
      });
      await services.messages.send(target, {
        text: requesterPhonePromptText(),
        keyboard: requesterContactKeyboard(),
      });
    } catch (error) {
      await reportActionError(error, () => services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить ФИО. Попробуйте ещё раз.',
      }));
    }
    return;
  }

  if (session.type === SessionType.WAITING_REQUESTER_PHONE) {
    try {
      if (!data.requesterName) throw new ValidationError('Черновик устарел. Начните создание обращения заново.');
      if (!contactInfo?.tel && media.length > 0) {
        throw new ValidationError('Введите номер текстом или нажмите «Поделиться контактом».');
      }
      const requesterPhone = normaliseRequesterPhone(contactInfo?.tel ?? text);
      await continueToCategorySelection(
        services,
        actor.maxUserId,
        chatId,
        data.requesterName,
        requesterPhone,
      );
    } catch (error) {
      await reportActionError(error, () => services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить номер. Попробуйте ещё раз.',
      }));
    }
    return;
  }


  if (session.type === SessionType.WAITING_INCIDENT_EDIT_VALUE) {
    try {
      const draft = requireCompleteIncidentDraft(data);
      switch (data.draftEditField) {
        case 'name': {
          if (sharedContact || contactInfo || media.length > 0) throw new ValidationError('Отправьте ФИО обычным текстовым сообщением.');
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            requesterName: normaliseRequesterName(text),
          });
          return;
        }
        case 'phone': {
          if (!contactInfo?.tel && media.length > 0) {
            throw new ValidationError('Введите номер текстом или нажмите «Поделиться контактом».');
          }
          await showIncidentDraftPreview(services, actor.maxUserId, chatId, {
            ...draft,
            requesterPhone: normaliseRequesterPhone(contactInfo?.tel ?? text),
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
      await reportActionError(error, () => services.messages.send(target, {
        text: error instanceof ValidationError ? error.message : 'Не удалось сохранить изменение. Попробуйте ещё раз.',
      }));
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
    await reportActionError(error, () => services.messages.send(target, {
      text: 'Не удалось сохранить черновик. Попробуйте ещё раз позже.',
    }));
  }
}

async function continueToCategorySelection(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint,
  requesterName: string,
  requesterPhone: string,
): Promise<void> {
  const categories = await services.categories.listActive();
  await services.sessions.start({
    maxUserId,
    chatId,
    type: SessionType.WAITING_INCIDENT_SELECTION,
    data: { requesterName, requesterPhone },
  });
  await services.messages.send(
    { userId: maxUserId },
    {
      text: categoryPromptText(categories.length),
      keyboard: requesterCategoryKeyboard(categories, 0),
    },
  );
}

/** `/start` and `bot_started`. */
export async function sendMainMenu(services: AppServices, actor: ResolvedActor, includeWork = true): Promise<void> {
  if (await services.bans.isBanned(actor.maxUserId)) {
    await services.messages.send({ userId: actor.maxUserId }, { text: REJECTION_MESSAGES.banned });
    return;
  }
  await services.messages.send(
    { userId: actor.maxUserId },
    { text: greetingText(), keyboard: [...mainMenuKeyboard(), ...(includeWork && await services.prisma.privateWorkItem.count({ where: { maxUserId: actor.maxUserId } }) && await hasPrivateWorkAccess(services, actor.maxUserId) ? [[{ type: 'callback' as const, text: 'Моя работа', payload: 'personal:home' }]] : [])] },
  );
}
