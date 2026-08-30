import { SessionType } from '@prisma/client';

import type { AppServices } from '../../app/container';
import type { CallbackPayload } from '../../max/callback-payload';
import { REJECTION_MESSAGES, dailyLimitMessage } from '../../incidents/incident.service';
import { moduleLogger } from '../../utils/logger';
import { mainMenuKeyboard, requesterCategoryKeyboard } from '../keyboards';
import {
  categoryPromptText,
  greetingText,
  incidentPromptText,
  myIncidentsText,
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
};

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
    case 'menu': {
      await services.messages.send(target, { text: greetingText(), keyboard: mainMenuKeyboard() });
      return undefined;
    }

    case 'rules': {
      await services.messages.send(target, { text: rulesText(), keyboard: mainMenuKeyboard() });
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
      const remaining = await services.incidents.remainingDailyQuota(actor.maxUserId);
      if (remaining <= 0) {
        await services.messages.send(target, {
          text: dailyLimitMessage(services.config.DAILY_INCIDENT_LIMIT),
          keyboard: mainMenuKeyboard(),
        });
        return 'Дневной лимит исчерпан';
      }
      const categories = await services.categories.listActive();
      await services.messages.send(target, {
        text: categoryPromptText(categories.length),
        keyboard: requesterCategoryKeyboard(categories, 0),
      });
      return undefined;
    }

    /** Paging the сфера picker: rewrite the same message, no new ones. */
    case 'page': {
      if (!context.messageId) return undefined;
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

      // The guess is stored on the session and copied onto the incident later;
      // it never routes anything — every incident goes to distribution first.
      await services.sessions.start({
        maxUserId: actor.maxUserId,
        chatId: context.chatId ?? actor.maxUserId,
        type: SessionType.WAITING_INCIDENT_TEXT,
        data: { selectedCategoryId },
      });

      await services.messages.send(target, { text: incidentPromptText() });
      log.debug({ maxUserId: actor.maxUserId.toString(), selectedCategoryId }, 'incident draft started');
      return undefined;
    }

    default:
      return undefined;
  }
}
