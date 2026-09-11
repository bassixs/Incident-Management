import type { Bot } from '@maxhub/max-bot-api';

import type { AppServices } from '../app/container';
import { moduleLogger } from '../utils/logger';
import { handleCallbackUpdate } from './callbacks';
import { handleBotAdded, handleBotStarted, handleMessageUpdate } from './handlers/message.handler';
import { handleMembershipUpdate } from './handlers/membership.handler';

const log = moduleLogger('bot');

/** Commands advertised in the MAX client UI. */
const BOT_COMMANDS = [
  { name: 'work', description: 'Моя работа — для сотрудников' },
  { name: 'start', description: 'Главное меню' },
  { name: 'my', description: 'Мои обращения' },
  { name: 'rules', description: 'Правила подачи обращения' },
  { name: 'whoami', description: 'Ваш MAX ID и ID чата' },
  { name: 'help', description: 'Список команд' },
  { name: 'info', description: 'О чате, правах и порядке работы' },
];

/**
 * Wire the update handlers.
 *
 * Handlers stay thin on purpose: validate → call a service → render. The
 * The durable inbox owns retry/attention state, so the library error hook logs
 * and rethrows to that boundary instead of silently treating a failed update
 * as processed.
 */
export function registerHandlers(services: AppServices): Bot {
  const bot = services.bot;

  bot.catch(async (error, ctx) => {
    log.error(
      {
        updateType: ctx.update?.update_type,
        err: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'unhandled error while processing update',
    );
    throw error;
  });

  bot.on('message_created', (ctx) => handleMessageUpdate(services, ctx));
  bot.on('message_callback', (ctx) => handleCallbackUpdate(services, ctx));
  bot.on('bot_started', (ctx) => handleBotStarted(services, ctx));
  bot.on('bot_added', (ctx) => handleBotAdded(services, ctx));
  bot.on('user_added', (ctx) => handleMembershipUpdate(services, ctx));
  bot.on('user_removed', (ctx) => handleMembershipUpdate(services, ctx));

  return bot;
}

export async function publishBotCommands(services: AppServices): Promise<void> {
  try {
    await services.bot.api.setMyCommands(BOT_COMMANDS);
    log.info({ count: BOT_COMMANDS.length }, 'bot commands published');
  } catch (error) {
    log.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'failed to publish bot commands',
    );
  }
}
