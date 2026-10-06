import { Prisma, type PrismaClient } from '@prisma/client';
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
  it('retries only failed state persistence while DB is down, then safely dispatches once', async () => {
    const row = await db.inboundUpdate.create({ data: { externalUpdateKey: 'retry-read', updateType: 'bot_started', payload: {} } });
    const max = { dispatch: vi.fn(async () => undefined) };
    const update = db.inboundUpdate.updateMany.bind(db.inboundUpdate);
    let unavailable = true;
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockRejectedValueOnce(Error('read unavailable'));
    vi.spyOn(db.inboundUpdate, 'updateMany').mockImplementation(((args: any) => {
      if (unavailable && args.where.status === 'PROCESSING') throw Error('write unavailable');
      return update(args);
    }) as never);
    const worker = new UpdateDispatcher(db, max as never);
    await expect(worker.kick()).rejects.toThrow('write unavailable');
    expect(max.dispatch).not.toHaveBeenCalled();
    unavailable = false;
    await worker.kick(); // settles failure only; the delayed business retry is not due
    expect((await db.inboundUpdate.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PENDING');
    expect(max.dispatch).not.toHaveBeenCalled();
    await db.inboundUpdate.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    const competitor = new UpdateDispatcher(db, max as never);
    await Promise.all([worker.kick(), competitor.kick()]);
    worker.stop(); competitor.stop(); await Promise.all([worker.waitForIdle(), competitor.waitForIdle()]);
    expect(max.dispatch).toHaveBeenCalledTimes(1);
    expect((await db.inboundUpdate.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('PROCESSED');
  });

  it('bounds pre-business retries and never blindly replays an uncertain business action', async () => {
    const row = await db.inboundUpdate.create({ data: { externalUpdateKey: 'bounded', updateType: 'bot_started', payload: {} } });
    const max = { dispatch: vi.fn(async () => { throw Error('business result unknown'); }) };
    const read = vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow');
    const worker = new UpdateDispatcher(db, max as never);
    for (let attempt = 0; attempt < 3; attempt++) {
      read.mockRejectedValueOnce(Error('read down'));
      await worker.kick();
      await db.inboundUpdate.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    }
    expect((await db.inboundUpdate.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('FAILED');
    expect(max.dispatch).not.toHaveBeenCalled();
    await db.inboundUpdate.create({ data: { externalUpdateKey: 'business', updateType: 'bot_started', payload: {} } });
    await worker.kick(); await worker.kick(); worker.stop(); await worker.waitForIdle();
    expect(max.dispatch).toHaveBeenCalledTimes(1);
    const restarted = new UpdateDispatcher(db, max as never);
    await restarted.start(); restarted.stop(); await restarted.waitForIdle();
    expect(max.dispatch).toHaveBeenCalledTimes(1);
    expect(await db.inboundUpdate.count({ where: { status: 'FAILED', processedAt: null } })).toBe(2);
  });

  it('keeps an interrupted PROCESSING event for manual review after restart, not automatic replay', async () => {
    await db.inboundUpdate.create({ data: { externalUpdateKey: 'interrupted', updateType: 'bot_started', payload: {}, status: 'PROCESSING', lockedAt: new Date() } });
    const max = { dispatch: vi.fn() }; const worker = new UpdateDispatcher(db, max as never);
    await worker.start(); worker.stop(); await worker.waitForIdle();
    expect(max.dispatch).not.toHaveBeenCalled();
    expect(await db.inboundUpdate.count({ where: { status: 'FAILED', lockedAt: null, processedAt: null } })).toBe(1);
  });

  it('retains files when both commit acknowledgement and reconciliation read fail, then delivers after restart', async () => {
    const storage = files(); const create = db.outboundMessage.create.bind(db.outboundMessage);
    const find = db.outboundMessage.findUnique.bind(db.outboundMessage);
    let lost = false;
    vi.spyOn(db.outboundMessage, 'create').mockImplementationOnce((async (args: any) => { await create(args); lost = true; throw Error('lost ACK'); }) as never);
    vi.spyOn(db.outboundMessage, 'findUnique').mockImplementation(((args: any) => {
      if (lost) { lost = false; throw Error('database unavailable during reconciliation'); }
      return find(args);
    }) as never);
    const worker = new MaxMessageService({} as never, { prisma: db, storage }); worker.stop();
    await expect(worker.send({ userId: 123n }, { text: 'Synthetic', delivery: { dedupeKey: 'lost-ack' },
      attachments: [{ type: 'FILE', body: Buffer.from('pdf') }] })).rejects.toThrow('reconciliation');
    expect(storage.values.size).toBe(1); expect(storage.remove).not.toHaveBeenCalled();
    const max = { uploadFile: vi.fn(async () => ({ type: 'file', payload: { token: 'synthetic' } })),
      sendToUser: vi.fn(async () => ({ body: { mid: 'synthetic-ack' } })) };
    const restarted = new MaxMessageService(max as never, { prisma: db, storage });
    await restarted.flush(); restarted.stop(); await restarted.waitForIdle();
    const saved = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'lost-ack' } });
    expect(saved.status).toBe('SENT');
    expect(saved.payload).toMatchObject({ deliveryProgress: { version: 1, mids: ['synthetic-ack'] } });
    expect(max.sendToUser).toHaveBeenCalledTimes(1);
    await worker.send({ userId: 123n }, { text: 'Synthetic', delivery: { dedupeKey: 'lost-ack' } });
    expect(await db.outboundMessage.count()).toBe(1);
  });

  it('does not interpret a successful absent read after an ambiguous INSERT as proof of rollback', async () => {
    const storage = files();
    vi.spyOn(db.outboundMessage, 'create').mockRejectedValueOnce(Error('unknown write result'));
    const worker = new MaxMessageService({} as never, { prisma: db, storage }); worker.stop();
    await expect(worker.send({ userId: 123n }, { text: 'Synthetic', attachments: [{ type: 'FILE', body: Buffer.from('pdf') }] })).rejects.toThrow('unknown');
    expect(await db.outboundMessage.count()).toBe(0);
    expect(storage.values.size).toBe(1); expect(storage.remove).not.toHaveBeenCalled();
  });

  it('cleans only this operation files after a confirmed rejected INSERT', async () => {
    const storage = files(); await storage.save({ key: 'foreign/shared', body: Buffer.from('keep') });
    vi.spyOn(db.outboundMessage, 'create').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique rejection', { code: 'P2002', clientVersion: 'synthetic' }));
    const worker = new MaxMessageService({} as never, { prisma: db, storage }); worker.stop();
    await expect(worker.send({ userId: 123n }, { text: 'Synthetic', attachments: [{ type: 'FILE', body: Buffer.from('pdf') }] })).rejects.toThrow('unique');
    expect([...storage.values.keys()]).toEqual(['foreign/shared']);
  });

  it('concurrent enqueue with one dedupe key keeps exactly one job and its file', async () => {
    const storage = files();
    const first = new MaxMessageService({} as never, { prisma: db, storage }); first.stop();
    const second = new MaxMessageService({} as never, { prisma: db, storage }); second.stop();
    const message = { text: 'Synthetic', delivery: { dedupeKey: 'concurrent' }, attachments: [{ type: 'FILE' as const, body: Buffer.from('pdf') }] };
    await Promise.all([first.send({ userId: 123n }, message), second.send({ userId: 123n }, message)]);
    expect(await db.outboundMessage.count()).toBe(1);
    expect(storage.values.size).toBe(1);
  });

  it('keeps shared files and retries post-commit deletion failures on the next retention instance', async () => {
    const { row } = await expired(); const storage = files();
    await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const other = await db.incident.create({ data: { publicCode: 'INC-OTHER', requesterId: row.requesterId,
      requesterMaxUserId: 123n, requesterName: 'Synthetic', text: 'Synthetic', deadlineAt: now,
      attachments: { create: { type: 'FILE', storageKey: 'synthetic/file' } } } });
    await new RetentionService(db, storage).run(now);
    expect(await db.incident.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await storage.exists('synthetic/file')).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(await db.systemSetting.count({ where: { key: { startsWith: 'retention.file-delete.v1:' } } })).toBe(1);
    await db.incidentAttachment.deleteMany({ where: { incidentId: other.id } });
    storage.remove.mockRejectedValueOnce(Error('storage temporarily unavailable'));
    const failed = await new RetentionService(db, storage).run(now);
    expect(failed.failures).toHaveLength(1);
    expect(await storage.exists('synthetic/file')).toBe(true);
    const retried = await new RetentionService(db, storage).run(now);
    expect(retried.deletedFiles).toBe(1);
    expect(await storage.exists('synthetic/file')).toBe(false);
    expect(await db.systemSetting.count({ where: { key: { startsWith: 'retention.file-delete.v1:' } } })).toBe(0);
    expect((await new RetentionService(db, storage).run(now)).deletedFiles).toBe(0);
  });

  it('preserves files borrowed by an unrelated outgoing job', async () => {
    await expired(); const storage = files(); await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const borrowed = await db.outboundMessage.create({ data: { targetType: 'chat', targetId: 456n,
      payload: { text: 'Synthetic' }, attachments: [{ type: 'FILE', storageKey: 'synthetic/file', owned: false }] } });
    await new RetentionService(db, storage).run(now);
    expect(await db.outboundMessage.findUnique({ where: { id: borrowed.id } })).not.toBeNull();
    expect(await storage.exists('synthetic/file')).toBe(true); expect(storage.remove).not.toHaveBeenCalled();
  });

  it('reconciles a lost claim ACK before any business action and deduplicates redelivery', async () => {
    const max = { dispatch: vi.fn(async () => undefined) };
    const worker = new UpdateDispatcher(db, max as never);
    const event = { update_type: 'bot_started', timestamp: 1, chat_id: 123, user: { user_id: 123, name: 'Synthetic' } } as never;
    const reserved = await worker.reserve(event);
    const update = db.inboundUpdate.updateMany.bind(db.inboundUpdate);
    vi.spyOn(db.inboundUpdate, 'updateMany').mockImplementationOnce((async (args: any) => { await update(args); throw Error('claim ACK lost'); }) as never);
    await worker.kick();
    expect(max.dispatch).not.toHaveBeenCalled();
    expect((await db.inboundUpdate.findUniqueOrThrow({ where: { id: reserved.id } })).status).toBe('PENDING');
    expect((await worker.reserve(event)).fresh).toBe(false);
    await db.inboundUpdate.update({ where: { id: reserved.id }, data: { nextAttemptAt: new Date(0) } });
    await worker.kick(); worker.stop(); await worker.waitForIdle();
    expect(max.dispatch).toHaveBeenCalledTimes(1);
    expect(await db.inboundUpdate.count()).toBe(1);
  });

  it('a competing dispatcher cannot enter business handling while the claimed read is delayed', async () => {
    await db.inboundUpdate.create({ data: { externalUpdateKey: 'concurrent-read', updateType: 'bot_started', payload: {} } });
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const read = db.inboundUpdate.findUniqueOrThrow.bind(db.inboundUpdate);
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockImplementationOnce((async (args: any) => {
      entered(); await blocked; return read(args);
    }) as never);
    const max = { dispatch: vi.fn(async () => undefined) };
    const first = new UpdateDispatcher(db, max as never); const second = new UpdateDispatcher(db, max as never);
    const active = first.kick(); await started; await second.kick();
    expect(max.dispatch).not.toHaveBeenCalled();
    release(); await active; first.stop(); second.stop(); await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(max.dispatch).toHaveBeenCalledTimes(1);
  });

  it('revalidates eligibility after a real competing transaction locks and changes the incident', async () => {
    const { row, job } = await expired(); const storage = files();
    await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const competitor = createTestPrisma();
    const find = db.incident.findMany.bind(db.incident);
    vi.spyOn(db.incident, 'findMany').mockImplementationOnce((async (args: any) => {
      const stale = await find(args);
      await competitor.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Incident" WHERE id=${row.id} FOR UPDATE`;
        await tx.incident.update({ where: { id: row.id }, data: { status: 'REVISION_REQUIRED' } });
      });
      return stale;
    }) as never);
    try { await new RetentionService(db, storage).run(now); }
    finally { await competitor.$disconnect(); }
    expect((await db.incident.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('REVISION_REQUIRED');
    expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).not.toBeNull();
    expect(await storage.exists('synthetic/file')).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('a lost retention COMMIT acknowledgement leaves durable, safely reconcilable file work', async () => {
    const { row } = await expired(); const storage = files();
    await storage.save({ key: 'synthetic/file', body: Buffer.from('pdf') });
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementationOnce((async (fn: any) => { await transaction(fn); throw Error('COMMIT ACK lost'); }) as never);
    const result = await new RetentionService(db, storage).run(now);
    expect(result.failures).toHaveLength(1); // uncertain caller result is not hidden
    expect(await db.incident.findUnique({ where: { id: row.id } })).toBeNull();
    // The independent journal read proves commit before the physical removal.
    expect(await storage.exists('synthetic/file')).toBe(false);
    expect((await new RetentionService(db, storage).run(now)).deletedFiles).toBe(0);
  });

  it('a lost competing claim ACK cannot release the owner even with identical claim timestamps', async () => {
    const row = await db.inboundUpdate.create({ data: { externalUpdateKey: 'same-clock', updateType: 'bot_started', payload: {} } });
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const blocked = new Promise<void>(r => { release = r; });
    const read = db.inboundUpdate.findUniqueOrThrow.bind(db.inboundUpdate);
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockImplementationOnce((async (args: any) => { entered(); await blocked; return read(args); }) as never);
    const max = { dispatch: vi.fn(async () => undefined) };
    const first = new UpdateDispatcher(db, max as never); const second = new UpdateDispatcher(db, max as never);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    const active = first.kick();
    try {
      await started;
      const claimed = await read({ where: { id: row.id } });
      const update = db.inboundUpdate.updateMany.bind(db.inboundUpdate);
      vi.spyOn(db.inboundUpdate, 'updateMany').mockImplementationOnce((async (args: any) => {
        expect(args.data.lockedAt.getTime()).toBe(claimed.lockedAt!.getTime());
        expect((await update(args)).count).toBe(0);
        throw Error('competing claim ACK lost');
      }) as never);
      await (second as any).processById(row.id);
      expect((await read({ where: { id: row.id } })).processingToken).toBe(claimed.processingToken);
      expect((await read({ where: { id: row.id } })).status).toBe('PROCESSING');
    } finally {
      release(); await active; first.stop(); second.stop();
      await Promise.all([first.waitForIdle(), second.waitForIdle()]); vi.useRealTimers();
    }
    expect(max.dispatch).toHaveBeenCalledTimes(1);
  });

});

