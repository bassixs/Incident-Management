import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { queueMessage } from '../../src/delivery/workflow-outbox';
import { MaxMessageService } from '../../src/max/max-message.service';
import { actorFor, createHarness, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_USERS } from '../helpers/setup-env';

describeIntegration('executor channel in the post-rating invitation', () => {
  let prisma: PrismaClient; let h: TestHarness;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); });

  it('uses the actual executor after delivery and rating, upgrades a held invitation and sends it once', async () => {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
    const incident = await h.services.incidents.create({
      requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+79001112233' },
      text: 'Нужен ремонт памятника', problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга',
    });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await h.services.distribution.assign(incident.id, group.id, actor);
    // The title and resident's municipality must not select a different channel.
    await prisma.responsibleGroup.update({ where: { id: group.id }, data: { code: 'EA_CULTURAL_HERITAGE', name: 'Переименованный профильный чат' } });
    const key = `subscription-invite:${incident.id}`;
    await expect(h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5)).rejects.toThrow();
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: key } })).toBeNull();
    await h.services.answers.submit(incident.id, actor, 'Работы завершены');
    await h.services.review.approve(incident.id, actor);
    // An invitation saved by an earlier release still needs the executor button.
    await prisma.$transaction(tx => queueMessage(tx, { userId: TEST_USERS.requesterA }, {
      text: 'Подпишитесь:', delivery: { dedupeKey: key },
    }, incident.id));
    await prisma.outboundMessage.updateMany({ where: { dedupeKey: { not: key } }, data: { status: 'SENT' } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'subscription' } });
    const worker = new MaxMessageService({ sendToUser } as never, { prisma, storage: {} as never });
    await worker.flush(); expect(sendToUser).not.toHaveBeenCalled();
    await expect(h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterB, 5)).rejects.toThrow();
    const ratings = await Promise.allSettled([
      h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5),
      h.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 4),
    ]);
    expect(ratings.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await worker.flush(); await worker.flush();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser).toHaveBeenCalledWith(TEST_USERS.requesterA, expect.stringContaining('канале исполнителя'), expect.objectContaining({
      attachments: [{ type: 'inline_keyboard', payload: { buttons: [
        [{ type: 'link', text: 'Владислав Шапша', url: 'https://max.ru/Shapsha_VV' }],
        [{ type: 'link', text: 'Правительство Калужской области', url: 'https://max.ru/pravitelstvo40' }],
        [{ type: 'link', text: 'Управление по охране культурного наследия', url: 'https://max.ru/id4028060590_gos' }],
      ] } }],
    }));
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: key } })).toBe(1);
  });
});
