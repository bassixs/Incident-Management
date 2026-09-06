import type { AppServices } from '../app/container';
import { UserRole, type Permission } from './roles';

export type WorkingChat = {
  chatId: bigint;
  distribution: boolean;
  review: boolean;
  delivery: boolean;
  groups: Array<{ name: string; bypassReview: boolean }>;
  roles: UserRole[];
  permissions: Permission[];
  labels: string[];
};

/** MAX's authenticated update proves participation in this chat. Grants are
 * derived from current configuration on every action, never copied into global
 * User.roles. Existing members work immediately; moving/disabling a chat leaves
 * no stale privilege behind. A private dialog never supplies this context. */
export async function workingChatFor(services: AppServices, chatId: bigint): Promise<WorkingChat | undefined> {
  const distribution = services.config.DISTRIBUTION_CHAT_ID === chatId;
  const review = services.config.REVIEW_CHAT_ID === chatId;
  const delivery = services.config.DELIVERY_ALERT_CHAT_ID === chatId;
  const groups = await services.prisma.responsibleGroup.findMany({
    where: { maxChatId: chatId, isActive: true },
    select: { name: true, bypassReview: true }, orderBy: { name: 'asc' },
  });
  if (!distribution && !review && !delivery && !groups.length) return undefined;
  const roles = new Set<UserRole>(); const labels: string[] = [];
  if (distribution) { roles.add(UserRole.DISPATCHER); labels.push('распределитель'); }
  if (review) { roles.add(UserRole.APPROVER); labels.push('согласующий'); }
  if (groups.length) { roles.add(UserRole.RESPONDER); labels.push('исполнитель'); }
  // The regional group sends answers directly; its existing guard requires a dispatcher.
  if (groups.some(group => group.bypassReview)) roles.add(UserRole.DISPATCHER);
  if (delivery) labels.push('контроль доставки');
  return { chatId, distribution, review, delivery, groups, roles: [...roles], labels,
    permissions: delivery ? ['delivery.manage', 'incident.lookup'] : [] };
}
