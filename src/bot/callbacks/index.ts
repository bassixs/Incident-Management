import { setTimeout as delay } from 'node:timers/promises';

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

  const lease = actionLease(payload, actor.maxUserId, chatId, messageId);
  let acknowledged = false;
  try {
    if (lease && !(await services.actionGuard.acquire(lease))) {
      await answerCallback(services, callback.callback_id, 'Уже обрабатывается. Пожалуйста, подождите.');
      return;
    }

    const operation = dispatchCallback(
      services,
      actor,
      chatId,
      messageId,
      callback.callback_id,
      payload,
    );
    const raced = await Promise.race([
      operation.then((notice) => ({ kind: 'done' as const, notice })),
      delay(600).then(() => ({ kind: 'pending' as const })),
    ]);

    if (raced.kind === 'done') {
      await answerCallback(services, callback.callback_id, raced.notice);
      return;
    }

    acknowledged = true;
    await answerCallback(services, callback.callback_id, 'Принято, обрабатываю…');
    await operation;
  } catch (error) {
    if (lease) await services.actionGuard.release(lease.key).catch(() => undefined);
    log.warn(
      incidentLogFields({
        maxUserId: actor.maxUserId,
        chatId,
        action: payload.kind === 'noop' ? payload.kind : payload.action,
        incidentId: payload.kind === 'incident' ? payload.incidentId : undefined,
      }),
      `callback failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (acknowledged) {
      const target =
        update.message?.recipient?.chat_type === 'dialog' || chatId === undefined
          ? ({ userId: actor.maxUserId } as const)
          : ({ chatId } as const);
      await services.messages.send(target, { text: `⚠️ ${errorNotice(error)}` });
    } else {
      await answerCallback(services, callback.callback_id, errorNotice(error));
    }
  }
}

async function dispatchCallback(
  services: AppServices,
  actor: Awaited<ReturnType<typeof resolveActor>>,
  chatId: bigint | undefined,
  messageId: string | undefined,
  callbackId: string,
  payload: NonNullable<ReturnType<typeof parseCallbackPayload>>,
): Promise<string | undefined> {
  switch (payload.kind) {
    case 'user':
      return handleUserCallback({ services, actor, chatId, messageId, callbackId }, payload);
    case 'incident':
      return handleIncidentCallback({ services, actor, chatId, messageId }, payload);
    case 'session':
      return handleSessionCallback(services, actor.maxUserId, chatId, payload.action);
    case 'report':
      return handleReportCallback({ services, actor, chatId }, payload);
    case 'noop':
      return undefined;
  }
}

function actionLease(
  payload: NonNullable<ReturnType<typeof parseCallbackPayload>>,
  maxUserId: bigint,
  chatId: bigint | undefined,
  messageId: string | undefined,
) {
  if (payload.kind === 'noop') return undefined;

  if (payload.kind === 'incident') {
    const globallyExclusive = ['assign-category', 'assign-group', 'take', 'approve'].includes(payload.action);
    return {
      key: [
        globallyExclusive ? 'incident-global' : `user:${maxUserId.toString()}`,
        payload.incidentId,
        payload.action,
        globallyExclusive ? '-' : payload.argument ?? '-',
      ].join(':'),
      maxUserId,
      incidentId: payload.incidentId,
      action: payload.action,
      ttlMs: 120_000,
    };
  }

  const scope = `user:${maxUserId.toString()}:chat:${chatId?.toString() ?? '-'}:message:${messageId ?? '-'}`;
  return {
    key: `${scope}:${payload.kind}:${payload.action}:${'argument' in payload ? payload.argument ?? '-' : '-'}`,
    maxUserId,
    action: `${payload.kind}:${payload.action}`,
    ttlMs: payload.kind === 'report' ? 300_000 : payload.kind === 'user' ? 2_000 : 10_000,
  };
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
