import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { MediaStorage, StoredObject } from './media-storage.interface';

/** Development / single-node storage backed by the local filesystem. */
export class LocalMediaStorage implements MediaStorage {
  constructor(private readonly rootDir: string) {}

  private resolve(storageKey: string): string {
    const normalised = path
      .normalize(storageKey)
      .replace(/^([/\\]|\.\.[/\\])+/, '')
      .replace(/\\/g, '/');
    const target = path.resolve(this.rootDir, normalised);
    const root = path.resolve(this.rootDir);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Refusing to access media outside the storage root: ${storageKey}`);
    }
    return target;
  }

  async save({ key, body, mimeType }: { key: string; body: Buffer; mimeType?: string }): Promise<StoredObject> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    return { storageKey: key, size: body.byteLength, mimeType };
  }

  async load(storageKey: string): Promise<Buffer> {
    return fs.readFile(this.resolve(storageKey));
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(storageKey));
      return true;
    } catch {
      return false;
    }
  }

  async remove(storageKey: string): Promise<void> {
    await fs.rm(this.resolve(storageKey), { force: true });
  }
}
