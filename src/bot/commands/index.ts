import { InboxStatus, OutboxStatus, ResponsibleGroupKind, UserRole } from '@prisma/client';

import type { AppServices } from '../../app/container';
import { AuditAction } from '../../audit/admin-audit.service';
import { parseReportRange, REPORT_USAGE } from '../../reports/report-range';
import { formatRetentionPreview, formatRetentionRun } from '../../retention/retention.service';
import { AppError, ForbiddenError, ValidationError } from '../../utils/errors';
import { moduleLogger } from '../../utils/logger';
import { hasPermission } from '../../users/roles';
import { assertWorkingChat, requirePermission } from '../middleware/authorize';
import { reportPeriodKeyboard } from '../keyboards';
import { sendReport } from '../views/report';
import { incidentLookupCard, myIncidentsText, rulesText } from '../views/cards';
import { sendMainMenu } from '../handlers/requester.handler';
import type { ResolvedActor } from '../handlers/helpers';
import { adminAuditText, incidentHistoryText } from '../views/history';

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
  '/history <НОМЕР> — история обращения',
  '/report — выбрать период кнопками; можно и сразу: /report 7d, /report 01.08.2026 - 10.08.2026',
  '/resend <НОМЕР> — повторить доставку согласованного ответа',
  '/chatid — показать ID текущего чата',
  '',
  'Только для администратора:',
  '/ban <MAX_USER_ID> <причина>',
  '/unban <MAX_USER_ID>',
  '/categories — список тем обращения',
  '/category_add <КОД> <Название>',
  '/category_on <КОД> | /category_off <КОД>',
  '/category_name <КОД> <Новое название>',
  '/groups — список ответственных групп',
  '/group_chat <КОД> <CHAT_ID>',
  '/group_on <КОД> | /group_off <КОД>',
  '/group_name <КОД> <Новое название>',
  '/group_authority <КОД> <Подпись ответа | ->',
  '/group_template <КОД> <шаблон|-> ',
  '/role <MAX_USER_ID> <ADMIN,DISPATCHER,...|-> ',
  '/sla_check — принудительная проверка сроков',
  '/delivery_status — состояние очередей сообщений',
  '/delivery_errors — последние проблемы доставки',
  '/delivery_retry [КОД] — повторить одну или все неудачные исходящие доставки',
  '/retention_preview — показать, что удалится по правилу 90 дней',
  '/retention_run УДАЛИТЬ — запустить очистку после предварительной проверки',
  '/audit — последние административные изменения',
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

  history: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'incident.lookup');
    assertWorkingChat(isDialog);
    const code = args[0];
    if (!code) throw new ValidationError('Использование: /history INC-20260823-0001');
    const incident = await services.incidents.findByPublicCode(code);
    if (!incident) throw new AppError(`Обращение ${code.toUpperCase()} не найдено.`, 'NOT_FOUND');
    const entries = await services.history.listForIncident(incident.id);
    const actorIds = [...new Set(entries.flatMap((entry) => (entry.actorMaxUserId ? [entry.actorMaxUserId] : [])))];
    const users = actorIds.length
      ? await services.prisma.user.findMany({
          where: { maxUserId: { in: actorIds } },
          select: { maxUserId: true, displayName: true },
        })
      : [];
    await services.messages.send(
      { chatId },
      { text: incidentHistoryText(incident, entries, users, services.config.APP_TIMEZONE) },
    );
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
        text: sent === 'queued'
          ? `⏳ Ответ по ${incident.publicCode} ожидает доставки. Бот повторит отправку автоматически.`
          : sent === 'sent'
          ? `✅ Ответ по ${incident.publicCode} доставлен пользователю.`
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
    await recordAudit(services, actor, {
      action: AuditAction.USER_BANNED,
      targetType: 'пользователь',
      targetId: maxUserId.toString(),
      summary: `Заблокирован пользователь ${maxUserId.toString()}: ${reason}`,
      metadata: { reason },
    });
    await reply(services, chatId, isDialog, actor, `🚫 Пользователь ${maxUserId.toString()} заблокирован.`);
  },

  unban: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const rawId = args[0];
    if (!rawId) throw new ValidationError('Использование: /unban <MAX_USER_ID>');
    const maxUserId = parseMaxId(rawId);
    const lifted = await services.bans.unban(maxUserId);
    if (lifted > 0) {
      await recordAudit(services, actor, {
        action: AuditAction.USER_UNBANNED,
        targetType: 'пользователь',
        targetId: maxUserId.toString(),
        summary: `Снята блокировка пользователя ${maxUserId.toString()}`,
      });
    }
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

  /** Requester-facing topics; they no longer contain routing chat settings. */
  categories: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const categories = await services.categories.listAll();
    if (categories.length === 0) {
      await reply(services, chatId, isDialog, actor, 'Сферы не заданы.');
      return;
    }

    const active = categories.filter((item) => item.isActive);
    const disabled = categories.filter((item) => !item.isActive);

    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        `Темы обращения: ${categories.length}`,
        ...(active.length
          ? ['', `✅ Доступны пользователю (${active.length}):`, ...active.map((item) => `${item.code} — ${item.name}`)]
          : []),
        ...(disabled.length
          ? ['', `⛔ Отключены (${disabled.length}):`, ...disabled.map((item) => `${item.code} — ${item.name}`)]
          : []),
      ].join('\n'),
    );
  },

  groups: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const groups = await services.responsibleGroups.listAll();
    if (groups.length === 0) {
      await reply(services, chatId, isDialog, actor, 'Ответственные группы не заданы. Выполните npm run seed.');
      return;
    }
    const sections = [
      { kind: ResponsibleGroupKind.REGIONAL, title: 'Калужская область' },
      { kind: ResponsibleGroupKind.LOCAL_GOVERNMENT, title: 'Органы местного самоуправления' },
      { kind: ResponsibleGroupKind.EXECUTIVE_AUTHORITY, title: 'Органы исполнительной власти' },
    ];
    for (const section of sections) {
      const items = groups.filter((group) => group.kind === section.kind);
      await reply(
        services,
        chatId,
        isDialog,
        actor,
        [
          `${section.title} (${items.length}):`,
          '',
          ...items.map(
            (group) =>
              `${group.isActive ? '✅' : '⛔'} ${group.code} — ${group.name}\n` +
              `   чат: ${group.maxChatId?.toString() ?? 'не задан'}${group.bypassReview ? ' · без согласования' : ''}`,
          ),
        ].join('\n'),
      );
    }
  },

  category_add: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!code || !name) throw new ValidationError('Использование: /category_add <КОД> <Название>');
    const category = await services.categories.create({ code, name });
    await recordAudit(services, actor, {
      action: AuditAction.CATEGORY_CREATED,
      targetType: 'сфера',
      targetId: category.code,
      summary: `Создана сфера ${category.code} — ${category.name}`,
    });
    await reply(services, chatId, isDialog, actor, `Тема ${category.code} создана.`);
  },

  category_on: async (context) => setCategoryActive(context, true),
  category_off: async (context) => setCategoryActive(context, false),

  /** Renames the display label; the code stays put so history keeps matching. */
  category_name: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!code || !name) throw new ValidationError('Использование: /category_name <КОД> <Новое название>');
    const category = await services.categories.rename(code, name);
    await recordAudit(services, actor, {
      action: AuditAction.CATEGORY_RENAMED,
      targetType: 'сфера',
      targetId: category.code,
      summary: `Сфера ${category.code} переименована в «${category.name}»`,
    });
    await reply(services, chatId, isDialog, actor, `Сфера ${category.code} → «${category.name}»`);
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
    await recordAudit(services, actor, {
      action: AuditAction.ROLES_SET,
      targetType: 'пользователь',
      targetId: maxUserId.toString(),
      summary: `Роли пользователя ${maxUserId.toString()}: ${roles.length ? roles.join(', ') : 'сняты'}`,
      metadata: { roles },
    });
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
    await recordAudit(services, actor, {
      action: AuditAction.SLA_SWEEP,
      summary: `Запущена ручная SLA-проверка: проверено ${result.checked}, просрочено ${result.overdue}`,
      metadata: result,
    });
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

  group_chat: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, rawChatId] = args;
    if (!code || !rawChatId) throw new ValidationError('Использование: /group_chat <КОД> <CHAT_ID>');
    const group = await services.responsibleGroups.setChatId(code, parseMaxId(rawChatId));
    await recordAudit(services, actor, {
      action: AuditAction.GROUP_CHAT_SET,
      targetType: 'ответственная группа',
      targetId: group.code,
      summary: `Для группы ${group.code} задан чат ${group.maxChatId?.toString()}`,
      metadata: { chatId: group.maxChatId?.toString() },
    });
    await reply(services, chatId, isDialog, actor, `Группа ${group.code} → чат ${group.maxChatId?.toString()}`);
  },

  group_on: async (context) => setGroupActive(context, true),
  group_off: async (context) => setGroupActive(context, false),

  group_name: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    const name = nameParts.join(' ').trim();
    if (!code || !name) throw new ValidationError('Использование: /group_name <КОД> <Новое название>');
    const group = await services.responsibleGroups.rename(code, name);
    await recordAudit(services, actor, {
      action: AuditAction.GROUP_RENAMED,
      targetType: 'ответственная группа',
      targetId: group.code,
      summary: `Группа ${group.code} переименована в «${group.name}»`,
    });
    await reply(services, chatId, isDialog, actor, `Группа ${group.code} → «${group.name}»`);
  },

  group_authority: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...nameParts] = args;
    if (!code) throw new ValidationError('Использование: /group_authority <КОД> <Подпись ответа | ->');
    const raw = nameParts.join(' ').trim();
    const group = await services.responsibleGroups.setAuthority(code, raw === '' || raw === '-' ? null : raw);
    await recordAudit(services, actor, {
      action: AuditAction.GROUP_AUTHORITY_SET,
      targetType: 'ответственная группа',
      targetId: group.code,
      summary: group.authorityName
        ? `Для группы ${group.code} задана подпись «${group.authorityName}»`
        : `Для группы ${group.code} удалена подпись`,
    });
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      group.authorityName
        ? `Ответы группы ${group.code} будут подписаны «${group.authorityName}».`
        : `Подпись ответов группы ${group.code} убрана.`,
    );
  },

  group_template: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const [code, ...templateParts] = args;
    if (!code) throw new ValidationError('Использование: /group_template <КОД> <шаблон | ->');
    const raw = templateParts.join(' ').trim();
    const group = await services.responsibleGroups.setTemplate(code, raw === '-' || raw === '' ? null : raw);
    await recordAudit(services, actor, {
      action: AuditAction.GROUP_TEMPLATE_SET,
      targetType: 'ответственная группа',
      targetId: group.code,
      summary: group.answerTemplate
        ? `Для группы ${group.code} обновлён шаблон ответа`
        : `Для группы ${group.code} удалён шаблон ответа`,
    });
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      group.answerTemplate ? `Шаблон группы ${group.code} обновлён.` : `Шаблон группы ${group.code} удалён.`,
    );
  },

  delivery_status: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const [outPending, outSending, outFailed, inPending, inProcessing, inFailed] = await Promise.all([
      services.prisma.outboundMessage.count({ where: { status: OutboxStatus.PENDING } }),
      services.prisma.outboundMessage.count({ where: { status: OutboxStatus.SENDING } }),
      services.prisma.outboundMessage.count({ where: { status: OutboxStatus.FAILED } }),
      services.prisma.inboundUpdate.count({ where: { status: InboxStatus.PENDING } }),
      services.prisma.inboundUpdate.count({ where: { status: InboxStatus.PROCESSING } }),
      services.prisma.inboundUpdate.count({ where: { status: InboxStatus.FAILED } }),
    ]);
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        'Очереди доставки:',
        `Исходящие — ждут: ${outPending}, отправляются: ${outSending}, требуют внимания: ${outFailed}`,
        `Входящие — ждут: ${inPending}, обрабатываются: ${inProcessing}, требуют внимания: ${inFailed}`,
      ].join('\n'),
    );
  },

  delivery_errors: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const problems = await services.deliveryProblems.recent(10);
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      problems.length > 0
        ? formatDeliveryProblems(problems, services.config)
        : 'Проблем доставки, требующих внимания, нет.',
    );
  },

  delivery_retry: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    const reference = args[0]?.trim().toLowerCase();
    if (reference && !/^[a-f0-9-]{6,36}$/.test(reference)) {
      throw new ValidationError('Код ошибки некорректен. Скопируйте его из /delivery_errors.');
    }
    const result = await services.deliveryProblems.retryFailedOutbound(reference);
    if (result.status === 'not_found') {
      throw new ValidationError('Исходящая ошибка с таким кодом не найдена или уже исправлена.');
    }
    if (result.status === 'ambiguous') {
      throw new ValidationError('Код совпал с несколькими ошибками. Укажите больше символов кода.');
    }
    if (result.count > 0) await services.messages.flush();
    const label = result.reference
      ? `Ошибка ${result.reference}${result.incidentCode ? ` (${result.incidentCode})` : ''}`
      : 'Все неудачные исходящие сообщения';
    if (result.count > 0) {
      await recordAudit(services, actor, {
        action: AuditAction.DELIVERY_RETRIED,
        targetType: result.reference ? 'ошибка доставки' : 'очередь доставки',
        targetId: result.reference,
        summary: result.reference
          ? `Повторно запущена доставка ${result.reference}${result.incidentCode ? ` (${result.incidentCode})` : ''}`
          : `Повторно запущены все неудачные исходящие сообщения: ${result.count}`,
        metadata: {
          count: result.count,
          ...(result.incidentCode ? { incidentCode: result.incidentCode } : {}),
        },
      });
    }
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      result.count > 0
        ? `${label}: повторно поставлено в очередь.`
        : 'Неудачных исходящих доставок нет.',
    );
  },

  retention_preview: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    assertWorkingChat(isDialog);
    const preview = await services.retention.preview();
    await reply(
      services,
      chatId,
      isDialog,
      actor,
      [
        formatRetentionPreview(preview),
        '',
        preview.incidents > 0
          ? 'Для запуска: /retention_run УДАЛИТЬ'
          : 'Сейчас удалять нечего.',
      ].join('\n'),
    );
  },

  retention_run: async ({ services, actor, chatId, isDialog, args }) => {
    requirePermission(actor, 'admin.manage');
    assertWorkingChat(isDialog);
    if (args.join(' ').trim().toUpperCase() !== 'УДАЛИТЬ') {
      throw new ValidationError('Сначала выполните /retention_preview, затем подтвердите: /retention_run УДАЛИТЬ');
    }
    const result = await services.retention.run();
    await recordAudit(services, actor, {
      action: AuditAction.RETENTION_RUN,
      targetType: 'завершённые обращения',
      summary: `Очистка хранения: удалено ${result.deletedIncidents}, ошибок ${result.failures.length}`,
      metadata: {
        cutoff: result.preview.cutoff.toISOString(),
        deletedIncidents: result.deletedIncidents,
        deletedFiles: result.deletedFiles,
        deletedBytes: result.deletedBytes,
        deletedRequesterProfiles: result.deletedRequesterProfiles,
        failures: result.failures.length,
        skippedBecauseLocked: result.skippedBecauseLocked,
      },
    });
    await reply(services, chatId, isDialog, actor, formatRetentionRun(result));
  },

  audit: async ({ services, actor, chatId, isDialog }) => {
    requirePermission(actor, 'admin.manage');
    const entries = await services.audit.recent(20);
    await reply(services, chatId, isDialog, actor, adminAuditText(entries, services.config.APP_TIMEZONE));
  },
};

