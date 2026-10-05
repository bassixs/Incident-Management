import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UserRole, type PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { buildServices } from '../../src/app/container';
import { MaxMessageService, splitText } from '../../src/max/max-message.service';
import { MediaService } from '../../src/media/media.service';
import { queueStaffRefresh } from '../../src/delivery/workflow-outbox';
import { reviewCard } from '../../src/bot/views/cards';
import { reviewKeyboard } from '../../src/bot/keyboards';
import { actorFor, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { enterPersonalWork, invitePersonalWork, personalAction, receivePersonalText } from '../../src/work-queues/private-workspace';
import { photoReference } from '../../src/media/max-photo-reference';
import type { Message } from '../../src/max/max-types';

describeIntegration('PR11 delivery review regressions', () => {
  let prisma: PrismaClient; const workers: MaxMessageService[] = [];
  const storage = { load: vi.fn(), save: vi.fn(), remove: vi.fn(), exists: vi.fn() };
  const edits: Array<{ mid: string; text: string; buttons: any[] }> = [];
  const sends: Array<{ target: bigint; text: string; extra: any; mid: string }> = [];
  let sequence = 0, failResident = true, failPart = 0, partCalls = 0;
  function worker() {
    const send = async (target: bigint, text: string, extra?: any) => {
      if (target === TEST_USERS.requesterA && failResident && extra?.attachments?.some((a: any) => a.type === 'image')) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid photo token' });
      if (target === TEST_CHATS.sector && failPart && ++partCalls === failPart) throw new MaxError(503, { code: 'unavailable', message: 'Test failure' });
      const mid = `review-test-${++sequence}`; sends.push({ target, text, extra, mid }); return { body: { mid } };
    };
    const max = { sendToChat: send, sendToUser: send, editCardWithKeyboard: async (mid: string, text: string, buttons: any[]) => { edits.push({ mid, text, buttons }); }, editMessage: async () => undefined };
    const w = new MaxMessageService(max as never, { prisma, storage }); vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w);
    return { w, services: buildServices(prisma, { messages: w, media: new MediaService(storage as never, max as never) }) };
  }
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); edits.length = sends.length = 0; sequence = partCalls = failPart = 0; failResident = true; });
  afterEach(async () => { for (const w of workers) w.stop(); await Promise.all(workers.splice(0).map(w => w.waitForIdle())); vi.restoreAllMocks(); });
  afterAll(() => prisma.$disconnect());
  async function assigned(direct = false) {
    const { w, services } = worker();
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Test employee', [UserRole.ADMIN]);
    const incident = await services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Street light' });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: direct ? GROUP_CODES.regional : GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, actor); await w.flush();
    return { w, services, actor, incident, group };
  }

  it.each([false, true])('REPRO outcome failed never becomes delivery success: direct=%s', async direct => {
    const { w, services, actor, incident } = await assigned(direct);
    const markWorked = vi.spyOn(services.distribution, 'markWorked');
    const result = await services.answers.submit(incident.id, actor, 'Completed', [{ kind: 'IMAGE', token: 'test-photo' }]);
    if (!direct) await services.review.approve(incident.id, actor, result.answer.id);
    await w.flush();
    const id = result.answer.id;
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${id}` } })).status).toBe('FAILED');
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id } })).deliveredAt).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(0);
    expect(markWorked).not.toHaveBeenCalled();
    if (direct) expect(result).toMatchObject({ deliveryFailed: true, deliveryQueued: false });
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `answer-delivered:${id}:sector` } })).toBeNull();
    expect(sends.some(s => s.text.includes('доставлен пользователю.'))).toBe(false);
    if (!direct) expect(sends.some(s => s.text.includes('Автоматические попытки прекращены'))).toBe(true);
    failResident = false; await services.review.resend(incident.id, actor.maxUserId); await w.flush();
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id } })).deliveredAt).not.toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(1);
    expect(await services.review.resend(incident.id, actor.maxUserId)).toBe('already-sent'); await w.flush();
    expect(sends.filter(s => s.text.includes('доставлен пользователю.'))).toHaveLength(1);
  });

  it('REPRO incomplete long review card must not receive the full card or buttons in its first fragment', async () => {
    const { services, actor, incident, w, group } = await assigned();
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 1, status: 'WAITING_REVIEW', text: 'a'.repeat(5000), createdByUserId: actor.userId } });
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'WAITING_REVIEW' } });
    const fresh = (await services.repository.findById(incident.id))!;
    const text = reviewCard(fresh, fresh.answers[0]!, group); expect(splitText(text)).toHaveLength(2);
    failPart = 2; partCalls = 0;
    await w.send({ chatId: TEST_CHATS.sector }, { text, keyboard: reviewKeyboard(incident.id, answer.id), delivery: { dedupeKey: 'work-copy:review:partial', tracking: { type: 'REVIEW_CARD', incidentId: incident.id, answerId: answer.id } } });
    const job = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'work-copy:review:partial' } });
    expect(job.status).toBe('PENDING'); expect((job.payload as any).deliveryProgress.mids).toHaveLength(1);
    await prisma.$transaction(tx => queueStaffRefresh(tx, incident.id, 'lease-change')); await w.flush();
    expect(edits.filter(e => e.mid === job.firstMessageId && e.buttons.length)).toEqual([]);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ payload: job.payload, attachments: job.attachments, status: 'PENDING' });
  });

  it.each([false, true])('private employee confirmation reports terminal failure, not success: direct=%s', async direct => {
    const { services, actor, incident, group, w } = await assigned(direct);
    services.max = { api: { getMyInfo: async () => ({ username: 'test_bot' }),
      getChatMembers: async (_id: number, args: { user_ids: number[] }) => ({ members: args.user_ids.map(user_id => ({ user_id, is_bot: false })) }) } } as never;
    const chat = direct ? group.maxChatId! : TEST_CHATS.review;
    if (!direct) await services.answers.submit(incident.id, actor, 'Completed', [{ kind: 'IMAGE', token: 'test-photo' }]);
    await invitePersonalWork(services, actor, chat, incident.id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { incidentId: incident.id, originChatId: chat } });
    await enterPersonalWork(services, actor, item.id);
    if (direct) {
      await personalAction(services, actor, item.id, 'run', `incident:answer:${incident.id}`);
      await receivePersonalText(services, actor, { body: { mid: 'private-input', text: 'Completed', attachments: [{ type: 'image', payload: { token: 'test-photo' } }] } } as Message);
    } else {
      const answer = await prisma.incidentAnswer.findFirstOrThrow({ where: { incidentId: incident.id } });
      await personalAction(services, actor, item.id, 'run', `incident:approve:${incident.id}:${answer.id}`);
    }
    const data = (await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).data as any;
    await personalAction(services, actor, item.id, 'confirm', data.draft?.nonce ?? data.pending?.nonce); await w.flush();
    const answer = await prisma.incidentAnswer.findFirstOrThrow({ where: { incidentId: incident.id } });
    expect(answer.deliveredAt).toBeNull();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } })).status).toBe('FAILED');
    const feedback = sends.filter(s => s.target === actor.maxUserId).map(s => s.text).join('\n');
    expect(feedback).toMatch(/[Аа]втоматические попытки прекращены/);
    expect(feedback).not.toContain('согласован и доставлен'); expect(feedback).not.toContain('доставлен пользователю.');
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: `answer-delivered:${answer.id}:sector` } })).toBeNull();
  });

  async function partial(terminal: boolean, keyboardSent: boolean, sector = false) {
    const f = await assigned();
    const answer = await prisma.incidentAnswer.create({ data: { incidentId: f.incident.id, version: 1, status: 'WAITING_REVIEW', text: 'b'.repeat(5000), createdByUserId: f.actor.userId } });
    if (!sector) await prisma.incident.update({ where: { id: f.incident.id }, data: { status: 'WAITING_REVIEW' } });
    const fresh = (await f.services.repository.findById(f.incident.id))!;
    const text = reviewCard(fresh, fresh.answers[0]!, f.group), fragments = splitText(text);
    const photos = Array.from({ length: keyboardSent ? 9 : 4 }, (_, n) => ({ type: 'IMAGE', storageKey: photoReference(`photo-${n}`), owned: false }));
    const job = await prisma.outboundMessage.create({ data: { targetType: 'chat', targetId: TEST_CHATS.sector,
      dedupeKey: `work-copy:${sector ? 'sector' : 'review'}:${f.incident.id}:partial`, incidentId: f.incident.id, answerId: answer.id,
      ...(sector ? {} : { trackingType: 'REVIEW_CARD' as const }), attempts: terminal ? 11 : 0,
      payload: { text, keyboard: reviewKeyboard(f.incident.id, answer.id) }, attachments: photos } });
    failPart = keyboardSent ? 3 : 2; partCalls = 0; await f.w.flush(); failPart = 0;
    const partialJob = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(partialJob.status).toBe(terminal ? 'FAILED' : 'PENDING');
    expect((partialJob.payload as any).deliveryProgress.mids).toHaveLength(keyboardSent ? 2 : 1);
    return { ...f, answer, job: partialJob, fragments };
  }

  it.each([false, true])('refresh a partial prefix, then restart and finish without rewriting or duplicating it: FAILED=%s', async terminal => {
    const { w, services, actor, incident, job, fragments } = await partial(terminal, false);
    const before = structuredClone(job.payload);
    // A lease change generates the usual durable refresh.
    await services.workQueues.claimReview(actor, TEST_CHATS.review, incident.id);
    await prisma.$transaction(tx => queueStaffRefresh(tx, incident.id, 'partial-lease'));
    await w.send({ chatId: TEST_CHATS.review }, { text: 'Following job' }); await w.flush();
    expect(edits.filter(e => e.mid === job.firstMessageId)).toEqual([]);
    expect(sends.some(s => s.text === 'Following job')).toBe(true);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).payload).toEqual(before);
    w.stop(); await w.waitForIdle();
    // Isolated explicit retry of this fixture (not a production operation).
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    const next = worker(); await next.w.flush(); await next.w.flush();
    const completed = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(completed.status).toBe('SENT'); expect(completed.firstMessageId).toBe(job.firstMessageId);
    expect(sends.filter(s => s.text === fragments[0])).toHaveLength(1);
    const keyboardMid = (completed.payload as any).keyboardMessageId;
    expect(keyboardMid).not.toBe(job.firstMessageId);
    expect(edits.some(e => e.mid === keyboardMid && e.buttons.length)).toBe(true);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect(completed.attachments).toEqual(job.attachments); expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each([false, true])('retire confirmed buttons on obsolete partial review without changing progress: FAILED=%s', async terminal => {
    const { w, services, actor, incident, answer, job } = await partial(terminal, true);
    const before = structuredClone(job.payload), mid = (job.payload as any).keyboardMessageId;
    await services.review.requestRevision(incident.id, 'Revise', actor, answer.id); await w.flush();
    expect(edits.filter(e => e.mid === mid).at(-1)?.buttons).toEqual([]);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).payload).toEqual(before);
    const count = sends.length; w.stop(); await w.waitForIdle();
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    const next = worker(); await next.w.flush();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('FAILED');
    // Retiring the obsolete head also releases the queued revision notice.
    const later = sends.slice(count);
    expect(later).toHaveLength(terminal ? 0 : 1);
    expect(later.every(s => s.text.includes('ОТВЕТ ВОЗВРАЩЁН НА ДОРАБОТКУ') && !s.extra?.attachments?.some((a: any) => a.type === 'image'))).toBe(true);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect(await prisma.incidentHistory.count({ where: { action: 'ANSWER_SENT' } })).toBe(0);
  });

  it.each([false, true])('update the confirmed keyboard tail during a lease change and finish all photos: FAILED=%s', async terminal => {
    const { w, services, actor, incident, job, fragments } = await partial(terminal, true);
    const mid = (job.payload as any).keyboardMessageId;
    await services.workQueues.claimReview(actor, TEST_CHATS.review, incident.id);
    await prisma.$transaction(tx => queueStaffRefresh(tx, incident.id, 'lease-with-tail')); await w.flush();
    const tail = edits.filter(e => e.mid === mid).at(-1)!;
    expect(tail.text).toContain('Закреплено за:'); expect(tail.text).toContain(fragments[1]);
    expect(tail.buttons.length).toBeGreaterThan(0);
    expect(edits.filter(e => e.mid === job.firstMessageId).every(e => !e.buttons.length)).toBe(true);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).payload).toEqual(job.payload);
    w.stop(); await w.waitForIdle();
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    const next = worker(); await next.w.flush(); await next.w.flush();
    const done = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.status).toBe('SENT'); expect((done.payload as any).keyboardMessageId).toBe(mid);
    const photos = sends.flatMap(s => s.extra?.attachments ?? []).filter(a => a.type === 'image').map(a => a.payload.token);
    expect(photos).toEqual(Array.from({ length: 9 }, (_, n) => `photo-${n}`));
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect((done.payload as any).deliveryProgress.mids.slice(0, 2)).toEqual((job.payload as any).deliveryProgress.mids);
  });

  it.each([false, true])('reassignment retires buttons of a partial working copy: FAILED=%s', async terminal => {
    const { w, incident, job } = await partial(terminal, true, true);
    const other = await prisma.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.otherSector } });
    await prisma.incident.update({ where: { id: incident.id }, data: { assignedGroupId: other.id } });
    await prisma.$transaction(tx => queueStaffRefresh(tx, incident.id, 'new-assignment')); await w.flush();
    const mid = (job.payload as any).keyboardMessageId;
    expect(edits.filter(e => e.mid === mid).at(-1)?.buttons).toEqual([]);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).payload).toEqual(job.payload);
    const count = sends.length; w.stop(); await w.waitForIdle();
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    const next = worker(); await next.w.flush();
    expect(sends.length).toBe(count);
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', lastError: 'STALE_PARTIAL_SECTOR_COPY', payload: job.payload, attachments: job.attachments });
  });

  it.each([false, true])('a newer answer prevents publishing the missing old keyboard tail: FAILED=%s', async terminal => {
    const { w, actor, incident, job } = await partial(terminal, false);
    await prisma.incidentAnswer.create({ data: { incidentId: incident.id, version: 2, status: 'WAITING_REVIEW', text: 'New answer', createdByUserId: actor.userId } });
    await prisma.$transaction(tx => queueStaffRefresh(tx, incident.id, 'new-answer')); await w.flush();
    expect(edits.filter(e => e.mid === job.firstMessageId)).toEqual([]);
    const count = sends.length; w.stop(); await w.waitForIdle();
    await prisma.outboundMessage.update({ where: { id: job.id }, data: { status: 'PENDING', nextAttemptAt: new Date(0) } });
    const next = worker(); await next.w.flush();
    expect(sends.length).toBe(count);
    expect(await prisma.outboundMessage.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED', lastError: 'STALE_PARTIAL_REVIEW_CARD', payload: job.payload, attachments: job.attachments });
  });

  it('approval of a completed long review card edits only bounded fragments and retires its buttons', async () => {
    failResident = false;
    const { w, services, actor, incident } = await assigned();
    const result = await services.answers.submit(incident.id, actor, 'c'.repeat(5000)); await w.flush();
    const job = await prisma.outboundMessage.findFirstOrThrow({ where: { incidentId: incident.id, trackingType: 'REVIEW_CARD' } });
    expect(job.status).toBe('SENT');
    const tail = (job.payload as any).keyboardMessageId; expect(tail).not.toBe(job.firstMessageId);
    edits.length = 0;
    await services.review.approve(incident.id, actor, result.answer.id); await w.flush();
    expect(edits.filter(e => e.mid === tail).at(-1)?.buttons).toEqual([]);
    expect(edits.filter(e => e.mid === job.firstMessageId).every(e => !e.buttons.length)).toBe(true);
    expect(edits.every(e => Array.from(e.text).length <= 3800)).toBe(true);
    expect((await prisma.incidentAnswer.findUniqueOrThrow({ where: { id: result.answer.id } })).deliveredAt).not.toBeNull();
  });
});
