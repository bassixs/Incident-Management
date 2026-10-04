import { randomUUID } from 'node:crypto';
import { latency } from '../utils/latency';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { Bot, MaxError } from '@maxhub/max-bot-api';
import type {
  AttachmentRequest,
  Message,
  SendMessageExtra,
  Update,
  UpdateType,
} from './max-types';

import { getConfig } from '../config';
import { assertMediaSize } from '../media/media-limits';
import { ValidationError } from '../utils/errors';
import { ApiRateGate } from './api-rate-gate';
import { hasSameCardContent } from './card-content';
import { moduleLogger } from '../utils/logger';
import { retry } from '../utils/retry';

const log = moduleLogger('max-client');

/**
 * MAX ids are int64 in the protocol but always well inside the double-safe
 * range in practice. We keep them as BigInt in the database and convert only
 * at the API boundary, failing loudly instead of silently rounding.
 */
export function toApiId(value: bigint | number): number {
  const asNumber = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`MAX id ${value.toString()} exceeds the safe integer range`);
  }
  return asNumber;
}

export type WebhookSubscription = {
  url: string;
  time?: number;
  update_types?: string[] | null;
  version?: string | null;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const SHARE_LINK_PREFIX = '\n\nСсылка из предпросмотра: ';

function isPublicLink(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/\s/.test(value);
  } catch { return false; }
}

function reviewContentWithoutReservation(text: string): string | undefined {
  // Only the generated review-card prefix is presentation-only. Keep the entire
  // remaining card, including incident identity, answer, history and version.
  // Never strip lease-like lines in resident/answer text or arbitrary headers.
  return /^📝 ОТВЕТ НА СОГЛАСОВАНИЕ\n(?:🟢 Свободно — можно взять в работу|👤 Закреплено за: [^\n]+\n⏳ До \d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(МСК\))\n\n(№ INC-[\d-]+\n\n[\s\S]*\n\nВерсия ответа:\n[1-9]\d*)$/u.exec(text)?.[1];
}

function preserveShareFallbackText(current: string | undefined | null, intended: string): string {
  if (!current) return intended;
  let body = current;
  const links: string[] = [];
  // Read only a trailing URL-only suffix; an embedded marker is content.
  for (;;) {
    const index = body.lastIndexOf(SHARE_LINK_PREFIX);
    if (index < 0) break;
    const link = body.slice(index + SHARE_LINK_PREFIX.length);
    if (!isPublicLink(link)) break;
    links.unshift(link);
    body = body.slice(0, index);
  }
  if (!links.length) return intended;
  const content = reviewContentWithoutReservation(body);
  if (body !== intended && (content === undefined || content !== reviewContentWithoutReservation(intended))) return intended;
  const preserved = intended + [...new Set(links)].filter(link => !intended.includes(link))
    .map(link => `${SHARE_LINK_PREFIX}${link}`).join('');
  // A larger service header must not silently evict a previously retained URL.
  if (Array.from(preserved).length > 4000) throw new ValidationError('Не удалось сохранить ссылки карточки: превышен лимит текста MAX.');
  return preserved;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ValidationError) return false;
  if (error instanceof MaxError) return RETRYABLE_STATUS.has(error.status);
  // Network-level failures (fetch TypeError, aborted sockets) are retryable.
  return error instanceof Error;
}

/**
 * Thin, retrying wrapper around the official MAX Bot API client.
 *
 * Everything the library exposes is delegated to it. The three subscription
 * endpoints it does not implement are called through a small REST adapter
 * against the documented official API - no invented methods.
 */
export class MaxClient {
  private readonly rateGate = new ApiRateGate();
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(readonly bot: Bot) {
    const config = getConfig();
    this.baseUrl = config.MAX_API_BASE_URL.replace(/\/+$/, '');
    this.token = config.BOT_TOKEN;
  }

  get api() {
    return this.bot.api;
  }

