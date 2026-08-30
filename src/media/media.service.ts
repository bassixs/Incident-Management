import { randomUUID } from 'node:crypto';
import * as path from 'node:path';

import type { Attachment } from '../max/max-types';

import { getConfig } from '../config';
import type { MaxClient } from '../max/max-client';
import { moduleLogger } from '../utils/logger';
import { LocalMediaStorage } from './local-media-storage';
import type { MediaStorage } from './media-storage.interface';
import { S3MediaStorage } from './s3-media-storage';

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
 * Copies attachments out of MAX into our own storage and back again.
 *
 * MAX attachment URLs are temporary, so the DB never points at them as the
 * canonical location - it stores a storageKey and we re-upload the bytes when
 * the file has to travel to another chat or to the requester.
 */
export class MediaService {
  constructor(
    private readonly storage: MediaStorage,
    private readonly max: MaxClient,
  ) {}

  /** Download one MAX attachment and persist it. Returns null if unusable. */
  async ingest(prefix: string, media: IncomingMedia): Promise<StoredMedia | null> {
    if (media.kind !== 'IMAGE' && media.kind !== 'FILE') return null;
    if (!media.url) {
      log.warn({ prefix, kind: media.kind }, 'attachment has no download url, skipping');
      return null;
    }
    try {
      const { body, mimeType } = await this.max.downloadFromUrl(media.url);
      const extension = pickExtension(media.filename, mimeType, media.kind);
      const key = `${prefix}/${randomUUID()}${extension}`;
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
      log.error(
        { prefix, err: error instanceof Error ? error.message : String(error) },
        'failed to ingest MAX attachment',
      );
      return null;
    }
  }

  async ingestAll(prefix: string, media: IncomingMedia[]): Promise<StoredMedia[]> {
    const stored: StoredMedia[] = [];
    for (const item of media) {
      const result = await this.ingest(prefix, item);
      if (result) stored.push(result);
    }
    return stored;
  }

  async load(storageKey: string): Promise<Buffer> {
    return this.storage.load(storageKey);
  }

  /** Best-effort read; a missing file must not break answer delivery. */
  async tryLoad(storageKey: string): Promise<Buffer | null> {
    try {
      return await this.storage.load(storageKey);
    } catch (error) {
      log.error(
        { storageKey, err: error instanceof Error ? error.message : String(error) },
        'stored attachment could not be read',
      );
      return null;
    }
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
