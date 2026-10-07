import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { type PrismaClient, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { MaxError } from '@maxhub/max-bot-api';
import { resetConfigCache } from '../../src/config';
import { addWorkingHours, workingMilliseconds } from '../../src/sla/working-time';
import { recordPolicyDelivery } from '../../src/sla/policy';
import { MaxMessageService } from '../../src/max/max-message.service';
import { buildServices } from '../../src/app/container';
import { FakeMediaService } from '../helpers/fakes';
import { photoReference } from '../../src/media/max-photo-reference';
import { showPersonalWork } from '../../src/work-queues/private-workspace';
import { distributionCard, reviewCard, sectorCard, revisionCard, incidentLookupCard, finalAnswerToRequester } from '../../src/bot/views/cards';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_USERS, TEST_CHATS } from '../helpers/setup-env';

const time = (s: string) => new Date(`${s}+03:00`);
describeIntegration('working hour policy and legacy coexistence', () => {
  let db: PrismaClient, h: TestHarness;
  const workers: MaxMessageService[] = [];
  const set = (s: string) => vi.setSystemTime(time(s));
  const policy = (value: string) => { process.env.INCIDENT_SLA_POLICY = value; resetConfigCache(); };
  beforeAll(() => { pushSchemaOnce(); db = createTestPrisma(); });
  beforeEach(async () => {
    await resetDatabase(db); await seedCategories(db); policy('WORKING_HOURS_V1');
    vi.useFakeTimers({ toFake: ['Date'] }); set('2026-10-09T16:00:00'); h = await createHarness(db);
  });
  afterEach(async () => { workers.forEach(w => w.stop()); await Promise.all(workers.splice(0).map(w => w.waitForIdle()));
    vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.INCIDENT_SLA_POLICY; resetConfigCache(); });
  afterAll(() => db.$disconnect());
  const fresh = (id: string) => h.services.repository.findById(id).then(i => i!);
  const create = () => h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA }, text: 'Synthetic street light' });
  const cycles = (id: string) => db.incidentAssignmentCycle.findMany({ where: { incidentId: id }, orderBy: { sequence: 'asc' } });
  async function actors() {
    const actor = await actorFor(db, TEST_USERS.admin, 'Synthetic administrator', [UserRole.ADMIN]);
    const group = await db.responsibleGroup.findUniqueOrThrow({ where: { maxChatId: TEST_CHATS.sector } });
    return { actor, group };
  }
  async function assigned() {
    const i = await create(); const { actor, group } = await actors();
    await h.services.distribution.assign(i.id, group.id, actor); return { i, actor, group };
  }
  function worker(max: object = {}) {
    const w = new MaxMessageService({ sendToChat: async () => ({ body: { mid: 'synthetic-chat' } }),
      sendToUser: async () => ({ body: { mid: 'synthetic-user' } }), editCardWithKeyboard: async () => undefined,
      editMessage: async () => undefined, ...max } as never,
    { prisma: db, storage: { load: vi.fn(), save: vi.fn(), remove: vi.fn(), exists: vi.fn() } });
    vi.spyOn(w, 'wake').mockImplementation(() => {}); workers.push(w); return w;
  }

  it('stamps registration, keeps old deadlines and old draft uses the policy at confirmation', async () => {
    policy('LEGACY'); const old = await create();
    const draft = await db.operatorSession.create({ data: { maxUserId: TEST_USERS.requesterB, chatId: TEST_USERS.requesterB,
      type: 'WAITING_INCIDENT_CONFIRMATION', expiresAt: time('2026-10-09T17:00:00'),
      data: { previewToken: 'synthetic-preview', draftText: 'Synthetic saved text' } } });
    policy('WORKING_HOURS_V1');
    const current = await h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterB }, text: 'Synthetic saved text',
      draftSessionId: draft.id, draftPreviewToken: 'synthetic-preview' });
    expect(current.slaPolicy).toBe('WORKING_HOURS_V1'); expect(current.createdAt).toEqual(time('2026-10-09T16:00:00'));
    expect(current.deadlineAt).toEqual(time('2026-10-14T13:00:00'));
    expect(await fresh(old.id)).toMatchObject({ slaPolicy: 'LEGACY', deadlineAt: old.deadlineAt });
    policy('LEGACY'); const { actor, group } = await actors();
    await h.services.distribution.assign(current.id, group.id, actor);
    expect(await cycles(current.id)).toHaveLength(1); // Saved version, not current config.
    await h.services.distribution.assign(old.id, group.id, actor);
    expect(await cycles(old.id)).toHaveLength(0);
    expect((await fresh(old.id)).deadlineAt).toEqual(old.deadlineAt);
  });

  it('separates clocks at late assignment and preserves original queue priority', async () => {
    const i = await create(); set('2026-10-14T12:00:00'); const { actor, group } = await actors();
    await h.services.distribution.assign(i.id, group.id, actor);
    const [c] = await cycles(i.id);
    expect(c).toMatchObject({ assignedAt: new Date(), preparationDueAt: addWorkingHours(new Date(), 22), returnDueAt: addWorkingHours(new Date(), 2) });
    expect((await fresh(i.id)).deadlineAt).toEqual(i.deadlineAt);
    expect(distributionCard(await fresh(i.id))).toContain('позже общего срока');
    await h.services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Synthetic routing reason');
    const other = await create();
    expect((await h.services.distributionQueue.claim(actor, TEST_CHATS.distribution))?.id).toBe(i.id);
    expect(other.createdAt).not.toEqual(i.createdAt);
  });

  it.each([-1, 0, 60_001])('allows return relative to two-hour deadline by %s ms and records actual lateness', async delta => {
    const { i, actor } = await assigned(); const [c] = await cycles(i.id);
    vi.setSystemTime(new Date(c!.returnDueAt.getTime() + delta));
    await h.services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Required routing reason');
    const [done] = await cycles(i.id);
    expect(done).toMatchObject({ outcome: 'RETURNED', returnedAt: new Date(), returnReason: 'Required routing reason' });
    expect(workingMilliseconds(done!.returnDueAt, done!.returnedAt!)).toBe(Math.max(0, delta));
    expect((await fresh(i.id)).deadlineAt).toEqual(i.deadlineAt);
  });

  it('creates real reassignment cycles, including same group; duplicate assignments cannot extend them', async () => {
    const i = await create(); const { actor, group } = await actors();
    const attempts = await Promise.allSettled([h.services.distribution.assign(i.id, group.id, actor), h.services.distribution.assign(i.id, group.id, actor)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(await cycles(i.id)).toHaveLength(1);
    for (const code of [group.code, 'IT']) {
      await h.services.sector.returnToDistribution(i.id, actor, (await fresh(i.id)).assignedGroup!.maxChatId!, 'Another routing cycle');
      const next = await db.responsibleGroup.findUniqueOrThrow({ where: { code } });
      await h.services.distribution.assign(i.id, next.id, actor);
    }
    expect((await cycles(i.id)).map(c => c.groupCode)).toEqual([group.code, group.code, 'IT']);
    expect((await cycles(i.id)).map(c => c.sequence)).toEqual([1, 2, 3]);
  });

  it('employee release/reclaim and review revision never replace deadlines or first preparation', async () => {
    const { i, actor, group } = await assigned(); const before = (await cycles(i.id))[0]!;
    await h.services.sector.takeInWork(i.id, actor); await h.services.sector.release(i.id, actor, TEST_CHATS.sector);
    const second = await actorFor(db, TEST_USERS.dispatcher, 'Other employee', [UserRole.ADMIN]);
    await h.services.sector.takeInWork(i.id, second);
    set('2026-10-12T09:30:00'); const first = await h.services.answers.submit(i.id, second, 'Initial project');
    const prepared = (await cycles(i.id))[0]!;
    expect(prepared.firstPreparedAt).toEqual(new Date());
    await h.services.review.requestRevision(i.id, 'Synthetic revision reason', actor, first.answer.id);
    set('2026-10-13T16:00:00'); await h.services.answers.submit(i.id, second, 'Revised project');
    const after = (await cycles(i.id))[0]!;
    expect(after).toMatchObject({ id: before.id, preparationDueAt: before.preparationDueAt, returnDueAt: before.returnDueAt,
      firstPreparedAt: prepared.firstPreparedAt, firstPreparedAnswerId: first.answer.id });
    expect(await db.incidentHistory.count({ where: { incidentId: i.id, action: 'SLA_PROJECT_SUBMITTED' } })).toBe(2);
    const current = await fresh(i.id);
    for (const view of [sectorCard(current, group), revisionCard(current, 1, 'Reason'), incidentLookupCard(current, undefined, false, false)]) {
      expect(view).not.toMatch(/рабочих часа|Срок ответа|Общий срок|Срок подготовки|Просроч/);
    }
    expect(reviewCard(current, current.answers.at(-1)!, group)).toContain('Общий срок');
  });

  it('direct REGION_KALUGA retains no-signature formatting and completes only upon delivery ACK', async () => {
    const i = await create(); const { actor, group } = await actors();
    await db.responsibleGroup.update({ where: { id: group.id }, data: { code: 'REGION_KALUGA', bypassReview: true, authorityName: 'Администрация Губернатора' } });
    await h.services.distribution.assign(i.id, group.id, actor);
    vi.spyOn(h.messages, 'send').mockResolvedValue({ state: 'queued', trackingApplied: false });
    const { answer, sentDirectly } = await h.services.answers.submit(i.id, actor, 'Prepared text https://example.test/result');
    expect(sentDirectly).toBe(true); expect((await cycles(i.id))[0]!.firstPreparedAt).not.toBeNull();
    const before = await fresh(i.id); expect(before.slaDeliveredAt).toBeNull();
    expect(finalAnswerToRequester(before, answer, new Date(), before.assignedGroup!.authorityName, 'REGION_KALUGA')).not.toContain('Ответ подготовлен');
    set('2026-10-14T14:00:00'); await h.services.sla.sweep();
    expect((await fresh(i.id)).isOverdue).toBe(true);
    const w = worker(); await w.flush();
    const done = await fresh(i.id);
    expect(done.slaDeliveredAt).toEqual(new Date()); expect(done.answers.at(-1)!.deliveredAt).not.toBeNull();
    expect((await cycles(i.id))[0]!.outcome).toBe('DELIVERED');
    expect(await db.incidentHistory.count({ where: { incidentId: i.id, action: 'ANSWER_SENT' } })).toBe(1);
  });

  it('approved but MAX 403 keeps total clock active, not the preparation clock', async () => {
    const { i, actor } = await assigned(); const { answer } = await h.services.answers.submit(i.id, actor, 'Prepared project');
    const preparation = (await cycles(i.id))[0]!.firstPreparedAt;
    vi.spyOn(h.messages, 'send').mockResolvedValue({ state: 'queued', trackingApplied: false });
    await h.services.review.approve(i.id, actor, answer.id);
    set('2026-10-14T14:00:00'); await h.services.sla.sweep();
    const w = worker({ sendToUser: async (_id: bigint, text: string) => {
      if (text.includes('Prepared project')) throw new MaxError(403, { code: 'error.dialog.suspended', message: 'Synthetic refusal' });
      return { body: { mid: 'other-notification' } };
    } });
    await w.flush(); w.stop(); await w.waitForIdle();
    expect((await fresh(i.id)).slaDeliveredAt).toBeNull(); expect((await cycles(i.id))[0]!.firstPreparedAt).toEqual(preparation);
    const job = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } });
    expect(job.status).toBe('PENDING'); expect(job.sentAt).toBeNull(); expect(job.attempts).toBe(1); expect(job.lastError).toContain('403');
    expect((await fresh(i.id)).answers.at(-1)!.deliveredAt).toBeNull();
    await db.outboundMessage.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
    await worker().flush(); expect((await fresh(i.id)).slaDeliveredAt).not.toBeNull();
  });

  it('keeps legacy reminders separate; persists deduped new recipients across restart and return', async () => {
    policy('LEGACY'); const old = await create(); policy('WORKING_HOURS_V1'); const { i, actor } = await assigned();
    set('2026-10-12T09:00:00'); await h.services.sla.sweep();
    expect(await db.outboundMessage.count({ where: { dedupeKey: `sla:${old.id}:elapsed24` } })).toBe(1);
    expect(await db.outboundMessage.count({ where: { dedupeKey: `sla:${i.id}:elapsed24` } })).toBe(0);
    set('2026-10-14T13:00:00'); await Promise.all([h.services.sla.sweep(), h.services.sla.sweep()]);
    const jobs = await db.outboundMessage.findMany({ where: { dedupeKey: { startsWith: `sla-working-v1:${i.id}:` } } });
    expect(jobs.map(j => j.targetId).sort()).toEqual([TEST_CHATS.distribution, TEST_CHATS.review].sort());
    await h.services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Late return allowed');
    h = await createHarness(db); await h.services.sla.sweep();
    expect(await db.outboundMessage.count({ where: { dedupeKey: { startsWith: `sla-working-v1:${i.id}:` } } })).toBe(2);
    expect((await fresh(i.id)).slaReminder24SentAt).toBeNull();
  });

  it('uses the actual personal-work context even when the employee has administrator and reviewer roles', async () => {
    const { i, actor } = await assigned();
    h.services.max = { api: { getChatMembers: async () => ({ members: [{ user_id: Number(actor.maxUserId), is_bot: false }] }) } } as never;
    const sector = await db.privateWorkItem.create({ data: { maxUserId: actor.maxUserId, incidentId: i.id, originChatId: TEST_CHATS.sector } });
    await h.services.sector.takeInWork(i.id, actor);
    await showPersonalWork(h.services, actor, sector.id, true);
    const shown = h.messages.toUser(actor.maxUserId).at(-1)!.message.text;
    expect(shown).not.toMatch(/Общий срок|Проект \(22|рабочих часа|Срок ответа/);
    expect(shown).toContain(actor.displayName); // Existing temporary reservation remains.
    await h.services.answers.submit(i.id, actor, 'Project for review');
    const review = await db.privateWorkItem.create({ data: { maxUserId: actor.maxUserId, incidentId: i.id, originChatId: TEST_CHATS.review } });
    await showPersonalWork(h.services, actor, review.id, true);
    expect(h.messages.toUser(actor.maxUserId).at(-1)!.message.text).toContain('Общий срок');
  });

  it('does not extend assignment clocks when the working card waits for MAX', async () => {
    const i = await create(); const { actor, group } = await actors();
    vi.spyOn(h.messages, 'send').mockResolvedValue({ state: 'queued', trackingApplied: false });
    await h.services.distribution.assign(i.id, group.id, actor);
    const before = (await cycles(i.id))[0]!;
    expect((await fresh(i.id)).sectorMessageId).toBeNull(); expect(before.cardDeliveredAt).toBeNull();
    set('2026-10-12T11:00:00'); await worker().flush();
    const after = (await cycles(i.id))[0]!;
    expect(after.cardDeliveredAt).toEqual(new Date()); expect(after.assignedAt).toEqual(before.assignedAt);
    expect(after.preparationDueAt).toEqual(before.preparationDueAt); expect(after.returnDueAt).toEqual(before.returnDueAt);
  });

  it('does not complete total SLA after only part of an answer; restart preserves confirmed parts and photographs', async () => {
    const { i, actor, group } = await assigned();
    await db.responsibleGroup.update({ where: { id: group.id }, data: { bypassReview: true } });
    vi.spyOn(h.messages, 'send').mockResolvedValue({ state: 'queued', trackingApplied: false });
    const { answer } = await h.services.answers.submit(i.id, actor, 'x'.repeat(8000));
    const job = await db.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `answer:${answer.id}` } });
    const photos = Array.from({ length: 5 }, (_, n) => ({ type: 'IMAGE', storageKey: photoReference(`synthetic-${n}`), owned: false }));
    await db.outboundMessage.update({ where: { id: job.id }, data: { attachments: photos } });
    await db.outboundMessage.updateMany({ where: { id: { not: job.id } }, data: { nextAttemptAt: time('2026-11-01T00:00:00') } });
    const received: Array<{ text: string; photos: number }> = []; let calls = 0;
    const first = worker({ sendToUser: async (_id: bigint, text: string, extra: any) => {
      if (++calls === 2) throw new MaxError(503, { code: 'unavailable', message: 'Synthetic temporary error' });
      received.push({ text, photos: extra.attachments?.filter((a: any) => a.type === 'image').length ?? 0 });
      return { body: { mid: 'confirmed-prefix' } };
    } });
    await first.flush(); first.stop(); await first.waitForIdle();
    expect((await fresh(i.id)).slaDeliveredAt).toBeNull(); expect((await fresh(i.id)).answers.at(-1)!.deliveredAt).toBeNull();
    const partial = await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } });
    expect(partial.payload).toMatchObject({ deliveryProgress: { mids: ['confirmed-prefix'] } });
    await db.outboundMessage.update({ where: { id: job.id }, data: { nextAttemptAt: new Date(0) } });
    const next = worker({ sendToUser: async (_id: bigint, text: string, extra: any) => {
      received.push({ text, photos: extra.attachments?.filter((a: any) => a.type === 'image').length ?? 0 });
      return { body: { mid: `remaining-${received.length}` } };
    } });
    await next.flush(); await next.flush();
    expect(received.filter(r => r.text === received[0]!.text)).toHaveLength(1);
    expect(received.reduce((sum, r) => sum + r.photos, 0)).toBe(5);
    expect((await fresh(i.id)).slaDeliveredAt).not.toBeNull();
    expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: job.id } })).attachments).toEqual(photos);
    expect(await db.incidentHistory.count({ where: { incidentId: i.id, action: 'ANSWER_SENT' } })).toBe(1);
  });

  it('does not send at night or after rejection, and coincident chats produce one job', async () => {
    const previous = process.env.REVIEW_CHAT_ID; process.env.REVIEW_CHAT_ID = String(TEST_CHATS.distribution); resetConfigCache();
    try {
      const i = await create(); set('2026-10-14T13:00:00'); await h.services.sla.sweep();
      const jobs = await db.outboundMessage.findMany({ where: { dedupeKey: { startsWith: `sla-working-v1:${i.id}:` } } }); expect(jobs).toHaveLength(1);
      // Isolate this notification without touching business state.
      await db.outboundMessage.updateMany({ where: { id: { not: jobs[0]!.id } }, data: { nextAttemptAt: time('2026-11-01T00:00:00') } });
      set('2026-10-14T17:00:00'); const send = vi.fn().mockResolvedValue({ body: { mid: 'unexpected' } }); await worker({ sendToChat: send }).flush();
      expect(send).not.toHaveBeenCalled();
      expect((await db.outboundMessage.findUniqueOrThrow({ where: { id: jobs[0]!.id } })).nextAttemptAt).toEqual(time('2026-10-15T08:00:00'));
      const { actor } = await actors(); await h.services.distribution.reject(i.id, 'Synthetic rejection', actor);
      set('2026-10-15T09:00:00'); await h.services.sla.sweep();
      await worker().flush();
      expect(await db.outboundMessage.count({ where: { dedupeKey: { startsWith: `sla-working-v1:${i.id}:` }, status: 'CANCELLED', cancelReason: 'INCIDENT_REJECTED' } })).toBe(1);
      expect(await db.outboundMessage.count({ where: { dedupeKey: `rejection:${i.id}` } })).toBe(1);
    } finally { if (previous === undefined) delete process.env.REVIEW_CHAT_ID; else process.env.REVIEW_CHAT_ID = previous; resetConfigCache(); }
  });

  it.each(['delivered', 'changed-before-send'])('revalidates notification after queueing: %s', async mode => {
    const i = await create(); set('2026-10-14T13:00:00'); await h.services.sla.sweep();
    const jobs = await db.outboundMessage.findMany({ where: { dedupeKey: { startsWith: `sla-working-v1:${i.id}:` } } });
    await db.outboundMessage.updateMany({ where: { id: { notIn: jobs.map(j => j.id) } }, data: { nextAttemptAt: time('2026-11-01T00:00:00') } });
    if (mode === 'delivered') await db.$transaction(tx => recordPolicyDelivery(tx, i.id, new Date()));
    const sent: string[] = [];
    const send = vi.fn(async (_chat: bigint, text: string, _extra: unknown, guard?: () => Promise<void>) => {
      if (mode === 'changed-before-send') await db.$transaction(tx => recordPolicyDelivery(tx, i.id, new Date()));
      await guard?.(); sent.push(text); return { body: { mid: 'should-not-ack' } };
    });
    await worker({ sendToChat: send }).flush(); expect(sent).toEqual([]);
    expect(await db.outboundMessage.count({ where: { id: { in: jobs.map(j => j.id) }, status: 'SENT' } })).toBe(0);
  });

  it('reports several cycles without redefining approval date or inventing a late return', async () => {
    const { i, actor, group } = await assigned();
    set('2026-10-12T10:15:00'); await h.services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Synthetic routing cause');
    await h.services.distribution.assign(i.id, group.id, actor);
    const { answer } = await h.services.answers.submit(i.id, actor, 'Prepared answer');
    vi.spyOn(h.messages, 'send').mockResolvedValue({ state: 'queued', trackingApplied: false });
    await h.services.review.approve(i.id, actor, answer.id);
    const approval = (await fresh(i.id)).answeredAt;
    set('2026-10-14T16:00:00');
    const report = await h.services.reports.build({ from: time('2026-10-01T00:00:00'), to: time('2026-11-01T00:00:00'), slug: 'synthetic', title: 'Synthetic' });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(report.buffer as never);
    expect(book.worksheets[0]!.getCell(2, 2).value).toBe('12.10.2026 10:15');
    expect((await fresh(i.id)).answeredAt).toEqual(approval);
    const sheet = book.getWorksheet('Циклы назначения')!; expect(sheet.rowCount).toBe(3);
    expect(sheet.getCell(2, 16).value).toBe('С опозданием'); expect(sheet.getCell(3, 16).value).toBe('Возврата не было');
    expect(sheet.getCell(3, 17).value).toBe(''); expect(sheet.getCell(3, 9).value).not.toBe('');
    expect(report.overdueRows).toBe(1);
  });
});
