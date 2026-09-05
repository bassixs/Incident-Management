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
 * A missing attachment must fail the attempt; the durable outbox can retry
 * without falsely claiming that the complete answer reached the requester.
 */
export async function loadOutboundAttachments(
  media: MediaService,
  records: StoredAttachmentRecord[],
): Promise<OutboundAttachment[]> {
  const outbound: OutboundAttachment[] = [];
  for (const record of records) {
    const body = await media.load(record.storageKey);
    outbound.push({ type: record.type, body, originalName: record.originalName });
  }
  return outbound;
}
