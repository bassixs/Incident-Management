import type { PrismaClient } from '@prisma/client';
import type { Update } from '../max/max-types';
import { containsPersonalData } from './personal-data';

/** Drop resident profile/forward metadata before the durable inbox sees an event. */
export async function minimiseInbound(update: Update, prisma: PrismaClient): Promise<Update> {
  const value = JSON.parse(JSON.stringify(update));
  delete value.privacyRejected;
  const message = value.message;
  const dialog = message?.recipient?.chat_type === 'dialog';
  const userId = value.callback?.user?.user_id ?? message?.sender?.user_id ?? value.user?.user_id;
  let staffDraft = false;
  if (dialog && message?.sender && !value.callback && Number.isSafeInteger(userId)) {
    const item = await prisma.privateWorkItem.findFirst({ where: { maxUserId: BigInt(userId), selected: true }, select: { id: true } });
    staffDraft = !!item;
  }
  const residentMessage = dialog && !value.callback && !staffDraft;
  if (residentMessage && message?.body) {
    const rejected = containsPersonalData(message.body.text ?? '') || !!message.link ||
      message.body.attachments?.some((a: any) => a.type === 'contact');
    if (rejected) {
      value.privacyRejected = true;
      message.body.text = null;
      message.body.attachments = [];
    }
    delete message.link;
    delete message.body.markup;
    // Retain only opaque photo references; filenames and remote profile URLs are unnecessary.
    for (const attachment of message.body.attachments ?? []) {
      if (attachment.type === 'image') {
        attachment.payload = { token: attachment.payload?.token };
      } else if (attachment.type !== 'inline_keyboard') {
        attachment.payload = {};
      }
    }
  }
  if (value.callback && message?.body) {
    message.body.text = null;
    message.body.attachments = [];
    delete message.link;
  }
  // Work-chat names remain available for employee attribution; private resident profiles do not.
  if ((dialog && !staffDraft) || value.update_type === 'bot_started') {
    for (const user of [message?.sender, value.callback?.user, value.user]) {
      if (!user) continue;
      for (const key of Object.keys(user)) if (!['user_id', 'is_bot', 'last_activity_time'].includes(key)) delete user[key];
      user.name = 'Житель';
    }
  }
  return value as Update;
}