  private async measured<T>(name: string, operation: () => Promise<T>, target?: string, attempt = 1): Promise<T> {
    const requestId = randomUUID();
    const queuedAt = Date.now();
    if (target) await this.rateGate.wait(target, 550, () => this.rateGate.wait('global', 45));
    else await this.rateGate.wait('global', 45);
    const started = Date.now();
    try {
      const result = await operation();
      latency('max-request', { method: name, requestId, attempt, rateWaitMs: started - queuedAt, requestMs: Date.now() - started, ok: true });
      return result;
    } catch (error) {
      latency('max-request', { method: name, requestId, attempt, rateWaitMs: started - queuedAt, requestMs: Date.now() - started,
        ok: false, ...(error instanceof MaxError ? { status: error.status } : {}) });
      throw error;
    }
  }

  private call<T>(name: string, operation: () => Promise<T>, target?: string): Promise<T> {
    let attempt = 0;
    return retry(() => this.measured(name, operation, target, ++attempt), {
      attempts: 4,
      shouldRetry: isRetryable,
      onRetry: (error, attempt, waitMs) =>
        log.warn({ method: name, attempt, waitMs, status: error instanceof MaxError ? error.status : undefined }, 'MAX API call failed, retrying'),
    });
  }

  async getMe() {
    return this.call('getMyInfo', () => this.api.getMyInfo());
  }

  async getMessage(messageId: string) {
    return this.call('getMessage', () => this.api.getMessage(messageId));
  }

  async getChatMessages(chatId: bigint, before?: number) {
    return this.call('getMessages', () => this.api.getMessages(toApiId(chatId), { count: 100, ...(before === undefined ? {} : { from: before }) }));
  }

  /** Panel creation is reconciled by PinnedPanelService, never blindly retried. */
  async sendPanelOnce(chatId: bigint, text: string): Promise<Message> {
    return this.measured('sendPanelOnce', () => this.api.sendMessageToChat(toApiId(chatId), text, { notify: false }), `chat:${chatId}`);
  }

  async getPinnedMessage(chatId: bigint | number) {
    return this.call('getPinnedMessage', () => this.api.getPinnedMessage(toApiId(chatId)));
  }

  async pinMessage(chatId: bigint | number, messageId: string) {
    return this.call('pinMessage', () => this.api.pinMessage(toApiId(chatId), messageId, { notify: false }), `chat:${chatId}`);
  }

  async sendToChat(chatId: bigint | number, text: string, extra?: SendMessageExtra, beforeAttempt?: () => Promise<void>): Promise<Message> {
    return this.call('sendMessageToChat', async () => { await beforeAttempt?.(); return this.api.sendMessageToChat(toApiId(chatId), text, extra); }, `chat:${chatId}`);
  }

  async sendToUser(userId: bigint | number, text: string, extra?: SendMessageExtra, beforeAttempt?: () => Promise<void>): Promise<Message> {
    return this.call('sendMessageToUser', async () => { await beforeAttempt?.(); return this.api.sendMessageToUser(toApiId(userId), text, extra); }, `user:${userId}`);
  }

  /**
   * Edit a message in place.
   *
   * The `attachments` field is three-valued on purpose, verified against the
   * live API:
   *   undefined — field omitted, existing photos and keyboard are preserved;
   *   []        — attachment list cleared (media and buttons both go);
   *   [...]     — list replaced wholesale.
   */
  async editMessage(
    messageId: string,
    text: string,
    attachments?: AttachmentRequest[] | undefined,
  ): Promise<void> {
    const result = await this.call('editMessage', () =>
      this.api.editMessage(messageId, {
        text,
        ...(attachments === undefined ? {} : { attachments }),
      }),
    );
    if (!result.success) throw new ValidationError('MAX не подтвердил обновление карточки.');
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.call('deleteMessage', () => this.api.deleteMessage(messageId));
  }

