import { reportActionError } from '../../utils/errors';
import type { Context } from '@maxhub/max-bot-api';

import type { AppServices } from '../../app/container';
import { REJECTION_MESSAGES } from '../../incidents/incident.service';
import type { BotAddedUpdateLike, MessageCreatedUpdate } from './update-shapes';
import { moduleLogger } from '../../utils/logger';
import { findCommand } from '../commands';
import { handleOperatorMessage } from './operator.handler';
import { handleRequesterMessage, sendMainMenu } from './requester.handler';
import { chatIdOf, isDialog, parseCommand, resolveActor, userFacingError } from './helpers';

const log = moduleLogger('bot-messages');

const UNKNOWN_COMMAND = 'Неизвестная команда. Отправьте /help, чтобы увидеть список доступных команд.';

/**
 * Router for `message_created`.
 *
 * Three mutually exclusive branches: a slash command, a requester writing in
 * their dialog, or an operator finishing a pending action in a working chat.
 * Messages in a working chat with no pending session are ignored on purpose —
 * the bot must not talk over people doing their jobs.
 */
export async function handleMessageUpdate(services: AppServices, ctx: Context): Promise<void> {
  const update = ctx.update as MessageCreatedUpdate;
  const message = update.message;
  const sender = message?.sender;
  if (!message || !sender || sender.is_bot) return;

  const dialog = isDialog(message);
  // In a dialog MAX may omit chat_id. The author's user id is then an
  // equivalent, stable scope key — and it has to be derived the same way here
  // and in the callback router, or a session would be created under one key
  // and looked up under another.
  const chatId = chatIdOf(message) ?? (dialog ? BigInt(sender.user_id) : undefined);
  if (chatId === undefined) return;

  const actor = await resolveActor(services, sender, message.recipient.chat_type === 'chat' ? chatId : undefined);

  // Reject documents at every requester step, including command captions and
  // photos sent as files. Do not download them or change the current session.
  if (dialog && message.body.attachments?.some(attachment => attachment.type === 'file')) {
    await services.messages.send({ userId: actor.maxUserId }, { text: REJECTION_MESSAGES.file });
    return;
  }

  const command = parseCommand(message.body.text);
  if (command) {
    const handler = findCommand(command.name);
    if (!handler) {
      if (dialog) await services.messages.send({ userId: actor.maxUserId }, { text: UNKNOWN_COMMAND });
      return;
    }
    try {
      await handler({ services, actor, chatId, isDialog: dialog, args: command.args });
    } catch (error) {
      log.warn(
        { command: command.name, maxUserId: actor.maxUserId.toString(), chatId: chatId.toString() },
        `command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await reportActionError(error, () => services.messages
        .send(dialog ? { userId: actor.maxUserId } : { chatId }, { text: userFacingError(error) }));
    }
    return;
  }

  if (dialog) {
    let contactInfo: { tel?: string; fullName?: string } | undefined;
    try {
      contactInfo = ctx.contactInfo;
    } catch (error) {
      log.warn(
        { maxUserId: actor.maxUserId.toString() },
        `invalid MAX contact attachment: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await handleRequesterMessage(services, actor, chatId, message, contactInfo);
    return;
  }

  const session = await services.sessions.find(actor.maxUserId, chatId);
  if (!session) return;
  await handleOperatorMessage(services, actor, chatId, message, session);
}

/** `bot_started` — the requester opened the dialog for the first time. */
export async function handleBotStarted(services: AppServices, ctx: Context): Promise<void> {
  const user = ctx.user;
  if (!user) return;
  const actor = await resolveActor(services, user);
  await sendMainMenu(services, actor);
}

/**
 * `bot_added` — announce the chat id so an administrator can paste it into
 * DISTRIBUTION_CHAT_ID / REVIEW_CHAT_ID / a category without guessing.
 */
export async function handleBotAdded(services: AppServices, ctx: Context): Promise<void> {
  const update = ctx.update as BotAddedUpdateLike;
  if (update.chat_id === undefined) return;
  await services.messages.send(
    { chatId: BigInt(update.chat_id) },
    {
      text: [
        'Бот подключён к этому чату.',
        '',
        `ID чата: ${update.chat_id}`,
        '',
        'Укажите его в DISTRIBUTION_CHAT_ID, REVIEW_CHAT_ID или в настройках ответственной группы',
        '(/group_chat <КОД> <CHAT_ID>).',
      ].join('\n'),
    },
  );
}
