import type { AppServices } from '../app/container';
import type { ResolvedActor } from '../bot/handlers/helpers';
import { ForbiddenError } from '../utils/errors';
import { workingChatFor } from '../users/working-chat';
import { assertDispatcher, assertResponder } from '../bot/middleware/authorize';

/** Re-read assignment and MAX membership on every reveal. Never queue the phone for retry. */
export async function revealResidentContact(services: AppServices, actor: ResolvedActor, chatId: bigint, incidentId: string): Promise<void> {
  const deny = () => new ForbiddenError('Контакт недоступен на этом этапе или в этом рабочем чате.');
  if (chatId === services.config.REVIEW_CHAT_ID || chatId === services.config.DELIVERY_ALERT_CHAT_ID) throw deny();
  const workingChat = await workingChatFor(services, chatId);
  if (!workingChat) throw deny();
  const membership = await services.max.api.getChatMembers(Number(chatId), { user_ids: [Number(actor.maxUserId)] });
  if (!membership.members.some(m => BigInt(m.user_id) === actor.maxUserId && !m.is_bot)) throw deny();
  // Read after membership lookup so a slow network check cannot retain an old assignment.
  const incident = await services.repository.findById(incidentId);
  if (!incident?.requesterPhone) throw deny();
  const scoped = { ...actor, workingChat, roles: [...new Set([...actor.roles, ...workingChat.roles])] };
  if (chatId === services.config.DISTRIBUTION_CHAT_ID && incident.status === 'DISTRIBUTION') {
    assertDispatcher(services, scoped, chatId);
  } else {
    if (!incident.assignedGroup?.isActive || incident.assignedGroup.maxChatId !== chatId ||
        !['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status)) throw deny();
    assertResponder(scoped, incident, chatId);
  }
  try {
    // A personal response avoids exposing the number to all members or leaving it in the outbox.
    await services.messages.send({ userId: actor.maxUserId }, {
      text: `📞 ${incident.publicCode}\nТелефон для связи: ${incident.requesterPhone}\nТолько для уточнения деталей этого сообщения.`,
      immediatePreview: true,
    });
  } catch {
    throw new ForbiddenError('Откройте личный диалог с ботом, нажмите «Начать» и повторите запрос контакта.');
  }
}
