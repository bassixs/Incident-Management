import { randomUUID } from 'node:crypto';
import type { SessionType } from '@prisma/client';
import type { AppServices } from '../app/container';
import type { Button } from '../max/max-types';
import type { CompositeMessage } from '../max/max-message.service';
import { parseCallbackPayload, type CallbackPayload } from '../max/callback-payload';
import { isResidentDraft, type SessionData } from '../sessions/operator-session.service';
import { ValidationError } from '../utils/errors';
import { deliverSavedScreen, prepareScreenDelivery, screenFacts, screenRef, OLD_SCREEN_NOTICE } from './draft-screen-delivery';
import { moduleLogger } from '../utils/logger';
import { deliveryTrace } from '../utils/latency';

export const STALE_DRAFT = OLD_SCREEN_NOTICE;
export const MISSING_DRAFT = 'Сохранённого черновика нет или истекли 24 часа с последнего действия. Нажмите «Создать сообщение», чтобы оформить новое.';
export const DRAFT_BUSY = 'Предыдущее действие ещё выполняется. Дождитесь следующего экрана бота.';
export class DraftActionError extends ValidationError {}
const log = moduleLogger('draft-screen');
const refusalTimes = new Map<string, number>();
export function draftRefusal(reason: string, data: SessionData, clickedScreen?: string): void {
  const key = `${screenRef(data.draftToken)}:${screenRef(clickedScreen)}:${reason}`;
  const previous = refusalTimes.get(key) ?? 0;
  if (Date.now() - previous < 10_000) return;
  if (refusalTimes.size >= 1000) refusalTimes.clear();
  refusalTimes.set(key, Date.now());
  log.info({ ...deliveryTrace(), ...screenFacts(data), clickedScreen: screenRef(clickedScreen), reason }, 'draft action refused');
}
export type ResidentInputBinding = { sessionId: string; draftToken: string; screenToken: string };

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

export async function withResidentDraftLock<T>(services: AppServices, userId: bigint, chatId: bigint, operation: () => Promise<T>): Promise<T> {
  const key = `resident-draft:${userId}:${chatId}`;
  if (!await services.actionGuard.acquire({ key, action: 'resident-draft', maxUserId: userId, ttlMs: 120_000 })) {
    const current = await services.sessions.find(userId, chatId);
    draftRefusal('RESIDENT_ACTION_BUSY', current ? services.sessions.readData(current) : {});
    throw new DraftActionError(DRAFT_BUSY);
  }
  try { return await operation(); } finally { await services.actionGuard.release(key); }
}

export async function consumeDraftButton(services: AppServices, userId: bigint, chatId: bigint, payload: Extract<CallbackPayload, { kind: 'user' }>) {
  if (payload.action !== 'draft-action') { draftRefusal('UNBOUND_LEGACY_ACTION', {}); throw new DraftActionError(STALE_DRAFT); }
  const [token, index, extra] = (payload.argument ?? '').split('~');
  const session = await services.prisma.operatorSession.findUnique({ where: { maxUserId_chatId: { maxUserId: userId, chatId } } });
  const data = session && services.sessions.readData(session);
  const reason = !session ? 'NO_SESSION' : session.expiresAt <= new Date() ? 'EXPIRED' : !isResidentDraft(session.type) ? 'WRONG_SESSION_TYPE'
    : !data?.draftToken ? 'NO_DRAFT_TOKEN' : token !== data.screenToken ? 'SCREEN_MISMATCH'
      : extra !== undefined || !/^\d{1,3}$/.test(index ?? '') ? 'INVALID_INDEX' : undefined;
  if (reason) { if (reason === 'EXPIRED') await services.sessions.find(userId, chatId); draftRefusal(reason, data ?? {}, token); throw new DraftActionError(['NO_SESSION', 'EXPIRED'].includes(reason) ? MISSING_DRAFT : STALE_DRAFT); }
  if (!session || !data) throw new DraftActionError(MISSING_DRAFT);
  const parsed = parseCallbackPayload(data.screenActions?.[Number(index)]);
  if (parsed?.kind !== 'user' || !isDraftAction(parsed.action) || parsed.action === 'draft-action') { draftRefusal('ACTION_MISSING', data, token); throw new DraftActionError(STALE_DRAFT); }
  if (data.previewDeliveryPending && parsed.action === 'draft-confirm') {
    draftRefusal('DELIVERY_UNCONFIRMED', data, token);
    throw new DraftActionError('Карточка ещё восстанавливается. Дождитесь её доставки и снова нажмите «Всё верно». Сообщение пока не отправлено.');
  }
  // Consume before side effects. A distinct callback id for the same button is still a duplicate.
  const consumed = { ...data, screenActions: [], draftTouchedAt: Date.now() };
  delete consumed.draftScreenDelivery;
  if (!await services.sessions.replaceCurrent(session, session.type, consumed)) { draftRefusal('SESSION_CAS_CONFLICT', data, token); throw new DraftActionError(DRAFT_BUSY); }
  return parsed;
}

/** A stage transition cannot upsert a cancelled/expired session back into existence. */
export async function saveDraftStep(services: AppServices, input: {
  maxUserId: bigint; chatId: bigint; type: SessionType; data: SessionData;
}): Promise<void> {
  const current = await services.sessions.find(input.maxUserId, input.chatId);
  if (!current || !isResidentDraft(current.type) || services.sessions.readData(current).draftToken !== input.data.draftToken) throw new ValidationError(STALE_DRAFT);
  if (!await services.sessions.replaceCurrent(current, input.type, { ...input.data, draftTouchedAt: Date.now() })) throw new ValidationError(STALE_DRAFT);
}

/** For pickers and text-entry prompts. Draft replies are immediate, never static outbox jobs. */
export async function sendDraftScreen(services: AppServices, userId: bigint, chatId: bigint, message: CompositeMessage, acceptedAction = true): Promise<void> {
  const current = await services.sessions.find(userId, chatId);
  if (!current || !isResidentDraft(current.type)) throw new ValidationError(STALE_DRAFT);
  const data = { ...services.sessions.readData(current) };
  data.draftToken ??= randomUUID();
  if (acceptedAction) data.draftTouchedAt = Date.now();
  const keyboard = bindDraftKeyboard(data, message.keyboard);
  prepareScreenDelivery(data, { ...message, keyboard }, false, current.type);
  if (!await services.sessions.replaceCurrent(current, current.type, data)) throw new ValidationError(STALE_DRAFT);
  await deliverSavedScreen(services, { ...current, data: data as never });
}
