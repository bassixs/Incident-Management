import type { Context } from '@maxhub/max-bot-api';
import type { AppServices } from '../../app/container';
import type { Update } from '../../max/max-types';
import { workingChatFor } from '../../users/working-chat';

/** Access itself is derived from the chat for every command/callback, so no
 * global role survives leaving a chat and existing members need no backfill. */
export async function handleMembershipUpdate(services: AppServices, ctx: Context): Promise<void> {
  const update = ctx.update as Extract<Update, { update_type: 'user_added' | 'user_removed' }>;
  if (update.is_channel || update.user.is_bot) return;
  const chatId = BigInt(update.chat_id);
  if (update.update_type === 'user_removed') {
    await services.sessions.clear(BigInt(update.user.user_id), chatId);
    return;
  }
  const chat = await workingChatFor(services, chatId);
  if (!chat) return;
  const user = await services.users.upsertFromMax(update.user);
  await services.messages.send({ chatId }, {
    text: `${user.displayName}, добро пожаловать!\nВаши права в этом чате: ${chat.labels.join(', ')}. Можно сразу приступать к работе.\n\nОтправьте /info — бот объяснит порядок работы и покажет доступные команды.`,
    delivery: { dedupeKey: `welcome:${chatId}:${user.maxUserId}:${update.timestamp}` },
  });
}