export function formatDeliveryProblems(
  problems: import('../../delivery/delivery-problem.service').DeliveryProblem[],
  config: AppServices['config'],
): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.APP_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const blocks = problems.map((problem) => {
    const lines = [
      `${problem.direction === 'outbound' ? '📤' : '📥'} Ошибка ${problem.reference}`,
      `Когда: ${formatter.format(problem.occurredAt)}`,
      `Что: ${problem.description}`,
      ...(problem.incidentCode ? [`Обращение: ${problem.incidentCode}`] : []),
      ...(problem.targetId
        ? [`Получатель: ${problem.targetType === 'user' ? 'пользователь' : 'чат'} ${problem.targetId.toString()}`]
        : []),
      `Попыток: ${problem.attempts}`,
      ...(problem.textPreview ? [`Контекст: ${problem.textPreview}`] : []),
      ...(problem.error ? [`Причина: ${redactSecrets(problem.error, config)}`] : []),
      problem.direction === 'outbound'
        ? `Повторить: /delivery_retry ${problem.reference}`
        : 'Входящее событие автоматически не повторять — сначала нужна ручная проверка.',
    ];
    return lines.join('\n');
  });
  return ['Последние проблемы доставки:', '', ...blocks.flatMap((block, index) => (index ? ['', block] : [block]))].join(
    '\n',
  );
}

