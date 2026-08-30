import type { Context } from '@maxhub/max-bot-api';

import type { AppServices } from '../../app/container';
import { parseCallbackPayload } from '../../max/callback-payload';
import type { MessageCallbackUpdate } from '../../max/max-types';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { answerCallback, chatIdOf, errorNotice, resolveActor } from '../handlers/helpers';
import { SESSION_PROMPTS } from '../handlers/session-guard';
import { handleIncidentCallback } from './incident.callbacks';
import { handleReportCallback } from './report.callbacks';
import { handleUserCallback } from './user.callbacks';

const log = moduleLogger('bot-callbacks');

/** Single entry point for `message_callback` updates. */
export async function handleCallbackUpdate(services: AppServices, ctx: Context): Promise<void> {
  const update = ctx.update as MessageCallbackUpdate;
  const callback = update.callback;
  if (!callback) return;

  const payload = parseCallbackPayload(callback.payload);
  if (!payload) {
    await answerCallback(services, callback.callback_id, 'Кнопка устарела.');
    return;
  }

  const actor = await resolveActor(services, callback.user);
  // Mirrors the fallback in the message router so session keys line up.
  const messageId = update.message?.body?.mid;
  const chatId =
    chatIdOf(update.message ?? undefined) ??
    (update.message?.recipient?.chat_type === 'dialog' ? BigInt(callback.user.user_id) : undefined);

  try {
    let notice: string | undefined;
    switch (payload.kind) {
      case 'user':
        notice = await handleUserCallback({ services, actor, chatId, messageId }, payload);
        break;
      case 'incident':
        notice = await handleIncidentCallback({ services, actor, chatId }, payload);
        break;
      case 'session':
        notice = await handleSessionCallback(services, actor.maxUserId, chatId, payload.action);
        break;
      case 'report':
        notice = await handleReportCallback({ services, actor, chatId }, payload);
        break;
      case 'noop':
        break;
    }
    await answerCallback(services, callback.callback_id, notice);
  } catch (error) {
    log.warn(
      incidentLogFields({
        maxUserId: actor.maxUserId,
        chatId,
        action: payload.kind === 'noop' ? payload.kind : payload.action,
        incidentId: payload.kind === 'incident' ? payload.incidentId : undefined,
      }),
      `callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await answerCallback(services, callback.callback_id, errorNotice(error));
  }
}

async function handleSessionCallback(
  services: AppServices,
  maxUserId: bigint,
  chatId: bigint | undefined,
  action: 'continue' | 'cancel',
): Promise<string> {
  if (chatId === undefined) return 'Действие недоступно.';

  if (action === 'cancel') {
    await services.sessions.clear(maxUserId, chatId);
    return 'Незавершённое действие отменено.';
  }

  const session = await services.sessions.find(maxUserId, chatId);
  if (!session) return 'Активных действий нет.';
  await services.sessions.extend(session.id);
  const incident = session.incidentId ? await services.repository.findById(session.incidentId) : null;
  return `${incident ? `${incident.publicCode}: ` : ''}${SESSION_PROMPTS[session.type]}`;
}
