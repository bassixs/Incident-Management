import type { AttachmentType } from '@prisma/client';

import type { OutboundAttachment } from '../max/max-message.service';
import type { MediaService } from './media.service';
import { photoToken } from './max-photo-reference';

export type StoredAttachmentRecord = {
  type: AttachmentType;
  storageKey: string;
  originalName: string | null;
};

/**
 * Reuse MAX photo tokens, or load legacy photos/staff files for delivery.
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
    const token = photoToken(record.storageKey);
    if (token) {
      outbound.push({ type: 'IMAGE', maxToken: token, originalName: record.originalName });
      continue;
    }
    const body = await media.load(record.storageKey);
    outbound.push({ type: record.type, body, originalName: record.originalName });
  }
  return outbound;
}
