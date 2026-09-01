import { UserRole } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { parseReportRange, REPORT_USAGE } from '../../reports/report-range';
import { AppError, ForbiddenError, ValidationError } from '../../utils/errors';
import { moduleLogger } from '../../utils/logger';
import { hasPermission } from '../../users/roles';
import { assertWorkingChat, requirePermission } from '../middleware/authorize';
import { reportPeriodKeyboard } from '../keyboards';
import { sendReport } from '../views/report';
import { incidentLookupCard, myIncidentsText, rulesText } from '../views/cards';
import { sendMainMenu } from '../handlers/requester.handler';
import type { ResolvedActor } from '../handlers/helpers';

const log = moduleLogger('bot-commands');

export type CommandContext = {
  services: AppServices;
  actor: ResolvedActor;
  chatId: bigint;
  isDialog: boolean;
  args: string[];
};

type CommandHandler = (context: CommandContext) => Promise<void>;

const STAFF_HELP = [
  'Команды для сотрудников:',
  '',
  '/incident <НОМЕР> — карточка обращения',
  '/report — выбрать период кнопками; можно и сразу: /report 7d, /report 01.08.2026 - 10.08.2026',
  '/resend <НОМЕР> — повторить доставку согласованного ответа',
  '/chatid — показать ID текущего чата',
  '',
  'Только для администратора:',
  '/ban <MAX_USER_ID> <причина>',
  '/unban <MAX_USER_ID>',
  '/categories — список сфер',
  '/category_add <КОД> <Название>',
  '/category_chat <КОД> <CHAT_ID>',
  '/category_on <КОД> | /category_off <КОД>',
  '/category_name <КОД> <Новое название>',
  '/category_authority <КОД> <Ведомство для подписи | ->',
  '/category_template <КОД> <шаблон|-> ',
  '/role <MAX_USER_ID> <ADMIN,DISPATCHER,...|-> ',
  '/sla_check — принудительная проверка сроков',
].join('\n');

const USER_HELP = [
  'Доступные команды:',
  '',
  '/start — главное меню',
  '/rules — правила подачи обращения',
  '/my — мои обращения',
  '/whoami — ваш MAX ID и ID чата',
].join('\n');

