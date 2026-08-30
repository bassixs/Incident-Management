/**
 * Types re-exported from the official MAX client.
 *
 * `@maxhub/max-bot-api` publishes its protocol types under the `/types`
 * subpath but does not export the flattened request "extras". Rather than deep
 * importing into `dist/`, the two shapes we need are mirrored here against the
 * documented POST /messages body.
 */
export type {
  Attachment,
  AttachmentRequest,
  BotStartedUpdate,
  Button,
  CallbackButton,
  Chat,
  Message,
  MessageBody,
  MessageCallbackUpdate,
  MessageCreatedUpdate,
  Update,
  UpdateType,
  User as MaxUser,
} from '@maxhub/max-bot-api/types';

import type { AttachmentRequest } from '@maxhub/max-bot-api/types';

/** Body/query options accepted by POST /messages and PUT /messages. */
export type SendMessageExtra = {
  attachments?: AttachmentRequest[] | null;
  link?: { type: 'forward' | 'reply'; mid: string } | null;
  notify?: boolean;
  format?: 'markdown' | 'html' | null;
  disable_link_preview?: boolean;
};

/** All update types this bot subscribes to. */
export const SUBSCRIBED_UPDATE_TYPES = [
  'message_created',
  'message_callback',
  'bot_started',
  'bot_added',
  'bot_removed',
  'message_edited',
] as const;
