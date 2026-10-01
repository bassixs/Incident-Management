import { deliveryTrace, latency } from '../../utils/latency';
import type { Context } from '@maxhub/max-bot-api';

import type { AppServices } from '../../app/container';
import type { Actor } from '../../distribution/distribution.service';
import type { MaxUser, Message } from '../../max/max-types';
import type { UserRole } from '../../users/roles';
import { workingChatFor, type WorkingChat } from '../../users/working-chat';
import { AppError } from '../../utils/errors';
import { moduleLogger } from '../../utils/logger';

const log = moduleLogger('bot');

export type ResolvedActor = Actor & { roles: UserRole[]; workingChat?: WorkingChat };

/** Upsert the MAX profile and resolve effective roles for this update. */
export async function resolveActor(services: AppServices, maxUser: MaxUser, workingChatId?: bigint): Promise<ResolvedActor> {
  const workingChat = workingChatId === undefined || maxUser.is_bot ? undefined : await workingChatFor(services, workingChatId);
  const { user, roles: storedRoles } = await services.users.identity(maxUser, !!workingChat);
  const roles = [...new Set([...storedRoles, ...(workingChat?.roles ?? [])])];
  return {
    userId: user.id,
    maxUserId: user.maxUserId,
    displayName: maxUser.name && maxUser.name !== 'Житель' ? maxUser.name.trim() : user.displayName,
    role: roles.join('|'),
    roles,
    ...(workingChat ? { workingChat } : {}),
  };
}

export function chatIdOf(message: Message | null | undefined): bigint | undefined {
  const chatId = message?.recipient?.chat_id;
  return chatId === null || chatId === undefined ? undefined : BigInt(chatId);
}

export function isDialog(message: Message | null | undefined): boolean {
  return message?.recipient?.chat_type === 'dialog';
}

/** A callback must always be answered, but that must never mask a real error. */
export async function answerCallback(
  services: AppServices,
  callbackId: string,
  notification?: string,
): Promise<void> {
  const started = Date.now();
  try {
    await services.max.answerCallback(callbackId, notification);
    latency('callback-ack', { ok: true, durationMs: Date.now() - started, ageMs: Date.now() - (deliveryTrace().receivedAt ?? started) });
  } catch (error) {
    latency('callback-ack', { ok: false, durationMs: Date.now() - started, ageMs: Date.now() - (deliveryTrace().receivedAt ?? started) });
    log.warn(
      { callbackId, err: error instanceof Error ? error.message : String(error) },
      'failed to answer callback',
    );
  }
}

/** MAX truncates callback notifications; keep them short and informative. */
export function shortNotice(text: string, limit = 180): string {
  const characters = Array.from(text.replace(/\n+/g, ' '));
  return characters.length <= limit ? characters.join('') : `${characters.slice(0, limit - 1).join('')}…`;
}

export function errorNotice(error: unknown): string {
  if (error instanceof AppError) return shortNotice(error.message);
  return 'Не удалось выполнить действие. Попробуйте ещё раз.';
}

export function userFacingError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return 'Произошла ошибка. Попробуйте ещё раз позже.';
}

/** Parse `/command arg1 arg2` out of a plain MAX message. */
export function parseCommand(text: string | null | undefined): { name: string; args: string[] } | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  if (!head) return null;
  // `/report@some_bot` in group chats.
  const name = head.slice(1).split('@')[0]!.toLowerCase();
  return { name, args: rest };
}

export function contextUser(ctx: Context): MaxUser | undefined {
  return ctx.user as MaxUser | undefined;
}
