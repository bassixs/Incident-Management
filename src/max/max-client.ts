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

function isRetryable(error: unknown): boolean {
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

  private call<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return retry(operation, {
      attempts: 4,
      shouldRetry: isRetryable,
      onRetry: (error, attempt, waitMs) =>
        log.warn(
          { method: name, attempt, waitMs, err: error instanceof Error ? error.message : String(error) },
          'MAX API call failed, retrying',
        ),
    });
  }

  async getMe() {
    return this.call('getMyInfo', () => this.api.getMyInfo());
  }

  async sendToChat(chatId: bigint | number, text: string, extra?: SendMessageExtra): Promise<Message> {
    return this.call('sendMessageToChat', () => this.api.sendMessageToChat(toApiId(chatId), text, extra));
  }

  async sendToUser(userId: bigint | number, text: string, extra?: SendMessageExtra): Promise<Message> {
    return this.call('sendMessageToUser', () => this.api.sendMessageToUser(toApiId(userId), text, extra));
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
    await this.call('editMessage', () =>
      this.api.editMessage(messageId, {
        text,
        ...(attachments === undefined ? {} : { attachments }),
      }),
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.call('deleteMessage', () => this.api.deleteMessage(messageId));
  }

  async answerCallback(callbackId: string, notification?: string): Promise<void> {
    await this.call('answerOnCallback', () =>
      this.api.answerOnCallback(callbackId, notification ? { notification } : {}),
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
    if (!fileName) {
      const { token } = await this.call('uploadFile', () => this.api.upload.file({ source }));
      return { type: 'file', payload: { token } };
    }
    const safeName = path.basename(fileName).replace(/[\\/:*?"<>|]/g, '_') || 'file.bin';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'max-upload-'));
    const filePath = path.join(directory, safeName);
    try {
      await fs.writeFile(filePath, source);
      const { token } = await this.call('uploadFile', () => this.api.upload.file({ source: filePath }));
      return { type: 'file', payload: { token } };
    } finally {
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Fetch an attachment MAX hosts behind a temporary URL. */
  async downloadFromUrl(url: string): Promise<{ body: Buffer; mimeType?: string }> {
    return this.call('downloadFromUrl', async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to download MAX attachment: HTTP ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return {
        body: Buffer.from(arrayBuffer),
        mimeType: response.headers.get('content-type') ?? undefined,
      };
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