  /** Replace only a card's controls while retaining its existing MAX media tokens. */
  async editCardWithKeyboard(messageId: string, text: string, buttons: import('./max-types').Button[][]): Promise<void> {
    const current = await this.call('getMessage', () => this.api.getMessage(messageId));
    // Retain fallback links on replay and reservation changes of the same review
    // content/version, even when MAX no longer returns a share attachment.
    text = preserveShareFallbackText(current.body.text, text);
    if (hasSameCardContent(current, text, buttons)) return;
    const attachments: AttachmentRequest[] = [];
    for (const item of current.body.attachments ?? []) {
      if (item.type === 'inline_keyboard') continue;
      if (item.type === 'share' && (item.payload?.token || item.payload?.url)) {
        attachments.push({ type: 'share', payload: {
          ...(item.payload.token ? { token: item.payload.token } : {}),
          ...(item.payload.url ? { url: item.payload.url } : {}),
        } });
      } else if (['image', 'file', 'video', 'audio'].includes(item.type) && 'payload' in item && item.payload && 'token' in item.payload && item.payload.token) {
        attachments.push({ type: item.type as 'image' | 'file' | 'video' | 'audio', payload: { token: item.payload.token } });
      } else {
        // Never silently drop an unrecognised attachment while replacing buttons.
        throw new ValidationError('Не удалось сохранить вложения карточки при обновлении кнопок.');
      }
    }
    if (buttons.length) attachments.push({ type: 'inline_keyboard', payload: { buttons } });
    try {
      await this.editMessage(messageId, text, attachments);
    } catch (error) {
      const shares = attachments.filter(item => item.type === 'share');
      // This exact permanent rejection has been observed for MAX's own returned
      // preview tokens. Never treat another 400 or a network error as permission
      // to remove attachments.
      if (!shares.length || !(error instanceof MaxError) || error.status !== 400 ||
        error.message !== '400: No valid url or token provided for share attachment') throw error;
      const urls = shares.map(item => item.payload?.url);
      if (urls.some(url => typeof url !== 'string' || !isPublicLink(url))) throw error;
      const missing = [...new Set(urls as string[])].filter(url => !text.includes(url));
      const fallbackText = text + missing.map(url => `${SHARE_LINK_PREFIX}${url}`).join('');
      // Fail closed rather than truncate either the answer or the retained URL.
      if (Array.from(fallbackText).length > 4000) throw error;
      await this.editMessage(messageId, fallbackText, attachments.filter(item => item.type !== 'share'));
      log.info({ messageId, removedPreviews: shares.length }, 'invalid link preview removed during card update');
    }
  }

  async answerCallback(callbackId: string, notification?: string): Promise<void> {
    // MAX rejects an empty acknowledgement. This only acknowledges the click;
    // it must not imply successful delivery of a queued message.
    await this.call('answerOnCallback', () =>
      this.api.answerOnCallback(callbackId, { notification: notification?.trim() || 'Принято.' }),
    );
  }

  async getChat(chatId: bigint | number) {
    return this.call('getChat', () => this.api.getChat(toApiId(chatId)));
  }

  async uploadImage(source: Buffer): Promise<AttachmentRequest> {
    const payload = await this.call('uploadImage', () => this.api.upload.image({ source }));
    return { type: 'image', payload } as AttachmentRequest;
  }

