import { MaxError } from '@maxhub/max-bot-api';
import type { PrismaClient } from '@prisma/client';
import type { Button, Message } from './max-types';
import type { MaxClient } from './max-client';
import { hasSameCardContent } from './card-content';
import { moduleLogger } from '../utils/logger';

const log = moduleLogger('pinned-panel');
export const STALE_PANEL_TEXT = 'Панель устарела. Используйте закреплённую панель';
export const panelRecoveryKey = (key: string) => `panel-recovery:${key}`;
type Recovery = { intentAt?: number; missingId?: string; missingAt?: number; retire?: string[] };
type Context = { chatId: string; jobId: string; panelId?: string };
const missing = (error: unknown) => error instanceof MaxError && error.status === 404;

/** Strict recognition: never use an incident card or another author's message. */
export function isOwnQueuePanel(message: Message, chatId: bigint, botId: number, distribution: boolean): boolean {
  if (message.sender?.user_id !== botId || !message.sender.is_bot || String(message.recipient.chat_id) !== String(chatId)) return false;
  const text = message.body?.text ?? '';
  const header = distribution ? '📋 ОЧЕРЕДЬ РАСПРЕДЕЛЕНИЯ' : '📋 ОЧЕРЕДЬ (ПРОФИЛЬНОГО ЧАТА|СОГЛАСОВАНИЯ)';
  if (!new RegExp(`^${header}\\n\\nОжидают ${distribution ? 'распределения' : 'обработки'}: \\d+\\nСвободны: -?\\d+ · `).test(text) || !text.includes('Панель обновляется каждую минуту.')) return false;
  const allowed = new Set(distribution ? ['personal:home', 'queue:next', 'queue:list:0', 'queue:refresh', 'work:today:0']
    : ['personal:home', 'work:next', 'work:list:0', 'work:mine:0', 'work:today:0', 'work:refresh']);
  return (message.body.attachments ?? []).every(a => a.type === 'inline_keyboard' &&
    a.payload.buttons.flat().every(b => b.type === 'callback' && allowed.has(b.payload)));
}

/** One durable outbox job per chat serializes calls. A send intent precedes the
 * non-idempotent POST; unacknowledged sends are reconciled, not sent again. */
export class PinnedPanelService {
  private botId?: number;
  constructor(private readonly db: PrismaClient, private readonly max: MaxClient) {}

  private async operation<T>(ctx: Context, operation: string, call: () => Promise<T>): Promise<T> {
    try { return await call(); }
    catch (error) {
      log.warn({ ...ctx, operation, status: error instanceof MaxError ? error.status : null }, 'queue panel operation failed');
      throw error;
    }
  }

