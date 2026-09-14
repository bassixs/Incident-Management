import { reportActionError } from '../../utils/errors';
import { setTimeout as delay } from 'node:timers/promises';

import type { Context } from '@maxhub/max-bot-api';

import type { AppServices } from '../../app/container';
import { parseCallbackPayload } from '../../max/callback-payload';
import type { MessageCallbackUpdate } from '../../max/max-types';
import { incidentLogFields, moduleLogger } from '../../utils/logger';
import { answerCallback, chatIdOf, errorNotice, resolveActor } from '../handlers/helpers';
import { SESSION_PROMPTS, discardObsoleteSession } from '../handlers/session-guard';
import { handleIncidentCallback } from './incident.callbacks';
import { handleReportCallback } from './report.callbacks';
import { handleUserCallback } from './user.callbacks';
import { handleQueueCallback } from './queue.callbacks';
import { assertWorkingChat } from '../middleware/authorize';
import { sendChatGuide } from '../views/chat-guide';
import { cleanupCommand } from '../commands/cleanup';
import { resumeRejection } from './rejection-flow';
import { resumeReviewEdit } from './review-edit-flow';
import { cancelStaffSession, pendingConfirmation, showStaffConfirmation, withConfirmationLock } from './staff-confirmation';
import { invitePersonalWork, personalAction, personalHome, exitPersonalWork, withPersonalWorkLock } from '../../work-queues/private-workspace';
import { sendMainMenu } from '../handlers/requester.handler';

const log = moduleLogger('bot-callbacks');

