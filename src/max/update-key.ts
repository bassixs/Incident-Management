import { createHash } from 'node:crypto';

import type { Update } from './max-types';

/**
 * Deterministic idempotency key for one MAX update.
 *
 * The MAX Bot API does not expose a single "update id", so we derive the key
 * from the most stable identifier each event type carries (message `mid`,
 * `callback_id`, ...). Redelivery of the same event therefore always produces
 * the same key, and ProcessedUpdate's unique index turns the replay into a
 * no-op. If a shape ever appears that we do not recognise, we fall back to a
 * hash of the whole payload, which is still stable across redeliveries.
 */
export function buildUpdateKey(update: Update): string {
  switch (update.update_type) {
    case 'message_created':
      return `message_created:${update.message.body.mid}`;
    case 'message_edited':
      return `message_edited:${update.message.body.mid}:${update.message.body.seq}`;
    case 'message_removed':
      return `message_removed:${update.message_id}`;
    case 'message_callback':
      return `message_callback:${update.callback.callback_id}`;
    case 'bot_started':
      return `bot_started:${update.chat_id}:${update.user.user_id}:${update.timestamp}`;
    case 'bot_added':
    case 'bot_removed':
    case 'user_added':
    case 'user_removed':
      return `${update.update_type}:${update.chat_id}:${update.user.user_id}:${update.timestamp}`;
    case 'chat_title_changed':
      return `chat_title_changed:${update.chat_id}:${update.timestamp}`;
    case 'message_chat_created':
      return `message_chat_created:${update.message_id}`;
    case 'message_construction_request':
    case 'message_constructed':
      return `${update.update_type}:${update.session_id}:${update.timestamp}`;
    default:
      return fallbackKey(update);
  }
}

function fallbackKey(update: Update): string {
  const digest = createHash('sha256').update(JSON.stringify(update)).digest('hex').slice(0, 32);
  return `${(update as { update_type?: string }).update_type ?? 'unknown'}:sha256:${digest}`;
}
