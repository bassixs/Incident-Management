import { isDeepStrictEqual } from 'node:util';
import type { Button, Message } from './max-types';

/** Compare against MAX, not a cache: deleted or externally edited cards must be repaired. */
export function hasSameCardContent(current: Message, text: string, buttons: Button[][]): boolean {
  if (current.body?.text !== text) return false;
  const keyboards = (current.body.attachments ?? []).filter(item => item.type === 'inline_keyboard');
  if (keyboards.length > 1) return false;
  return isDeepStrictEqual(keyboards[0]?.payload.buttons ?? [], buttons);
}
