import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { retireClarifications } from '../../src/maintenance/retire-clarifications';
import * as outbox from '../../src/delivery/workflow-outbox';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { sectorKeyboard, revisionKeyboard } from '../../src/bot/keyboards';
import { MaxMessageService } from '../../src/max/max-message.service';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('retired clarification workflow', () => {
  let prisma: PrismaClient;
  let h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => prisma.$disconnect());
  async function fixture() {
    const incident = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Фонарь' });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.sector } });
    await h.services.distribution.assign(incident.id, group.id, actor);
    const question = await prisma.clarification.create({ data: { incidentId: incident.id, question: 'Укажите дом', askedByUserId: actor.userId,
      askedByMaxUserId: actor.maxUserId, chatId: TEST_CHATS.sector, questionSourceId: incident.id, status: 'WAITING_REPLY' } });
    return { incident, question };
  }
  it('removes the controls and makes every old question/reply button inert', async () => {
    const { incident, question } = await fixture();
    for (const keyboard of [sectorKeyboard(incident.id, { hasTemplate: true }), revisionKeyboard(incident.id)])
      expect(JSON.stringify(keyboard)).not.toContain('clarify');
    for (const action of ['clarify', 'clarify-send', 'clarify-cancel'] as const) {
      expect(await handleIncidentCallback({ services: h.services, actor, chatId: TEST_CHATS.sector },
        { kind: 'incident', incidentId: incident.id, action, argument: question.id })).toContain('больше не используются');
    }
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Иван Иванов', []);
    expect(await handleUserCallback({ services: h.services, actor: requester, chatId: requester.maxUserId, messageId: undefined, callbackId: 'old-reply' },
      { kind: 'user', action: 'clarify-reply', argument: question.id })).toContain('больше не требуется');
    expect(await prisma.operatorSession.count()).toBe(0);
    expect(await prisma.clarification.count()).toBe(1);
  });
  it('resumes remaining time once, preserves answered evidence and removes only unfinished questions and sessions', async () => {
    const { incident, question } = await fixture();
    const now = new Date('2026-09-08T12:00:00Z'); const hour = 3_600_000;
    const deadline = new Date(now.getTime() + 10 * hour);
    await prisma.incident.update({ where: { id: incident.id }, data: { deadlineAt: deadline, activeClarificationId: question.id,
      slaPausedAt: new Date(now.getTime() - 2 * hour), slaPausedMs: 1000n } });
    const answered = await prisma.clarification.create({ data: { incidentId: incident.id, question: 'Старый вопрос', replyText: 'Старый ответ',
      askedByUserId: actor.userId, askedByMaxUserId: actor.maxUserId, chatId: TEST_CHATS.sector, questionSourceId: 'answered', status: 'ANSWERED' } });
    await prisma.operatorSession.createMany({ data: [
      { maxUserId: actor.maxUserId, chatId: TEST_CHATS.sector, incidentId: incident.id, type: 'WAITING_CLARIFICATION_QUESTION', expiresAt: now },
      { maxUserId: TEST_USERS.requesterA, chatId: TEST_USERS.requesterA, incidentId: incident.id, type: 'WAITING_CLARIFICATION_REPLY', expiresAt: now },
      { maxUserId: actor.maxUserId, chatId: -1005n, type: 'WAITING_REPORT_PERIOD', expiresAt: now },
    ] });
    await prisma.outboundMessage.createMany({ data: [
      { targetType: 'user', targetId: TEST_USERS.requesterA, payload: {}, attachments: [], dedupeKey: `clarification-question:${question.id}` },
      { targetType: 'chat', targetId: TEST_CHATS.sector, payload: {}, attachments: [], dedupeKey: `clarification-reply:${answered.id}` },
    ] });
    await retireClarifications(prisma, now);
    const result = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(result).toMatchObject({ activeClarificationId: null, slaPausedAt: null, slaPausedMs: BigInt(2 * hour + 1000), deadlineAt: new Date(deadline.getTime() + 2 * hour) });
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: question.id } })).status).toBe('CANCELLED');
    expect(await prisma.clarification.findUniqueOrThrow({ where: { id: answered.id } })).toMatchObject({ status: 'ANSWERED', replyText: 'Старый ответ' });
    expect(await prisma.operatorSession.findMany()).toEqual([expect.objectContaining({ type: 'WAITING_REPORT_PERIOD' })]);
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `clarification-question:${question.id}` } })).toBeNull();
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `clarification-reply:${answered.id}` } })).not.toBeNull();
    await retireClarifications(prisma, new Date(now.getTime() + hour));
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).deadlineAt).toEqual(result.deadlineAt);
    expect(await prisma.incidentHistory.count({ where: { action: 'CLARIFICATION_RETIRED' } })).toBe(1);
    await expect(h.services.answers.submit(incident.id, actor, 'Ответ после отмены уточнения', [])).resolves.toBeDefined();
  });
  it('rolls back all retirement changes if queueing the refreshed cards fails', async () => {
    const { incident, question } = await fixture();
    await prisma.incident.update({ where: { id: incident.id }, data: { activeClarificationId: question.id, slaPausedAt: new Date() } });
    vi.spyOn(outbox, 'queueSectorRefresh').mockRejectedValue(new Error('refresh unavailable'));
    await expect(retireClarifications(prisma)).rejects.toThrow('refresh unavailable');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).activeClarificationId).toBe(question.id);
    expect((await prisma.clarification.findUniqueOrThrow({ where: { id: question.id } })).status).toBe('WAITING_REPLY');
  });
  it('does not deliver an obsolete queued question even if it appears after retirement', async () => {
    const { incident, question } = await fixture();
    const max = { sendToUser: vi.fn(), sendToChat: vi.fn() };
    const messages = new MaxMessageService(max as never, { prisma, storage: { load: vi.fn(), remove: vi.fn() } as never });
    await prisma.outboundMessage.create({ data: { targetType: 'user', targetId: TEST_USERS.requesterA, payload: {
      text: 'Старый вопрос', operation: { type: 'clarification-question', incidentId: incident.id, clarificationId: question.id },
    }, attachments: [], dedupeKey: 'obsolete-question' } });
    await messages.flush();
    expect(JSON.stringify(max.sendToUser.mock.calls, (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('Старый вопрос');
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: 'obsolete-question' } })).toBeNull();
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).slaPausedAt).toBeNull();
  });
  it('clears legacy input sessions without saving a question or reply', async () => {
    const { incident } = await fixture();
    const session = await prisma.operatorSession.create({ data: { maxUserId: actor.maxUserId, chatId: TEST_CHATS.sector,
      incidentId: incident.id, type: 'WAITING_CLARIFICATION_QUESTION', expiresAt: new Date(Date.now() + 60_000) } });
    await handleOperatorMessage(h.services, actor, TEST_CHATS.sector, { body: { text: 'Новый вопрос', mid: 'legacy' } } as never, session);
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Иван Иванов', []);
    await h.services.sessions.start({ maxUserId: requester.maxUserId, chatId: requester.maxUserId, incidentId: incident.id, type: 'WAITING_CLARIFICATION_REPLY' });
    await handleRequesterMessage(h.services, requester, requester.maxUserId, { body: { text: 'Новый ответ', mid: 'reply' } } as never);
    expect(await prisma.operatorSession.count()).toBe(0);
    expect(await prisma.clarification.count()).toBe(1);
    expect(h.messages.toUser(requester.maxUserId).at(-1)!.message.text).toContain('больше не требуется');
  });
});
