import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type PrismaClient, type Prisma, UserRole } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { photoReference } from '../../src/media/max-photo-reference';
import { queueStaffRefresh } from '../../src/delivery/workflow-outbox';
import { reviewCard } from '../../src/bot/views/cards';
import { reviewKeyboard } from '../../src/bot/keyboards';
import { actorFor, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

const MAIN_SHA = 'c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a';
const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describeIntegration('main -> stopped worker -> reserve -> main, same PostgreSQL', () => {
  let prisma: PrismaClient, MainWorker: typeof MaxMessageService;
  const workers: MaxMessageService[] = [];
  const accepted: Array<{ phase: string; target: bigint; text: string; extra: any; mid: string }> = [];
  const edits: Array<{ mid: string; text: string; buttons: any[] }> = [];
  let phase = '', calls = 0, failAt = 0, lostAt = 0;
  let beforeRequest: (() => Promise<void>) | undefined;
  let afterAccept: (() => Promise<void>) | undefined;
  const storage = { save: vi.fn(), load: vi.fn(async () => Buffer.from('fixture-file')), remove: vi.fn(), exists: vi.fn(async () => true) };
  beforeAll(() => {
    const root = process.env.DELIVERY_REFERENCE_ROOT;
    if (!root) throw new Error('DELIVERY_REFERENCE_ROOT must point to a clean, locally built checkout of the pinned main; never use a running installation.');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()).toBe(MAIN_SHA);
    execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'src', 'prisma', 'package.json', 'package-lock.json'], { cwd: root });
    MainWorker = createRequire(resolve(root, 'package.json'))('./dist/max/max-message.service.js').MaxMessageService;
    expect(MainWorker).not.toBe(MaxMessageService);
    pushSchemaOnce(); prisma = createTestPrisma();
  });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); accepted.length = edits.length = 0; calls = failAt = lostAt = 0; beforeRequest = afterAccept = undefined; storage.remove.mockClear(); });
  afterEach(async () => { workers.forEach(w => w.stop()); await Promise.allSettled(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(async () => { await prisma?.$disconnect(); });
  function worker(version: 'main' | 'reserve') {
    phase = version;
    const send = async (target: bigint, text: string, extra?: any, beforeAttempt?: () => Promise<void>) => {
      await beforeRequest?.(); await beforeAttempt?.();
      if (++calls === failAt) throw new MaxError(503, { code: 'temporary', message: 'Simulated MAX failure' });
      const mid = `accepted-${calls}`; accepted.push({ phase, target, text, extra, mid });
      await afterAccept?.();
      if (calls === lostAt) throw new MaxError(503, { code: 'temporary', message: 'Simulated lost ACK' });
      return { body: { mid } };
    };
    const max = { sendToUser: send, sendToChat: send, uploadFile: async () => ({ type: 'file', payload: { token: 'test-file' } }),
      editCardWithKeyboard: async (mid: string, text: string, buttons: any[]) => { edits.push({ mid, text, buttons }); }, editMessage: async () => undefined };
    const w = new (version === 'main' ? MainWorker : MaxMessageService)(max as never, { prisma, storage });
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }
  const stop = async (w: MaxMessageService) => { w.stop(); await w.waitForIdle(); };
  const due = (id: string) => prisma.outboundMessage.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
  async function answerFixture() {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Test employee', [UserRole.ADMIN]);
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Test resident', []);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.regional } });
    const incident = await prisma.incident.create({ data: { publicCode: 'INC-000001', requesterId: requester.userId, requesterMaxUserId: requester.maxUserId,
      requesterName: 'Test resident', text: 'Fixture', status: 'RESOLVED', answeredAt: new Date(), deadlineAt: new Date(), assignedGroupId: group.id } });
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'APPROVED', text: 'x'.repeat(5000), createdByUserId: actor.userId, approvedAt: new Date() } });
    const job = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'user', targetId: requester.maxUserId, incidentId: incident.id, answerId: answer.id,
      dedupeKey: `answer:${answer.id}`, trackingType: 'ANSWER_TO_REQUESTER', payload: { text: answer.text, keyboard: [[{ type: 'callback', text: 'Rate', payload: 'test' }]] }, attachments: [] } });
    return { incident, answer, actor, job };
  }

  it('preserves a legacy queued job without progress and leaves retired FAILED records untouched across both switches', async () => {
    const first = worker('main'); await stop(first);
    await first.send({ userId: 1n }, { text: 'Legacy queued job', delivery: { dedupeKey: 'legacy' } });
    const retired = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'chat', targetId: -999n, payload: { text: 'Synthetic greeting' }, attachments: [], status: 'FAILED', lastError: 'MANUALLY_RETIRED_FOREIGN_BOT_ADDED' } });
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'legacy' } })).payload).not.toHaveProperty('deliveryProgress');
    const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    const last = worker('main'); await last.flush(); await stop(last);
    expect(accepted.map(a => a.text)).toEqual(['Legacy queued job']);
    expect(await prisma.outboundMessage.findUnique({ where: { id: retired.id } })).toEqual(retired);
  });

  it('continues long text, nine photos and a file in both directions, with backoff and successor ordering', async () => {
    const text = 't'.repeat(5000), first = worker('main'); failAt = 3;
    await first.send({ userId: 1n }, { text, attachments: [...Array.from({ length: 9 }, (_, n) => ({ type: 'IMAGE' as const, maxToken: `p${n}` })), { type: 'FILE', body: Buffer.from('file'), originalName: 'test.txt' }],
      keyboard: [[{ type: 'callback', text: 'Action', payload: 'test' }]], delivery: { dedupeKey: 'multipart' } });
    await first.send({ userId: 1n }, { text: 'Successor', delivery: { dedupeKey: 'successor' } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'multipart' } });
    expect(row.status).toBe('PENDING'); expect((row.payload as any).deliveryProgress.mids).toHaveLength(2);
    const reserve = worker('reserve'); await reserve.flush(); expect(accepted).toHaveLength(2);
    await due(row.id); failAt = 5; await reserve.flush(); await stop(reserve);
    const middle = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(middle.status).toBe('PENDING'); expect((middle.payload as any).deliveryProgress.mids).toHaveLength(3);
    expect(accepted.some(a => a.text === 'Successor')).toBe(false);
    await due(row.id); failAt = 0; const last = worker('main'); await last.flush(); await stop(last);
    const done = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe('SENT'); expect(done.firstMessageId).toBe(row.firstMessageId); expect(done.attachments).toEqual(row.attachments);
    expect(accepted.slice(0, 2).map(a => a.text)).toEqual(splitText(text));
    expect(accepted.flatMap(a => a.extra?.attachments ?? []).filter(a => a.type === 'image').map(a => a.payload.token)).toEqual(Array.from({ length: 9 }, (_, n) => `p${n}`));
    expect(accepted.flatMap(a => a.extra?.attachments ?? []).filter(a => a.type === 'file')).toHaveLength(1);
    expect(accepted.at(-1)?.text).toBe('Successor'); expect(accepted).toHaveLength(6);
    expect(new Set((done.payload as any).deliveryProgress.mids).size).toBe(5);
  });

  it('reclaims an expired SENDING only after the original worker is gone, keeping its confirmed prefix', async () => {
    const first = worker('main'); failAt = 2;
    const update = prisma.outboundMessage.updateMany.bind(prisma.outboundMessage);
    const crash = vi.spyOn(prisma.outboundMessage, 'updateMany').mockImplementation(args => {
      if (args.data.status === 'PENDING') throw new Error('Simulated exit before error status write');
      return update(args);
    });
    await expect(first.send({ userId: 1n }, { text: 's'.repeat(5000), delivery: { dedupeKey: 'crash' } })).rejects.toThrow('Simulated exit');
    crash.mockRestore(); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'crash' } });
    expect(row.status).toBe('SENDING'); expect((row.payload as any).deliveryProgress.mids).toHaveLength(1);
    const reserve = worker('reserve'); await reserve.flush(); expect(accepted).toHaveLength(1);
    // Simulated passage of lease time, not an operational status reset.
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { lockedAt: new Date(0) } });
    failAt = 0; await reserve.flush(); await stop(reserve);
    expect(accepted.map(a => a.text)).toEqual(splitText('s'.repeat(5000)));
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT');
  });

  it('keeps FAILED partial answer; simultaneous authorized manual retries deliver once, and main does not resend it', async () => {
    const f = await answerFixture(); await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { attempts: 11 } });
    const first = worker('main'); failAt = 2; await first.flush(); await stop(first);
    const failed = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: f.job.id } }); expect(failed.status).toBe('FAILED');
    const reserve = worker('reserve'); await reserve.flush(); expect(await prisma.outboundMessage.findUnique({ where: { id: f.job.id } })).toEqual(failed);
    const services = buildServices(prisma, { messages: reserve, media: new FakeMediaService() as never });
    failAt = 0;
    const outcomes = await Promise.all([services.review.resend(f.incident.id, f.actor.maxUserId), services.review.resend(f.incident.id, f.actor.maxUserId)]);
    expect(outcomes).toContain('sent'); await reserve.flush(); await stop(reserve);
    const delivered = await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } }); expect(delivered.deliveredAt).not.toBeNull();
    expect(accepted.filter(a => a.target === TEST_USERS.requesterA).map(a => a.text)).toEqual(splitText(f.answer.text));
    expect(accepted.filter(a => a.text.includes('доставлен пользователю'))).toHaveLength(1);
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
    const last = worker('main'); await last.flush(); await stop(last);
    expect(await prisma.incidentAnswer.findUnique({ where: { id: f.answer.id } })).toEqual(delivered);
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
    expect(accepted.filter(a => a.text.includes('доставлен пользователю'))).toHaveLength(1);
  });

  it('finishes all saved ACKs after a failed final transaction without any repeat answer parts', async () => {
    const f = await answerFixture(); const first = worker('main');
    // Fail the final SENT write, not the earlier recipient-claim transaction.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reserve_test_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${f.job.id}' AND NEW.status='SENT' THEN RAISE EXCEPTION 'Simulated final transaction failure'; END IF; RETURN NEW; END $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER reserve_test_completion BEFORE UPDATE ON "OutboundMessage" FOR EACH ROW EXECUTE FUNCTION reserve_test_completion()');
    try { await first.flush(); } finally {
      await stop(first);
      await prisma.$executeRawUnsafe('DROP TRIGGER reserve_test_completion ON "OutboundMessage"');
      await prisma.$executeRawUnsafe('DROP FUNCTION reserve_test_completion()');
    }
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: f.job.id } }); expect(row.status).toBe('PENDING');
    expect(row.lastError).toContain('Simulated final transaction failure');
    expect((row.payload as any).deliveryProgress.mids).toHaveLength(2);
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).toBeNull();
    const n = accepted.filter(a => a.target === TEST_USERS.requesterA).length;
    await due(row.id); const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(accepted.filter(a => a.target === TEST_USERS.requesterA)).toHaveLength(n);
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).not.toBeNull();
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
    expect(accepted.filter(a => a.text.includes('доставлен пользователю'))).toHaveLength(1);
    const last = worker('main'); await last.flush(); await stop(last);
    expect(accepted.filter(a => a.target === TEST_USERS.requesterA)).toHaveLength(n);
  });

  it.each(['null', 'version', 'hash', 'mids', 'first-mid', 'duplicates', 'empty-mid', 'total-parts'] as const)('refuses damaged %s progress from persisted main state without guessing or deleting it', async variant => {
    const first = worker('main'); failAt = 2; await first.send({ userId: 1n }, { text: 'b'.repeat(5000), delivery: { dedupeKey: 'bad' } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'bad' } }); const payload = structuredClone(row.payload) as any;
    if (variant === 'null') payload.deliveryProgress = null;
    if (variant === 'version') payload.deliveryProgress.version = 2;
    if (variant === 'hash') payload.deliveryProgress.planHash = '0'.repeat(64);
    if (variant === 'mids') payload.deliveryProgress.mids = [null];
    if (variant === 'duplicates') payload.deliveryProgress.mids.push(payload.deliveryProgress.mids[0]);
    if (variant === 'empty-mid') payload.deliveryProgress.mids = [' '];
    if (variant === 'total-parts') payload.deliveryProgress.totalParts += 1;
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { payload, nextAttemptAt: new Date(0), ...(variant === 'first-mid' ? { firstMessageId: 'wrong' } : {}) } });
    const n = accepted.length, reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    const rejected = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(rejected.status).toBe('FAILED'); expect(rejected.lastError).toContain('DELIVERY_PROGRESS_MISMATCH');
    expect(rejected.payload).toEqual(payload); expect(rejected.attachments).toEqual(row.attachments); expect(accepted).toHaveLength(n);
    const last = worker('main'); await last.flush(); await stop(last);
    expect(accepted).toHaveLength(n); expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toEqual(rejected);
  });

  it('rejects an old answer version after switching and releases its successor without sending remaining old text', async () => {
    const f = await answerFixture(); const first = worker('main'); failAt = 2; await first.flush(); await stop(first);
    await prisma.incidentAnswer.create({ data: { incidentId: f.incident.id, version: 2, status: 'WAITING_REVIEW', text: 'New answer', createdByUserId: f.actor.userId } });
    await prisma.incident.update({ where: { id: f.incident.id }, data: { status: 'WAITING_REVIEW' } });
    await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'user', targetId: TEST_USERS.requesterA, payload: { text: 'Successor' }, attachments: [] } });
    await due(f.job.id); const n = accepted.length; failAt = 0; const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(accepted.slice(n).map(a => a.text)).toEqual(['Successor']);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: f.job.id } })).status).toBe('FAILED');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(0);
  });

  it('refuses a superseded sector assignment when continuing main progress', async () => {
    const f = await answerFixture(); await prisma.outboundMessage.delete({ where: { id: f.job.id } });
    await prisma.incident.update({ where: { id: f.incident.id }, data: { status: 'ASSIGNED' } });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.regional } });
    const first = worker('main'); failAt = 2;
    await first.send({ chatId: group.maxChatId! }, { text: 'c'.repeat(5000), delivery: { dedupeKey: `sector-card:${f.incident.id}`, tracking: { type: 'SECTOR_CARD', incidentId: f.incident.id } } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `sector-card:${f.incident.id}` } });
    const other = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await prisma.incident.update({ where: { id: f.incident.id }, data: { assignedGroupId: other.id } }); await due(row.id);
    const n = accepted.length, reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    const retired = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(retired.status).toBe('FAILED'); expect(retired.lastError).toContain('STALE_SECTOR_ASSIGNMENT');
    expect(retired.payload).toEqual(row.payload); expect(accepted).toHaveLength(n);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: f.incident.id } })).sectorMessageId).toBeNull();
  });

  it('rechecks ownership after request limiter wait and never overwrites another attempt', async () => {
    const first = worker('main'); failAt = 2;
    await first.send({ userId: 1n }, { text: 'o'.repeat(5000), delivery: { dedupeKey: 'owner' } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'owner' } }); await due(row.id);
    let taken: Awaited<ReturnType<typeof prisma.outboundMessage.findUniqueOrThrow>> | undefined;
    beforeRequest = async () => {
      beforeRequest = undefined;
      taken = await prisma.outboundMessage.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lockedAt: new Date() } });
    };
    const n = accepted.length, reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(taken?.status).toBe('SENDING'); expect(accepted).toHaveLength(n);
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toEqual(taken);
    expect(taken?.payload).toEqual(row.payload);
  });

  it('waits for an in-flight ACK before switching and does not replay it in the reserve', async () => {
    const entered = gate(), release = gate(); const first = worker('main');
    beforeRequest = async () => { beforeRequest = undefined; entered.resolve(); await release.promise; };
    const sending = first.send({ userId: 1n }, { text: 'h'.repeat(5000), delivery: { dedupeKey: 'shutdown' } });
    try {
      await entered.promise; first.stop(); let idle = false;
      const stopped = first.waitForIdle().then(() => { idle = true; });
      expect(idle).toBe(false);
      expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'shutdown' } })).status).toBe('SENDING');
      release.resolve(); await sending; await stopped; expect(idle).toBe(true);
    } finally { release.resolve(); }
    const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(accepted.map(a => a.text)).toEqual(splitText('h'.repeat(5000)));
  });

  it('does not overwrite a new owner if ownership changes between MAX acceptance and ACK persistence', async () => {
    const first = worker('main'); failAt = 2;
    await first.send({ userId: 1n }, { text: 'q'.repeat(5000), delivery: { dedupeKey: 'cas' } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'cas' } }); await due(row.id);
    let taken: Awaited<ReturnType<typeof prisma.outboundMessage.findUniqueOrThrow>> | undefined;
    afterAccept = async () => {
      afterAccept = undefined;
      taken = await prisma.outboundMessage.update({ where: { id: row.id }, data: { attempts: { increment: 1 }, lockedAt: new Date() } });
    };
    failAt = 0; const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(accepted.map(a => a.text)).toEqual(splitText('q'.repeat(5000)));
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toEqual(taken);
    expect(taken?.payload).toEqual(row.payload); expect(taken?.status).toBe('SENDING');
    expect(taken?.sentAt).toBeNull(); // Accepted but uncommitted ACK is an explicit residual uncertainty.
  });

  it('refreshes only an ACKed review tail, retires buttons on revision, and does not resend old media after switching back', async () => {
    const f = await answerFixture(); await prisma.outboundMessage.delete({ where: { id: f.job.id } });
    await prisma.incident.update({ where: { id: f.incident.id }, data: { status: 'WAITING_REVIEW' } });
    await prisma.incidentAnswer.update({ where: { id: f.answer.id }, data: { status: 'WAITING_REVIEW' } });
    const first = worker('main'); const services = buildServices(prisma, { messages: first, media: new FakeMediaService() as never });
    const fresh = (await services.repository.findById(f.incident.id))!;
    const row = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'chat', targetId: TEST_CHATS.review, incidentId: f.incident.id, answerId: f.answer.id,
      trackingType: 'REVIEW_CARD', dedupeKey: `review-card:${f.answer.id}`, attempts: 11,
      payload: { text: reviewCard(fresh, fresh.answers[0]!, fresh.assignedGroup), keyboard: reviewKeyboard(f.incident.id, f.answer.id) },
      attachments: Array.from({ length: 9 }, (_, n) => ({ type: 'IMAGE', storageKey: photoReference(`review-${n}`), owned: false })) } });
    failAt = 3; await first.flush(); await stop(first);
    const partial = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } }); expect(partial.status).toBe('FAILED');
    const mid = (partial.payload as any).keyboardMessageId; expect(mid).not.toBe(partial.firstMessageId);
    const reserve = worker('reserve'); const s = buildServices(prisma, { messages: reserve, media: new FakeMediaService() as never });
    await s.workQueues.claimReview(f.actor, TEST_CHATS.review, f.incident.id);
    await prisma.$transaction(tx => queueStaffRefresh(tx, f.incident.id, 'reserve-lease')); await reserve.flush();
    expect(edits.some(e => e.mid === mid && e.buttons.length)).toBe(true);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect(edits.filter(e => e.mid === partial.firstMessageId).every(e => !e.buttons.length)).toBe(true);
    await s.review.requestRevision(f.incident.id, 'Fixture revision', f.actor, f.answer.id); await reserve.flush(); await stop(reserve);
    expect(edits.filter(e => e.mid === mid).at(-1)?.buttons).toEqual([]);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).payload).toEqual(partial.payload);
    const n = accepted.length; const last = worker('main'); await last.flush(); await stop(last); expect(accepted).toHaveLength(n);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('lost ACK remains ambiguous; only saved confirmed parts are protected', async () => {
    const first = worker('main'); lostAt = 2; await first.send({ userId: 1n }, { text: 'a'.repeat(5000), delivery: { dedupeKey: 'lost' } }); await stop(first);
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'lost' } }); expect((row.payload as any).deliveryProgress.mids).toHaveLength(1);
    await due(row.id); lostAt = 0; const reserve = worker('reserve'); await reserve.flush(); await stop(reserve);
    expect(accepted.map(a => a.text)).toEqual([splitText('a'.repeat(5000))[0], splitText('a'.repeat(5000))[1], splitText('a'.repeat(5000))[1]]);
  });
});
