import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { drainFileDeletions, queueFileDeletion, FILE_DELETION_PREFIX } from '../../src/retention/file-deletions';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describeIntegration('PR13 review boundaries', () => {
  let db: PrismaClient;
  beforeAll(async () => { pushSchemaOnce(); db = createTestPrisma(); await db.$connect(); });
  beforeEach(() => resetDatabase(db));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => db.$disconnect());
  async function event(key: string, partitionKey: string) {
    return db.inboundUpdate.create({ data: { externalUpdateKey: key, partitionKey, updateType: 'bot_started', payload: { key } } });
  }
  async function intent(key: string) {
    await db.$transaction(tx => queueFileDeletion(tx, { storageKey: key, size: 1, publicCode: 'INC-SYNTHETIC' }));
  }

  it('a delayed head keeps its lane while another user can proceed', async () => {
    const first = await event('first', 'user:1'); await event('second', 'user:1'); await event('other', 'user:2');
    const dispatch = vi.fn(async () => undefined);
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockRejectedValueOnce(Error('before business'));
    const worker = new UpdateDispatcher(db, { dispatch } as never, 1);
    try { await worker.kick(); } finally { worker.stop(); await worker.waitForIdle(); }
    expect(dispatch.mock.calls.map(c => (c as any)[0].key)).toEqual(['other']);
    expect((await db.inboundUpdate.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('PENDING');
  });

  it('a suspended storage removal does not block inbox or outbox writes', async () => {
    await intent('slow-file');
    const entered = barrier(); const release = barrier();
    const remove = vi.fn(async () => { entered.resolve(); await release.promise; });
    const draining = drainFileDeletions(db, { remove } as never);
    await entered.promise;
    const writer = createTestPrisma(); let written = false;
    try {
      await writer.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await tx.inboundUpdate.create({ data: { externalUpdateKey: 'parallel', updateType: 'bot_started', payload: {} } });
        await tx.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, payload: {}, attachments: [] } });
      }); written = true;
    } catch { /* record actual lock refusal, then release the storage barrier */ }
    finally { release.resolve(); await draining; await writer.$disconnect(); }
    expect(written).toBe(true);
  });

  it('100 failing deletion records do not starve the next valid record', async () => {
    for (let n = 0; n < 100; n++) await intent(`bad-${n}`);
    await db.systemSetting.updateMany({ where: { key: { startsWith: FILE_DELETION_PREFIX } }, data: { updatedAt: new Date(0) } });
    await intent('good');
    const remove = vi.fn(async (key: string) => { if (key !== 'good') throw Error('persistent storage error'); });
    await drainFileDeletions(db, { remove } as never);
    await drainFileDeletions(db, { remove } as never);
    expect(remove).toHaveBeenCalledWith('good');
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_PREFIX } } })).toBe(100);
  });
});
