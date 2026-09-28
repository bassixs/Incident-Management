import type { Message } from '../max/max-types';

/** Links in resident text, not the download URLs of attached photographs. */
export function containsLink(text: string | null | undefined): boolean {
  const value = (text ?? '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '');
  return /(?:https?|ftp|tg|max):\/\/|mailto:|\bwww\.|(?:^|[^\p{L}\p{N}_@])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+|рф|рус|москва|онлайн|сайт)(?=$|[^\p{L}\p{N}_-])/iu.test(value);
}

export function messageContainsLink(message: Message): boolean {
  return containsLink(message.body.text)
    // SDK 0.2.x only types mentions; accept newer link markup on the wire too.
    || !!message.body.markup?.some(item => (item as { type: string }).type === 'link')
    || !!message.body.attachments?.some(item => item.type === 'share')
    || !!(message.link?.type === 'forward' && messageContainsLink({ body: message.link.message } as Message));
}
