import type { AttachmentRequest, Button, Message } from './max-types';

import { moduleLogger } from '../utils/logger';
import { MaxClient } from './max-client';

const log = moduleLogger('max-message');

/** Conservative MAX text ceiling; long cards are split rather than truncated. */
const MAX_TEXT_LENGTH = 3800;
/** Attachments of one kind per outgoing message. */
const ATTACHMENTS_PER_MESSAGE = 4;

export type OutboundAttachment = {
  type: 'IMAGE' | 'FILE';
  body: Buffer;
  originalName?: string | null;
};

export type SendTarget = { chatId: bigint } | { userId: bigint };

export type CompositeMessage = {
  text: string;
  /** Prefix repeated on every follow-up part, e.g. `№ INC-20260823-0001`. */
  label?: string;
  keyboard?: Button[][];
  attachments?: OutboundAttachment[];
  disableLinkPreview?: boolean;
};

/**
 * Delivers a logical message that may not fit into a single MAX message.
 *
 * MAX will not accept arbitrary mixes of attachments in one message, and long
 * text has a hard ceiling, so we split. Every part after the first repeats the
 * incident label so an operator scrolling a busy chat can still see which
 * incident the fragment belongs to.
 */
export class MaxMessageService {
  constructor(private readonly max: MaxClient) {}

  /**
   * Deliver text, media and buttons as ONE MAX message wherever possible.
   *
   * MAX accepts an image and an inline keyboard side by side in a single
   * message, and an edit that omits `attachments` leaves both untouched — so
   * a card can carry its photo and still be updated later. Extra messages are
   * only produced when the text overflows or when attachments of a second
   * kind have to travel (MAX groups media by type).
   */
  async send(target: SendTarget, message: CompositeMessage): Promise<{ firstMessageId?: string }> {
    const parts = splitText(message.text, message.label);
    const keyboardAttachment: AttachmentRequest | undefined = message.keyboard?.length
      ? { type: 'inline_keyboard', payload: { buttons: message.keyboard } }
      : undefined;

    const groups = groupAttachments(message.attachments ?? []);
    const [inlineGroup, ...trailingGroups] = groups;
    const inlineAttachments = inlineGroup ? await this.upload(inlineGroup) : [];

    let firstMessageId: string | undefined;

    for (let index = 0; index < parts.length; index += 1) {
      const isLast = index === parts.length - 1;
      // Media and buttons ride along with the final chunk of text.
      const attachments = isLast
        ? [...inlineAttachments, ...(keyboardAttachment ? [keyboardAttachment] : [])]
        : [];
      const sent = await this.deliver(
        target,
        parts[index]!,
        attachments.length ? attachments : undefined,
        message.disableLinkPreview,
      );
      firstMessageId ??= sent?.body?.mid;
    }

    // Anything that could not share the first message (a file next to photos,
    // or more media than one message may carry) follows, labelled so the
    // fragment stays traceable to its incident.
    for (const group of trailingGroups) {
      const uploaded = await this.upload(group);
      if (uploaded.length === 0) continue;
      await this.deliver(target, message.label ?? '', uploaded, true);
    }

    return { firstMessageId: firstMessageId ?? undefined };
  }

  /**
   * Rewrite a card's text while leaving its photo and buttons in place.
   * Used when a card gains a detail but stays actionable (§22 "В работе").
   */
  async editCardText(messageId: string, text: string): Promise<boolean> {
    return this.edit(messageId, text, undefined);
  }

  /**
   * Replace a card with a closing notice: text only, no media, no buttons.
   * Used once an incident leaves a chat's responsibility (§58), so a stale
   * button cannot be pressed again.
   */
  async finalizeCard(messageId: string, text: string): Promise<boolean> {
    return this.edit(messageId, text, []);
  }

  /**
   * Swap the buttons on a message, e.g. paging the сфера picker.
   * The attachment list is replaced, so any media on that message is dropped —
   * only use this on messages that carry buttons alone.
   */
  async editCardKeyboard(messageId: string, text: string, keyboard: Button[][]): Promise<boolean> {
    return this.edit(messageId, text, [{ type: 'inline_keyboard', payload: { buttons: keyboard } }]);
  }

  /** Editing is best-effort: a refused edit must never abort the action. */
  private async edit(
    messageId: string,
    text: string,
    attachments: AttachmentRequest[] | undefined,
  ): Promise<boolean> {
    try {
      await this.max.editMessage(messageId, text, attachments);
      return true;
    } catch (error) {
      log.warn(
        { messageId, err: error instanceof Error ? error.message : String(error) },
        'failed to edit MAX card',
      );
      return false;
    }
  }

  private async deliver(
    target: SendTarget,
    text: string,
    attachments?: AttachmentRequest[],
    disableLinkPreview?: boolean,
  ): Promise<Message | undefined> {
    const extra = {
      ...(attachments?.length ? { attachments } : {}),
      ...(disableLinkPreview ? { disable_link_preview: true } : {}),
    };
    try {
      return 'chatId' in target
        ? await this.max.sendToChat(target.chatId, text, extra)
        : await this.max.sendToUser(target.userId, text, extra);
    } catch (error) {
      log.error(
        {
          target: 'chatId' in target ? target.chatId.toString() : target.userId.toString(),
          err: error instanceof Error ? error.message : String(error),
        },
        'failed to deliver MAX message',
      );
      throw error;
    }
  }

  private async upload(group: OutboundAttachment[]): Promise<AttachmentRequest[]> {
    const uploaded: AttachmentRequest[] = [];
    for (const item of group) {
      try {
        uploaded.push(
          item.type === 'IMAGE'
            ? await this.max.uploadImage(item.body)
            : await this.max.uploadFile(item.body, item.originalName),
        );
      } catch (error) {
        // A failed attachment must never swallow the answer text that was
        // already delivered; log and continue with what we have.
        log.error(
          { name: item.originalName, err: error instanceof Error ? error.message : String(error) },
          'attachment upload failed, skipping',
        );
      }
    }
    return uploaded;
  }
}

export function splitText(text: string, label?: string): string[] {
  const characters = Array.from(text);
  if (characters.length <= MAX_TEXT_LENGTH) return [text];

  const prefix = label ? `${label}\n\n` : '';
  const prefixLength = Array.from(prefix).length;
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < characters.length) {
    const budget = chunks.length === 0 ? MAX_TEXT_LENGTH : MAX_TEXT_LENGTH - prefixLength;
    const slice = characters.slice(cursor, cursor + budget).join('');
    chunks.push(chunks.length === 0 ? slice : `${prefix}${slice}`);
    cursor += budget;
  }
  return chunks;
}

export function groupAttachments(attachments: OutboundAttachment[]): OutboundAttachment[][] {
  const groups: OutboundAttachment[][] = [];
  for (const type of ['IMAGE', 'FILE'] as const) {
    const ofType = attachments.filter((item) => item.type === type);
    for (let index = 0; index < ofType.length; index += ATTACHMENTS_PER_MESSAGE) {
      groups.push(ofType.slice(index, index + ATTACHMENTS_PER_MESSAGE));
    }
  }
  return groups;
}
