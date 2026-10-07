import { randomUUID } from 'node:crypto';
import type { AppServices } from '../../app/container';
import type { IncidentWithRelations } from '../../incidents/incident.repository';
import { loadOutboundAttachments } from '../../media/attachment-loader';
import { isUnavailablePhoto } from '../../media/max-photo-reference';
import { incidentCallback } from '../../max/callback-payload';
import type { Button } from '../../max/max-types';
import { workingChatFor } from '../../users/working-chat';
import { ConflictError, ForbiddenError } from '../../utils/errors';
import { formatDateTime } from '../../utils/datetime';
import { assertResponder } from '../middleware/authorize';
import type { ResolvedActor } from '../handlers/helpers';
import { contextPages, executorSummary } from '../views/executor-context';
import { sectorCard } from '../views/cards';
import { sectorKeyboard } from '../keyboards';
import { leaseView } from '../../work-queues/leases';

type Route = { view: 'home' | 'original' | 'versions' | 'answer' | 'remarks' | 'files' | 'file' | 'draft' | 'latest-remarks' | 'back'; page?: number; fromPage?: number; answerId?: string; fileId?: string };
type State = { token: string; mid: string; incidentId: string; groupId: string; cycle: string; itemId?: string; actions: Route[] };
type Context = { services: AppServices; actor: ResolvedActor; chatId: bigint; incidentId: string; messageId?: string;
  privateItemId?: string; checkPrivate?: () => Promise<void>; backPrivate?: (guard: () => Promise<void>) => Promise<void> };