function redactSecrets(value: string, config: AppServices['config']): string {
  let result = value;
  const secrets = [
    config.BOT_TOKEN,
    config.WEBHOOK_SECRET,
    config.S3_ACCESS_KEY_ID,
    config.S3_SECRET_ACCESS_KEY,
    config.DATABASE_URL,
  ];
  try {
    secrets.push(new URL(config.DATABASE_URL).password);
  } catch {
    // Configuration validation reports an invalid URL elsewhere.
  }
  for (const secret of secrets) {
    if (!secret || secret.length < 4) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), '[скрыто]');
  }
  result = result.replace(/\b(authorization|token|password|secret)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[скрыто]');
  return Array.from(result).length <= 300 ? result : `${Array.from(result).slice(0, 299).join('')}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function setCategoryActive(context: CommandContext, isActive: boolean): Promise<void> {
  const { services, actor, chatId, isDialog, args } = context;
  requirePermission(actor, 'admin.manage');
  const code = args[0];
  if (!code) throw new ValidationError(`Использование: /category_${isActive ? 'on' : 'off'} <КОД>`);
  const category = await services.categories.setActive(code, isActive);
  await recordAudit(services, actor, {
    action: isActive ? AuditAction.CATEGORY_ENABLED : AuditAction.CATEGORY_DISABLED,
    targetType: 'сфера',
    targetId: category.code,
    summary: `Сфера ${category.code} ${isActive ? 'включена' : 'отключена'}`,
  });
  await reply(
    services,
    chatId,
    isDialog,
    actor,
    `Сфера ${category.code} ${isActive ? 'включена' : 'отключена'}.`,
  );
}

async function setGroupActive(context: CommandContext, isActive: boolean): Promise<void> {
  const { services, actor, chatId, isDialog, args } = context;
  requirePermission(actor, 'admin.manage');
  const code = args[0];
  if (!code) throw new ValidationError(`Использование: /group_${isActive ? 'on' : 'off'} <КОД>`);
  const group = await services.responsibleGroups.setActive(code, isActive);
  await recordAudit(services, actor, {
    action: isActive ? AuditAction.GROUP_ENABLED : AuditAction.GROUP_DISABLED,
    targetType: 'ответственная группа',
    targetId: group.code,
    summary: `Группа ${group.code} ${isActive ? 'включена' : 'отключена'}`,
  });
  await reply(
    services,
    chatId,
    isDialog,
    actor,
    `Группа ${group.code} ${isActive ? 'включена' : 'отключена'}.`,
  );
}

async function recordAudit(
  services: AppServices,
  actor: ResolvedActor,
  entry: {
    action: string;
    summary: string;
    targetType?: string | undefined;
    targetId?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  },
): Promise<void> {
  await services.audit.record({
    ...entry,
    actorMaxUserId: actor.maxUserId,
    actorName: actor.displayName,
  });
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
