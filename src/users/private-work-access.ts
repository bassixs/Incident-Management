import type { AppServices } from '../app/container';

/** A stored role or an old work item is not proof of current MAX membership. */
export async function hasPrivateWorkAccess(services: AppServices, maxUserId: bigint): Promise<boolean> {
  const groups = await services.prisma.responsibleGroup.findMany({
    where: { isActive: true, maxChatId: { not: null } }, select: { maxChatId: true },
  });
  const configured = new Set([
    services.config.DISTRIBUTION_CHAT_ID, services.config.REVIEW_CHAT_ID,
    services.config.DELIVERY_ALERT_CHAT_ID, ...groups.map(group => group.maxChatId),
  ].filter((id): id is bigint => id != null));
  // Try previous work chats first, but recheck them against both configuration and MAX.
  const previous = await services.prisma.privateWorkItem.findMany({
    where: { maxUserId }, select: { originChatId: true }, distinct: ['originChatId'],
  });
  const chats = [...new Set([...previous.map(item => item.originChatId).filter(id => configured.has(id)), ...configured])];
  for (let offset = 0; offset < chats.length; offset += 4) {
    const results = await Promise.all(chats.slice(offset, offset + 4).map(async chatId => {
      try {
        const result = await services.max.api.getChatMembers(Number(chatId), { user_ids: [Number(maxUserId)] });
        return result.members.some(member => BigInt(member.user_id) === maxUserId && !member.is_bot);
      } catch { return false; } // Never grant access from a failed or cached check.
    }));
    if (results.some(Boolean)) return true;
  }
  return false;
}
