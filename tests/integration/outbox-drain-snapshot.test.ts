import { type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MaxMessageService } from '../../src/max/max-message.service';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

// Run unchanged against both bbfa7b9 and this branch. No timing sleeps.
describeIntegration('existing drain snapshot contract', () => {
  let db: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  afterAll(() => db.$disconnect());
  it('an already-running empty snapshot is not proof that a newly-due job was delivered', async () => {
    await resetDatabase(db);
    let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const find = db.outboundMessage.findFirst.bind(db.outboundMessage);
    let hold = true, unavailable = true;
    const max = { sendToUser: vi.fn(async () => {
      if (unavailable) throw Error('synthetic MAX outage');
      return { body: { mid: 'confirmed-retry' } };
    }) };
    vi.spyOn(db.outboundMessage, 'findFirst').mockImplementation((async (args: any) => {
      const value = await find(args);
      if (hold && args?.where?.NOT) { hold = false; expect(value).toBeNull(); enter(); await blocked; }
      return value;
    }) as never);
    const worker = new MaxMessageService(max as never, { prisma: db, storage: {} as never });
    try {
      await worker.send({ userId: 777n }, { text: 'Synthetic', delivery: { dedupeKey: 'snapshot-boundary' } });
      await entered; // real background wake already read the not-yet-due queue
      unavailable = false;
      await db.outboundMessage.update({ where: { dedupeKey: 'snapshot-boundary' }, data: { nextAttemptAt: new Date(0) } });
      const existingDrain = worker.flush(); release(); await existingDrain;
      expect(await db.outboundMessage.findUnique({ where: { dedupeKey: 'snapshot-boundary' } })).toMatchObject({ status: 'PENDING', attempts: 1 });
      await worker.flush(); // explicitly fresh snapshot, not an arbitrary sleep
      expect(await db.outboundMessage.findUnique({ where: { dedupeKey: 'snapshot-boundary' } })).toMatchObject({ status: 'SENT', firstMessageId: 'confirmed-retry', attempts: 2 });
      expect(max.sendToUser).toHaveBeenCalledTimes(2); // one failed request + one ACK
    } finally {
      release(); worker.stop(); await worker.waitForIdle(); vi.restoreAllMocks();
    }
  });
});
