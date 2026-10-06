import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    return db.inboundUpdate.create({ data: { externalUpdateKey: key, partitionKey, updateType: 'bot_started', nextAttemptAt: new Date(0), payload: { key } } });
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

  it('an eligibility read failure stops the sweep without claiming or spinning', async () => {
    const row = await event('eligibility', 'user:1'); const dispatch = vi.fn(async () => undefined);
    const query = db.$queryRaw.bind(db); let calls = 0;
    vi.spyOn(db, '$queryRaw').mockImplementation(((...args: any[]) => {
      if (++calls === 2) throw Error('eligibility unavailable');
      return (query as any)(...args);
    }) as never);
    const worker = new UpdateDispatcher(db, { dispatch } as never, 1);
    try {
      await expect(worker.kick()).rejects.toThrow('eligibility unavailable');
      expect(calls).toBe(2); expect(dispatch).not.toHaveBeenCalled();
      expect(await db.inboundUpdate.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'PENDING', attempts: 0 });
      await worker.kick(); expect(dispatch).toHaveBeenCalledTimes(1);
    } finally { worker.stop(); await worker.waitForIdle(); }
  });

  it('direct handle cannot bypass an earlier reserved event in the same lane', async () => {
    const head = await event('first', 'user:1');
    await db.inboundUpdate.update({ where: { id: head.id }, data: { nextAttemptAt: new Date(Date.now() + 60_000) } });
    const seen: string[] = []; const dispatch = vi.fn(async (v: any) => { seen.push(v.key); });
    const worker = new UpdateDispatcher(db, { dispatch } as never, 1);
    try {
      await worker.handle({ update_type: 'bot_started', user: { user_id: 1 }, chat_id: 1, timestamp: 1, key: 'second' } as never);
      expect(seen).toEqual([]);
      expect(await db.inboundUpdate.count({ where: { status: 'PENDING', attempts: 0 } })).toBe(2);
      await db.inboundUpdate.update({ where: { id: head.id }, data: { nextAttemptAt: new Date(0) } });
      await worker.kick(); expect(seen).toEqual(['first','second']);
      expect(await db.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(2);
    } finally { worker.stop(); await worker.waitForIdle(); }
  });

  it('a suspended storage removal does not block inbox or outbox writes', async () => {
    await intent('slow-file');
    const entered = barrier(); const release = barrier();
    const remove = vi.fn(async () => { entered.resolve(); await release.promise; });
    const draining = drainFileDeletions(db, { remove } as never);
    await Promise.race([entered.promise, draining.then(r => { if (!remove.mock.calls.length) throw Error(JSON.stringify(r)); })]);
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
    await Promise.race([entered.promise, work.then(r => { if (!remove.mock.calls.length) throw Error(JSON.stringify(r)); })]);
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
    try {
      await expect.poll(async () => {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS waiting`;
        return rows[0]?.waiting;
      }).toBe(true);
    } finally { release.resolve(); await transaction; await draining; await writer.$disconnect(); }
    expect(remove).not.toHaveBeenCalled();
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_FENCE_PREFIX } } })).toBe(0);
  });

  it('a writer already waiting for the key sees the fence committed after its statement began', async () => {
    const key = 'fence-commit-race'; const entered = barrier(); const release = barrier();
    const writer = createTestPrisma();
    const fence = db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 724091))`;
      await tx.systemSetting.create({ data: { key: FILE_DELETION_FENCE_PREFIX + createHash('sha256').update(key).digest('hex'), value: 'PERMANENT_STORAGE_KEY_RETIREMENT_V1' } });
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const writing = writer.outboundMessage.create({ data: { targetType: 'user', targetId: 1n, payload: {}, attachments: [{ storageKey: key }] } })
      .then(() => 'UNEXPECTED_COMMIT', e => String(e));
    try {
      await expect.poll(async () => {
        const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory') AS waiting`;
        return rows[0]?.waiting;
      }).toBe(true);
    } finally { release.resolve(); await fence; }
    try {
      expect(await writing).toContain('STORAGE_KEY_RETIRED');
      expect(await db.outboundMessage.count()).toBe(0);
    } finally { await writer.$disconnect(); }
  });

  it('all seven reference writers reject retired keys and permit unrelated keys', async () => {
    await intent('retired'); await drainFileDeletions(db, { remove: async () => undefined } as never);
    const tables = ['IncidentAttachment','AnswerAttachment','ClarificationAttachment','OutboundMessage','OperatorSession','PrivateWorkItem','InboundUpdate'];
    const triggers = await db.$queryRaw<Array<{ table_name: string }>>`SELECT event_object_table AS table_name FROM information_schema.triggers WHERE trigger_name='guard_retired_storage' AND event_manipulation='INSERT'`;
    expect(triggers.map(r => r.table_name).sort()).toEqual(tables.sort());
    const user = await db.user.create({ data: { maxUserId: 10n, displayName: 'Synthetic' } });
    const incident = await db.incident.create({ data: { publicCode: 'INC-SYNTHETIC', requesterId: user.id, requesterMaxUserId: 10n, requesterName: 'Synthetic', text: 'Synthetic', deadlineAt: new Date() } });
    const answer = await db.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, text: 'Synthetic', createdByUserId: user.id } });
    const clarification = await db.clarification.create({ data: { incidentId: incident.id, question: 'Synthetic', askedByUserId: user.id, askedByMaxUserId: 10n, chatId: 10n, questionSourceId: 'synthetic' } });
    const writers = [
      (storageKey: string) => db.incidentAttachment.create({ data: { incidentId: incident.id, type: 'FILE', storageKey } }),
      (storageKey: string) => db.answerAttachment.create({ data: { answerId: answer.id, type: 'FILE', storageKey } }),
      (storageKey: string) => db.clarificationAttachment.create({ data: { clarificationId: clarification.id, type: 'FILE', storageKey } }),
      (storageKey: string) => db.outboundMessage.create({ data: { targetType: 'user', targetId: 10n, attachments: [], payload: { nested: [{ storageKey }] } } }),
      (storageKey: string) => db.operatorSession.create({ data: { maxUserId: 10n, chatId: 10n, type: 'WAITING_INCIDENT_CONFIRMATION', expiresAt: new Date(), data: { nested: [{ storageKey }] } } }),
      (storageKey: string) => db.privateWorkItem.create({ data: { maxUserId: 10n, incidentId: incident.id, originChatId: 10n, data: { nested: [{ storageKey }] } } }),
      (storageKey: string) => db.inboundUpdate.create({ data: { externalUpdateKey: storageKey, updateType: 'bot_started', payload: { nested: [{ storageKey }] } } }),
    ];
    for (const writer of writers) {
      await expect(writer('retired')).rejects.toThrow('STORAGE_KEY_RETIRED');
      await expect(writer('safe')).resolves.toBeDefined();
    }
    await expect(db.inboundUpdate.update({ where: { externalUpdateKey: 'safe' }, data: { payload: { storageKey: 'retired' } } })).rejects.toThrow('STORAGE_KEY_RETIRED');
    // Retaining an existing key is permitted even under an older snapshot;
    // adding a reference there cannot safely prove fence absence and is refused.
    await db.$transaction(tx => tx.inboundUpdate.update({ where: { externalUpdateKey: 'safe' }, data: { lastError: 'synthetic' } }), { isolationLevel: 'RepeatableRead' });
    await expect(db.$transaction(tx => tx.inboundUpdate.update({ where: { externalUpdateKey: 'safe' }, data: { payload: { storageKey: 'another-safe' } } }), { isolationLevel: 'RepeatableRead' })).rejects.toThrow('STORAGE_REFERENCE_REQUIRES_READ_COMMITTED');
    await event('unrelated', 'user:3');
    expect(await db.systemSetting.count({ where: { key: { startsWith: FILE_DELETION_FENCE_PREFIX } } })).toBe(1);
  });

  it('fails closed without a reference guard and retains damaged retry metadata verbatim', async () => {
    await intent('guarded'); const remove = vi.fn(async () => undefined);
    await db.$executeRawUnsafe('DROP TRIGGER guard_retired_storage ON "InboundUpdate"');
    try { await expect(drainFileDeletions(db, { remove } as never)).rejects.toThrow('STORAGE_REFERENCE_GUARDS_NOT_INSTALLED'); }
    finally {
      await db.$executeRawUnsafe('CREATE TRIGGER guard_retired_storage BEFORE INSERT OR UPDATE ON "InboundUpdate" FOR EACH ROW EXECUTE FUNCTION guard_retired_storage_reference()');
    }
    expect(remove).not.toHaveBeenCalled();
    const job = await db.systemSetting.findFirstOrThrow({ where: { key: { startsWith: FILE_DELETION_PREFIX } } });
    const key = FILE_DELETION_STATE_PREFIX + job.key.slice(FILE_DELETION_PREFIX.length);
    await db.systemSetting.create({ data: { key, value: '{broken-state' } });
    await drainFileDeletions(db, { remove } as never);
    expect((await db.systemSetting.findUniqueOrThrow({ where: { key } })).value).toBe('{broken-state');
    expect(remove).not.toHaveBeenCalled();
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
