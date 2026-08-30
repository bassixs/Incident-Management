import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import type { MediaStorage, StoredObject } from './media-storage.interface';

export type S3StorageOptions = {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
};

/** Production storage: any S3-compatible object store (AWS S3, MinIO, ...). */
export class S3MediaStorage implements MediaStorage {
  private readonly client: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle ?? true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    });
  }

  async save({ key, body, mimeType }: { key: string; body: Buffer; mimeType?: string }): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        Body: body,
        ...(mimeType ? { ContentType: mimeType } : {}),
      }),
    );
    return { storageKey: key, size: body.byteLength, mimeType };
  }

  async load(storageKey: string): Promise<Buffer> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: storageKey }),
    );
    if (!result.Body) throw new Error(`Empty S3 object: ${storageKey}`);
    const bytes = await result.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.options.bucket, Key: storageKey }));
      return true;
    } catch {
      return false;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: storageKey }));
  }
}
