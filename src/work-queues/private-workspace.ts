import { randomUUID } from 'node:crypto';
import { Prisma, SessionType, type PrivateWorkItem } from '@prisma/client';
import type { AppServices } from '../app/container';
import { acquireAdvisoryLock, TRANSACTION_OPTIONS } from '../database/prisma';
import type { IncidentWithRelations } from '../incidents/incident.repository';
import { loadOutboundAttachments } from '../media/attachment-loader';
import { classifyAttachments } from '../media/media.service';
import type { Button, Message } from '../max/max-types';
import type { CompositeMessage } from '../max/max-message.service';
import { parseCallbackPayload } from '../max/callback-payload';
import { workingChatFor } from '../users/working-chat';
import { ConflictError, ForbiddenError, ValidationError } from '../utils/errors';
import { formatDateTime } from '../utils/datetime';
import { assertDispatcher, assertApprover, assertResponder, assertWorkingChat } from '../bot/middleware/authorize';
import type { ResolvedActor } from '../bot/handlers/helpers';
import { handleIncidentCallback } from '../bot/callbacks/incident.callbacks';
import { handleOperatorMessage } from '../bot/handlers/operator.handler';
import { distributionKeyboard, sectorKeyboard, reviewKeyboard } from '../bot/keyboards';
import { incidentLookupCard, reviewCard } from '../bot/views/cards';
import { leaseText, SECTOR_LEASE_ACTION } from './leases';
import { queueMessage } from '../delivery/workflow-outbox';

type Snapshot = { type: SessionType; data: Record<string, unknown> };
type Draft = { text: string; attachments: Message['body']['attachments']; nonce: string; sourceMessageId: string };
type WorkData = { cycle?: string; session?: Snapshot; draft?: Draft; pending?: { raw: string; title: string; nonce: string }; leaseUntil?: string };
type Scope = { item: PrivateWorkItem; incident: IncidentWithRelations; actor: ResolvedActor; kind: 'distribution' | 'review' | 'sector'; active: boolean };
const dataOf = (item: PrivateWorkItem) => item.data as unknown as WorkData;
const json = (data: WorkData) => JSON.parse(JSON.stringify(data)) as Prisma.InputJsonValue;
const cycleOf = (incident: IncidentWithRelations) => `${incident.history?.[0]?.id ?? 'initial'}:${incident.answers.at(-1)?.id ?? 'none'}`;
const cb = (action: string, id?: string, argument?: string): Button => ({ type: 'callback', text: action, payload: ['personal', action, id, argument].filter(v => v !== undefined).join(':') });
const button = (text: string, action: string, id?: string, argument?: string): Button => ({ ...cb(action, id, argument), text });
const navigation = (): Button[][] => [[button('Моя работа', 'home'), button('Меню жителя', 'resident')]];
const botLinks = new WeakMap<AppServices, Promise<string>>();

export async function withPersonalWorkLock<T>(services: AppServices, userId: bigint, operation: () => Promise<T>): Promise<T> {
  const key = `private-work:${userId}`;
  if (!await services.actionGuard.acquire({ key, action: 'private-work', maxUserId: userId, ttlMs: 120_000 })) throw new ConflictError('Предыдущее действие ещё выполняется. Подождите подтверждения бота.');
  try { return await operation(); } finally { await services.actionGuard.release(key); }
}

async function botLink(services: AppServices, payload: string): Promise<string> {
  let base = botLinks.get(services);
  if (!base) {
    base = services.max.api.getMyInfo().then(info => {
      const name = info.username?.replace(/^@/, '');
      if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) throw new ConflictError('Не удалось получить ссылку на бота. Откройте личный чат и отправьте /work.');
      return `https://max.ru/${name}`;
    }).catch(error => { botLinks.delete(services); throw error; });
    botLinks.set(services, base);
  }
  return `${await base}?start=${encodeURIComponent(payload)}`;
}

