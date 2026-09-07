import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { actorFor, createHarness, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('executor signature through submission and delivery', () => {
  let prisma: PrismaClient; let h: TestHarness;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); });

  it.each([
    { direct: false, authority: 'ГЖИ', expected: 'Государственной жилищной инспекцией Калужской области' },
    { direct: true, authority: 'Калужская область', expected: 'Администрацией Губернатора Калужской области' },
  ])('$authority: stored and immediately delivered signatures match', async ({ direct, authority, expected }) => {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
    const group = await prisma.responsibleGroup.update({
      where: { code: direct ? GROUP_CODES.regional : GROUP_CODES.facility },
      data: { name: 'Переименованный рабочий чат', authorityName: authority },
    });
    const incident = await h.services.incidents.create({
      requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+79001112233' },
      text: 'Нужен ремонт', problemMunicipalityCode: 'OBNINSK_CITY', problemMunicipalityName: 'Город Обнинск',
    });
    await h.services.distribution.assign(incident.id, group.id, actor);
    const { answer, sentDirectly } = await h.services.answers.submit(incident.id, actor, 'Ремонт выполнен');
    const signature = `Ответ подготовлен ${expected}.`;
    expect(sentDirectly).toBe(direct);
    if (!direct) {
      const review = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `review-card:${answer.id}` } });
      expect(review.payload).toMatchObject({ text: expect.stringContaining(signature) });
      expect(h.messages.toChat(TEST_CHATS.review).at(-1)?.message.text).toContain(signature);
      await h.services.review.approve(incident.id, actor);
    } else {
      expect(h.messages.toChat(TEST_CHATS.review)).toHaveLength(0);
    }
    const queued = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } });
    expect(queued.payload).toMatchObject({ text: expect.stringContaining(signature) });
    const delivered = h.messages.toUser(TEST_USERS.requesterA).at(-1)!.message.text;
    expect(delivered).toContain(signature);
    expect(delivered).not.toContain('Администрацией города Обнинска');
    expect(delivered).not.toContain('Переименованный рабочий чат');
    expect(h.messages.toUser(TEST_USERS.requesterB)).toHaveLength(0);
  });
});
