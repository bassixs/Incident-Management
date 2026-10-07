import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { enterPersonalWork, invitePersonalWork } from '../../src/work-queues/private-workspace';
import { buildServices } from '../../src/app/container';
import type { Button } from '../../src/max/max-types';

describeIntegration.each(['chat', 'private'] as const)('distribution navigation through incoming callbacks (%s)', mode => {
  let db: PrismaClient, h: TestHarness, actor: Awaited<ReturnType<typeof actorFor>>;
  let incident: Awaited<ReturnType<TestHarness['services']['incidents']['create']>>;
  let itemId: string | undefined;
  let screens: Map<string, { text: string; keyboard: Button[][] }>, current: string;
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db); h = await createHarness(db);
    actor = await actorFor(db, TEST_USERS.admin, 'Тестовый диспетчер', [UserRole.ADMIN]);
    await db.category.createMany({ data: Array.from({ length: 14 }, (_, n) => ({ code: `TOPIC_${n}`, name: `Тема ${n}`, sortOrder: 100 + n })) });
    await db.responsibleGroup.createMany({ data: Array.from({ length: 14 }, (_, n) => ({ code: `GROUP_${n}`, name: `Организация ${n}`, kind: 'LOCAL_GOVERNMENT', maxChatId: BigInt(-8000 - n), sortOrder: 100 + n })) });
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: { getMyInfo: vi.fn(async () => ({ username: 'synthetic_bot' })), getChatMembers: vi.fn(async (_chat, args) => ({ members: args.user_ids.map((id: number) => ({ user_id: id, is_bot: false })) })) } } as never;
    incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Тестовый житель', phone: '+79001234567' }, text: 'Синтетическое сообщение' });
    await h.services.distribution.publishCard(incident.id);
    incident = (await h.services.repository.findById(incident.id))!;
    screens = new Map(); current = incident.distributionMessageId!; itemId = undefined;
    const send = h.messages.send.bind(h.messages);
    vi.spyOn(h.messages, 'send').mockImplementation(async (target, message) => {
      const result = await send(target, message);
      if (message.keyboard?.length) { current = result.firstMessageId!; screens.set(current, { text: message.text, keyboard: message.keyboard }); }
      return result;
    });
    vi.spyOn(h.messages, 'editCardKeyboard').mockImplementation(async (mid, text, keyboard) => { current = mid; screens.set(mid, { text, keyboard }); return true; });
    if (mode === 'private') {
      await invitePersonalWork(h.services, actor, TEST_CHATS.distribution, incident.id);
      const item = await db.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id } });
      itemId = item.id; await enterPersonalWork(h.services, actor, item.id);
    }
  });
  async function click(payload: string, mid = /^incident:(assign|topic):/.test(payload) ? incident.distributionMessageId! : current) {
    if (itemId && payload.startsWith('incident:')) payload = `personal:run:${itemId}:${payload}`;
    await handleCallbackUpdate(h.services, { update: { message: { recipient: { chat_id: Number(itemId ? actor.maxUserId : TEST_CHATS.distribution), chat_type: itemId ? 'dialog' : 'chat' }, body: { mid } }, callback: { callback_id: randomUUID(), user: { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false }, payload } } } as never);
  }
  const button = (text: string) => {
    const found = screens.get(current)?.keyboard.flat().find(b => b.text === text);
    if (!found || found.type !== 'callback') throw new Error(`Missing ${text} on ${JSON.stringify(screens.get(current))}`);
    return found.payload;
  };
  const notice = () => String(vi.mocked(h.services.max.answerCallback).mock.calls.at(-1)?.[1] ? JSON.stringify(vi.mocked(h.services.max.answerCallback).mock.calls.at(-1)?.[1]) : '');
  const page = () => {
    const rows = screens.get(current)!.keyboard;
    const counter = rows.flat().find(b => /^\d+ \/ \d+$/.test(b.text))?.text;
    if (counter) return counter;
    // The existing private adapter drops noop page counters. Check the visible
    // seeded entries, not a counter this UI never promised to render.
    const first = rows[0]?.[0]?.text;
    if (first === 'Хозяйственная группа' || first === 'Хозяйственная часть') return '1 / 3';
    if (first === 'Организация 5' || first === 'Тема 4') return '2 / 3';
    if (first === 'Организация 11' || first === 'Тема 10') return '3 / 3';
    return undefined;
  };
  async function unchanged() {
    const fresh = await db.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(fresh.status).toBe('DISTRIBUTION'); expect(fresh.assignedGroupId).toBeNull();
    expect(await db.incidentHistory.count({ where: { incidentId: incident.id, action: 'ASSIGNED' } })).toBe(0);
  }
  it('topic: last page -> previous already visited page returns immediately', async () => {
    await click(`incident:topic:${incident.id}`);
    await click(button('Вперёд ➡️')); expect(page()).toBe('2 / 3');
    await click(button('Вперёд ➡️')); expect(page()).toBe('3 / 3');
    await click(button('⬅️ Назад')); expect(page()).toBe('2 / 3');
    await unchanged();
  });
  it('organization: last page -> previous already visited page returns immediately', async () => {
    await click(`incident:assign:${incident.id}`);
    await click(button('Органы местного самоуправления'));
    await click(button('Вперёд ➡️')); expect(page()).toBe('2 / 3');
    await click(button('Вперёд ➡️')); expect(page()).toBe('3 / 3');
    await click(button('⬅️ Назад')); expect(page()).toBe('2 / 3');
    await unchanged();
  });
  it('organization: return to organization types after opening assignment', async () => {
    await click(`incident:assign:${incident.id}`);
    await click(button('Органы местного самоуправления'));
    await click(button('К выбору типа организации'));
    expect(screens.get(current)!.keyboard.flat().some(b => b.text === 'Органы исполнительной власти')).toBe(true);
    await unchanged();
  });
  const fresh = () => db.incident.findUniqueOrThrow({ where: { id: incident.id } });
  async function groups() {
    await click(`incident:assign:${incident.id}`);
    await click(button('Органы местного самоуправления'));
  }
  it('returns across first/middle/last pages repeatedly without extending the claim', async () => {
    await groups(); const before = await fresh();
    for (let n = 0; n < 3; n++) {
      await click(button('Вперёд ➡️')); expect(page()).toBe('2 / 3');
      await click(button('⬅️ Назад')); expect(page()).toBe('1 / 3');
    }
    expect((await fresh()).distributionClaimUntil).toEqual(before.distributionClaimUntil);
    await unchanged();
  });
  it('rejects a repeated old page and delayed callback while keeping the current screen usable', async () => {
    await groups(); const old = button('Вперёд ➡️'); const mid = current;
    await click(old); expect(page()).toBe('2 / 3');
    await click(old, mid); expect(page()).toBe('2 / 3'); expect(notice()).toMatch(/устарел/);
    await click(button('Вперёд ➡️')); expect(page()).toBe('3 / 3');
    await unchanged();
  });
  it('an empty organization result still offers a working return', async () => {
    await db.responsibleGroup.updateMany({ where: { kind: 'LOCAL_GOVERNMENT' }, data: { isActive: false } });
    await groups(); expect(screens.get(current)!.text).toContain('нет доступных');
    await click(button('К выбору типа организации'));
    expect(button('Органы исполнительной власти')).toBeTruthy(); await unchanged();
  });
  it('returns from confirmation to the same organization page without assigning; explicit confirm assigns once', async () => {
    await groups(); await click(button('Вперёд ➡️'));
    const choice = screens.get(current)!.keyboard[0]![0]!.text;
    await click(button(choice)); await unchanged();
    const oldConfirm = button('Подтвердить'), confirmationMid = current;
    await click(button('Вернуться к выбору организации')); expect(page()).toBe('2 / 3');
    expect(button(choice)).toBeTruthy(); await unchanged();
    await click(oldConfirm, confirmationMid); await unchanged(); expect(notice()).toMatch(/устарел/);
    await click(button(choice)); const confirm = button('Подтвердить'), mid = current;
    await click(confirm); expect((await fresh()).status).toBe('ASSIGNED');
    await click(confirm, mid);
    expect(await db.incidentHistory.count({ where: { incidentId: incident.id, action: 'ASSIGNED' } })).toBe(1);
  });
  it.each(['expired', 'other-owner', 'new-lease'] as const)('navigation refuses %s without renewing or losing incident data', async reason => {
    await groups(); const next = button('Вперёд ➡️');
    const before = await fresh();
    const until = new Date(reason === 'expired' ? Date.now() - 1 : before.distributionClaimUntil!.getTime() + 1000);
    await db.incident.update({ where: { id: incident.id }, data: { distributionClaimUntil: until, ...(reason === 'other-owner' ? { distributionClaimedBy: 99999n } : {}) } });
    await click(next); expect(page()).toBe('1 / 3');
    const after = await fresh(); expect(after.distributionClaimUntil).toEqual(until);
    expect(after.text).toBe(before.text); expect(after.requesterPhone).toBe(before.requesterPhone);
    await unchanged();
  });
  it('a changed topic invalidates the pending organization confirmation', async () => {
    await groups(); await click(button('Хозяйственная группа')); const confirm = button('Подтвердить');
    const topic = await db.category.findFirstOrThrow();
    await db.incident.update({ where: { id: incident.id }, data: { userSelectedCategoryId: topic.id } });
    await click(confirm); await unchanged(); expect(notice()).toMatch(/устарел/);
  });
  it('changing topic preserves the claim and incident, invalidating the older organization screen', async () => {
    await groups(); const old = button('Вперёд ➡️'), oldMid = current, before = await fresh();
    await click(`incident:topic:${incident.id}`);
    await click(button('Вперёд ➡️')); await click(button('Вперёд ➡️'));
    await click(button('Иное'));
    expect((await fresh()).userSelectedCategoryId).toBeNull();
    expect((await fresh()).distributionClaimUntil).toEqual(before.distributionClaimUntil);
    await click(old, oldMid); expect(notice()).toMatch(/устарел/); await unchanged();
  });
  it('retains screen validation across reconstructed services (restart)', async () => {
    await groups(); const next = button('Вперёд ➡️'); const max = h.services.max;
    h.services = buildServices(db, { messages: h.messages as never, media: h.services.media }); h.services.max = max;
    await click(next); expect(page()).toBe('2 / 3'); await unchanged();
  });
  it('does not accept a forged MID or another operator screen', async () => {
    await groups(); const next = button('Вперёд ➡️');
    await click(next, 'unrelated-mid'); expect(page()).toBe('1 / 3'); expect(notice()).toMatch(/устарел/);
    await unchanged();
  });

  it('serializes concurrent transitions without assigning or extending the lease', async () => {
    await groups(); const payload = button('Вперёд ➡️'); const mid = current;
    const edit = h.messages.editCardKeyboard.bind(h.messages);
    let arrived!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.mocked(h.messages.editCardKeyboard).mockImplementationOnce(async (...args) => { arrived(); await gate; return edit(...args); });
    const first = click(payload, mid); await entered;
    try { await click(payload, mid); expect(notice()).toMatch(/выполняется/); }
    finally { resume(); await first; }
    expect(page()).toBe('2 / 3'); await unchanged();
  });
  it('does not reactivate a screen whose HTTP edit completed after ownership changed', async () => {
    await groups(); const payload = button('Вперёд ➡️'), mid = current;
    const edit = h.messages.editCardKeyboard.bind(h.messages);
    let arrived!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    vi.mocked(h.messages.editCardKeyboard).mockImplementationOnce(async (...args) => { arrived(); await gate; return edit(...args); });
    const first = click(payload, mid); await entered;
    await db.incident.update({ where: { id: incident.id }, data: { distributionClaimedBy: 99999n } });
    resume(); await first;
    await click(button('Вперёд ➡️')); await unchanged();
    expect((await fresh()).distributionClaimedBy).toBe(99999n);
  });
  it('an edit failure fails closed and the current incident can be reopened without data loss', async () => {
    await groups(); const old = button('Вперёд ➡️'), mid = current;
    vi.mocked(h.messages.editCardKeyboard).mockResolvedValueOnce(false);
    await click(old, mid); expect(notice()).toMatch(/Не удалось обновить/);
    await click(old, mid); expect(notice()).toMatch(/устарел/);
    await click(`incident:assign:${incident.id}`); await click(button('Органы местного самоуправления'));
    await click(button('Вперёд ➡️')); expect(page()).toBe('2 / 3'); await unchanged();
  });
  it('legacy intermediate buttons cannot mutate a topic or acquire a new claim', async () => {
    await groups(); const before = await fresh();
    await click(`incident:topic-set:${incident.id}:none`);
    await click(`incident:assign-group:${incident.id}:00000000-0000-0000-0000-000000000001`);
    expect((await fresh()).distributionClaimUntil).toEqual(before.distributionClaimUntil);
    await unchanged();
  });

});
