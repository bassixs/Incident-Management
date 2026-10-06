import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { drainFileDeletions, queueFileDeletion, FILE_DELETION_PREFIX, FILE_DELETION_STATE_PREFIX, FILE_DELETION_FENCE_PREFIX } from '../../src/retention/file-deletions';
import { createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase } from '../helpers/integration';

function barrier() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describeIntegration('PR13 review boundaries', () => {
  let db: PrismaClient;
  beforeAll(async () => {
    pushSchemaOnce(); db = createTestPrisma(); await db.$connect();
    // db push cannot install triggers. Exercise the exact migration SQL as well.
    for (const statement of readFileSync('prisma/migrations/20261006230000_storage_deletion_fence/migration.sql', 'utf8').split('-- statement')) {
      await db.$executeRawUnsafe(statement);
    }
  });
  beforeEach(() => resetDatabase(db));
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => db.$disconnect());
  async function event(key: string, partitionKey: string) {
    return db.inboundUpdate.create({ data: { externalUpdateKey: key, partitionKey, updateType: 'bot_started', payload: { key } } });
  }
  async function intent(key: string) {
    await db.$transaction(tx => queueFileDeletion(tx, { storageKey: key, size: 1, publicCode: 'INC-SYNTHETIC' }));
  }
  async function stateRows() { return db.systemSetting.findMany({ where: { key: { startsWith: FILE_DELETION_STATE_PREFIX } } }); }

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

  it('repeated pre-dispatch errors retain order across restart until bounded exhaustion', async () => {
    const first = await event('first', 'user:1'); await event('second', 'user:1'); await event('other', 'user:2');
    const seen: string[] = [];
    const max = { dispatch: vi.fn(async (v: any) => { seen.push(v.key); }) };
    const original = db.inboundUpdate.findUniqueOrThrow.bind(db.inboundUpdate);
    vi.spyOn(db.inboundUpdate, 'findUniqueOrThrow').mockImplementation(((args: any) => {
      if (args.where.id === first.id) return Promise.reject(Error('pre-dispatch'));
      return original(args);
    }) as never);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const worker = new UpdateDispatcher(db, max as never, 2);
      try {
        if (attempt > 1) {
          await worker.start();
          expect(seen).toEqual(['other']); // persisted future head survives restart
          await db.inboundUpdate.update({ where: { id: first.id }, data: { nextAttemptAt: new Date(0) } });
        }
        await worker.kick();
      } finally { worker.stop(); await worker.waitForIdle(); }
      expect(seen).toEqual(attempt === 3 ? ['other', 'second'] : ['other']);
      expect((await original({ where: { id: first.id } })).attempts).toBe(attempt);
    }
    expect((await original({ where: { id: first.id } })).status).toBe('FAILED');
  });

  it('a recovered head dispatches before its follower, including competing workers', async () => {
    const head = await event('first', 'user:1'); await event('second', 'user:1');
    await db.inboundUpdate.update({ where: { id: head.id }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } });
    const seen: string[] = []; const entered = barrier(); const release = barrier();
    const max = { dispatch: vi.fn(async (v: any) => { seen.push(v.key); if (v.key === 'first') { entered.resolve(); await release.promise; } }) };
    const a = new UpdateDispatcher(db, max as never); const b = new UpdateDispatcher(db, max as never);
    try {
      await Promise.all([a.kick(), b.kick()]); expect(seen).toEqual([]);
      await db.inboundUpdate.update({ where: { id: head.id }, data: { nextAttemptAt: new Date(0) } });
      const running = a.kick(); await entered.promise;
      await b.kick(); expect(seen).toEqual(['first']);
      release.resolve(); await running; await b.kick(); expect(seen).toEqual(['first', 'second']);
    } finally { release.resolve(); a.stop(); b.stop(); await Promise.all([a.waitForIdle(), b.waitForIdle()]); }
  });

  it('late removal after timeout holds only a permanent key fence, never table locks', async () => {
    await intent('late'); const entered = barrier(); const release = barrier(); const finished = barrier();
    const remove = vi.fn(async () => { entered.resolve(); await release.promise; finished.resolve(); });
    const work = drainFileDeletions(db, { remove } as never, { removeTimeoutMs: 50 });
    await entered.promise;
    await event('write-while-storage-hangs', 'user:9');
    await db.outboundMessage.create({ data: { targetType: 'user', targetId: 9n, payload: { storageKey: 'unrelated' }, attachments: [] } });
    const result = await work;
    expect(result.deletedFiles).toBe(0); expect(result.failures[0]?.error).toContain('STORAGE_RESULT_UNKNOWN');
    expect(JSON.parse((await stateRows())[0]!.value).status).toBe('unknown');
    const reference = () => db.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, payload: {}, attachments: [{ storageKey: 'late' }] } });
    await expect(reference()).rejects.toThrow('STORAGE_KEY_RETIRED');
    release.resolve(); await finished.promise;
    await expect(reference()).rejects.toThrow('STORAGE_KEY_RETIRED');
    await drainFileDeletions(db, { remove } as never, { now: () => Date.now() + 600_000 });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_PREFIX } } })).toBe(1);
  });

  it('a reference committed by another client before retirement preserves the file', async () => {
    await intent('shared-race'); const entered = barrier(); const release = barrier(); const writer = createTestPrisma();
    const transaction = writer.$transaction(async tx => {
      await tx.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, payload: {}, attachments: [{ storageKey: 'shared-race' }] } });
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const remove = vi.fn(async () => undefined);
    const draining = drainFileDeletions(db, { remove } as never);
    release.resolve(); await transaction; await draining; await writer.$disconnect();
    expect(remove).not.toHaveBeenCalled();
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_FENCE_PREFIX } } })).toBe(0);
  });

  it('all seven reference writers reject retired keys and permit unrelated keys', async () => {
    await intent('retired'); await drainFileDeletions(db, { remove: async () => undefined } as never);
    const tables = ['IncidentAttachment','AnswerAttachment','ClarificationAttachment','OutboundMessage','OperatorSession','PrivateWorkItem','InboundUpdate'];
    const triggers = await db.$queryRaw<Array<{ table_name: string }>>`SELECT event_object_table AS table_name FROM information_schema.triggers WHERE trigger_name='guard_retired_storage' AND event_manipulation='INSERT'`;
    expect(triggers.map(r => r.table_name).sort()).toEqual(tables.sort());
    // A generic trigger reads top-level and nested JSON storage keys identically.
    for (const payload of [{ storageKey: 'retired' }, { nested: [{ storageKey: 'retired' }] }]) {
      await expect(db.inboundUpdate.create({ data: { externalUpdateKey: JSON.stringify(payload), updateType: 'bot_started', payload } })).rejects.toThrow('STORAGE_KEY_RETIRED');
    }
    await event('unrelated', 'user:3');
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_FENCE_PREFIX } } })).toBe(1);
  });

  it('bounded persisted retries preserve errors, malformed records and later work', async () => {
    await intent('persistent');
    const corrupt = FILE_DELETION_PREFIX + 'corrupt';
    await db.systemSetting.create({ data: { key: corrupt, value: '{invalid json' } });
    const remove = vi.fn(async () => { throw Error('private external detail must not be saved'); });
    let clock = Date.now();
    for (let n = 0; n < 5; n++) {
      await drainFileDeletions(db, { remove } as never, { now: () => clock }); clock += 60_001;
    }
    expect(remove).toHaveBeenCalledTimes(3);
    const states = (await stateRows()).map(r => JSON.parse(r.value));
    expect(states.map(s => s.status).sort()).toEqual(['exhausted','invalid']);
    expect(JSON.stringify(states)).not.toContain('private external detail');
    expect((await db.systemSetting.findUniqueOrThrow({ where: { key: corrupt } })).value).toBe('{invalid json');
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_PREFIX } } })).toBe(2);
    await intent('later'); const good = vi.fn(async () => undefined);
    await drainFileDeletions(db, { remove: good } as never, { now: () => clock });
    expect(good).toHaveBeenCalledExactlyOnceWith('later');
  });
});
