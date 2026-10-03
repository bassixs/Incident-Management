/** Kept byte-for-byte compatible with historical outbox greetings. */
export function botAddedGreeting(chatId: bigint): string {
  return [
    'Бот подключён к этому чату.', '', `ID чата: ${chatId}`, '',
    'Укажите его в DISTRIBUTION_CHAT_ID, REVIEW_CHAT_ID или в настройках ответственной группы',
    '(/group_chat <КОД> <CHAT_ID>).',
  ].join('\n');
}
