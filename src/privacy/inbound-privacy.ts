import type { PrismaClient } from '@prisma/client';
import type { Update } from '../max/max-types';
import { containsPersonalData } from './personal-data';
import { parseManualPhone } from './optional-contact';
import { isResidentDraft, type SessionData } from '../sessions/operator-session.service';

/** Drop resident profile/forward metadata before the durable inbox sees an event. */
export async function minimiseInbound(update: Update, prisma: PrismaClient): Promise<Update> {
  const value = JSON.parse(JSON.stringify(update));
  delete value.privacyRejected;
  delete value.contactRejected;
  delete value.verifiedDraftContact;
  delete value.draftPhoneInput;
  delete value.residentDraftInput;
  delete value.privateWorkInputId;
  const message = value.message;
  const dialog = message?.recipient?.chat_type === 'dialog';
  const userId = value.callback?.user?.user_id ?? message?.sender?.user_id ?? value.user?.user_id;
  let staffDraft = false;
  if (dialog && message?.sender && !value.callback && Number.isSafeInteger(userId)) {
    const item = await prisma.privateWorkItem.findFirst({ where: { maxUserId: BigInt(userId), selected: true }, select: { id: true } });
    staffDraft = !!item;
    if (item) value.privateWorkInputId = item.id;
  }
  const session = dialog && !value.callback && Number.isSafeInteger(userId)
    ? await prisma.operatorSession.findUnique({ where: { maxUserId_chatId: {
      maxUserId: BigInt(userId), chatId: BigInt(message.recipient.chat_id ?? userId),
    } } }) : null;
  const data = session?.data as SessionData | null;
  // Selection is the dialog mode: entering personal work keeps the resident
  // draft for later, but it must not intercept newly admitted employee input.
  // Previously admitted draftPhoneInput events retain their binding in inbox
  // and are still handled before the employee route (message.handler.ts).
  const residentMessage = dialog && !value.callback && !staffDraft;
  if (residentMessage && (!session || isResidentDraft(session.type)) && !/^\/[a-z_]+(?:\s|$)/i.test(message?.body?.text ?? '')) {
    const sentAt = message?.timestamp ?? value.timestamp;
    const timely = session && session.expiresAt > new Date() && typeof sentAt === 'number' &&
      typeof data?.inputStartedAt === 'number' && sentAt >= data.inputStartedAt;
    value.residentDraftInput = { sessionId: timely ? session.id : '', draftToken: timely ? data?.draftToken : '', screenToken: timely ? data?.screenToken : '' };
  }
  const phoneStep = residentMessage && session?.type === 'WAITING_INCIDENT_EDIT_VALUE' &&
    data?.draftEditField === 'phone' && session.expiresAt > new Date();
  const contacts = message?.body?.attachments?.filter((a: any) => a.type === 'contact') ?? [];
  if (contacts.length) {
    // Legacy native contacts never enter a text/employee route or survive in inbox.
    message.body.text = null;
    message.body.attachments = [];
    delete message.link;
    value.contactRejected = true;
  } else if (phoneStep && message?.body && !/^\/(?:start|cancel)(?:\s|$)/i.test(message.body.text ?? '')) {
    const sentAt = message.timestamp ?? value.timestamp;
    const timely = typeof sentAt === 'number' &&
      typeof data.phoneInputStartedAt === 'number' && sentAt >= data.phoneInputStartedAt;
    const phone = timely && !message.link && !message.body.attachments?.length
      ? parseManualPhone(message.body.text ?? '') : null;
    // Bind even invalid input; it must never fall through into another draft or a staff reply.
    value.draftPhoneInput = { sessionId: session.id, draftToken: data.draftToken, previewToken: data.previewToken, screenToken: data.screenToken,
      ...(phone ? { phone } : {}) };
    message.body.text = null;
    message.body.attachments = [];
    delete message.link;
  } else if (residentMessage && message?.body && parseManualPhone(message.body.text ?? '')) {
    // A delayed number outside the explicit input step must not become a new
    // problem description. Do not retain the number or infer a new binding.
    value.draftPhoneInput = { sessionId: '', draftToken: '', previewToken: '' };
    message.body.text = null;
    message.body.attachments = [];
    delete message.link;
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
