import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { resetConfigCache } from '../../src/config';
import { recordPolicyDelivery } from '../../src/sla/policy';
import { MaxMessageService } from '../../src/max/max-message.service';
import { DeliveryAlertService } from '../../src/delivery/delivery-alert.service';
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

  it.each([
    ['2026-10-14', '2026-10-15', false], ['2026-10-16', '2026-10-19', false],
    ['2026-10-14', '2026-10-15', true], ['2026-10-16', '2026-10-19', true],
  ] as const)('defers %s to %s (temporary failure %s), keeps one job across sweep/restart', async (day, next, error) => {
    const { i, job } = await reminder(); set(`${day}T16:59:59`);
    const sends: string[] = [];
    const first = worker(async (_id, text) => {
      if (error) throw new MaxError(503, { code: 'unavailable', message: 'Synthetic error' });
      sends.push(text); return { body: { mid: 'unexpected-before-night' } };
    });
    if (error) await first.flush();
    set(`${day}T17:00:00`); await first.flush();
    first.stop(); await first.waitForIdle();
    const held = await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(held.status).toBe('DEFERRED'); expect(held.attempts).toBe(error ? 1 : 0);
    expect(held.nextAttemptAt).toEqual(time(`${next}T08:00:00`));
    const restarted = worker(async (_id, text) => { sends.push(text); return { body: { mid: `ack-${sends.length}` } }; });
    await restarted.send({ chatId: job.targetId }, { text: 'Ordinary card', delivery: { dedupeKey: 'ordinary' } });
    expect(sends).toEqual(['Ordinary card']);
    set(`${next}T08:00:00`);
    await Promise.all([h.services.sla.sweep(), h.services.sla.sweep(), restarted.flush()]);
    await restarted.flush();
    expect(sends).toHaveLength(2);
    expect(await db.outboundMessage.count({ where: { dedupeKey: job.dedupeKey } })).toBe(1);
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('SENT');
    expect((await db.incident.findUniqueOrThrow({ where: { id: i.id } })).workingDeadlineQueuedAt).not.toBeNull();
  });

  it('revalidates after rate waiting crosses closing time without invoking the MAX send', async () => {
    const { job } = await reminder(); const accepted: string[] = [];
    const w = worker(async (_id, text, _extra, guard) => {
      set('2026-10-14T17:00:00'); await guard?.(); accepted.push(text); return { body: { mid: 'ack' } };
    });
    await w.flush();
    expect(accepted).toEqual([]);
    expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'DEFERRED', attempts: 0, sentAt: null });
  });

  it('does not overlap recipients across workers when the deferred reminder becomes ready', async () => {
    const { job } = await reminder(); set('2026-10-14T17:00:00'); await worker(vi.fn()).flush();
    set('2026-10-15T07:59:59');
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(r => { release = r; }); const entered = new Promise<void>(r => { started = r; });
    let active = 0, peak = 0; const accepted: string[] = [];
    const send = async (_id: bigint, text: string) => {
      peak = Math.max(peak, ++active);
      try { if (text === 'In flight card') { started(); await gate; } accepted.push(text); return { body: { mid: `ack-${accepted.length}` } }; }
      finally { active--; }
    };
    const a = worker(send), b = worker(send);
    const pending = a.send({ chatId: job.targetId }, { text: 'In flight card', delivery: { dedupeKey: 'inflight' } });
    try {
      await entered; set('2026-10-15T08:00:00');
      await Promise.all([h.services.sla.sweep(), h.services.sla.sweep(), b.flush()]);
      expect(accepted).toEqual([]); expect(peak).toBe(1);
    } finally { release(); await pending; }
    await Promise.all([a.flush(), b.flush()]); await a.flush();
    expect(accepted).toHaveLength(2); expect(accepted[0]).toBe('In flight card'); expect(peak).toBe(1);
    expect(await db.outboundMessage.count({ where: { dedupeKey: job.dedupeKey } })).toBe(1);
  });

  it('keeps a partial ordinary message ahead of its follower while the reminder sleeps', async () => {
    const { job } = await reminder(); set('2026-10-14T17:00:00'); await worker(vi.fn()).flush();
    let call = 0; const accepted: string[] = [];
    const a = worker(async (_id, text) => {
      if (++call === 2) throw new MaxError(503, { code: 'unavailable', message: 'Synthetic error' });
      accepted.push(text); return { body: { mid: `part-${accepted.length}` } };
    });
    await a.send({ chatId: job.targetId }, { text: 'x'.repeat(5000), delivery: { dedupeKey: 'partial' } });
    await a.send({ chatId: job.targetId }, { text: 'Follower', delivery: { dedupeKey: 'follower' } });
    expect(accepted).toHaveLength(1);
    const partial = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'partial' } });
    expect(partial.payload).toMatchObject({ deliveryProgress: { mids: ['part-1'] } });
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'follower' } })).status).toBe('PENDING');
    a.stop(); await a.waitForIdle(); set('2026-10-14T17:00:31');
    const b = worker(async (_id, text) => { accepted.push(text); return { body: { mid: `part-${accepted.length}` } }; });
    await b.flush(); expect(accepted.map(x => x.length)).toEqual([3800, 1200, 8]);
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'partial' } })).status).toBe('SENT');
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('DEFERRED');
  });

  it.each(['ANSWER_DELIVERED', 'INCIDENT_REJECTED', 'RECIPIENT_REMOVED', 'POLICY_CHANGED', 'DEADLINE_NOT_DUE', 'INCIDENT_MISSING'])('cancels %s without alerting, acknowledging or recreating the job', async reason => {
    const { i, job } = await reminder(); const original = process.env.DISTRIBUTION_CHAT_ID;
    try {
      if (reason === 'ANSWER_DELIVERED') await db.$transaction(tx => recordPolicyDelivery(tx, i.id, new Date()));
      if (reason === 'INCIDENT_REJECTED') await db.incident.update({ where: { id: i.id }, data: { status: 'REJECTED' } });
      if (reason === 'RECIPIENT_REMOVED') { process.env.DISTRIBUTION_CHAT_ID = '9999001'; resetConfigCache(); }
      if (reason === 'POLICY_CHANGED') await db.incident.update({ where: { id: i.id }, data: { slaPolicy: 'LEGACY' } });
      if (reason === 'DEADLINE_NOT_DUE') await db.incident.update({ where: { id: i.id }, data: { deadlineAt: time('2026-10-20T10:00:00') } });
      if (reason === 'INCIDENT_MISSING') await db.incident.delete({ where: { id: i.id } });
      const send = vi.fn().mockResolvedValue({ body: { mid: 'follower-ack' } }); const w = worker(send);
      await w.flush(); expect(send).not.toHaveBeenCalled();
      expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date(), sentAt: null, firstMessageId: null, trackingApplied: false });
      const alert = vi.fn(); await new DeliveryAlertService(db, { sendToChat: alert } as never, 9999002n).checkNow();
      expect(alert).not.toHaveBeenCalled();
      await Promise.all([h.services.sla.sweep(), h.services.sla.sweep()]);
      await worker(send).flush(); expect(send).not.toHaveBeenCalled();
      expect(await db.outboundMessage.count({ where: { dedupeKey: job.dedupeKey } })).toBe(1);
      await w.send({ chatId: job.targetId }, { text: 'Follower', delivery: { dedupeKey: 'after-cancel' } });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { if (original === undefined) delete process.env.DISTRIBUTION_CHAT_ID; else process.env.DISTRIBUTION_CHAT_ID = original; resetConfigCache(); }
  });

  it('cancels state changed after the rate wait, but keeps true terminal errors visible', async () => {
    const { i, job } = await reminder(); const accepted: string[] = [];
    await worker(async (_id, text, _extra, guard) => {
      await db.$transaction(tx => recordPolicyDelivery(tx, i.id, new Date())); await guard?.();
      accepted.push(text); return { body: { mid: 'unexpected' } };
    }).flush();
    expect(accepted).toEqual([]); expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CANCELLED');
    const failed = await db.outboundMessage.create({ data: { targetType: 'chat', targetId: job.targetId, incidentId: i.id,
      payload: { text: 'Synthetic malformed reminder', operation: { type: 'working-deadline', incidentId: i.id }, deliveryProgress: { unknown: true } }, attachments: [] } });
    await worker(vi.fn()).flush();
    expect(await db.outboundMessage.findUnique({ where: { id: failed.id } })).toMatchObject({ status: 'FAILED', lastError: 'WORKING_DEADLINE_INVALID_JOB' });
    const alert = vi.fn().mockResolvedValue({ body: { mid: 'alert' } });
    await new DeliveryAlertService(db, { sendToChat: alert } as never, 9999002n).checkNow(); expect(alert).toHaveBeenCalledTimes(1);
  });

  it('retains a real MAX failure after exhaustion, not a cancellation', async () => {
    const { job } = await reminder(); await db.outboundMessage.update({ where: { id: job.id }, data: { attempts: 11 } });
    await worker(async () => { throw new MaxError(503, { code: 'unavailable', message: 'Synthetic error' }); }).flush();
    expect(await db.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', attempts: 12, cancelledAt: null, cancelReason: null, sentAt: null });
    const alert = vi.fn().mockResolvedValue({ body: { mid: 'alert' } });
    await new DeliveryAlertService(db, { sendToChat: alert } as never, 9999002n).checkNow(); expect(alert).toHaveBeenCalledTimes(1);
  });
});
