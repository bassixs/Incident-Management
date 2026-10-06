import { type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { MaxMessageService } from '../../src/max/max-message.service';
import { RetentionService } from '../../src/retention/retention.service';
import { createTestPrisma, describeIntegration, ensureUser, pushSchemaOnce, resetDatabase } from '../helpers/integration';

describeIntegration('durable failure boundaries', () => {
  let db: PrismaClient;
  beforeAll(async () => { pushSchemaOnce(); db = createTestPrisma(); await db.$connect(); });
  beforeEach(() => resetDatabase(db));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => db.$disconnect());
  const now = new Date('2026-10-06T00:00:00Z');
  const files = () => {
    const values = new Map<string, Buffer>();
    return { values, save: async ({ key, body }: { key: string; body: Buffer }) => {
      values.set(key, body); return { storageKey: key, size: body.length };
    }, load: async (key: string) => { const v = values.get(key); if (!v) throw Error('missing file'); return v; },
    exists: async (key: string) => values.has(key), remove: vi.fn(async (key: string) => { values.delete(key); }) };
  };
  async function expired() {
    const user = await ensureUser(db, 123n, 'Synthetic');
    const row = await db.incident.create({ data: { publicCode: 'INC-SYNTHETIC', requesterId: user.id,
      requesterMaxUserId: user.maxUserId, requesterName: 'Synthetic', text: 'Synthetic',
      status: 'RESOLVED', deadlineAt: new Date(0), answeredAt: new Date(0) } });
    await db.incidentAttachment.create({ data: { incidentId: row.id, type: 'FILE', storageKey: 'synthetic/file', size: 3 } });
    const job = await db.outboundMessage.create({ data: { targetType: 'user', targetId: 123n, incidentId: row.id,
      payload: { text: 'Synthetic' }, attachments: [], status: 'FAILED' } });
    return { row, job };
  }

  it('releases a claimed inbox event after a pre-dispatch database read fails', async () => {
    const row = await db.inboundUpdate.create({ data: { externalUpdateKey: 'synthetic-read', updateType: 'bot_started', payload: {} } });
    const max = { dispatch: vi.fn() };
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockRejectedValueOnce(Error('synthetic database read failure'));
    const worker = new UpdateDispatcher(db, max as never);
    try { await worker.kick().catch(() => undefined); }
    finally { worker.stop(); await worker.waitForIdle(); }
    const saved = await db.inboundUpdate.findUniqueOrThrow({ where: { id: row.id } });
    expect(max.dispatch).not.toHaveBeenCalled();
    expect(saved.status).not.toBe('PROCESSING');
    expect(saved.status).not.toBe('PROCESSED');
    expect(saved.lockedAt).toBeNull();
  });

  it('keeps an attachment when INSERT committed but its acknowledgement was lost', async () => {
    const storage = files();
    const create = db.outboundMessage.create.bind(db.outboundMessage);
    vi.spyOn(db.outboundMessage, 'create').mockImplementationOnce((async (args: any) => { await create(args); throw Error('lost database ACK'); }) as never);
    const worker = new MaxMessageService({} as never, { prisma: db, storage });
    worker.stop(); // enqueue only; no worker or MAX call
    await worker.send({ userId: 123n }, { text: 'Synthetic', delivery: { dedupeKey: 'stable-send' },
      attachments: [{ type: 'FILE', body: Buffer.from('pdf'), originalName: 'synthetic.pdf' }] }).catch(() => undefined);
    const row = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'stable-send' } });
    const key = (row.attachments as Array<{ storageKey: string }>)[0]!.storageKey;
    expect(await storage.exists(key)).toBe(true);
    expect(await db.outboundMessage.count()).toBe(1);
  });

  it('preserves incident, related jobs and files if status changed after candidate selection', async () => {
    const { row, job } = await expired(); const storage = files();
    await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const find = db.incident.findMany.bind(db.incident);
    vi.spyOn(db.incident, 'findMany').mockImplementationOnce((async (args: any) => {
      const selected = await find(args);
      await db.incident.update({ where: { id: row.id }, data: { status: 'IN_PROGRESS' } });
      return selected;
    }) as never);
    await new RetentionService(db, storage).run(now);
    expect(await db.incident.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).not.toBeNull();
    expect(await storage.exists('synthetic/file')).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('does not delete files when the retention database transaction rolls back', async () => {
    const { row, job } = await expired(); const storage = files();
    await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (fn: any) => transaction(async tx => {
      await fn(tx); throw Error('synthetic rollback');
    })) as never);
    await new RetentionService(db, storage).run(now);
    expect(await db.incident.findUnique({ where: { id: row.id } })).not.toBeNull();
    expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).not.toBeNull();
    expect(await storage.exists('synthetic/file')).toBe(true);
  });
});
