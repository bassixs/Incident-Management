import { randomUUID } from 'node:crypto';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import type { Button } from '../../src/max/max-types';

describeIntegration('distribution navigation through incoming callbacks', () => {
  let db: PrismaClient, h: TestHarness, actor: Awaited<ReturnType<typeof actorFor>>;
  let incident: Awaited<ReturnType<TestHarness['services']['incidents']['create']>>;
  let screens: Map<string, { text: string; keyboard: Button[][] }>, current: string;
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db); h = await createHarness(db);
    actor = await actorFor(db, TEST_USERS.admin, 'Тестовый диспетчер', [UserRole.ADMIN]);
    await db.category.createMany({ data: Array.from({ length: 14 }, (_, n) => ({ code: `TOPIC_${n}`, name: `Тема ${n}`, sortOrder: 100 + n })) });
    await db.responsibleGroup.createMany({ data: Array.from({ length: 14 }, (_, n) => ({ code: `GROUP_${n}`, name: `Организация ${n}`, kind: 'LOCAL_GOVERNMENT', maxChatId: BigInt(-8000 - n), sortOrder: 100 + n })) });
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: { getChatMembers: vi.fn(async (_chat, args) => ({ members: args.user_ids.map((id: number) => ({ user_id: id, is_bot: false })) })) } } as never;
    incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Тестовый житель', phone: '+79001234567' }, text: 'Синтетическое сообщение' });
    screens = new Map(); current = 'incident-card';
    const send = h.messages.send.bind(h.messages);
    vi.spyOn(h.messages, 'send').mockImplementation(async (target, message) => {
      const result = await send(target, message);
      if (message.keyboard?.length) { current = result.firstMessageId!; screens.set(current, { text: message.text, keyboard: message.keyboard }); }
      return result;
    });
    vi.spyOn(h.messages, 'editCardKeyboard').mockImplementation(async (mid, text, keyboard) => { current = mid; screens.set(mid, { text, keyboard }); return true; });
  });
  async function click(payload: string, mid = current) {
    await handleCallbackUpdate(h.services, { update: { message: { recipient: { chat_id: Number(TEST_CHATS.distribution), chat_type: 'chat' }, body: { mid } }, callback: { callback_id: randomUUID(), user: { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false }, payload } } } as never);
  }
  const button = (text: string) => {
    const found = screens.get(current)?.keyboard.flat().find(b => b.text === text);
    if (!found || found.type !== 'callback') throw new Error(`Missing ${text} on ${JSON.stringify(screens.get(current))}`);
    return found.payload;
  };
  const page = () => screens.get(current)!.keyboard.flat().find(b => /^\d+ \/ \d+$/.test(b.text))?.text;
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
});