export const COMMANDS: Record<string, CommandHandler> = {
  start: async ({ services, actor, isDialog }) => {
    if (!isDialog) return;
    await sendMainMenu(services, actor);
  },

  help: async (context) => {
    const { services, actor, chatId, isDialog } = context;
    const staff = hasPermission(actor.roles, 'incident.lookup');
    const text = staff && !isDialog ? `${USER_HELP}\n\n${STAFF_HELP}` : USER_HELP;
    await reply(services, chatId, isDialog, actor, text);
  },

  rules: async ({ services, actor, chatId, isDialog }) => {
    await reply(services, chatId, isDialog, actor, rulesText());
  },

  my: async ({ services, actor, chatId, isDialog }) => {
    if (!isDialog) throw new ForbiddenError('Эта команда доступна только в личном чате с ботом.');
    const incidents = await services.incidents.listForRequester(actor.maxUserId);
    await reply(services, chatId, isDialog, actor, myIncidentsText(incidents));
  },

  chatid: async ({ services, chatId, isDialog, actor }) => {
    requirePermission(actor, 'incident.lookup');
    await reply(services, chatId, isDialog, actor, `ID этого чата: ${chatId.toString()}`);
  },

  /**
   * Setup helper: there is no other way to learn your own MAX user id, and it
   * is needed to fill ADMINS on a fresh deployment. Reveals only the caller's
   * own identity, so it is intentionally available to everyone.
   */
  whoami: async ({ services, actor, chatId, isDialog }) => {
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        `Ваш MAX ID: ${actor.maxUserId.toString()}`,
        `Имя: ${actor.displayName}`,
        `Роли: ${actor.roles.join(', ')}`,
        '',
        `ID этого чата: ${chatId.toString()}`,
        `Тип чата: ${isDialog ? 'личный диалог' : 'групповой чат'}`,
      ].join('\n'),
    );
  },

  incident: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'incident.lookup');
    assertWorkingChat(isDialog);
    const code = args[0];
    if (!code) throw new ValidationError('Использование: /incident INC-20260823-0001');
    const incident = await services.incidents.findByPublicCode(code);
    if (!incident) throw new AppError(`Обращение ${code.toUpperCase()} не найдено.`, 'NOT_FOUND');
    await services.messages.send({ chatId }, { text: incidentLookupCard(incident) });
  },

  /**
   * A bare `/report` offers the period as buttons; arguments still work for
   * anyone who prefers typing (`/report 7d`, `/report 01.08.2026 - 10.08.2026`).
   */
  report: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'report.generate');
    assertWorkingChat(isDialog);

    if (args.length === 0) {
      await services.messages.send(
        { chatId },
        { text: 'За какой период сформировать отчёт?', keyboard: reportPeriodKeyboard() },
      );
      return;
    }

    await sendReport(services, chatId, parseReportRange(args), actor.maxUserId);
  },

  resend: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'incident.lookup');
    assertWorkingChat(isDialog);
    const code = args[0];
    if (!code) throw new ValidationError('Использование: /resend INC-20260823-0001');
    const incident = await services.incidents.findByPublicCode(code);
    if (!incident) throw new AppError(`Обращение ${code.toUpperCase()} не найдено.`, 'NOT_FOUND');
    const sent = await services.review.resend(incident.id);
    await services.messages.send(
      { chatId },
      {
        text: sent
          ? `✅ Ответ по ${incident.publicCode} отправлен пользователю повторно.`
          : `ℹ️ Ответ по ${incident.publicCode} уже был доставлен ранее.`,
      },
    );
  },

  ban: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [rawId, ...reasonParts] = args;
    const reason = reasonParts.join(' ').trim();
    if (!rawId || !reason) throw new ValidationError('Использование: /ban <MAX_USER_ID> <причина>');
    const maxUserId = parseMaxId(rawId);
    await services.bans.ban({ maxUserId, reason, createdById: actor.userId });
    await reply(services, chatId, isDialog, actor, `🚫 Пользователь ${maxUserId.toString()} заблокирован.`);
  },

  unban: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const rawId = args[0];
    if (!rawId) throw new ValidationError('Использование: /unban <MAX_USER_ID>');
    const maxUserId = parseMaxId(rawId);
    const lifted = await services.bans.unban(maxUserId);
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      lifted > 0
        ? `✅ Блокировка пользователя ${maxUserId.toString()} снята.`
        : `Пользователь ${maxUserId.toString()} не был заблокирован.`,
    );
  },

  /** Grouped by readiness — with two dozen сферы a flat list is unreadable. */
  categories: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const categories = await services.categories.listAll();
    if (categories.length === 0) {
      await reply(services, chatId, isDialog, actor, 'Сферы не заданы.');
      return;
    }

    const describe = (category: (typeof categories)[number]): string =>
      `${category.code} — ${category.name}${category.answerTemplate ? ' 📄' : ''}\n` +
      `     ${category.authorityName ?? '⚠️ ведомство не задано'}`;

    const ready = categories.filter((item) => item.isActive && item.maxChatId !== null);
    const noChat = categories.filter((item) => item.isActive && item.maxChatId === null);
    const disabled = categories.filter((item) => !item.isActive);

    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        `Сферы: ${categories.length}`,
        ...(ready.length
          ? ['', `✅ Готовы к распределению (${ready.length}):`, ...ready.map(describe)]
          : []),
        ...(noChat.length
          ? [
              '',
              `⚠️ Без рабочего чата (${noChat.length}) — диспетчеру не показываются:`,
              ...noChat.map(describe),
              '',
              'Задать: /category_chat <КОД> <CHAT_ID>',
            ]
          : []),
        ...(disabled.length ? ['', `⛔ Отключены (${disabled.length}):`, ...disabled.map(describe)] : []),
        '',
        `Без ведомства для подписи: ${categories.filter((item) => item.isActive && !item.authorityName).length}`,
        'Задать: /category_authority <КОД> <Название ведомства>',
        '',
        '📄 — задан шаблон ответа',
      ].join('\n'),
    );
  },

  category_add: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!code || !name) throw new ValidationError('Использование: /category_add <КОД> <Название>');
    const category = await services.categories.create({ code, name });
    await reply(services, chatId, isDialog, actor, `Сфера ${category.code} создана. Задайте чат: /category_chat ${category.code} <CHAT_ID>`);
  },

  category_chat: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, rawChatId] = args;
    if (!code || !rawChatId) throw new ValidationError('Использование: /category_chat <КОД> <CHAT_ID>');
    const category = await services.categories.setChatId(code, parseMaxId(rawChatId));
    await reply(services, chatId, isDialog, actor, `Сфера ${category.code} → чат ${category.maxChatId?.toString()}`);
  },

  category_on: async (context) => setCategoryActive(context, true),
  category_off: async (context) => setCategoryActive(context, false),

  /**
   * Sets the body that signs answers for a сфера. The signature is added to
   * the answer automatically, so responders never type it.
   */
  category_authority: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    if (!code) {
      throw new ValidationError('Использование: /category_authority <КОД> <Название ведомства | ->');
    }
    const authority = nameParts.join(' ').trim();
    const category = await services.categories.setAuthority(
      code,
      authority === '' || authority === '-' ? null : authority,
    );
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      category.authorityName
        ? `Сфера ${category.code}: ответы будут подписаны «${category.authorityName}».`
        : `Сфера ${category.code}: подпись ведомства убрана.`,
    );
  },

  /** Renames the display label; the code stays put so history keeps matching. */
  category_name: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!code || !name) throw new ValidationError('Использование: /category_name <КОД> <Новое название>');
    const category = await services.categories.rename(code, name);
    await reply(services, chatId, isDialog, actor, `Сфера ${category.code} → «${category.name}»`);
  },

  category_template: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...templateParts] = args;
    if (!code) throw new ValidationError('Использование: /category_template <КОД> <шаблон | ->');
    const raw = templateParts.join(' ').trim();
    const category = await services.categories.setTemplate(code, raw === '-' || raw === '' ? null : raw);
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      category.answerTemplate ? `Шаблон сферы ${category.code} обновлён.` : `Шаблон сферы ${category.code} удалён.`,
    );
  },

  role: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [rawId, rawRoles] = args;
    if (!rawId || !rawRoles) {
      throw new ValidationError('Использование: /role <MAX_USER_ID> <ADMIN,DISPATCHER,APPROVER,RESPONDER | ->');
    }
    const maxUserId = parseMaxId(rawId);
    const roles =
      rawRoles === '-'
        ? []
        : rawRoles
            .split(',')
            .map((item) => item.trim().toUpperCase())
            .filter(Boolean)
            .map((item) => {
              if (!(item in UserRole)) throw new ValidationError(`Неизвестная роль: ${item}`);
              return item as UserRole;
            });
    await services.users.upsertFromMax({ user_id: Number(maxUserId), name: `User ${maxUserId}`, username: null });
    await services.users.setRoles(maxUserId, roles);
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      `Роли пользователя ${maxUserId.toString()}: ${roles.length ? roles.join(', ') : 'сброшены'}`,
    );
  },

  sla_check: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const result = await services.sla.sweep();
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        'Проверка сроков выполнена.',
        `Проверено: ${result.checked}`,
        `Предупреждений 24ч: ${result.warned24}`,
        `Предупреждений 6ч: ${result.warned6}`,
        `Просрочено: ${result.overdue}`,
        `Сессий очищено: ${result.sessionsPurged}`,
      ].join('\n'),
    );
  },
};

async function setCategoryActive(context: CommandContext, isActive: boolean): Promise<void> {
  const { services, actor, chatId, isDialog, args } = context;
  requirePermission(actor, 'admin.manage');
  const code = args[0];
  if (!code) throw new ValidationError(`Использование: /category_${isActive ? 'on' : 'off'} <КОД>`);
  const category = await services.categories.setActive(code, isActive);
  await reply(
    services,
    chatId,
    isDialog,
    actor,
    `Сфера ${category.code} ${isActive ? 'включена' : 'отключена'}.`,
  );
}

/** Dialogs are addressed by user id, working chats by chat id. */
async function reply(
  services: AppServices,
  chatId: bigint,
  isDialog: boolean,
  actor: ResolvedActor,
  text: string,
): Promise<void> {
  await services.messages.send(isDialog ? { userId: actor.maxUserId } : { chatId }, { text });
}

function parseMaxId(raw: string): bigint {
  try {
    return BigInt(raw.trim());
  } catch {
    throw new ValidationError(`Некорректный MAX ID: ${raw}`);
  }
}

export function findCommand(name: string): CommandHandler | undefined {
  return COMMANDS[name];
}

export { REPORT_USAGE };