/** Single entry point for `message_callback` updates. */
export async function handleCallbackUpdate(services: AppServices, ctx: Context): Promise<void> {
  const update = ctx.update as MessageCallbackUpdate;
  const callback = update.callback;
  if (!callback || callback.user.is_bot) return;

  const payload = parseCallbackPayload(callback.payload);
  if (!payload) {
    await answerCallback(services, callback.callback_id, 'Кнопка устарела.');
    return;
  }

  // Mirrors the fallback in the message router so session keys line up.
  const messageId = update.message?.body?.mid;
  const chatId =
    chatIdOf(update.message ?? undefined) ??
    (update.message?.recipient?.chat_type === 'dialog' ? BigInt(callback.user.user_id) : undefined);

  const actor = await resolveActor(services, callback.user, update.message?.recipient?.chat_type === 'chat' ? chatId : undefined);

  const lease = actionLease(payload, actor.maxUserId, chatId, messageId);
  let acknowledged = false;
  let leaseAcquired = false;
  try {
    if (lease && !(await services.actionGuard.acquire(lease))) {
      await answerCallback(services, callback.callback_id, 'Уже обрабатывается. Пожалуйста, подождите.');
      return;
    }
    leaseAcquired = !!lease;

    const operation = dispatchCallback(
      services,
      actor,
      chatId,
      messageId,
      callback.callback_id,
      payload,
      update.message?.recipient?.chat_type !== 'chat',
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
    await reportActionError(error, async () => {
      if (acknowledged) {
        const target =
          update.message?.recipient?.chat_type === 'dialog' || chatId === undefined
            ? ({ userId: actor.maxUserId } as const)
            : ({ chatId } as const);
        await services.messages.send(target, { text: `⚠️ ${errorNotice(error)}` });
      } else {
        await answerCallback(services, callback.callback_id, errorNotice(error));
      }
    });
  } finally {
    // Reopening a cancelled rejection is a new draft, not a duplicate submission.
    if (leaseAcquired && lease && payload.kind === 'incident' && ['reject', 'personal', 'review-edit', 'approve', 'assign-group', 'action-confirm', 'action-edit', 'action-cancel'].includes(payload.action)) {
      await services.actionGuard.release(lease.key).catch(() => undefined);
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
  isDialog: boolean,
): Promise<string | undefined> {
  switch (payload.kind) {
    case 'personal':
      return withPersonalWorkLock(services, actor.maxUserId, async () => {
        if (!isDialog) {
          if (payload.action !== 'home' || chatId === undefined) throw new Error('Откройте личный диалог с ботом.');
          return invitePersonalWork(services, actor, chatId);
        }
        if (payload.action === 'resident') { await exitPersonalWork(services, actor.maxUserId); await sendMainMenu(services, actor); }
        else if (payload.action === 'home') await personalHome(services, actor, Number(payload.argument ?? 0));
        else await personalAction(services, actor, payload.itemId!, payload.action, payload.argument, messageId);
        return undefined;
      });
    case 'work':
      await assertWorkingChat(services, chatId, isDialog);
      if (payload.action === 'next') return services.workQueues.claim(actor, chatId!);
      if (payload.action === 'refresh') await services.workQueues.refresh(actor, chatId!);
      else if (payload.action === 'open') await services.workQueues.open(actor, chatId!, payload.argument!);
      else if (payload.action === 'release') await withConfirmationLock(services, actor.maxUserId, chatId!, () => services.workQueues.release(actor, chatId!, payload.argument!));
      else await services.workQueues.list(actor, chatId!, Number(payload.argument), payload.action === 'mine', payload.action === 'today');
      return 'Готово';
    case 'cleanup':
      await services.cleanup.authorize(actor, chatId, isDialog);
      if (payload.action === 'custom') {
        await services.messages.send({ chatId: chatId! }, { text: 'Укажите даты одной командой, например:\n\n/clear_data 01.09.2026 - 07.09.2026\n\nИли один день: /clear_data 07.09.2026\nБот сначала покажет подсчёт. Без отдельного подтверждения ничего не удаляется.' });
      } else await cleanupCommand({ services, actor, chatId: chatId!, isDialog, args: [payload.action] }, 'data');
      return undefined;
    case 'help':
      await sendChatGuide(services, actor, chatId, isDialog, payload.action);
      return undefined;
    case 'queue':
      await assertWorkingChat(services, chatId, isDialog);
      if (payload.action === 'release') return withConfirmationLock(services, actor.maxUserId, chatId!, () => handleQueueCallback(services, actor, chatId, payload));
      return handleQueueCallback(services, actor, chatId, payload);
    case 'user':
      if (isDialog) await exitPersonalWork(services, actor.maxUserId);
      return handleUserCallback({ services, actor, chatId, messageId, callbackId }, payload);
    case 'incident':
      await assertWorkingChat(services, chatId, isDialog);
      return handleIncidentCallback({ services, actor, chatId, messageId }, payload);
    case 'session':
      return handleSessionCallback(services, actor.maxUserId, chatId, payload.action);
    case 'report':
      return handleReportCallback({ services, actor, chatId, isDialog }, payload);
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
  if (payload.kind === 'personal') return undefined;

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
    ttlMs:
      payload.kind === 'report'
        ? 300_000
        : payload.kind === 'user' && payload.action === 'draft-confirm'
          ? 120_000
          : payload.kind === 'user'
            ? 2_000
            : 10_000,
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
    await cancelStaffSession(services, maxUserId, chatId);
    return 'Незавершённое действие отменено.';
  }

  const session = await services.sessions.find(maxUserId, chatId);
  if (!session) return 'Активных действий нет.';
  if (await discardObsoleteSession(services, session)) return 'Обращение уже перешло на другой этап. Незавершённое действие сброшено.';
  await services.sessions.extend(session.id);
  if (pendingConfirmation(session)) { await showStaffConfirmation(services, session); return 'Проверьте действие и подтвердите или отмените.'; }
  if ((session.data as { reviewEdit?: boolean } | null)?.reviewEdit) {
    await resumeReviewEdit(services, session);
    return 'Правка ответа продолжена.';
  }
  if (session.type === 'WAITING_REJECTION_REASON' && (session.data as { rejectionToken?: string } | null)?.rejectionToken) {
    await resumeRejection(services, session);
    return 'Подготовка отклонения продолжена.';
  }
  const incident = session.incidentId ? await services.repository.findById(session.incidentId) : null;
  const prompt = (session.data as { redistribution?: boolean } | null)?.redistribution ? 'Ожидается причина возврата на перераспределение.' : SESSION_PROMPTS[session.type];
  return `${incident ? `${incident.publicCode}: ` : ''}${prompt}`;
}