/** A private update cannot prove group membership: always ask MAX, including for admins. */
async function actorInChat(services: AppServices, actor: ResolvedActor, chatId: bigint): Promise<ResolvedActor> {
  const workingChat = await workingChatFor(services, chatId);
  if (!workingChat) throw new ForbiddenError('Рабочий чат больше не подключён.');
  const result = await services.max.api.getChatMembers(Number(chatId), { user_ids: [Number(actor.maxUserId)] });
  if (!result.members.some(member => BigInt(member.user_id) === actor.maxUserId && !member.is_bot)) {
    throw new ForbiddenError('Вы больше не участник рабочего чата. Доступ к обращению закрыт.');
  }
  return { ...actor, workingChat, roles: [...new Set([...actor.roles, ...workingChat.roles])], role: [...new Set([...actor.roles, ...workingChat.roles])].join('|') };
}

async function scope(services: AppServices, actor: ResolvedActor, id: string): Promise<Scope> {
  const item = await services.prisma.privateWorkItem.findFirst({ where: { id, maxUserId: actor.maxUserId } });
  if (!item) throw new ForbiddenError('Это рабочее пространство другого сотрудника или оно уже удалено.');
  const scoped = await actorInChat(services, actor, item.originChatId);
  const incident = await services.repository.findById(item.incidentId);
  if (!incident) throw new ConflictError('Обращение уже удалено.');
  if (scoped.workingChat!.distribution) return { item, actor: scoped, incident, kind: 'distribution', active: incident.status === 'DISTRIBUTION' };
  if (scoped.workingChat!.review) return { item, actor: scoped, incident, kind: 'review', active: incident.status === 'WAITING_REVIEW' };
  if (incident.assignedGroup?.maxChatId !== item.originChatId) throw new ForbiddenError('Обращение передано в другую организацию. Откройте «Моя работа».');
  return { item, actor: scoped, incident, kind: 'sector', active: ['ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED'].includes(incident.status) };
}

async function lease(services: AppServices, s: Scope) {
  if (!s.active) return null;
  if (s.kind === 'distribution') return s.incident.distributionClaimUntil && s.incident.distributionClaimUntil > new Date()
    ? { name: s.incident.distributionClaimedName ?? 'Сотрудник', until: s.incident.distributionClaimUntil, owner: s.incident.distributionClaimedBy } : null;
  const row = await services.prisma.actionLock.findFirst({ where: { incidentId: s.item.incidentId, action: s.kind === 'review' ? 'review-queue' : SECTOR_LEASE_ACTION, lockedUntil: { gt: new Date() } } });
  if (!row) return null;
  const user = await services.prisma.user.findUnique({ where: { maxUserId: row.maxUserId } });
  return { name: user?.displayName ?? 'Сотрудник', until: row.lockedUntil, owner: row.maxUserId };
}

async function save(services: AppServices, item: PrivateWorkItem, data: WorkData) {
  await services.prisma.privateWorkItem.update({ where: { id: item.id }, data: { data: json(data) } });
}
async function select(services: AppServices, item: PrivateWorkItem) {
  await services.prisma.$transaction(async tx => {
    await acquireAdvisoryLock(tx, 'private-selection', item.maxUserId.toString());
    await tx.privateWorkItem.updateMany({ where: { maxUserId: item.maxUserId, selected: true }, data: { selected: false } });
    await tx.privateWorkItem.update({ where: { id: item.id }, data: { selected: true, openedAt: new Date() } });
  }, TRANSACTION_OPTIONS);
}
async function snapshot(services: AppServices, item: PrivateWorkItem) {
  const current = await services.sessions.find(item.maxUserId, item.originChatId);
  if (!current || current.incidentId !== item.incidentId) return;
  const fresh = await services.prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } });
  await save(services, fresh, { ...dataOf(fresh), session: { type: current.type, data: (current.data ?? {}) as Record<string, unknown> } });
}

