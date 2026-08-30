export type StoredObject = {
  storageKey: string;
  size: number;
  mimeType?: string | undefined;
};

/**
 * Durable storage for incident and answer attachments.
 *
 * MAX serves uploaded media behind temporary URLs, so those URLs are treated
 * as a transport detail only: every attachment that matters is copied here at
 * ingest time and re-uploaded to MAX when it needs to be sent somewhere else.
 */
export interface MediaStorage {
  save(input: { key: string; body: Buffer; mimeType?: string | undefined }): Promise<StoredObject>;
  load(storageKey: string): Promise<Buffer>;
  exists(storageKey: string): Promise<boolean>;
  remove(storageKey: string): Promise<void>;
}
