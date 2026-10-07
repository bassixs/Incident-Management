import { assertNavigationClaim } from '../../distribution/queue-state';
import { randomUUID } from 'node:crypto';
import { incidentCallback, parseCallbackPayload, type CallbackPayload } from '../../max/callback-payload';
import type { Button } from '../../max/max-types';
import { ConflictError } from '../../utils/errors';
import { assertDispatcher } from '../middleware/authorize';
import { ensureFreeSession } from '../handlers/session-guard';
import { pendingConfirmation, withConfirmationLock } from './staff-confirmation';
import { handleIncidentCallback, type IncidentCallbackContext } from './incident.callbacks';

type Route = Extract<CallbackPayload, { kind: 'incident' }>;
type Screen = {
  incidentId: string; token: string; lease: string; topicId: string | null;
  privateExecution: boolean; mid?: string; actions: Route[]; route: Route;
  returnRoute?: Route;
  selectedGroupId?: string;
};
export const isDistributionNavigation = (action: string) =>
  ['distribution-nav', 'topic', 'topic-page', 'topic-set', 'assign', 'assign-branch', 'assign-page', 'assign-group'].includes(action);
export const navigationKey = (userId: bigint, chatId: bigint) => `distribution-navigation:${userId}:${chatId}`;
const stale = () => new ConflictError('Этот экран устарел. Откройте «Распределить» или «Изменить тему» в актуальной карточке сообщения.');


/** One bounded record per operator/chat; no resident text or files. Old screen tokens
 * are consumed by CAS before work, so a late MAX response cannot make them live again. */
