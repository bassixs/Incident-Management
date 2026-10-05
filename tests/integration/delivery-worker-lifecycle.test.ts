import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { UserRole, type PrismaClient } from '@prisma/client';
import { MaxMessageService } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_USERS } from '../helpers/setup-env';

function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describeIntegration('outbox worker lifecycle evidence', () => {
  let prisma: PrismaClient;
  const workers: MaxMessageService[] = [];
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); });
  afterAll(() => prisma.$disconnect());

  it('two flushes on a replacement do not await an older worker owning the staff notification', async () => {
    const entered = gate(), release = gate(); let fail = true, sequence = 0;
    const accepted: string[] = [];
    const max = {
      sendToUser: async (_id: bigint, text: string) => {
        if (fail && text.includes('Получен ответ')) throw new Error('Simulated MAX unavailable');
        accepted.push(text); return { body: { mid: `user-${++sequence}` } };
      },
      sendToChat: async (_id: bigint, text: string) => {
        if (text.includes('доставлен пользователю')) { entered.resolve(); await release.promise; }
        accepted.push(text); return { body: { mid: `chat-${++sequence}` } };
      },
      editCardWithKeyboard: async () => undefined, editMessage: async () => undefined,
    };
    function worker() { const w = new MaxMessageService(max as never, { prisma, storage: {} as never }); workers.push(w); return w; }
    const old = worker();
    const services = buildServices(prisma, { messages: old, media: new FakeMediaService() as never });
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Test admin', [UserRole.ADMIN]);
    const incident = await services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Test light' });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.regional } });
    await services.distribution.assign(incident.id, group.id, actor);
    const { answer } = await services.answers.submit(incident.id, actor, 'Completed'); await old.flush();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_SENT' } })).toBe(0);
    fail = false;
    await prisma.outboundMessage.update({ where: { dedupeKey: `answer:${answer.id}` }, data: { nextAttemptAt: new Date(0) } });
    // Real background wake, deliberately not stopped: the old test's restart boundary.
    old.wake();
    try {
      await entered.promise;
      const replacement = worker(); await replacement.flush(); await replacement.flush();
      expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).not.toBeNull();
      expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_SENT' } })).toBe(1);
      expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `answer-delivered:${answer.id}:sector` } })).toMatchObject({ status: 'SENDING', attempts: 1 });
      // Precisely the old failing assertion: delivery is committed, notification still in flight.
      expect(accepted.filter(t => t.includes('доставлен пользователю'))).toHaveLength(0);
      old.stop(); replacement.stop();
    } finally { release.resolve(); }
    await Promise.all(workers.map(w => w.waitForIdle()));
    expect(accepted.filter(t => t.includes('доставлен пользователю'))).toHaveLength(1);
    expect(accepted.filter(t => t.includes('Получен ответ'))).toHaveLength(1);
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `answer-delivered:${answer.id}:sector` } })).toMatchObject({ status: 'SENT', attempts: 1 });
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ANSWER_SENT' } })).toBe(1);
  });
});
