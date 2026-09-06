import { AppError, ValidationError } from '../utils/errors';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { Attachment } from '../max/max-types';

import { getConfig } from '../config';
import type { MaxClient } from '../max/max-client';
import { moduleLogger } from '../utils/logger';
import { LocalMediaStorage } from './local-media-storage';
import type { MediaStorage } from './media-storage.interface';
import { S3MediaStorage } from './s3-media-storage';
import { assertMediaSize } from './media-limits';
import { isPhotoReference, photoReference } from './max-photo-reference';

const log = moduleLogger('media');

export type IncomingMediaKind = 'IMAGE' | 'FILE' | 'VIDEO' | 'AUDIO' | 'OTHER';

export type IncomingMedia = {
  kind: IncomingMediaKind;
  url?: string | undefined;
  token?: string | undefined;
  filename?: string | undefined;
  size?: number | undefined;
};

/** Split a MAX message's attachments into the kinds the workflow cares about. */
export function classifyAttachments(attachments: Attachment[] | null | undefined): IncomingMedia[] {
  if (!attachments?.length) return [];
  const result: IncomingMedia[] = [];
  for (const attachment of attachments) {
    switch (attachment.type) {
      case 'image':
        result.push({ kind: 'IMAGE', url: attachment.payload.url, token: attachment.payload.token });
        break;
      case 'file':
        result.push({
          kind: 'FILE',
          url: attachment.payload.url,
          token: attachment.payload.token,
          filename: attachment.filename,
          size: attachment.size,
        });
        break;
      case 'video':
        result.push({ kind: 'VIDEO', url: attachment.payload.url, token: attachment.payload.token });
        break;
      case 'audio':
        result.push({ kind: 'AUDIO', url: attachment.payload.url, token: attachment.payload.token });
        break;
      case 'inline_keyboard':
        // Echoed back on edited messages; never user content.
        break;
      default:
        result.push({ kind: 'OTHER' });
        break;
    }
  }
  return result;
}

export function hasKind(media: IncomingMedia[], kind: IncomingMediaKind): boolean {
  return media.some((item) => item.kind === kind);
}

export type StoredMedia = {
  type: 'IMAGE' | 'FILE';
  storageKey: string;
  mimeType?: string | undefined;
  originalName?: string | undefined;
  size: number;
  sourceUrl?: string | undefined;
  maxToken?: string | undefined;
};

export function createMediaStorage(): MediaStorage {
  const config = getConfig();
  if (config.MEDIA_STORAGE === 's3') {
    return new S3MediaStorage({
      bucket: config.S3_BUCKET!,
      region: config.S3_REGION,
      endpoint: config.S3_ENDPOINT,
      accessKeyId: config.S3_ACCESS_KEY_ID!,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
  }
  return new LocalMediaStorage(config.mediaLocalAbsolutePath);
}

/**
 * New photos stay in MAX: persist an opaque token reference, not their bytes
 * or a download URL. Files supplied by staff still use local/S3 storage.
 * Existing local photo paths remain readable during the transition.
 */
export class MediaService {
  constructor(
    private readonly storage: MediaStorage,
    private readonly max: MaxClient,
  ) {}

  /** Every accepted attachment must be persisted, otherwise fail the submission. */
  async ingest(prefix: string, media: IncomingMedia): Promise<StoredMedia> {
    if (media.kind !== 'IMAGE' && media.kind !== 'FILE') throw new ValidationError('Этот тип вложения не поддерживается.');
    if (media.size !== undefined) assertMediaSize(media.size);
    if (media.kind === 'IMAGE') {
      if (!media.token) throw new ValidationError('Не удалось получить фотографию из MAX. Прикрепите её заново и повторите отправку.');
      // size describes bytes retained in our storage, hence zero for references.
      return { type: 'IMAGE', storageKey: photoReference(media.token), maxToken: media.token,
        originalName: media.filename, size: 0 };
    }
    if (!media.url) {
      throw new AppError('Не удалось получить вложение из MAX. Прикрепите его заново и повторите отправку.', 'MEDIA_UNAVAILABLE');
    }
    let key: string | undefined;
    try {
      const { body, mimeType } = await this.max.downloadFromUrl(media.url);
      const extension = pickExtension(media.filename, mimeType, media.kind);
      key = `${prefix}/${randomUUID()}${extension}`;
      const stored = await this.storage.save({ key, body, mimeType });
      return {
        type: media.kind,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        originalName: media.filename ?? undefined,
        size: stored.size,
        sourceUrl: media.url,
        maxToken: media.token,
      };
    } catch (error) {
      if (key) await this.storage.remove(key).catch(() => undefined);
      if (error instanceof ValidationError) throw error;
      log.error(
        { prefix, err: error instanceof Error ? error.message : String(error) },
        'failed to ingest MAX attachment',
      );
      throw new AppError('Не удалось сохранить вложение. Повторите отправку с фотографией или файлом.', 'MEDIA_UNAVAILABLE');
    }
  }

  async ingestAll(prefix: string, media: IncomingMedia[]): Promise<StoredMedia[]> {
    const stored: StoredMedia[] = [];
    try {
      for (const item of media) stored.push(await this.ingest(prefix, item));
      return stored;
    } catch (error) {
      await this.discard(stored);
      throw error;
    }
  }

  async load(storageKey: string): Promise<Buffer> {
    return this.storage.load(storageKey);
  }

  /** Only for newly ingested files verified to have no committed DB owner. */
  async discard(stored: StoredMedia[]): Promise<void> {
    await Promise.all(stored.filter(item => !isPhotoReference(item.storageKey)).map(item => this.storage.remove(item.storageKey).catch(error => {
      log.warn({ storageKey: item.storageKey, err: String(error) }, 'uncommitted attachment cleanup failed');
    })));
  }

}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function pickExtension(filename: string | undefined, mimeType: string | undefined, kind: IncomingMediaKind): string {
  const fromName = filename ? path.extname(filename) : '';
  if (fromName && fromName.length <= 10) return fromName.toLowerCase();
  const base = mimeType?.split(';')[0]?.trim().toLowerCase();
  if (base && MIME_EXTENSIONS[base]) return MIME_EXTENSIONS[base]!;
  return kind === 'IMAGE' ? '.jpg' : '.bin';
}
