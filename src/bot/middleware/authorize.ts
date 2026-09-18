import type { AppServices } from '../../app/container';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { hasPermission, UserRole, type Permission } from '../../users/roles';
import { ForbiddenError } from '../../utils/errors';
import type { ResolvedActor } from '../handlers/helpers';

const GENERIC_DENIAL = 'У вас нет прав для этого действия.';

/**
 * Authorization for every callback and command.
 *
 * Two independent checks always apply:
 *  1. the actor's role must carry the permission;
 *  2. the action must arrive from the chat that owns it — a dispatcher button
 *     pressed anywhere but the distribution chat is refused, and so on.
 *
 * Callback payloads are never trusted for this: the incident is re-read from
 * the database and the chat id comes from the update, not from the button.
 */
export function requirePermission(actor: ResolvedActor, permission: Permission): void {
  if (!hasPermission(actor.roles, permission) && !actor.workingChat?.permissions.includes(permission)) {
    throw new ForbiddenError(GENERIC_DENIAL, { permission });
  }
}

export function requireChat(actual: bigint | undefined, expected: bigint | undefined, label: string): void {
  if (expected === undefined) {
    throw new ForbiddenError(`Рабочий чат «${label}» не настроен.`);
  }
  if (actual === undefined || actual !== expected) {
    throw new ForbiddenError(`Это действие доступно только в чате «${label}».`);
  }
}

export function assertDispatcher(services: AppServices, actor: ResolvedActor, chatId: bigint | undefined): void {
  requirePermission(actor, 'incident.distribute');
  requireChat(chatId, services.config.DISTRIBUTION_CHAT_ID, 'распределение');
}

export function assertApprover(services: AppServices, actor: ResolvedActor, chatId: bigint | undefined): void {
  requirePermission(actor, 'incident.approve');
  requireChat(chatId, services.config.REVIEW_CHAT_ID, 'согласование');
}

/** An automatically admitted sector member may look up only that sector's cards. */
export function assertIncidentVisible(actor: ResolvedActor, incident: IncidentWithRelations, chatId: bigint): void {
  const chat = actor.workingChat;
  if (!chat || actor.roles.includes(UserRole.ADMIN) || chat.distribution || chat.review || chat.delivery) return;
  if (incident.assignedGroup?.maxChatId !== chatId) {
    throw new ForbiddenError('В этом профильном чате доступны только обращения, назначенные его группе.');
  }
}

/**
 * Responder actions are bound to the incident's own sector chat.
 *
 * Membership of that chat is the grant — it is administered outside the bot,
 * and MAX guarantees the chat id on the update. An explicit RESPONDER/ADMIN
 * role is honoured as well, so a role-based rollout can be layered on later
 * without touching handlers.
 */
export function assertResponder(
  actor: ResolvedActor,
  incident: IncidentWithRelations,
  chatId: bigint | undefined,
): void {
  if (actor.roles.includes(UserRole.ADMIN)) return;

  const group = incident.assignedGroup;
  const sectorChatId = group?.maxChatId ?? null;
  if (sectorChatId === null) {
    throw new ForbiddenError(`Для сферы обращения ${incident.publicCode} не настроен рабочий чат.`);
  }
  if (chatId === undefined || chatId !== sectorChatId) {
    throw new ForbiddenError('Это действие доступно только в профильном чате этого обращения.');
  }
  if (group?.bypassReview && !hasPermission(actor.roles, 'incident.distribute')) {
    throw new ForbiddenError('В чате «Администрация Губернатора» отвечать могут только распределители.');
  }
}

/**
 * Staff commands run in working chats only.
 *
 * Reports and lookups expose other people's incidents, so they are refused in
 * a private dialog even for an admin: the output belongs in the chat whose
 * membership already defines who may read it.
 */
export async function assertWorkingChat(services: AppServices, chatId: bigint | undefined, isDialog = false): Promise<void> {
  const deny = () => new ForbiddenError('Эта команда доступна только в настроенном рабочем чате.');
  if (isDialog || chatId === undefined) throw deny();
  if ([services.config.DISTRIBUTION_CHAT_ID, services.config.REVIEW_CHAT_ID, services.config.DELIVERY_ALERT_CHAT_ID].includes(chatId)) return;
  const group = await services.prisma.responsibleGroup.findFirst({ where: { maxChatId: chatId, isActive: true }, select: { id: true } });
  if (!group) throw deny();
}