function wrapButtons(rows: Button[][] | undefined, item: PrivateWorkItem): Button[][] {
  return (rows ?? []).map(row => row.flatMap(b => {
    if (b.type !== 'callback') return [b];
    const p = parseCallbackPayload(b.payload);
    if (!p || (p.kind === 'incident' && ['personal', 'ban'].includes(p.action))) return [];
    if (p.kind === 'session') return [button(b.text, p.action === 'cancel' ? 'cancel' : 'show', item.id)];
    if (p.kind === 'incident' && p.action === 'cancel') return [button(b.text, 'cancel', item.id)];
    if ((p.kind === 'work' || p.kind === 'queue') && p.action === 'release') return [button(b.text, 'release', item.id)];
    if (p.kind !== 'incident' || p.incidentId !== item.incidentId) return [];
    return [button(b.text, 'run', item.id, b.payload)];
  })).filter(row => row.length);
}

/** Only UI replies are redirected. Business services retain the real group/outbox transport. */
function personalServices(services: AppServices, item: PrivateWorkItem, code: string): AppServices {
  const messages = new Proxy(services.messages, { get(target, property) {
    if (property === 'send') return async (destination: { chatId?: bigint; userId?: bigint }, message: CompositeMessage) => {
      if (destination.chatId !== item.originChatId) return target.send(destination as never, message);
      return target.send({ userId: item.maxUserId }, { ...message, text: `💼 ${code}\n\n${message.text}`, keyboard: [...wrapButtons(message.keyboard, item), ...navigation()], delivery: undefined });
    };
    if (property === 'editCardKeyboard') return (id: string, text: string, rows: Button[][]) => target.editCardKeyboard(id, `💼 ${code}\n\n${text}`, [...wrapButtons(rows, item), ...navigation()]);
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const sessions = new Proxy(services.sessions, { get(target, property) {
    if (property === 'start') return async (input: Parameters<typeof target.start>[0]) => {
      const result = await target.start({ ...input, data: { ...input.data, privateWorkspaceId: item.id } });
      await snapshot(services, item); return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...services, messages, sessions };
}

async function take(services: AppServices, s: Scope) {
  if (!s.active) throw new ConflictError('Обращение уже перешло на другой этап.');
  const oldData = dataOf(s.item);
  if (oldData.cycle && oldData.cycle !== cycleOf(s.incident) && (oldData.draft || oldData.session)) throw new ConflictError('По обращению уже появился новый ответ или новое назначение. Старый черновик не отправлен. Отмените старое действие и начните заново.');
  if (s.kind === 'distribution') await services.distributionQueue.claim(s.actor, s.item.originChatId, s.item.incidentId);
  else if (s.kind === 'review') await services.workQueues.claimReview(s.actor, s.item.originChatId, s.item.incidentId);
  else if ((await lease(services, s))?.owner !== s.actor.maxUserId) await services.sector.takeInWork(s.item.incidentId, s.actor);
  const fresh = await scope(services, s.actor, s.item.id);
  const owned = await lease(services, fresh);
  if (owned?.owner !== s.actor.maxUserId) throw new ConflictError('Не удалось закрепить обращение.');
  const data = dataOf(fresh.item);
  if (data.cycle && data.cycle !== cycleOf(fresh.incident) && (data.draft || data.session)) {
    throw new ConflictError('По обращению уже появился новый ответ или новое назначение. Старый черновик не отправлен. Отмените старое действие и начните заново.');
  }
  const next: WorkData = { ...data, cycle: cycleOf(fresh.incident), leaseUntil: owned.until.toISOString() };
  const live = await services.sessions.find(s.actor.maxUserId, s.item.originChatId);
  if (live && live.incidentId !== s.item.incidentId) throw new ConflictError('В этом рабочем чате у вас есть другое незавершённое действие. Сначала завершите или отмените его.');
  const previous = next.session ?? (live ? { type: live.type, data: (live.data ?? {}) as Record<string, unknown> } : undefined);
  if (previous) {
    const sessionData: Record<string, unknown> = { ...previous.data, privateWorkspaceId: s.item.id };
    if (s.kind === 'distribution') sessionData.distributionLeaseUntil = owned.until.toISOString();
    else sessionData.leaseUntil = owned.until.toISOString();
    await services.sessions.start({ maxUserId: s.actor.maxUserId, chatId: s.item.originChatId, incidentId: s.item.incidentId, type: previous.type, data: sessionData });
    next.session = { type: previous.type, data: sessionData };
  }
  await save(services, fresh.item, next);
}

export async function invitePersonalWork(services: AppServices, actor: ResolvedActor, chatId: bigint, incidentId?: string) {
  await assertWorkingChat(services, chatId);
  let payload = 'staff_home';
  let title = `${actor.displayName}, откройте свою работу в личном диалоге с ботом.`;
  if (incidentId) {
    const incident = await services.repository.findById(incidentId);
    if (!incident) throw new ConflictError('Обращение не найдено.');
    if (chatId === services.config.DISTRIBUTION_CHAT_ID) assertDispatcher(services, actor, chatId);
    else if (chatId === services.config.REVIEW_CHAT_ID) assertApprover(services, actor, chatId);
    else { assertResponder(actor, incident, chatId); if (incident.assignedGroup?.maxChatId !== chatId) throw new ForbiddenError('Откройте текущий профильный чат.'); }
    const item = await services.prisma.privateWorkItem.upsert({ where: { maxUserId_incidentId_originChatId: { maxUserId: actor.maxUserId, incidentId, originChatId: chatId } },
      create: { maxUserId: actor.maxUserId, incidentId, originChatId: chatId }, update: {} });
    const s = await scope(services, actor, item.id); await take(services, s);
    payload = `staff_${item.id}`;
    title = `👤 ${actor.displayName}\n${incident.publicCode} закреплено за вами.\n\nПродолжите в личном диалоге: там бот покажет текущий шаг. Текст ответа отправляйте в личный диалог.`;
  }
  await services.messages.send({ chatId }, { text: title, keyboard: [[{ type: 'link', text: 'Продолжить в боте', url: await botLink(services, payload) }]] });
  return 'Перейдите по кнопке «Продолжить в боте»';
}

function stage(data: WorkData): string {
  if (data.draft && !data.draft.nonce) return 'Бот ждёт исправленный текст и все нужные вложения одним сообщением.';
  if (data.draft || data.pending) return 'Текст или действие подготовлены. Бот ждёт подтверждения кнопкой.';
  if (data.session?.type === 'WAITING_FOR_ANSWER') return 'Бот ждёт текст ответа и, при необходимости, фото или файлы одним сообщением.';
  if (data.session?.type === 'WAITING_REVISION_REASON') return data.session.data.redistribution ? 'Бот ждёт причину перераспределения.' : 'Бот ждёт замечания для доработки ответа.';
  if (data.session?.type === 'WAITING_REJECTION_REASON') return data.session.data.rejectionStage === 'text' ? 'Бот ждёт причину отклонения.' : 'Продолжите отклонение кнопками ниже.';
  return 'Бот пока не ждёт текст. Выберите действие кнопкой.';
}

export async function showPersonalWork(services: AppServices, actor: ResolvedActor, id: string, details = false) {
  const s = await scope(services, actor, id); const data = dataOf(s.item); const owned = await lease(services, s);
  if (!s.active) {
    await services.messages.send({ userId: actor.maxUserId }, { text: `${s.incident.publicCode}: работа на этом этапе завершена. Бот не ждёт от вас сообщения.`, keyboard: navigation() }); return;
  }
  const active = owned?.owner === actor.maxUserId;
  let rows: Button[][] = [];
  let text = `💼 ${s.incident.publicCode}\n${s.kind === 'distribution' ? 'Распределение' : s.kind === 'review' ? 'Согласование' : 'Подготовка ответа'}\n${leaseText(owned)}\n\n${active ? stage(data) : 'Закрепление завершено или обращение занято коллегой. Сохранённый черновик не отправлен. Для продолжения заново возьмите обращение.'}`;
  if (data.draft) {
    text += `\n\nПодготовленный текст:\n${data.draft.text}\nВложений: ${data.draft.attachments?.length ?? 0}`;
    if (active && data.draft.nonce) rows.push([button('Верно — отправить', 'confirm', id, data.draft.nonce), button('Исправить', 'back', id)]);
  } else if (data.pending) {
    text += `\n\n${data.pending.title}`;
    if (active) rows.push([button('Подтвердить', 'confirm', id, data.pending.nonce), button('Назад', 'back', id)]);
  } else if (active && data.session?.type === 'WAITING_REJECTION_REASON') {
    // Reuse the version-bound rejection buttons through the private UI adapter.
    const { resumeRejection } = await import('../bot/callbacks/rejection-flow');
    const live = await services.sessions.find(actor.maxUserId, s.item.originChatId);
    if (live) { await resumeRejection(personalServices(services, s.item, s.incident.publicCode), live); return; }
  } else if (active && !data.session) {
    rows = wrapButtons(s.kind === 'distribution' ? distributionKeyboard(s.incident.id) : s.kind === 'review'
      ? reviewKeyboard(s.incident.id, s.incident.answers.at(-1)!.id)
      : sectorKeyboard(s.incident.id, { status: s.incident.status, hasTemplate: !!s.incident.assignedGroup?.answerTemplate }), s.item);
  }
  if (details) text += `\n\n${s.kind === 'review' ? reviewCard(s.incident, s.incident.answers.at(-1)!, s.incident.assignedGroup, owned) : incidentLookupCard(s.incident, owned)}`;
  else text += `\n\nОбращение:\n${s.incident.text}`;
  rows.push([button('Показать обращение', 'details', id), button('Обновить состояние', 'show', id)]);
  rows.push(active ? [button('Освободить', 'release', id), button('Отменить действие', 'cancel', id)] : [button('Взять и продолжить', 'resume', id), button('Отменить старое действие', 'cancel', id)]);
  await services.messages.send({ userId: actor.maxUserId }, { text, keyboard: [...rows, ...navigation()],
    ...(details ? { attachments: await loadOutboundAttachments(services.media, s.kind === 'review' ? s.incident.answers.at(-1)!.attachments : s.incident.attachments) } : {}) });
}

export async function personalHome(services: AppServices, actor: ResolvedActor, page = 0) {
  // Include work already taken in groups, even before its first private opening.
  const claims = await services.prisma.incident.findMany({ where: { OR: [{ distributionClaimedBy: actor.maxUserId, distributionClaimUntil: { gt: new Date() } },
    { id: { in: (await services.prisma.actionLock.findMany({ where: { maxUserId: actor.maxUserId, action: { in: ['sector-queue', 'review-queue'] }, lockedUntil: { gt: new Date() } } })).flatMap(l => l.incidentId ? [l.incidentId] : []) } }] }, include: { assignedGroup: true } });
  for (const i of claims) {
    const chatId = i.status === 'DISTRIBUTION' ? services.config.DISTRIBUTION_CHAT_ID : i.status === 'WAITING_REVIEW' ? services.config.REVIEW_CHAT_ID : i.assignedGroup?.maxChatId;
    if (chatId) await services.prisma.privateWorkItem.upsert({ where: { maxUserId_incidentId_originChatId: { maxUserId: actor.maxUserId, incidentId: i.id, originChatId: chatId } }, create: { maxUserId: actor.maxUserId, incidentId: i.id, originChatId: chatId }, update: {} });
  }
  const items = await services.prisma.privateWorkItem.findMany({ where: { maxUserId: actor.maxUserId, incident: { status: { in: ['DISTRIBUTION', 'ASSIGNED', 'IN_PROGRESS', 'REVISION_REQUIRED', 'WAITING_REVIEW'] } } }, orderBy: { updatedAt: 'desc' } });
  const visible: Scope[] = [];
  for (const item of items) { try { const s = await scope(services, actor, item.id); if (s.active) visible.push(s); } catch { /* No cached grants or titles on an unverifiable membership. */ } }
  page = Math.min(Math.max(0, page), Math.max(0, Math.ceil(visible.length / 8) - 1));
  const slice = visible.slice(page * 8, page * 8 + 8);
  const current = visible.find(s => s.item.selected);
  const currentStage = current && (await lease(services, current))?.owner === actor.maxUserId ? stage(dataOf(current!.item)) : 'Закрепление завершено. Для продолжения заново возьмите обращение.';
  await services.messages.send({ userId: actor.maxUserId }, { text: `💼 МОЯ РАБОТА\n\n${current ? `Сейчас выбрано: ${current.incident.publicCode}.\n${currentStage}\n\n` : ''}${visible.length ? `Доступных обращений: ${visible.length}. Выберите, с каким продолжить.` : 'Доступных обращений нет. Возьмите обращение в рабочем чате и нажмите «Работать лично». Если доступ недавно менялся, обновите список.'}`, keyboard: [
    ...slice.map(s => [button(`${s.incident.publicCode} · ${s.kind === 'distribution' ? 'распределение' : s.kind === 'review' ? 'согласование' : 'исполнение'}${dataOf(s.item).draft ? ' · черновик' : ''}`, 'open', s.item.id)]),
    ...(visible.length > 8 ? [[button('←', 'home', undefined, String(Math.max(0, page - 1))), button('→', 'home', undefined, String(page + 1))]] : []), ...navigation(),
  ] });
}

export async function enterPersonalWork(services: AppServices, actor: ResolvedActor, id: string) {
  const s = await scope(services, actor, id);
  await select(services, s.item);
  if (s.active) await take(services, s).catch(async error => services.messages.send({ userId: actor.maxUserId }, { text: error instanceof Error ? error.message : 'Не удалось взять обращение.', keyboard: navigation() }));
  await showPersonalWork(services, actor, id, true);
}

export async function exitPersonalWork(services: AppServices, maxUserId: bigint) {
  await services.prisma.privateWorkItem.updateMany({ where: { maxUserId, selected: true }, data: { selected: false } });
}

async function requireOwnLease(services: AppServices, s: Scope) {
  if (!s.active || (await lease(services, s))?.owner !== s.actor.maxUserId) throw new ConflictError('Закрепление завершено. Черновик сохранён. Нажмите «Взять и продолжить».');
  if (dataOf(s.item).cycle !== cycleOf(s.incident)) throw new ConflictError('Этап обращения изменился. Старый черновик не отправлен.');
}

async function run(services: AppServices, s: Scope, raw: string, messageId?: string) {
  const p = parseCallbackPayload(raw);
  if (!p || p.kind !== 'incident' || p.incidentId !== s.item.incidentId || ['personal', 'ban', 'clarify', 'clarify-send', 'clarify-cancel'].includes(p.action)) throw new ForbiddenError('Эта кнопка недоступна в личной работе.');
  const adapted = personalServices(services, s.item, s.incident.publicCode);
  const result = await handleIncidentCallback({ services: adapted, actor: s.actor, chatId: s.item.originChatId, messageId }, p);
  await snapshot(services, s.item);
  if (p.action === 'reject-cancel') await save(services, s.item, { cycle: cycleOf(s.incident), leaseUntil: dataOf(s.item).leaseUntil });
  if (result) await services.messages.send({ userId: s.actor.maxUserId }, { text: result, keyboard: navigation() });
}

export async function personalAction(services: AppServices, actor: ResolvedActor, id: string, action: string, argument?: string, messageId?: string) {
  const s = await scope(services, actor, id);
  if (action === 'open') { await enterPersonalWork(services, actor, id); return; }
  if (!s.item.selected) throw new ConflictError('Сейчас выбрано другое обращение. Откройте нужное через «Моя работа».');
  if (action === 'show' || action === 'details') { await showPersonalWork(services, actor, id, action === 'details'); return; }
  if (action === 'resume') { await take(services, s); await showPersonalWork(services, actor, id); return; }
  if (action === 'cancel') {
    await services.prisma.operatorSession.deleteMany({ where: { maxUserId: actor.maxUserId, chatId: s.item.originChatId, incidentId: s.item.incidentId } });
    await save(services, s.item, { cycle: cycleOf(s.incident), leaseUntil: dataOf(s.item).leaseUntil });
    await showPersonalWork(services, actor, id); return;
  }
  if (action === 'release') {
    await snapshot(services, s.item);
    if (s.kind === 'distribution') await services.distributionQueue.release(s.actor, s.item.originChatId, s.item.incidentId);
    else await services.workQueues.release(s.actor, s.item.originChatId, s.item.incidentId);
    await showPersonalWork(services, actor, id); return;
  }
  await requireOwnLease(services, s);
  const data = dataOf(s.item);
  if (action === 'back') {
    if (data.pending) { delete data.pending; await save(services, s.item, data); await showPersonalWork(services, actor, id); return; }
    // Retain the saved text while explicitly reopening input.
    if (data.draft) { data.draft.nonce = ''; await save(services, s.item, data); }
    await services.messages.send({ userId: actor.maxUserId }, { text: `${s.incident.publicCode}: отправьте исправленный текст и все нужные вложения одним сообщением. Бот ждёт ваше сообщение.`, keyboard: [[button('Показать черновик', 'show', id)], ...navigation()] }); return;
  }
  if (action === 'confirm') {
    if (data.pending && data.pending.nonce === argument) {
      const raw = data.pending.raw; await run(services, s, raw, messageId); delete data.pending; await save(services, s.item, data); return;
    }
    if (!data.draft?.nonce || data.draft.nonce !== argument || !data.session) throw new ConflictError('Предварительный просмотр устарел. Откройте актуальный черновик.');
    const live = await services.sessions.find(actor.maxUserId, s.item.originChatId);
    if (!live || live.incidentId !== s.item.incidentId || live.type !== data.session.type || (live.data as { privateWorkspaceId?: string } | null)?.privateWorkspaceId !== id) throw new ConflictError('Нажмите «Взять и продолжить», чтобы восстановить подготовку.');
    await handleOperatorMessage(personalServices(services, s.item, s.incident.publicCode), s.actor, s.item.originChatId,
      { body: { mid: data.draft.sourceMessageId, text: data.draft.text, attachments: data.draft.attachments } } as Message, live);
    const after = await services.sessions.find(actor.maxUserId, s.item.originChatId);
    const latest = await services.repository.findById(s.item.incidentId);
    const expected = data.session.type === 'WAITING_FOR_ANSWER' ? ['WAITING_REVIEW', 'RESOLVED'] : data.session.data.redistribution ? ['DISTRIBUTION'] : ['REVISION_REQUIRED'];
    if (!after && latest && expected.includes(latest.status)) await save(services, s.item, { cycle: data.cycle });
    else if (!after) await services.messages.send({ userId: actor.maxUserId }, { text: `${s.incident.publicCode}: действие не завершено. Черновик сохранён; заново возьмите обращение.`, keyboard: [[button('Открыть черновик', 'show', id)], ...navigation()] });
    else await snapshot(services, s.item);
    return;
  }
  if (action === 'run' && argument) {
    const p = parseCallbackPayload(argument);
    if (p?.kind !== 'incident' || p.incidentId !== s.item.incidentId) throw new ForbiddenError('Кнопка другого обращения.');
    if (['assign-group', 'approve'].includes(p.action)) {
      const group = p.action === 'assign-group' && p.argument ? await services.prisma.responsibleGroup.findUnique({ where: { id: p.argument } }) : null;
      const title = p.action === 'approve' ? 'Согласовать этот ответ и отправить жителю?' : `Направить обращение в организацию «${group?.name ?? 'не найдена'}»?`;
      await save(services, s.item, { ...data, pending: { raw: argument, title, nonce: randomUUID() } });
      await showPersonalWork(services, actor, id); return;
    }
    if (data.draft && !['reject-confirm', 'reject-edit', 'reject-cancel'].includes(p.action)) throw new ConflictError('Сначала подтвердите, исправьте или отмените сохранённый черновик.');
    await run(services, s, argument, messageId); return;
  }
  throw new ValidationError('Кнопка устарела.');
}

export async function receivePersonalText(services: AppServices, actor: ResolvedActor, message: Message): Promise<boolean> {
  const item = await services.prisma.privateWorkItem.findFirst({ where: { maxUserId: actor.maxUserId, selected: true } });
  if (!item) return false;
  const s = await scope(services, actor, item.id); const data = dataOf(item);
  if (!s.active || !data.session) {
    await services.messages.send({ userId: actor.maxUserId }, { text: `${s.incident.publicCode}: бот пока не ждёт текст. Выберите действие в рабочей карточке.`, keyboard: [[button('Текущее обращение', 'show', item.id)], ...navigation()] }); return true;
  }
  const text = (message.body.text ?? '').trim();
  if (!text || text.length > 12000) throw new ValidationError('Отправьте непустой текст до 12 000 символов.');
  const media = classifyAttachments(message.body.attachments);
  if (media.some(m => !['IMAGE', 'FILE'].includes(m.kind))) throw new ValidationError('Можно прикрепить фото или файлы. Видео и аудио не принимаются.');
  if (data.session.type !== 'WAITING_FOR_ANSWER' && media.length) throw new ValidationError('Для причины или замечаний нужен только текст.');
  if (data.session.type === 'WAITING_REJECTION_REASON') {
    if (data.session.data.rejectionStage !== 'text') throw new ValidationError('Выберите причину кнопкой или нажмите «Исправить».');
    if (Array.from(text).length > 2000) throw new ValidationError('Причина отклонения должна быть не длиннее 2000 символов.');
    if ((await lease(services, s))?.owner !== actor.maxUserId) {
      data.session.data = { ...data.session.data, reason: text, rejectionStage: 'preview', rejectionToken: randomUUID() };
      await save(services, item, data);
      await showPersonalWork(services, actor, item.id); return true;
    }
    await requireOwnLease(services, s);
    const live = await services.sessions.find(actor.maxUserId, item.originChatId);
    if (!live) throw new ConflictError('Нажмите «Взять и продолжить».');
    await handleOperatorMessage(personalServices(services, item, s.incident.publicCode), s.actor, item.originChatId, message, live);
    await snapshot(services, item); return true;
  }
  await save(services, item, { ...data, draft: { text, attachments: (message.body.attachments ?? []).filter(a => a.type === 'image' || a.type === 'file'), sourceMessageId: message.body.mid, nonce: randomUUID() } });
  await showPersonalWork(services, actor, item.id); return true;
}

/** One warning per reservation. Membership is rechecked before any personal notification. */
export async function sweepPersonalWork(services: AppServices) {
  const items = await services.prisma.privateWorkItem.findMany({ where: { openedAt: { not: null }, updatedAt: { gt: new Date(Date.now() - 24 * 60 * 60_000) } }, include: { user: true } });
  for (const item of items) {
    try {
      const actor = { userId: item.user.id, maxUserId: item.maxUserId, displayName: item.user.displayName, roles: item.user.roles, role: item.user.roles.join('|') };
      const s = await scope(services, actor, item.id); const owned = await lease(services, s);
      if (!owned || owned.owner !== actor.maxUserId || owned.until.getTime() - Date.now() > 120_000) continue;
      await services.prisma.$transaction(tx => queueMessage(tx, { userId: actor.maxUserId }, {
        text: `⏳ ${s.incident.publicCode}: закрепление заканчивается в ${formatDateTime(owned.until)} (МСК). Сохранённый черновик останется доступен. После окончания срока потребуется заново взять обращение.`,
        keyboard: [[button('Вернуться к обращению', 'open', item.id)]], delivery: { dedupeKey: `private-warning:${item.id}:${owned.until.getTime()}` },
      }, item.incidentId), TRANSACTION_OPTIONS);
    } catch { /* Never notify from a cached permission when MAX is unavailable. */ }
  }
}
