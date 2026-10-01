import { randomUUID } from 'node:crypto';
import type { SessionType } from '@prisma/client';
import type { AppServices } from '../app/container';
import type { Button } from '../max/max-types';
import type { CompositeMessage } from '../max/max-message.service';
import { parseCallbackPayload, type CallbackPayload } from '../max/callback-payload';
import { isResidentDraft, type SessionData } from '../sessions/operator-session.service';
import { ConflictError, ValidationError } from '../utils/errors';

export const STALE_DRAFT = 'Это действие устарело или срок хранения черновика истёк. Нажмите «Создать сообщение»: сохранённый черновик можно продолжить в течение 24 часов после последнего действия.';
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
  data.screenActions = [];
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
    throw new ConflictError('Предыдущее действие ещё выполняется. Подождите ответа бота.');
  }
  try { return await operation(); } finally { await services.actionGuard.release(key); }
}

export async function consumeDraftButton(services: AppServices, userId: bigint, chatId: bigint, payload: Extract<CallbackPayload, { kind: 'user' }>) {
  if (payload.action !== 'draft-action') throw new ValidationError(STALE_DRAFT);
  const [token, index, extra] = (payload.argument ?? '').split('~');
  const session = await services.sessions.find(userId, chatId);
  const data = session && services.sessions.readData(session);
  if (!session || !isResidentDraft(session.type) || !data?.draftToken || token !== data.screenToken || extra !== undefined || !/^\d{1,3}$/.test(index ?? '')) throw new ValidationError(STALE_DRAFT);
  const parsed = parseCallbackPayload(data.screenActions?.[Number(index)]);
  if (parsed?.kind !== 'user' || !isDraftAction(parsed.action) || parsed.action === 'draft-action') throw new ValidationError(STALE_DRAFT);
  // Consume before side effects. A distinct callback id for the same button is still a duplicate.
  if (!await services.sessions.replaceCurrent(session, session.type, { ...data, screenActions: [], draftTouchedAt: Date.now() })) throw new ValidationError(STALE_DRAFT);
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
  if (!await services.sessions.replaceCurrent(current, current.type, data)) throw new ValidationError(STALE_DRAFT);
  await services.messages.send({ userId }, { ...message, keyboard, immediatePreview: true });
}
