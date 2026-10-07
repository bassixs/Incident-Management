import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MaxError } from '@maxhub/max-bot-api';
import { type PrismaClient, UserRole } from '@prisma/client';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { finalAnswerToRequester } from '../../src/bot/views/cards';
import { photoReference } from '../../src/media/max-photo-reference';
import { buildServices } from '../../src/app/container';
import { queueAnswer } from '../../src/delivery/workflow-outbox';
import { FakeMediaService } from '../helpers/fakes';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('regional signature at durable delivery boundaries', () => {
  let prisma: PrismaClient;
  const workers: MaxMessageService[] = [];
  const storage = { save: vi.fn(), load: vi.fn(), remove: vi.fn(), exists: vi.fn().mockResolvedValue(true) };
  function worker(sendToUser: unknown) {
    const w = new MaxMessageService({ sendToUser, sendToChat: async () => ({ body: { mid: 'staff-notice' } }),
      editCardWithKeyboard: async () => undefined, editMessage: async () => undefined } as never, { prisma, storage });
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());
  async function fixture(long = false) {
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Synthetic employee', [UserRole.ADMIN]);
    const requester = await actorFor(prisma, TEST_USERS.requesterA, 'Synthetic resident', []);
    const group = await prisma.responsibleGroup.update({ where: { maxChatId: TEST_CHATS.sector },
      data: { code: 'REGION_KALUGA', authorityName: 'Администрация Губернатора Калужской области', bypassReview: true } });
    const at = new Date('2026-10-01T10:00:00Z');
    const incident = await prisma.incident.create({ data: { publicCode: 'INC-000001', requesterId: requester.userId,
      requesterMaxUserId: requester.maxUserId, requesterName: 'Synthetic resident', text: 'Synthetic incident', status: 'RESOLVED',
      assignedGroupId: group.id, answeredAt: at, deadlineAt: at } });
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'APPROVED',
      text: `${long ? 'x'.repeat(8000) : 'Кем подготовлен ответ\nОтвет подготовлен:\nСотрудником.'}\nhttps://example.test/result`,
      createdByUserId: actor.userId, approvedAt: at } });
    const legacy = finalAnswerToRequester(incident, answer, at, group.authorityName);
    const current = finalAnswerToRequester(incident, answer, at, group.authorityName, group.code);
    const keyboard = [[{ type: 'callback', text: 'Rate', payload: `rate:${incident.id}:5` }]];
    const attachments = [{ type: 'IMAGE', storageKey: photoReference('synthetic-photo'), owned: false }];
    const job = await prisma.outboundMessage.create({ data: { dedupeKey: `answer:${answer.id}`, targetType: 'user', targetId: requester.maxUserId,
      payload: { text: legacy, keyboard }, attachments, trackingType: 'ANSWER_TO_REQUESTER', incidentId: incident.id, answerId: answer.id } });
    return { incident, answer, job, legacy, current, keyboard, attachments };
  }
  const row = (id: string) => prisma.outboundMessage.findUniqueOrThrow({ where: { id } });
  const due = (id: string) => prisma.outboundMessage.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });

  it('rewrites an untouched legacy job before MAX, preserving text, photo, buttons and authorship', async () => {
    const f = await fixture();
    const send = vi.fn(async (_id: bigint, text: string, extra: any) => {
      expect((await row(f.job.id)).payload).toMatchObject({ text: f.current });
      expect(text).toBe(f.current);
      expect(extra.attachments.map((a: any) => a.type)).toEqual(['image', 'inline_keyboard']);
      return { body: { mid: 'public-answer' } };
    });
    const w = worker(send); await w.flush(); await w.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const done = await row(f.job.id);
    expect(done).toMatchObject({ status: 'SENT', attachments: f.attachments });
    expect(done.payload).toMatchObject({ text: f.current, keyboard: f.keyboard });
    expect(await prisma.incidentAnswer.findUnique({ where: { id: f.answer.id } }))
      .toMatchObject({ text: f.answer.text, createdByUserId: f.answer.createdByUserId, deliveredAt: expect.any(Date) });
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('persists the new format across a failed first request and worker restart', async () => {
    const f = await fixture(); const first = worker(vi.fn().mockRejectedValue(new MaxError(503, { code: 'unavailable', message: 'synthetic' })));
    await first.flush(); first.stop(); await first.waitForIdle();
    expect(await row(f.job.id)).toMatchObject({ status: 'PENDING', payload: { text: f.current }, firstMessageId: null });
    await due(f.job.id); const send = vi.fn().mockResolvedValue({ body: { mid: 'retry' } });
    await worker(send).flush();
    expect(send.mock.calls[0]![1]).toBe(f.current); expect((await row(f.job.id)).status).toBe('SENT');
  });

  it('formats an answer created before the update when its job is only now queued', async () => {
    const f = await fixture();
    await prisma.outboundMessage.delete({ where: { id: f.job.id } });
    await prisma.$transaction(tx => queueAnswer(tx, f.incident.id, f.answer.id, true));
    const queued = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${f.answer.id}` } });
    expect(queued.payload).toMatchObject({ text: f.current });
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).text).toBe(f.answer.text);
  });

  it('does not send when another writer changes the job before the guarded update', async () => {
    const f = await fixture(); const original = prisma.outboundMessage.updateMany.bind(prisma.outboundMessage);
    // Fault injection returns a native Promise rather than Prisma's lazy promise.
    vi.spyOn(prisma.outboundMessage as any, 'updateMany').mockImplementation(async (args: any) => {
      if (args.data.payload?.text === f.current) {
        await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { lockedAt: new Date(0), attempts: { increment: 1 } } });
      }
      return original(args);
    });
    const send = vi.fn(); await worker(send).flush(); expect(send).not.toHaveBeenCalled();
    expect((await row(f.job.id)).payload).toMatchObject({ text: f.legacy });
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).toBeNull();
  });

  it('preserves an old attempted job with unknown ACK rather than changing its content', async () => {
    const f = await fixture();
    await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { attempts: 1, lastError: 'connection lost after possible acceptance' } });
    const send = vi.fn().mockResolvedValue({ body: { mid: 'known-ack' } }); await worker(send).flush();
    expect(send.mock.calls[0]![1]).toBe(f.legacy);
  });

  it.each(['PENDING', 'FAILED'] as const)('keeps the legacy part plan and resumes %s without repeating an ACK', async status => {
    const f = await fixture(true); const received: string[] = []; let calls = 0;
    // An old attempt already began; generate real v1 progress through the same delivery engine.
    await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { attempts: 1 } });
    const first = worker(async (_id: bigint, text: string) => {
      if (++calls === 2) throw new MaxError(503, { code: 'unavailable', message: 'synthetic' });
      received.push(text); return { body: { mid: 'first-ack' } };
    });
    await first.flush(); first.stop(); await first.waitForIdle();
    const partial = await row(f.job.id); expect(partial.firstMessageId).toBe('first-ack');
    expect(partial.payload).toMatchObject({ text: f.legacy, deliveryProgress: { version: 1, mids: ['first-ack'] } });
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).toBeNull();
    await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { status, nextAttemptAt: new Date(0) } });
    const send = vi.fn(async (_id: bigint, text: string) => { received.push(text); return { body: { mid: `next-${received.length}` } }; });
    const next = worker(send);
    if (status === 'FAILED') {
      await next.flush(); expect(send).not.toHaveBeenCalled();
      const services = buildServices(prisma, { messages: next, media: new FakeMediaService() as never });
      expect(await services.review.resend(f.incident.id)).toBe('sent');
      expect(await services.review.resend(f.incident.id)).toBe('already-sent');
    } else await next.flush();
    expect(received).toEqual(splitText(f.legacy));
    expect(await row(f.job.id)).toMatchObject({ status: 'SENT', firstMessageId: 'first-ack', payload: { text: f.legacy } });
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
  });

  it('finishes accounting after every legacy ACK without another send', async () => {
    const f = await fixture(); await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { attempts: 1 } });
    const send = vi.fn().mockResolvedValue({ body: { mid: 'all-acked' } }); const first = worker(send);
    vi.spyOn(first as any, 'complete').mockRejectedValueOnce(new Error('synthetic commit unavailable'));
    await first.flush(); first.stop(); await first.waitForIdle();
    expect(await row(f.job.id)).toMatchObject({ status: 'PENDING', payload: { text: f.legacy, deliveryProgress: { mids: ['all-acked'] } } });
    await due(f.job.id); await worker(send).flush(); expect(send).toHaveBeenCalledTimes(1);
    expect((await row(f.job.id)).status).toBe('SENT');
    expect(await prisma.incidentHistory.count({ where: { incidentId: f.incident.id, action: 'ANSWER_SENT' } })).toBe(1);
  });

  it('does not guess which text belongs to an unmatched legacy template', async () => {
    const f = await fixture(); const text = `${f.legacy}\nUnrecognized stored content`;
    await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { payload: { text } } });
    const send = vi.fn(); await worker(send).flush(); expect(send).not.toHaveBeenCalled();
    expect(await row(f.job.id)).toMatchObject({ status: 'FAILED', payload: { text }, sentAt: null,
      lastError: expect.stringContaining('REQUESTER_SIGNATURE_REVIEW_REQUIRED') });
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: f.answer.id } })).deliveredAt).toBeNull();
  });

  it('leaves already delivered jobs and their stored signatures untouched', async () => {
    const f = await fixture(); await prisma.outboundMessage.update({ where: { id: f.job.id }, data: { status: 'SENT', sentAt: new Date(), firstMessageId: 'old' } });
    const before = await row(f.job.id); const send = vi.fn(); await worker(send).flush();
    expect(send).not.toHaveBeenCalled(); expect(await row(f.job.id)).toEqual(before);
  });
});