  async refresh(chatId: bigint, key: string, text: string, buttons: Button[][], jobId: string): Promise<{ firstMessageId: string }> {
    const ctx: Context = { chatId: String(chatId), jobId };
    const distribution = key.startsWith('distribution-panel:');
    const setting = await this.db.systemSetting.findUnique({ where: { key } });
    const recoveryKey = panelRecoveryKey(key);
    let state: Recovery = JSON.parse((await this.db.systemSetting.findUnique({ where: { key: recoveryKey } }))?.value ?? '{}');
    const save = async () => this.db.systemSetting.upsert({ where: { key: recoveryKey }, create: { key: recoveryKey, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
    this.botId ??= (await this.operation(ctx, 'identity', () => this.max.getMe())).user_id;
    const own = (m: Message) => isOwnQueuePanel(m, chatId, this.botId!, distribution);
    let id = setting?.value;
    let current: Message | undefined;
    ctx.panelId = id;
    const pinned = async () => {
      try { return (await this.operation(ctx, 'read-pin', () => this.max.getPinnedMessage(chatId))).message ?? undefined; }
      catch (error) { if (missing(error)) return undefined; throw error; }
    };
    if (id) {
      try { current = await this.operation(ctx, 'read', () => this.max.getMessage(id!)); }
      catch (error) { if (!missing(error)) throw error; }
      if (current && !own(current)) throw new Error('Stored queue panel identity does not match; manual inspection required');
      if (current && state.missingId) { delete state.missingId; delete state.missingAt; await save(); }
    }

    if (!current || state.intentAt !== undefined) {
      const pin = await pinned();
      // A 404 can mean lost access, not deletion. Consult the pin and history.
      const candidates = await this.findPanels(chatId, own, state.intentAt, ctx);
      if (pin && own(pin) && !candidates.some(m => m.body.mid === pin.body.mid)) candidates.unshift(pin);
      current = candidates.find(m => m.body.mid === id) ?? (pin && own(pin) ? pin : candidates[0]);
      if (current) {
        state.retire = [...new Set([...(state.retire ?? []), ...(id && id !== current.body.mid ? [id] : []),
          ...candidates.filter(m => m.body.mid !== current!.body.mid).map(m => m.body.mid)])];
        id = current.body.mid;
        log.info({ ...ctx, panelId: id, operation: 'reconcile' }, 'queue panel recovered');
      } else {
        if (state.intentAt !== undefined) {
          // MAX may have accepted the POST but not exposed the message yet.
          // Never gamble on a second send. Keep the intent for the next sweep.
          throw new Error('Queue panel send outcome is unknown; waiting for history reconciliation');
        }
        if (id && (state.missingId !== id || state.missingAt === undefined || Date.now() - state.missingAt < 5_000)) {
          if (state.missingId !== id) { state.missingId = id; state.missingAt = Date.now(); await save(); }
          throw new Error('Queue panel absence requires confirmation on a later sweep');
        }
        if (id) state.retire = [...new Set([...(state.retire ?? []), id])];
        state.intentAt = Date.now();
        await save();
        log.info({ ...ctx, operation: 'create-intent', knownIdAbsent: !setting?.value }, 'queue panel send intent saved');
        // The provisional copy has NO active buttons until its ID is durable.
        const sent = await this.operation(ctx, 'create-once', () => this.max.sendPanelOnce(chatId, text));
        id = sent.body.mid;
        if (!id) throw new Error('MAX returned no queue panel ID; reconciliation required');
        log.info({ ...ctx, panelId: id, operation: 'created' }, 'queue panel created without controls');
      }
      // Commit identity BEFORE editing/pinning and before outbox.complete().
      // If this transaction fails, the durable intent recovers via history.
      ctx.panelId = id;
      state = { retire: state.retire };
      await this.db.$transaction(async tx => {
        await tx.systemSetting.upsert({ where: { key }, create: { key, value: id! }, update: { value: id! } });
        await tx.outboundMessage.update({ where: { id: jobId }, data: { firstMessageId: id } });
        await tx.systemSetting.upsert({ where: { key: recoveryKey }, create: { key: recoveryKey, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
      });
      log.info({ ...ctx, operation: 'save-id' }, 'queue panel identity committed');
    }
    if (!id) throw new Error('Queue panel ID is missing');
    // Editing failures, including 404, never trigger creation in this call.
    if (!current || !hasSameCardContent(current, text, buttons)) {
      await this.operation(ctx, 'edit', () => this.max.editMessage(id!, text, [{ type: 'inline_keyboard', payload: { buttons } }]));
    }
    const pin = await pinned();
    if (pin?.body.mid !== id) {
      const result = await this.operation(ctx, 'pin', () => this.max.pinMessage(chatId, id!));
      if (!result.success) throw new Error('Queue panel pin was not confirmed');
    }
    for (const oldId of [...(state.retire ?? [])]) {
      if (oldId === id) continue;
      let old: Message;
      try { old = await this.operation({ ...ctx, panelId: oldId }, 'read-stale', () => this.max.getMessage(oldId)); }
      catch (error) { if (missing(error)) continue; throw error; }
      if (own(old)) await this.operation({ ...ctx, panelId: oldId }, 'retire', () => this.max.editMessage(oldId, STALE_PANEL_TEXT, []));
      else if (old.body?.text !== STALE_PANEL_TEXT) throw new Error('Stale queue panel identity does not match; manual inspection required');
      state.retire = state.retire?.filter(value => value !== oldId);
      await save();
    }
    return { firstMessageId: id };
  }

  private async findPanels(chatId: bigint, own: (message: Message) => boolean, since: number | undefined, ctx: Context): Promise<Message[]> {
    let before = Date.now() + 1_000;
    const found = new Map<string, Message>();
    // Bounded scan, never infer absence from an incomplete history window.
    for (let page = 0; page < 10; page++) {
      const result = await this.operation(ctx, 'history', () => this.max.getChatMessages(chatId, before));
      for (const message of result.messages) if (own(message)) found.set(message.body.mid, message);
      const oldest = Math.min(...result.messages.map(m => m.timestamp));
      if (result.messages.length < 100 || (since !== undefined && oldest < since)) {
        return [...found.values()].sort((a, b) => b.timestamp - a.timestamp);
      }
      if (oldest >= before) throw new Error('Queue panel history scan made no progress; manual inspection required');
      // Keep the boundary timestamp inclusive: do not skip equal timestamps.
      before = oldest;
    }
    throw new Error('Queue panel history scan limit reached; manual inspection required');
  }
}
