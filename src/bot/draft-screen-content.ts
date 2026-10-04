import { randomUUID } from 'node:crypto';
import type { Button } from '../max/max-types';
import type { CompositeMessage } from '../max/max-message.service';
import { parseCallbackPayload } from '../max/callback-payload';
import type { SessionData } from '../sessions/operator-session.service';
import { RESIDENT_PHOTO_LIMIT } from '../incidents/resident-photo-limit';
import { incidentDraftPhotoRetryKeyboard } from './keyboards';

export function isDraftAction(action: string): boolean {
  return action.startsWith('draft-') || ['category', 'page', 'location-page', 'municipality', 'locality'].includes(action);
}

/** Store routing hints on the server, not long category/location IDs in MAX.
 * Token + index is below 64 UTF-8 bytes regardless of the original payload.
 * The map belongs to one persisted draft AND one screen; raw legacy buttons fail closed.
 */
export function bindDraftKeyboard(data: SessionData, keyboard: Button[][] = []): Button[][] {
  data.screenToken = randomUUID();
  delete data.draftScreenDelivery;
  data.screenActions = [];
  const counter = keyboard.flat().find(b => b.type === 'callback' && /^\d+ \/ \d+$/.test(b.text));
  data.screenPage = counter ? Number(counter.text.split(' / ')[0]) : undefined;
  data.inputStartedAt = Date.now();
  return keyboard.map(row => row.map(button => {
    if (button.type !== 'callback') return button;
    const parsed = parseCallbackPayload(button.payload);
    if (parsed?.kind !== 'user' || !isDraftAction(parsed.action)) return button;
    const index = data.screenActions!.push(button.payload) - 1;
    return { ...button, payload: `user:draft-action:${data.screenToken}~${index}` };
  }));
}

export function photoReplacement(reason: string): CompositeMessage {
  return { text: `${reason}\n\nТекст сообщения и остальные данные сохранены. Отправьте до ${RESIDENT_PHOTO_LIMIT} фотографий заново, при необходимости уменьшив их размер, или нажмите «Продолжить без фотографий».`,
    keyboard: incidentDraftPhotoRetryKeyboard() };
}
