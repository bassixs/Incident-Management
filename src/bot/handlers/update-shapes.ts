import type { Message } from '../../max/max-types';

/**
 * Narrow views of the MAX update payloads the handlers touch.
 *
 * `Context#update` is a wide union; casting to these keeps the handlers honest
 * about which fields they actually rely on.
 */
export type MessageCreatedUpdate = {
  update_type: 'message_created';
  timestamp: number;
  message: Message;
};

export type BotAddedUpdateLike = {
  update_type: 'bot_added';
  timestamp: number;
  chat_id?: number;
};
