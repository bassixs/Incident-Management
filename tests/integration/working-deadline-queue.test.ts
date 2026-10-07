import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { resetConfigCache } from '../../src/config';
import { recordPolicyDelivery } from '../../src/sla/policy';
import { MaxMessageService } from '../../src/max/max-message.service';
import { createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_USERS, TEST_CHATS } from '../helpers/setup-env';

const time = (s: string) => new Date(`${s}+03:00`);
describeIntegration('working deadline queue review regressions', () => {
  let db: PrismaClient, h: TestHarness;
  const workers: MaxMessageService[] = [];
  const set = (s: string) => vi.setSystemTime(time(s));
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db);
    process.env.INCIDENT_SLA_POLICY = 'WORKING_HOURS_V1'; resetConfigCache();
    vi.useFakeTimers({ toFake: ['Date'] }); set('2026-10-09T16:00:00'); h = await createHarness(db);
  });
  afterEach(async () => {
    workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.waitForIdle()));
    vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.INCIDENT_SLA_POLICY; resetConfigCache();
  });
  afterAll(() => db.$disconnect());
  function worker(send: (...args: any[]) => Promise<any>) {
    const w = new MaxMessageService({ sendToChat: send, sendToUser: send, editCardWithKeyboard: async () => undefined,
      editMessage: async () => undefined } as never,
    { prisma: db, storage: { load: vi.fn(), save: vi.fn(), remove: vi.fn(), exists: vi.fn() } });
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }
  async function reminder() {
    const i = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Synthetic incident' });
    set('2026-10-14T16:59:59'); await h.services.sla.sweep();
    const job = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `sla-working-v1:${i.id}:${TEST_CHATS.distribution}` } });
    await db.outboundMessage.updateMany({ where: { id: { not: job.id } }, data: { nextAttemptAt: time('2026-11-01T00:00:00') } });
    return { i, job };
  }
  it('lets the next working card pass a reminder deferred after a MAX error across 17:00', async () => {
    const { job } = await reminder(); let fail = true;
    const sent: string[] = [];
    const w = worker(async (_id, text) => {
      if (fail) { fail = false; throw new MaxError(503, { code: 'unavailable', message: 'Synthetic error' }); }
      sent.push(text); return { body: { mid: `ack-${sent.length}` } };
    });
    await w.flush(); expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(1);
    set('2026-10-14T17:01:00'); await w.flush();
    await w.send({ chatId: job.targetId }, { text: 'Next working card', delivery: { dedupeKey: 'synthetic-card' } });
    await w.flush();
    expect(sent).toEqual(['Next working card']);
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).nextAttemptAt).toEqual(time('2026-10-15T08:00:00'));
  });
  it('records a delivered-answer reminder as cancelled rather than failed or sent', async () => {
    const { i, job } = await reminder(); await db.$transaction(tx => recordPolicyDelivery(tx, i.id, new Date()));
    const send = vi.fn().mockResolvedValue({ body: { mid: 'unexpected' } }); await worker(send).flush();
    expect(send).not.toHaveBeenCalled();
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.status).toBe('CANCELLED'); expect(row.sentAt).toBeNull(); expect(row.firstMessageId).toBeNull();
    expect((row as any).cancelReason).toBe('ANSWER_DELIVERED');
  });
});
