import { type PrismaClient, UserRole } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { MaxMessageService } from '../../src/max/max-message.service';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { distributionTopicKeyboard } from '../../src/bot/keyboards';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { incidentHistoryText } from '../../src/bot/views/history';
import * as outbox from '../../src/delivery/workflow-outbox';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, CATEGORY_CODES, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('topic correction during distribution', () => {
  let prisma: PrismaClient, services: AppServices, actor: Awaited<ReturnType<typeof actorFor>>, colleague: typeof actor, max: any;
  let sequence = 0;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); sequence = 0;
    const send = async () => ({ body: { mid: `mid-${++sequence}` } });
    max = { sendToChat: vi.fn(send), sendToUser: vi.fn(send), editMessage: vi.fn(async () => undefined), editCardWithKeyboard: vi.fn(async () => undefined) };
    services = buildServices(prisma, { messages: new MaxMessageService(max, { prisma, storage: { remove: async () => undefined } as never }) });
    actor = await actorFor(prisma, TEST_USERS.admin, 'Диспетчер', [UserRole.ADMIN]);
    colleague = await actorFor(prisma, TEST_USERS.dispatcher, 'Коллега', [UserRole.DISPATCHER]);
  });
  async function create() {
    const category = await prisma.category.findUniqueOrThrow({ where: { code: CATEGORY_CODES.facility } });
    return services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Житель Тест', phone: '+79001112233' }, text: 'Не работает фонарь', userSelectedCategoryId: category.id });
  }
  const click = (id: string, action: 'topic' | 'topic-page' | 'topic-set', argument?: string, who = actor, chatId = TEST_CHATS.distribution) => handleIncidentCallback({ services, actor: who, chatId }, { kind: 'incident', incidentId: id, action, argument });
  it('changes the topic through staff buttons, updates original and queue copy, and records both values', async () => {
    const i = await create(); await services.distributionQueue.claim(actor, TEST_CHATS.distribution, i.id, true);
    const category = await prisma.category.findUniqueOrThrow({ where: { code: CATEGORY_CODES.it } });
    await click(i.id, 'topic'); await click(i.id, 'topic-set', category.id);
    const fresh = (await services.repository.findById(i.id))!;
    expect(fresh.userSelectedCategoryId).toBe(category.id); expect(fresh.status).toBe('DISTRIBUTION'); expect(fresh.assignedGroupId).toBeNull(); expect(fresh.deadlineAt).toEqual(i.deadlineAt);
    const copy = await prisma.outboundMessage.findFirstOrThrow({ where: { dedupeKey: { startsWith: `distribution-claim:${i.id}:` } } });
    for (const mid of [fresh.distributionMessageId, copy.firstMessageId]) {
      const edit = max.editCardWithKeyboard.mock.calls.filter((c: any[]) => c[0] === mid).at(-1);
      expect(edit[1]).toContain(category.name); expect(edit[2].flat().some((b: any) => b.text === 'Изменить тему')).toBe(true);
    }
    const history = await services.history.listForIncident(i.id);
    expect(history.find(h => h.action === 'TOPIC_CHANGED')?.metadata).toMatchObject({ previousCategoryId: i.userSelectedCategoryId, categoryId: category.id });
    expect(incidentHistoryText(fresh, history, [], 'Europe/Moscow')).toContain('Тема обращения изменена');
    await click(i.id, 'topic-set', category.id);
    expect(await prisma.incidentHistory.count({ where: { incidentId: i.id, action: 'TOPIC_CHANGED' } })).toBe(1);
  });
  it('rejects another operator, a foreign chat and correction after assignment', async () => {
    const i = await create(); await click(i.id, 'topic');
    await expect(click(i.id, 'topic-set', 'none', colleague)).rejects.toThrow();
    await expect(click(i.id, 'topic-set', 'none', actor, TEST_CHATS.sector)).rejects.toThrow();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await services.distribution.assign(i.id, group.id, actor);
    await expect(click(i.id, 'topic-set', 'none')).rejects.toThrow('до распределения');
    expect((await services.repository.findById(i.id))!.userSelectedCategoryId).toBe(i.userSelectedCategoryId);
  });
  it('supports Иное and refuses inactive topics and malformed selection', async () => {
    const i = await create(); const category = await prisma.category.findUniqueOrThrow({ where: { code: CATEGORY_CODES.it } });
    await prisma.category.update({ where: { id: category.id }, data: { isActive: false } });
    await expect(click(i.id, 'topic-set', category.id)).rejects.toThrow('недоступна');
    await expect(click(i.id, 'topic-set', 'wrong')).rejects.toThrow();
    await click(i.id, 'topic-set', 'none'); expect((await services.repository.findById(i.id))!.userSelectedCategoryId).toBeNull();
  });
  it('rolls back the topic and history when the durable card refresh fails', async () => {
    const i = await create();
    vi.spyOn(outbox, 'queueDistributionRefresh').mockRejectedValueOnce(new Error('Queue failed'));
    await expect(services.distribution.changeTopic(i.id, null, actor)).rejects.toThrow('Queue failed');
    expect((await services.repository.findById(i.id))!.userSelectedCategoryId).toBe(i.userSelectedCategoryId);
    expect(await prisma.incidentHistory.count({ where: { incidentId: i.id, action: 'TOPIC_CHANGED' } })).toBe(0);
  });
  it('shows Иное last and produces incident-bound staff callbacks', async () => {
    const i = await create(); const categories = await services.categories.listActive();
    const buttons = distributionTopicKeyboard(i.id, categories).flat();
    expect(buttons.at(-1)!.text).toBe('Иное');
    for (const b of buttons) expect(parseCallbackPayload((b as any).payload)).toMatchObject({ kind: 'incident', incidentId: i.id, action: 'topic-set' });
  });
});
