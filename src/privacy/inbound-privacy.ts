import type { PrismaClient } from '@prisma/client';
import type { Update } from '../max/max-types';
import { containsPersonalData } from './personal-data';
import { getConfig } from '../config';
import { verifyOwnContact } from './optional-contact';
import type { SessionData } from '../sessions/operator-session.service';

/** Drop resident profile/forward metadata before the durable inbox sees an event. */
export async function minimiseInbound(update: Update, prisma: PrismaClient): Promise<Update> {
  const value = JSON.parse(JSON.stringify(update));
  delete value.privacyRejected;
  delete value.contactRejected;
  delete value.verifiedDraftContact;
  const message = value.message;
  const dialog = message?.recipient?.chat_type === 'dialog';
  const userId = value.callback?.user?.user_id ?? message?.sender?.user_id ?? value.user?.user_id;
  let staffDraft = false;
  if (dialog && message?.sender && !value.callback && Number.isSafeInteger(userId)) {
    const item = await prisma.privateWorkItem.findFirst({ where: { maxUserId: BigInt(userId), selected: true }, select: { id: true } });
    staffDraft = !!item;
  }
  const residentMessage = dialog && !value.callback && !staffDraft;
  const contacts = message?.body?.attachments?.filter((a: any) => a.type === 'contact') ?? [];
  if (contacts.length) {
    let accepted = false;
    if (residentMessage && contacts.length === 1 && message.body.attachments.length === 1 && !message.link) {
      const phone = verifyOwnContact(contacts[0].payload, userId, getConfig().BOT_TOKEN);
      if (phone) {
        const session = await prisma.operatorSession.findUnique({ where: { maxUserId_chatId: {
          maxUserId: BigInt(userId), chatId: BigInt(message.recipient.chat_id ?? userId),
        } } });
        const data = session?.data as SessionData | null;
        const sentAt = message.timestamp ?? value.timestamp;
        if (session?.type === 'WAITING_INCIDENT_CONFIRMATION' && session.expiresAt > new Date() &&
            data?.draftToken && data.previewToken && !data.requesterPhone &&
            typeof sentAt === 'number' && sentAt >= Number(data.previewStartedAt)) {
          value.verifiedDraftContact = { phone, draftToken: data.draftToken, previewToken: data.previewToken };
          accepted = true;
        }
      }
    }
    // Even staff/unexpected contacts never enter the durable inbox as raw VCF.
    message.body.text = null;
    message.body.attachments = [];
    delete message.link;
    // Contact captions/names are not incident text, including rejected contacts.
    // Keep a separate marker so invalid stage/signature is not reported as PII.
    if (!accepted) value.contactRejected = true;
  }
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
    if (message) { delete message.constructor; delete message.url; delete message.stat; }
    for (const user of [message?.sender, value.callback?.user, value.user]) {
      if (!user) continue;
      for (const key of Object.keys(user)) if (!['user_id', 'is_bot', 'last_activity_time'].includes(key)) delete user[key];
      user.name = 'Житель';
    }
  }
  return value as Update;
}