  /**
   * Upload a document.
   *
   * The library derives the displayed file name from the source path and falls
   * back to a random UUID for raw buffers, so a named upload is staged through
   * a temp file — otherwise `/report` would deliver a file called
   * `9f87…` with no extension.
   */
  async uploadFile(source: Buffer, fileName?: string | null): Promise<AttachmentRequest> {
    // The SDK's Buffer path can discard the token returned by /uploads.
    // Always use its file/stream path, also for unnamed documents.
    const safeName = path.basename(fileName || 'file.bin').replace(/[\\/:*?"<>|]/g, '_') || 'file.bin';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-upload-'));
    const filePath = path.join(directory, safeName);
    try {
      await fs.writeFile(filePath, source);
      const token = await this.call('uploadFile', async () => {
        const result = await this.api.upload.file({ source: filePath });
        if (typeof result?.token !== 'string' || !result.token.trim()) {
          // Retry the upload, never enqueue/send a malformed attachment.
          throw new Error('MAX не вернул токен загруженного файла.');
        }
        return result.token;
      });
      return { type: 'file', payload: { token } };
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Fetch an attachment MAX hosts behind a temporary URL. */
  async downloadFromUrl(url: string): Promise<{ body: Buffer; mimeType?: string }> {
    return this.call('downloadFromUrl', async () => {
      // Every retry gets a fresh timeout. Abort also closes a rejected response
      // before its body can consume unbounded memory or bandwidth.
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw new Error(`Failed to download MAX attachment: HTTP ${response.status}`);
        }
        reader = response.body?.getReader();
        assertMediaSize(Number(response.headers.get('content-length')));
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            // Never trust Content-Length: it may be absent, wrong, or refer
            // to a compressed body. Check before retaining every chunk.
            assertMediaSize(size);
            chunks.push(value);
          }
        }
        return {
          body: Buffer.concat(chunks, size),
          mimeType: response.headers.get('content-type') ?? undefined,
        };
      } finally {
        controller.abort();
        await reader?.cancel().catch(() => undefined);
        reader?.releaseLock();
      }
    });
  }

  // --- Webhook subscriptions: REST adapter over the official endpoints. -----

  private async rest<T>(
    method: string,
    endpoint: string,
    init: { query?: Record<string, string>; body?: unknown } = {},
  ): Promise<T> {
    return this.call(`rest ${method} ${endpoint}`, async () => {
      const url = new URL(endpoint, `${this.baseUrl}/`);
      for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
      const response = await fetch(url.href, {
        method,
        headers: {
          Authorization: this.token,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        throw new MaxError(response.status, {
          code: String(data.code ?? 'http_error'),
          message: String(data.message ?? response.statusText),
        });
      }
      return data as T;
    });
  }

  /** GET /subscriptions */
  async listWebhookSubscriptions(): Promise<WebhookSubscription[]> {
    const data = await this.rest<{ subscriptions?: WebhookSubscription[] }>('GET', 'subscriptions');
    return data.subscriptions ?? [];
  }

  /** POST /subscriptions */
  async subscribeWebhook(input: { url: string; updateTypes?: UpdateType[]; secret?: string }): Promise<void> {
    await this.rest('POST', 'subscriptions', {
      body: {
        url: input.url,
        ...(input.updateTypes?.length ? { update_types: input.updateTypes } : {}),
        ...(input.secret ? { secret: input.secret } : {}),
      },
    });
  }

  /** DELETE /subscriptions?url=... */
  async unsubscribeWebhook(url: string): Promise<void> {
    await this.rest('DELETE', 'subscriptions', { query: { url } });
  }

  /**
   * Push an update through the bot middleware stack.
   *
   * The library only wires this up for long polling; in webhook mode we feed
   * updates in ourselves. `handleUpdate` is a runtime instance property (the
   * `private` marker exists only in the type declarations).
   */
  async dispatch(update: Update): Promise<void> {
    const handler = (this.bot as unknown as { handleUpdate: (update: Update) => Promise<void> }).handleUpdate;
    if (typeof handler !== 'function') {
      throw new Error('max-bot-api changed shape: Bot#handleUpdate is unavailable');
    }
    await handler(update);
  }
}

let instance: MaxClient | undefined;

export function createMaxClient(bot: Bot): MaxClient {
  instance = new MaxClient(bot);
  return instance;
}

export function getMaxClient(): MaxClient {
  if (!instance) throw new Error('MaxClient has not been created yet');
  return instance;
}

export { MaxError };
