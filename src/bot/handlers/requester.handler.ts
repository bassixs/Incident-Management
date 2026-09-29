import { assertNoPersonalData, PRIVACY_REJECTION } from '../../privacy/personal-data';
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

const NO_SESSION_HINT = 'Чтобы создать новое сообщение, нажмите «Создать сообщение».';

/** §7-§12, §56 — everything a requester does in their private dialog. */
export async function handleRequesterMessage(
  services: AppServices,
  actor: ResolvedActor,
  chatId: bigint,
  message: Message,
  contactInfo?: import('../../privacy/optional-contact').VerifiedDraftContact,
): Promise<void> {
  const target = { userId: actor.maxUserId } as const;
  if (message.body.attachments?.some(a => a.type === 'contact')) {
    await services.messages.send(target, { text: PRIVACY_REJECTION }); return;
  }
  try { assertNoPersonalData(message.body.text ?? ''); } catch {
    await services.messages.send(target, { text: PRIVACY_REJECTION }); return;
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
    await services.messages.send(target, { text: 'Ответ на уточнение больше не требуется. Статус сообщения доступен в разделе «Мои сообщения».', keyboard: mainMenuKeyboard() });
    return;
  }

  const data = services.sessions.readData(session);
  if (contactInfo) {
    if (session.type !== SessionType.WAITING_INCIDENT_CONFIRMATION || data.draftToken !== contactInfo.draftToken ||
        data.previewToken !== contactInfo.previewToken || data.requesterPhone || data.pendingPhone) {
      await services.messages.send(target, { text: 'Запрос контакта устарел. Используйте кнопки текущей карточки.' }); return;
    }
    await showIncidentDraftPreview(services, actor.maxUserId, chatId, { ...data, pendingPhone: contactInfo.phone });
    return;
  }
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

  if ([SessionType.WAITING_REQUESTER_NAME, SessionType.WAITING_REQUESTER_PHONE].includes(session.type as any)) {
    await services.sessions.clear(actor.maxUserId, chatId); await sendMainMenu(services, actor); return;
  }

  if (session.type === SessionType.WAITING_INCIDENT_EDIT_VALUE) {
    try {
      const draft = requireCompleteIncidentDraft(data);
      switch (data.draftEditField) {
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
          throw new ValidationError('Черновик устарел. Начните создание сообщения заново.');
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
      !data.problemMunicipalityCode ||
      !data.problemMunicipalityName
    ) {
      await services.sessions.clear(actor.maxUserId, chatId);
      await services.messages.send(target, {
        text: 'Черновик устарел. Начните создание сообщения заново.',
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