const stale = () => new ConflictError('Этот экран больше не активен. Откройте «Обращение и доработки» в текущей карточке.');
export const contextKey = (user: bigint, chat: bigint, item?: string) => `executor-context:${user}:${chat}:${item ?? 'chat'}`;
export const isExecutorContext = (action: string) => action === 'context' || action === 'context-page';
const orderedFiles = (rows: IncidentWithRelations['attachments'] | IncidentWithRelations['answers'][number]['attachments']) => [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

/** Read-only domain view: never calls claim, session.start/clear, submit or assign.
 * Only its bounded screen record and in-flight lock are written. */
export async function showExecutorContext(ctx: Context, argument?: string): Promise<void> {
  const { services, actor, chatId, incidentId } = ctx;
  const key = contextKey(actor.maxUserId, chatId, ctx.privateItemId), owner = randomUUID(), lockKey = `${key}:lock`;
  if (!await services.actionGuard.acquire({ key: lockKey, maxUserId: actor.maxUserId, action: owner, ttlMs: 120_000 })) throw new ConflictError('Предыдущая страница ещё загружается.');
  try {
    const authorize = async () => {
      await ctx.checkPrivate?.();
      const incident = await services.repository.findById(incidentId);
      const chat = await workingChatFor(services, chatId);
      if (!incident?.assignedGroup?.isActive || incident.assignedGroup.maxChatId !== chatId || !chat) throw new ForbiddenError('Обращение больше не доступно этой организации. Откройте текущую рабочую карточку.');
      const roles = [...new Set([...(await services.users.rolesOf(actor.maxUserId)), ...chat.roles])];
      assertResponder({ ...actor, roles, workingChat: chat }, incident, chatId);
      return incident;
    };
    let incident = await authorize();
    const cycle = () => incident.history[0]?.id ?? 'initial';
    const initialGroup = incident.assignedGroupId!, initialCycle = cycle();
    const guard = async () => {
      incident = await authorize();
      const lock = await services.prisma.actionLock.findUnique({ where: { key: lockKey } });
      if (incident.assignedGroupId !== initialGroup || cycle() !== initialCycle || lock?.action !== owner || lock.lockedUntil <= new Date()) throw stale();
    };
    const stored = await services.prisma.systemSetting.findUnique({ where: { key } });
    let old: State | undefined, route: Route = { view: 'home' };
    if (argument !== undefined) {
      try { old = stored && JSON.parse(stored.value); } catch { throw stale(); }
      const [token, index, extra] = argument.split('~');
      if (!old || extra || !index || !/^\d+$/.test(index) || old.token !== token || old.mid !== ctx.messageId || old.incidentId !== incidentId || old.groupId !== initialGroup || old.cycle !== initialCycle || old.itemId !== ctx.privateItemId) throw stale();
      route = old.actions[Number(index)]!;
      if (!route) throw stale();
    }
    // Consume before external I/O. Failure leaves a safe route to reopen the view;
    // a late network response cannot make an old token valid again.
    const owned = JSON.stringify({ token: owner });
    if (stored) {
      if (!(await services.prisma.systemSetting.updateMany({ where: { key, value: stored.value }, data: { value: owned } })).count) throw stale();
    } else await services.prisma.systemSetting.create({ data: { key, value: owned } });
    const target = ctx.privateItemId ? { userId: actor.maxUserId } : { chatId };
    if (route.view === 'back') {
      await guard();
      if (ctx.backPrivate) await ctx.backPrivate(guard);
      else await services.messages.send(target, { text: sectorCard(incident, incident.assignedGroup!, await leaseView(services.prisma, incidentId, 'sector-queue')),
        keyboard: sectorKeyboard(incidentId, { status: incident.status, hasTemplate: !!incident.assignedGroup!.answerTemplate }),
        replyToMessageId: incident.sectorMessageId ?? undefined, immediatePreview: true, beforeImmediateSend: guard });
      await services.prisma.systemSetting.deleteMany({ where: { key, value: owned } });
      return;
    }
    const answer = route.answerId ? incident.answers.find(a => a.id === route.answerId) : undefined;
    if (route.answerId && !answer) throw new ConflictError('Эта версия ответа не сохранена или уже недоступна. Откройте историю заново.');
    const files = orderedFiles(answer ? answer.attachments : incident.attachments);
    let fileNotice = '';
    if (route.view === 'file') {
      const file = files.find(f => f.id === route.fileId);
      if (!file) throw new ConflictError('Запись об этом вложении отсутствует. Откройте список заново.');
      try {
        const attachments = await loadOutboundAttachments(services.media, [file]);
        await guard();
        const delivered = await services.messages.send(target, { text: `${incident.publicCode} · ${answer ? `версия ${answer.version}` : 'исходное обращение'}\nВложение ${files.indexOf(file) + 1} из ${files.length}`,
          attachments, immediatePreview: true, beforeImmediateSend: guard });
        if (delivered.state !== 'sent') throw new Error('Attachment was not acknowledged');
        fileNotice = 'Вложение отправлено отдельным сообщением.';
      } catch (error) {
        await guard();
        const missing = (error as { code?: string }).code === 'ENOENT' || isUnavailablePhoto(error);
        fileNotice = missing ? 'Вложение недоступно: файл отсутствует или MAX больше не принимает фотографию. Остальные данные сохранены.'
          : 'Не удалось подтвердить отправку вложения. Проверьте сообщения перед повтором: результат может быть неизвестен.';
      }
      route = { ...route, view: 'files', fileId: undefined };
    }
    await guard();
    const token = randomUUID(), actions: Route[] = [];
    const button = (text: string, next: Route): Button => {
      const index = actions.push(next) - 1;
      const raw = incidentCallback('context-page', incidentId, `${token}~${index}`);
      return { type: 'callback', text, payload: ctx.privateItemId ? `personal:run:${ctx.privateItemId}:${raw}` : raw };
    };
    let text = `${incident.publicCode} · Только просмотр`, rows: Button[][] = [];
    const pages = (content: string, title: string) => {
      const chunks = contextPages(content), page = Math.min(route.page ?? 0, chunks.length - 1);
      text += `\n${title} · ${page + 1}/${chunks.length}\n\n${chunks[page]}`;
      const navigation: Button[] = [];
      if (page > 0) navigation.push(button('← Предыдущая страница', { ...route, page: page - 1 }));
      if (page + 1 < chunks.length) navigation.push(button('Следующая страница →', { ...route, page: page + 1 }));
      if (navigation.length) rows.push(navigation);
    };
    switch (route.view) {
      case 'home': {
        text += '\n\n' + executorSummary(incident).join('\n');
        rows.push([button('Исходный текст', { view: 'original' }), button('Исходные фотографии', { view: 'files' })]);
        const latest = incident.answers.at(-1);
        if (latest) rows.push([button(`Текущий ответ · версия ${latest.version}`, { view: 'answer', answerId: latest.id })]);
        if (incident.revisionReason) rows.push([button('Последнее замечание полностью', { view: 'latest-remarks' })]);
        rows.push([button('Мой незавершённый ввод', { view: 'draft' })], [button('История версий и замечаний', { view: 'versions' })]);
        break;
      }
      case 'latest-remarks': pages(incident.revisionReason ?? 'Последнее замечание не сохранено.', 'Последнее замечание — сводка обращения, без привязки к версии'); break;
      case 'original': pages(incident.text, 'Исходный текст обращения'); break;
      case 'versions': {
        const versions = [...incident.answers].sort((a, b) => b.version - a.version), page = Math.min(route.page ?? 0, Math.max(0, Math.ceil(versions.length / 6) - 1));
        text += '\nИстория: от новых версий к старым.\n' + (versions.length ? 'Выберите версию ответа.' : 'Сохранённых версий ответа нет.');
        if (incident.revisionCount > versions.filter(a => a.revisionReason).length) text += '\nСтарая история неполная: не для каждого возврата сохранилась связанная версия с замечанием.';
        rows.push(...versions.slice(page * 6, page * 6 + 6).map(a => [button(`Версия ${a.version} · ${formatDateTime(a.createdAt)}`, { view: 'answer', answerId: a.id })]));
        if (page > 0) rows.push([button('← Новее', { view: 'versions', page: page - 1 })]);
        if ((page + 1) * 6 < versions.length) rows.push([button('Старше →', { view: 'versions', page: page + 1 })]);
        break;
      }
      case 'answer':
        pages(answer!.text, `Версия ${answer!.version} · ${formatDateTime(answer!.createdAt)}${answer!.id === incident.answers.at(-1)?.id ? ' · последняя сохранённая' : ' · историческая'}`);
        rows.push([button('Замечание к этой версии', { view: 'remarks', answerId: answer!.id, fromPage: route.page }), button(`Вложения (${files.length})`, { view: 'files', answerId: answer!.id, fromPage: route.page })]);
        break;
      case 'remarks': pages(answer!.revisionReason ?? 'Замечание к этой версии не сохранено. Это не подтверждает отсутствие замечаний в старой истории.', `Замечание к версии ${answer!.version}`); break;
      case 'files': {
        const page = Math.min(route.page ?? 0, Math.max(0, Math.ceil(files.length / 6) - 1));
        text += `\n${answer ? `Вложения версии ${answer.version}` : 'Исходные вложения'}: ${files.length}\n${fileNotice}`;
        if (!files.length) text += '\nСохранённых записей о вложениях нет. Недостающие старые файлы восстановить из истории нельзя.';
        rows.push(...files.slice(page * 6, page * 6 + 6).map((f, n) => [button(`${f.type === 'IMAGE' ? 'Фото' : 'Файл'} ${page * 6 + n + 1}`, { ...route, view: 'file', fileId: f.id, page })]));
        if (page > 0) rows.push([button('← Предыдущие вложения', { ...route, page: page - 1 })]);
        if ((page + 1) * 6 < files.length) rows.push([button('Следующие вложения →', { ...route, page: page + 1 })]);
        break;
      }
      case 'draft': {
        // Direct reads: sessions.find may expire/delete a session. A viewer must not.
        const session = await services.prisma.operatorSession.findFirst({ where: { maxUserId: actor.maxUserId, chatId, incidentId, type: 'WAITING_FOR_ANSWER' } });
        const data = session?.data as { confirmation?: { body?: { text?: string } }; prefillText?: string; privateWorkspaceId?: string } | null;
        const item = ctx.privateItemId ? await services.prisma.privateWorkItem.findUnique({ where: { id: ctx.privateItemId } }) : null;
        const draft = (item?.data as { draft?: { text?: string } } | null)?.draft;
        pages(!ctx.privateItemId && data?.privateWorkspaceId ? 'Этот черновик подготовлен в личной работе. Откройте его в личном диалоге с ботом.' : draft?.text ?? data?.confirmation?.body?.text ?? data?.prefillText ?? 'Подготовленный текст ещё не сохранён. Последняя версия ответа доступна отдельно.', 'Мой незавершённый ввод — не отправлен');
        break;
      }
    }
    if (route.view !== 'home') {
      const toAnswer = route.view === 'remarks' || (route.view === 'files' && route.answerId);
      const answerIndex = [...incident.answers].sort((a, b) => b.version - a.version).findIndex(a => a.id === route.answerId);
      rows.push([button('Назад', toAnswer ? { view: 'answer', answerId: route.answerId, page: route.fromPage }
        : route.view === 'answer' ? { view: 'versions', page: Math.max(0, Math.floor(answerIndex / 6)) } : { view: 'home' })]);
    }
    rows.push([button('К текущей рабочей карточке', { view: 'back' })]);
    await guard();
    let mid = old?.mid;
    if (mid) {
      if (!await services.messages.editCardKeyboard(mid, text, rows)) throw new ConflictError('Не удалось обновить просмотр. Откройте «Обращение и доработки» заново. Подготовленный ответ сохранён.');
    } else {
      const sent = await services.messages.send(target, { text, keyboard: rows, immediatePreview: true, beforeImmediateSend: guard });
      if (sent.state !== 'sent' || !sent.firstMessageId) throw stale();
      mid = sent.keyboardMessageId ?? sent.firstMessageId;
    }
    await guard();
    const state: State = { token, mid, incidentId, groupId: initialGroup, cycle: initialCycle, itemId: ctx.privateItemId, actions };
    if (!(await services.prisma.systemSetting.updateMany({ where: { key, value: owned }, data: { value: JSON.stringify(state) } })).count) throw stale();
  } finally {
    await services.prisma.actionLock.deleteMany({ where: { key: lockKey, action: owner } });
  }
}