export async function handleDistributionNavigation(context: IncidentCallbackContext, incoming: Route): Promise<string | undefined> {
  const { services, actor, chatId } = context;
  assertDispatcher(services, actor, chatId);
  if (chatId === undefined) throw stale();
  const key = navigationKey(actor.maxUserId, chatId);
  // A unique owner prevents an overdue request from releasing a successor's lock.
  const lock = `distribution-navigation-lock:${actor.maxUserId}:${chatId}`, owner = randomUUID();
  if (!await services.actionGuard.acquire({ key: lock, maxUserId: actor.maxUserId, action: owner, ttlMs: 120_000 })) {
    throw new ConflictError('Предыдущий переход ещё выполняется. Дождитесь результата.');
  }
  try {
    let route = incoming, previous: Screen | undefined;
    let ownedValue: string;
    let incident = await services.prisma.incident.findUniqueOrThrow({ where: { id: incoming.incidentId } });
    if (incoming.action === 'distribution-nav') {
      const row = await services.prisma.systemSetting.findUnique({ where: { key } });
      if (!row) throw stale();
      previous = JSON.parse(row.value) as Screen;
      const [token, index, extra] = (incoming.argument ?? '').split('~');
      if (extra || !index || !/^\d+$/.test(index) || previous.token !== token || previous.incidentId !== incident.id ||
          previous.privateExecution !== !!context.privateExecution || !context.messageId || previous.mid !== context.messageId) throw stale();
      assertNavigationClaim(incident, actor.maxUserId, previous);
      const chosen = previous.actions[Number(index)];
      if (!chosen) throw stale();
      route = chosen;
      const consumed = { ...previous, token: owner, actions: [] };
      ownedValue = JSON.stringify(consumed);
      if (!(await services.prisma.systemSetting.updateMany({ where: { key, value: row.value }, data: { value: ownedValue } })).count) throw stale();
    } else {
      // Only the two explicit entry buttons may acquire a claim. Old picker payloads
      // have no screen identity and must be reopened, never used to renew a lease.
      if (!['assign', 'topic'].includes(incoming.action)) throw stale();
      if (!context.privateExecution && (!context.messageId || (context.messageId !== incident.distributionMessageId &&
          !await services.prisma.outboundMessage.findFirst({ where: {
            incidentId: incident.id, targetType: 'chat', targetId: chatId, status: 'SENT',
            AND: [
              { OR: [{ trackingType: 'DISTRIBUTION_CARD' }, { dedupeKey: { startsWith: `distribution-claim:${incident.id}:` } }, { dedupeKey: { startsWith: `redistribution-notice:${incident.id}:` } }] },
              { OR: [{ firstMessageId: context.messageId }, { payload: { path: ['keyboardMessageId'], equals: context.messageId } }] },
            ],
          }, select: { id: true } })))) throw stale();
      if (!await ensureFreeSession(services, actor, chatId)) return;
      await services.distributionQueue.claim(actor, chatId, incident.id);
      incident = await services.prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
      assertNavigationClaim(incident, actor.maxUserId);
      ownedValue = JSON.stringify({ token: owner });
      await services.prisma.systemSetting.upsert({ where: { key }, create: { key, value: ownedValue }, update: { value: ownedValue } });
    }
    const lease = incident.distributionClaimUntil!.toISOString();
    const expected = { lease, topicId: incident.userSelectedCategoryId };
    const guard = async () => {
      const current = await services.prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
      assertNavigationClaim(current, actor.maxUserId, expected);
      const held = await services.prisma.actionLock.findUnique({ where: { key: lock } });
      if (held?.action !== owner || held.lockedUntil <= new Date()) throw stale();
    };
    let selectedGroupId: string | undefined;
    if (route.action === 'assignment-back') {
      if (!previous?.returnRoute) throw stale();
      await withConfirmationLock(services, actor.maxUserId, chatId, async () => {
        const session = await services.sessions.find(actor.maxUserId, chatId);
        const pending = session && pendingConfirmation(session);
        if (!session || session.incidentId !== incident.id || pending?.action !== 'assign-group' || pending.token !== route.argument) throw stale();
        await services.prisma.operatorSession.deleteMany({ where: { id: session.id } });
      });
      selectedGroupId = previous.route.argument;
      route = previous.returnRoute;
    }
    const branchOf = (p?: Route) => p?.action === 'assign-branch' ? p.argument : p?.action === 'assign-page' ? p.argument?.split('~')[0] : undefined;
    const branch = branchOf(route);
    if (branch && branch === branchOf(previous?.route)) selectedGroupId ??= previous?.selectedGroupId;
    const selected = selectedGroupId ? await services.prisma.responsibleGroup.findUnique({ where: { id: selectedGroupId } }) : null;
    const compatible = selected?.isActive && selected.maxChatId !== null && selected.kind ===
      (branch === 'local' ? 'LOCAL_GOVERNMENT' : branch === 'regional' ? 'REGIONAL' : branch === 'executive' ? 'EXECUTIVE_AUTHORITY' : undefined);
    if (!compatible) selectedGroupId = undefined;
    const screenText = (text: string) => compatible ? `${text}\n\nВыбрана организация: ${selected!.name}. Для подтверждения нажмите её кнопку; можно выбрать другую.` : text;
    const returnRoute = route.action === 'assign-group' ? previous?.route : previous?.returnRoute;
    const original = services.messages;
    async function prepare(rows: Button[][]): Promise<{ rows: Button[][]; screen: Screen }> {
      await guard();
      const token = randomUUID(), actions: Route[] = [];
      const wrapped = rows.map(row => row.map(b => {
        if (b.type !== 'callback') return b;
        const parsed = parseCallbackPayload(b.payload);
        if (parsed?.kind !== 'incident' || parsed.incidentId !== incident.id) return b;
        const index = actions.push(parsed) - 1;
        return { ...b, payload: incidentCallback('distribution-nav', incident.id, `${token}~${index}`) };
      }));
      const confirmation = actions.find(p => p.action === 'action-confirm');
      if (confirmation && returnRoute) {
        const index = actions.push({ kind: 'incident', action: 'assignment-back', incidentId: incident.id, argument: confirmation.argument }) - 1;
        wrapped.push([{ type: 'callback', text: 'Вернуться к выбору организации', payload: incidentCallback('distribution-nav', incident.id, `${token}~${index}`) }]);
      }
      return { rows: wrapped, screen: { incidentId: incident.id, token, ...expected, privateExecution: !!context.privateExecution, actions, route, returnRoute, selectedGroupId } };
    }
    async function save(screen: Screen, mid: string | undefined) {
      if (!mid) throw stale();
      await guard();
      const value = JSON.stringify({ ...screen, mid });
      if (!(await services.prisma.systemSetting.updateMany({ where: { key, value: ownedValue }, data: { value } })).count) throw stale();
      ownedValue = value;
    }
    const messages = new Proxy(original, { get(target, property) {
      if (property === 'send') return async (...args: Parameters<typeof original.send>) => {
        const [destination, message] = args;
        if (!message.keyboard?.length) return original.send(...args);
        const next = await prepare(message.keyboard);
        const sent = await original.send(destination, { ...message, text: screenText(message.text), immediatePreview: true, beforeImmediateSend: guard, keyboard: next.rows });
        if (sent.state !== 'sent') throw stale();
        await save(next.screen, sent.keyboardMessageId ?? sent.firstMessageId);
        return sent;
      };
      if (property === 'editCardKeyboard') return async (mid: string, text: string, rows: Button[][]) => {
        const next = await prepare(rows);
        const edited = await original.editCardKeyboard(mid, screenText(text), next.rows);
        if (!edited) throw new ConflictError('Не удалось обновить экран. Заново откройте распределение в карточке сообщения.');
        await save(next.screen, mid); return edited;
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    await guard();
    const result = await handleIncidentCallback({ ...context, services: { ...services, messages }, navigationAuthorized: expected }, route);
    // Topic selection ends this screen; no old organization choice survives it.
    if (route.action === 'topic-set' || route.action === 'action-confirm' || route.action === 'action-cancel' || route.action === 'cancel') {
      await services.prisma.systemSetting.deleteMany({ where: { key, value: ownedValue } });
    }
    return result;
  } finally {
    await services.prisma.actionLock.deleteMany({ where: { key: lock, action: owner } });
  }
}
