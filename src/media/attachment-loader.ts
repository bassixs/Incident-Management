import type { AttachmentType } from '@prisma/client';

import type { OutboundAttachment } from '../max/max-message.service';
import type { MediaService } from './media.service';

export type StoredAttachmentRecord = {
  type: AttachmentType;
  storageKey: string;
  originalName: string | null;
};

/**
 * Re-hydrate stored attachments for an outgoing MAX message.
 *
 * Files that can no longer be read are skipped rather than aborting delivery —
 * an answer without its photo still has to reach the requester.
 */
export async function loadOutboundAttachments(
  media: MediaService,
  records: StoredAttachmentRecord[],
): Promise<OutboundAttachment[]> {
  const outbound: OutboundAttachment[] = [];
  for (const record of records) {
    const body = await media.tryLoad(record.storageKey);
    if (!body) continue;
    outbound.push({ type: record.type, body, originalName: record.originalName });
  }
  return outbound;
}
