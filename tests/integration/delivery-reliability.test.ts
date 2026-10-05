import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { type PrismaClient, UserRole } from '@prisma/client';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { COMMANDS } from '../../src/bot/commands';
import { createHash } from 'node:crypto';

describeIntegration('delivery reliability regressions', () => {
  // Raw ready fixtures use epoch: database now() can be ahead of Date.now()
  // by one clock tick. Backoff-specific scenarios still set their own deadlines.
  let prisma: PrismaClient;
  const workers: MaxMessageService[] = [];
  const storage = { save: vi.fn(), load: vi.fn().mockResolvedValue(Buffer.from('test-file')), remove: vi.fn(), exists: vi.fn().mockResolvedValue(true) };
  function worker(max: object) {
    const w = new MaxMessageService({ editCardWithKeyboard: async () => undefined, editMessage: async () => undefined, ...max } as never, { prisma, storage });
    // Explicit sweeps make crash/retry boundaries deterministic, not timing-dependent.
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterEach(async () => { for (const w of workers) w.stop(); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());
  async function fixture() {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Test administrator', [UserRole.ADMIN]);
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Test resident', []);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.sector } });
    const incident = await prisma.incident.create({ data: { publicCode: 'INC-000001', requesterId: requester.userId,
      requesterMaxUserId: requester.maxUserId, requesterName: 'Resident', text: 'Test street light', status: 'ASSIGNED',
      assignedGroupId: group.id, deadlineAt: new Date(Date.now() + 86400000) } });
    return { actor, incident, group };
  }
  async function approved(attempts = 12) {
    const f = await fixture();
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: f.incident.id, version: 1, status: 'APPROVED', text: 'Completed', createdByUserId: f.actor.userId, approvedAt: new Date() } });
    await prisma.incident.update({ where: { id: f.incident.id }, data: { status: 'RESOLVED', answeredAt: new Date() } });
    const job = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `answer:${answer.id}`, targetType: 'user', targetId: TEST_USERS.requesterA,
      status: 'FAILED', attempts, lastError: '503: test outage', payload: { text: 'Approved answer' }, attachments: [],
      incidentId: f.incident.id, answerId: answer.id, trackingType: 'ANSWER_TO_REQUESTER' } });
    return { ...f, answer, job };
  }
  const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

  it('BASE-1 delivers photo recovery to the current sector and stores its MID', async () => {
    const { incident } = await fixture();
    const sendToChat = vi.fn(async (_id: bigint, _text: string, extra: any) => {
      if (extra.attachments?.some((x: any) => x.type === 'image')) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
      return { body: { mid: 'recovery-mid' } };
    });
    const editCardWithKeyboard = vi.fn().mockResolvedValue(undefined);
    const w = worker({ sendToChat, editCardWithKeyboard });
    await w.send({ chatId: TEST_CHATS.sector }, { text: 'Sector card', attachments: [{ type: 'IMAGE', maxToken: 'unavailable' }],
      keyboard: [[{ type: 'callback', text: 'Work', payload: `incident:take:${incident.id}` }]],
      delivery: { dedupeKey: `sector-card:${incident.id}`, tracking: { type: 'SECTOR_CARD', incidentId: incident.id } } });
    await w.flush();
    const original = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `sector-card:${incident.id}` } });
    const recovery = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `photo-recovery:${original.id}` } });
    expect(recovery.status).toBe('SENT');
    expect(recovery.firstMessageId).toBe('recovery-mid');
    expect(sendToChat.mock.calls.some(c => c[1].includes('Фотография недоступна'))).toBe(true);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBe('recovery-mid');
    expect(original.status).toBe('FAILED');
    expect(sendToChat.mock.calls.find(c => c[1].includes('Фотография недоступна'))?.[2].attachments.some((a: any) => a.type === 'inline_keyboard')).toBe(true);
    expect(editCardWithKeyboard.mock.calls.some(c => c[0] === 'recovery-mid' && c[2].flat().some((b: any) => b.text === 'Взять в работу'))).toBe(true);
  });

  it('BASE-2 manual resend revives the latest failed approved answer', async () => {
    const { incident, actor } = await fixture();
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'APPROVED', text: 'Completed', createdByUserId: actor.userId, approvedAt: new Date() } });
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'RESOLVED', answeredAt: new Date() } });
    const failed = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `answer:${answer.id}`, targetType: 'user', targetId: TEST_USERS.requesterA,
      status: 'FAILED', attempts: 12, lastError: '503: test outage', payload: { text: 'Approved answer' }, attachments: [],
      incidentId: incident.id, answerId: answer.id, trackingType: 'ANSWER_TO_REQUESTER' } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'answer-mid' } });
    const w = worker({ sendToUser });
    const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    await services.review.resend(incident.id);
    await w.flush();
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('SENT');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).not.toBeNull();
  });

  it('BASE-3 restart resumes a long message after the confirmed first part', async () => {
    const text = 'a'.repeat(8000), parts = splitText(text); const sent: string[] = [];
    let count = 0;
    const first = worker({ sendToUser: async (_id: bigint, body: string) => {
      if (++count === 2) throw new MaxError(503, { code: 'unavailable', message: 'test outage' });
      sent.push(body); return { body: { mid: `part-${count}` } };
    } });
    await first.send({ userId: 123n }, { text, delivery: { dedupeKey: 'split-regression' } });
    first.stop(); await first.waitForIdle();
    const pending = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'split-regression' } });
    expect(pending.status).toBe('PENDING'); expect(sent).toEqual([parts[0]]);
    await prisma.outboundMessage.update({ where: { id: pending.id }, data: { nextAttemptAt: new Date(0) } });
    const next = worker({ sendToUser: async (_id: bigint, body: string) => { sent.push(body); return { body: { mid: `next-${sent.length}` } }; } });
    await next.flush();
    expect(sent).toEqual(parts);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: pending.id } })).firstMessageId).toBe('part-1');
  });

  it.each(['different-chat', 'same-chat-new-cycle'] as const)('retires stale recovery before sending: %s', async mode => {
    const { incident, actor } = await fixture();
    const original = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `sector-card:${incident.id}`, targetType: 'chat', targetId: TEST_CHATS.sector,
      status: 'FAILED', payload: { text: 'old card' }, attachments: [], trackingType: 'SECTOR_CARD', incidentId: incident.id } });
    const recovery = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `photo-recovery:${original.id}`, targetType: 'chat', targetId: TEST_CHATS.sector,
      payload: { text: 'recovery' }, attachments: [], trackingType: 'SECTOR_CARD', incidentId: incident.id } });
    if (mode === 'different-chat') {
      const other = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.otherSector } });
      await prisma.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } });
    } else await prisma.incidentHistory.create({ data: { incidentId: incident.id, action: 'REDISTRIBUTION_REQUESTED', actorMaxUserId: actor.maxUserId } });
    const sendToChat = vi.fn(); await worker({ sendToChat }).flush();
    expect(sendToChat).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: recovery.id } })).toMatchObject({ status: 'FAILED', sentAt: null, firstMessageId: null, trackingApplied: false, lastError: expect.stringContaining('STALE_SECTOR_ASSIGNMENT') });
  });

  it('reassignment during a recovery request keeps acknowledged MID but retires its buttons', async () => {
    const { incident } = await fixture(); const entered = gate(), release = gate();
    const original = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `sector-card:${incident.id}`, targetType: 'chat', targetId: TEST_CHATS.sector,
      status: 'FAILED', payload: { text: 'old card' }, attachments: [], trackingType: 'SECTOR_CARD', incidentId: incident.id } });
    const recovery = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), dedupeKey: `photo-recovery:${original.id}`, targetType: 'chat', targetId: TEST_CHATS.sector,
      payload: { text: 'recovery', keyboard: [[{ type: 'callback', text: 'Take', payload: 'old-action' }]] }, attachments: [], trackingType: 'SECTOR_CARD', incidentId: incident.id } });
    const editCardWithKeyboard = vi.fn().mockResolvedValue(undefined);
    const w = worker({ sendToChat: async () => { entered.resolve(); await release.promise; return { body: { mid: 'late-card' } }; }, editCardWithKeyboard });
    const work = w.flush(); await entered.promise;
    const other = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.otherSector } });
    await prisma.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } }); release.resolve(); await work;
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: recovery.id } });
    expect(row).toMatchObject({ status: 'SENT', firstMessageId: 'late-card', trackingApplied: false });
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBeNull();
    expect(editCardWithKeyboard).toHaveBeenCalledWith('late-card', expect.stringContaining('перераспределение'), []);
    await w.flush(); expect(await prisma.incidentHistory.count({ where: { action: 'SECTOR_CARD_SENT' } })).toBe(0);
  });

  it('concurrent manual retries produce one send and preserve the previous error in history', async () => {
    const { incident, job, answer } = await approved(); const entered = gate(), release = gate();
    const sendToUser = vi.fn(async () => { entered.resolve(); await release.promise; return { body: { mid: 'manual' } }; });
    const w = worker({ sendToUser }); const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    const first = services.review.resend(incident.id, TEST_USERS.admin); await entered.promise;
    expect(await services.review.resend(incident.id, TEST_USERS.admin)).toBe('queued'); release.resolve(); expect(await first).toBe('sent');
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(await services.review.resend(incident.id)).toBe('already-sent');
    const history = await prisma.incidentHistory.findMany({ where: { action: 'ANSWER_DELIVERY_RETRY_REQUESTED' } });
    expect(history).toHaveLength(1); expect(history[0]).toMatchObject({ actorMaxUserId: TEST_USERS.admin, metadata: { outboxId: job.id, answerId: answer.id, previousAttempts: 12, previousError: '503: test outage' } });
  });

  it.each(['PENDING', 'SENDING'] as const)('manual resend respects existing %s, backoff and lease', async status => {
    const { incident, job } = await approved(); const future = new Date(Date.now() + 60000), lockedAt = new Date();
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status, nextAttemptAt: future, lockedAt } });
    const sendToUser = vi.fn(); const w = worker({ sendToUser });
    const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    expect(await services.review.resend(incident.id)).toBe('queued'); expect(sendToUser).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status, attempts: 12, nextAttemptAt: future, lockedAt });
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_DELIVERY_RETRY_REQUESTED' } })).toBe(0);
  });

  it.each(['revision', 'new-version', 'retired'] as const)('does not revive an unsafe answer: %s', async mode => {
    const { incident, job, actor } = await approved();
    if (mode === 'revision') await prisma.incident.update({ where: { id: incident.id }, data: { status: 'REVISION_REQUIRED' } });
    if (mode === 'new-version') await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 2, status: 'WAITING_REVIEW', text: 'new', createdByUserId: actor.userId } });
    if (mode === 'retired') await prisma.outboundMessage.update({ where: { id: job.id }, data: { lastError: 'MANUALLY_RETIRED_TEST: explicit stop' } });
    const sendToUser = vi.fn(); const services = buildServices(prisma, { messages: worker({ sendToUser }), media: new FakeMediaService() as never });
    await expect(services.review.resend(incident.id)).rejects.toThrow();
    expect(sendToUser).not.toHaveBeenCalled(); expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('ordinary deduplication never revives failed answers or retired service messages', async () => {
    const { incident, answer, job } = await approved(); const sendToUser = vi.fn(); const w = worker({ sendToUser });
    const retired = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'chat', targetId: -999n, dedupeKey: 'foreign-greeting', status: 'FAILED', lastError: 'MANUALLY_RETIRED_FOREIGN_BOT_ADDED', payload: { text: 'hello' }, attachments: [] } });
    const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    expect(await services.delivery.deliverAnswer(incident.id, answer.id, 'answer')).toBe('failed');
    await w.send({ chatId: -999n }, { text: 'hello', delivery: { dedupeKey: 'foreign-greeting' } });
    expect(sendToUser).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.count({ where: { id: { in: [job.id, retired.id] }, status: 'FAILED' } })).toBe(2);
  });

  it.each([{ photos: 7, fail: 2 }, { photos: 9, fail: 2 }, { photos: 9, fail: 3 }])('resumes $photos historical photos after part $fail fails', async ({ photos, fail }) => {
    const received: string[] = []; let calls = 0;
    const send = async (_id: bigint, _text: string, extra: any) => {
      if (++calls === fail) throw new MaxError(503, { code: 'temporary', message: 'test failure' });
      received.push(...(extra.attachments ?? []).filter((a: any) => a.type === 'image').map((a: any) => a.payload.token));
      return { body: { mid: `photo-part-${calls}` } };
    };
    const first = worker({ sendToChat: send });
    await first.send({ chatId: -1010n }, { text: 'Historical card', label: 'INC-test', attachments: Array.from({ length: photos }, (_, i) => ({ type: 'IMAGE' as const, maxToken: `photo-${i}` })),
      keyboard: [[{ type: 'callback', text: 'Work', payload: 'test' }]], delivery: { dedupeKey: 'historical' } });
    first.stop(); await first.waitForIdle();
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'historical' } });
    expect(row.status).toBe('PENDING'); expect((row.payload as any).deliveryProgress.mids).toHaveLength(fail - 1);
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    const restarted = worker({ sendToChat: send }); await restarted.flush(); await restarted.flush();
    expect(received).toEqual(Array.from({ length: photos }, (_, i) => `photo-${i}`));
    const done = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe('SENT'); expect(done.firstMessageId).toBe('photo-part-1'); expect((done.payload as any).keyboardMessageId).toBe('photo-part-1');
  });

  it('manual FAILED retry resumes staff answer attachments and marks delivery only after all parts', async () => {
    const { incident, answer, job } = await approved(11);
    const text = 'b'.repeat(8000); const received: string[] = []; let calls = 0;
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', attempts: 11, payload: { text, keyboard: [[{ type: 'callback', text: 'Rate', payload: 'test' }]] },
      attachments: [...Array.from({ length: 9 }, (_, i) => ({ type: 'IMAGE', storageKey: `max-photo:${'photo-' + i}`, owned: false })), { type: 'FILE', storageKey: 'answer/file', owned: false }] } });
    // Use the production encoding for references rather than a hand-written prefix.
    const { photoReference } = await import('../../src/media/max-photo-reference');
    const stored = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { attachments: (stored.attachments as any[]).map((a, n) => a.type === 'IMAGE' ? { ...a, storageKey: photoReference(`photo-${n}`) } : a) } });
    const sendToUser = async (_id: bigint, body: string, extra: any) => {
      if (++calls === 4) throw new MaxError(503, { code: 'temporary', message: 'test failure' });
      received.push(body || (extra.attachments?.[0]?.type ?? 'empty')); return { body: { mid: `answer-part-${calls}` } };
    };
    const first = worker({ sendToUser, uploadFile: async () => ({ type: 'file', payload: { token: 'file' } }) }); await first.flush(); first.stop(); await first.waitForIdle();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(0);
    const next = worker({ sendToUser, uploadFile: async () => ({ type: 'file', payload: { token: 'file' } }) });
    const services = buildServices(prisma, { messages: next, media: new FakeMediaService() as never });
    expect(await services.review.resend(incident.id)).toBe('sent');
    expect(received).toEqual([...splitText(text), 'image', 'image', 'file']);
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).not.toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(1);
    const done = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.firstMessageId).toBe('answer-part-1'); expect((done.payload as any).keyboardMessageId).toBe('answer-part-3');
  });

  it('retries completion after all parts were acknowledged without sending again', async () => {
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'acknowledged' } }); const w = worker({ sendToUser });
    const broken = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('database temporarily unavailable'));
    await w.send({ userId: 1n }, { text: 'one', delivery: { dedupeKey: 'completion' } }); broken.mockRestore(); w.stop(); await w.waitForIdle();
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'completion' } });
    expect(row.status).toBe('PENDING'); expect((row.payload as any).deliveryProgress.mids).toEqual(['acknowledged']);
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } }); await worker({ sendToUser }).flush();
    expect(sendToUser).toHaveBeenCalledTimes(1); expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('SENT');
  });

  it('fails closed if content differs from the saved part plan', async () => {
    let calls = 0; const w = worker({ sendToUser: async () => { if (++calls > 1) throw new Error('offline'); return { body: { mid: 'first' } }; } });
    await w.send({ userId: 1n }, { text: 'a'.repeat(8000), delivery: { dedupeKey: 'changed' } }); w.stop(); await w.waitForIdle();
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'changed' } });
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { payload: { ...(row.payload as any), text: 'different' }, nextAttemptAt: new Date(0) } });
    const sendToUser = vi.fn(); await worker({ sendToUser }).flush(); expect(sendToUser).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'FAILED', lastError: expect.stringContaining('DELIVERY_PROGRESS_MISMATCH') });
  });

  it('documents the ambiguous MAX acknowledgement: an unknown MID cannot prevent a duplicate', async () => {
    const accepted: string[] = []; let calls = 0;
    const sendToUser = async (_id: bigint, text: string) => { accepted.push(text); if (++calls === 1) throw new Error('connection lost after MAX accepted'); return { body: { mid: 'known' } }; };
    const w = worker({ sendToUser }); await w.send({ userId: 1n }, { text: 'one', delivery: { dedupeKey: 'ambiguous' } }); w.stop(); await w.waitForIdle();
    const row = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'ambiguous' } }); expect(row.firstMessageId).toBeNull();
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } }); await worker({ sendToUser }).flush();
    expect(accepted).toEqual(['one', 'one']);
  });

  it('checks /resend permissions before reviving any job', async () => {
    const { incident, job } = await approved(); const sendToUser = vi.fn();
    const services = buildServices(prisma, { messages: worker({ sendToUser }), media: new FakeMediaService() as never });
    const actor = await actorFor(prisma, TEST_USERS.requesterB, 'Resident', []);
    await expect(COMMANDS.resend!({ services, actor, chatId: actor.maxUserId, isDialog: true, args: [incident.publicCode] })).rejects.toThrow();
    expect(sendToUser).not.toHaveBeenCalled(); expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('returns failed, not queued, if a manual retry hits another permanent photo error', async () => {
    const { incident, job } = await approved(); const { photoReference } = await import('../../src/media/max-photo-reference');
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { attachments: [{ type: 'IMAGE', storageKey: photoReference('bad'), owned: false }] } });
    const sendToUser = vi.fn().mockRejectedValue(new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' }));
    const services = buildServices(prisma, { messages: worker({ sendToUser }), media: new FakeMediaService() as never });
    expect(await services.review.resend(incident.id)).toBe('failed');
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
  });

  it('does not finish stale answer tracking after state changes during a request', async () => {
    const { incident, answer } = await approved(); const entered = gate(), release = gate();
    const w = worker({ sendToUser: async () => { entered.resolve(); await release.promise; return { body: { mid: 'in-flight-old' } }; } });
    const services = buildServices(prisma, { messages: w, media: new FakeMediaService() as never });
    const sending = services.review.resend(incident.id); await entered.promise;
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'REVISION_REQUIRED' } });
    await prisma.incidentAnswer.update({ where: { id: answer.id }, data: { status: 'REVISION_REQUIRED' } });
    release.resolve(); expect(await sending).toBe('failed');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: answer.id } })).deliveredAt).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(0);
  });

  it('revalidates after recipient/rate waiting and never sends an obsolete approved version', async () => {
    const { incident, job } = await approved(); const accepted = vi.fn();
    const sendToUser = async (_id: bigint, _text: string, _extra: unknown, beforeAttempt?: () => Promise<void>) => {
      await prisma.incident.update({ where: { id: incident.id }, data: { status: 'REVISION_REQUIRED' } });
      await beforeAttempt!(); accepted(); return { body: { mid: 'should-not-send' } };
    };
    const services = buildServices(prisma, { messages: worker({ sendToUser }), media: new FakeMediaService() as never });
    expect(await services.review.resend(incident.id)).toBe('failed'); expect(accepted).not.toHaveBeenCalled();
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', firstMessageId: null, sentAt: null });
  });

  it('legacy outbox rows without progress still deliver; confirmed MID is required for SENT', async () => {
    const row = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'user', targetId: 1n, payload: { text: 'legacy' }, attachments: [] } });
    const first = worker({ sendToUser: async () => ({ body: {} }) }); await first.flush(); first.stop(); await first.waitForIdle();
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'PENDING', firstMessageId: null, sentAt: null });
    await prisma.outboundMessage.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(0) } });
    await worker({ sendToUser: async () => ({ body: { mid: 'legacy-ack' } }) }).flush();
    expect(await prisma.outboundMessage.findUnique({ where: { id: row.id } })).toMatchObject({ status: 'SENT', firstMessageId: 'legacy-ack' });
  });

  it('a restarted photo recovery keeps available previously confirmed parts and stored files', async () => {
    const { incident } = await fixture(); const sent: string[] = []; let calls = 0;
    const w = worker({ sendToChat: async (_id: bigint, _text: string, extra: any) => {
      if (++calls === 2) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
      sent.push(...(extra.attachments ?? []).filter((a: any) => a.type === 'image').map((a: any) => a.payload.token));
      return { body: { mid: 'available-part' } };
    } });
    await w.send({ chatId: TEST_CHATS.sector }, { text: 'Card', attachments: Array.from({ length: 7 }, (_, n) => ({ type: 'IMAGE' as const, maxToken: `p${n}` })),
      delivery: { dedupeKey: `sector-card:${incident.id}`, tracking: { type: 'SECTOR_CARD', incidentId: incident.id } } });
    w.stop(); await w.waitForIdle();
    const sendToChat = vi.fn().mockResolvedValue({ body: { mid: 'recovered' } }); const next = worker({ sendToChat }); await next.flush(); await next.flush();
    expect(sent).toEqual(['p0', 'p1', 'p2', 'p3']); expect(sendToChat).toHaveBeenCalledTimes(1);
    const original = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `sector-card:${incident.id}` } });
    expect(original.attachments).toHaveLength(7); expect((original.payload as any).deliveryProgress.mids).toEqual(['available-part']);
    expect(original.status).toBe('FAILED'); expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).sectorMessageId).toBe('recovered');
  });

  it('ROLLBACK: a stored confirmed prefix must not be sent again by a replacement worker', async () => {
    const text = 'r'.repeat(5000), parts = splitText(text);
    // Persisted v1 fixture: also run against the old runtime to characterize rollback.
    const planHash = createHash('sha256').update(JSON.stringify({ parts, target: 'user:1', attachments: [] })).digest('hex');
    const job = await prisma.outboundMessage.create({ data: { nextAttemptAt: new Date(0), targetType: 'user', targetId: 1n, attachments: [], firstMessageId: 'confirmed-before-switch',
      payload: { text, deliveryProgress: { version: 1, planHash, totalParts: parts.length, mids: ['confirmed-before-switch'] } } } });
    const sendToUser = vi.fn().mockResolvedValue({ body: { mid: 'after-switch' } }); await worker({ sendToUser }).flush();
    expect(sendToUser.mock.calls.map(call => call[1])).toEqual(parts.slice(1));
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'SENT', firstMessageId: 'confirmed-before-switch' });
  });

  it('a partial 429 keeps its successor behind backoff, then resumes in order after restart', async () => {
    const text = 'p'.repeat(5000), parts = splitText(text), sent: string[] = []; let calls = 0;
    const first = worker({ sendToUser: async (_id: bigint, body: string) => {
      if (++calls === 2) throw new MaxError(429, { code: 'rate.limit', message: 'test backoff' });
      sent.push(body); return { body: { mid: 'confirmed-prefix' } };
    } });
    await first.send({ userId: 1n }, { text, delivery: { dedupeKey: 'head' } });
    await first.send({ userId: 1n }, { text: 'successor', delivery: { dedupeKey: 'tail' } });
    await first.flush(); expect(sent).toEqual([parts[0]]); expect(calls).toBe(2);
    const head = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'head' } });
    expect(head.status).toBe('PENDING'); expect(head.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    first.stop(); await first.waitForIdle();
    await prisma.outboundMessage.update({ where: { id: head.id }, data: { nextAttemptAt: new Date(0) } });
    const next = worker({ sendToUser: async (_id: bigint, body: string) => { sent.push(body); return { body: { mid: `next-${sent.length}` } }; } });
    await next.flush(); await next.flush();
    expect(sent).toEqual([...parts, 'successor']);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: { in: ['head', 'tail'] }, status: 'SENT' } })).toBe(2);
  });
});
