import { type PrismaClient, UserRole } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { MaxMessageService } from '../../src/max/max-message.service';
import { workPanelKey } from '../../src/work-queues/state';
import { queueStaffRefresh } from '../../src/delivery/workflow-outbox';
import { discardObsoleteSession } from '../../src/bot/handlers/session-guard';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('working chat queues and obsolete actions', () => {
  let prisma: PrismaClient;
  let services: AppServices;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  let colleague: typeof actor;
  let max: any;
  let sent: Array<{ chat: bigint; text: string; extra: any; mid: string }>;
  let sequence: number;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma);
    vi.useFakeTimers({ toFake: ['Date'] });
    const future = new Date(Date.now() + 7 * 86_400_000); future.setUTCHours(9, 0, 0, 0); vi.setSystemTime(future);
    sent = []; sequence = 0;
    const send = async (chat: bigint, text: string, extra: any) => {
      const mid = `mid-${sent.length + 1}`; sent.push({ chat, text, extra, mid }); return { body: { mid } };
    };
    max = { sendToChat: vi.fn(send), sendToUser: vi.fn(send), editMessage: vi.fn(async () => undefined), editCardWithKeyboard: vi.fn(async () => undefined),
      api: { getMessage: vi.fn(async (mid: string) => ({ recipient: { chat_id: Number(sent.find(s => s.mid === mid)!.chat) } })),
        getPinnedMessage: vi.fn(async () => ({ message: null })), pinMessage: vi.fn(async () => ({ success: true })) } };
    max.getMessage = max.api.getMessage; max.getPinnedMessage = max.api.getPinnedMessage;
    max.pinMessage = (chat: bigint, mid: string) => max.api.pinMessage(Number(chat), mid, { notify: false });
    services = buildServices(prisma, { messages: new MaxMessageService(max, { prisma, storage: { remove: async () => undefined } as never }) });
    actor = await actorFor(prisma, TEST_USERS.admin, 'Первый сотрудник', [UserRole.ADMIN]);
    colleague = await actorFor(prisma, 9999n, 'Второй сотрудник', [UserRole.ADMIN]);
  });
  async function create(age = 0, groupCode: string = GROUP_CODES.facility) {
    const i = await services.incidents.create({ requester: { maxUserId: 6000n + BigInt(++sequence), name: 'Иван Иванов', phone: '+79001112233' }, text: 'Не работает освещение' });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: groupCode } });
    await services.distribution.assign(i.id, group.id, actor);
    return prisma.incident.update({ where: { id: i.id }, data: { createdAt: new Date(Date.now() - age * 60_000) } });
  }
  async function reviewing(age = 0) { const i = await create(age); await services.answers.submit(i.id, actor, 'Освещение восстановлено.', []); return i; }
  const lastEdit = (mid: string) => max.editCardWithKeyboard.mock.calls.filter((c: any[]) => c[0] === mid).at(-1);

  it('gives concurrent profile workers distinct oldest incidents and never another organization', async () => {
    const oldest = await create(60); const next = await create(30); const foreign = await create(120, GROUP_CODES.it);
    await Promise.all([services.workQueues.claim(actor, TEST_CHATS.sector), services.workQueues.claim(colleague, TEST_CHATS.sector)]);
    const rows = await prisma.incident.findMany({ where: { id: { in: [oldest.id, next.id] } } });
    expect(rows.every(i => i.status === 'IN_PROGRESS')).toBe(true);
    expect(new Set(rows.map(i => i.currentResponderId)).size).toBe(2);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe('ASSIGNED');
    await expect(services.workQueues.open(actor, TEST_CHATS.sector, foreign.id)).rejects.toThrow();
    await services.workQueues.list(actor, TEST_CHATS.sector, 0, true);
    const mine = sent.at(-1)!.text; expect(mine).toContain('Всего: 1'); expect(mine).not.toContain(foreign.publicCode);
  });
  it('reserves review work, prevents another approval, releases and expires reservations', async () => {
    const one = await reviewing(60); const two = await reviewing(30);
    await services.workQueues.claim(actor, TEST_CHATS.review);
    await services.workQueues.claim(actor, TEST_CHATS.review);
    expect(await prisma.actionLock.count({ where: { action: 'review-queue', maxUserId: actor.maxUserId } })).toBe(1);
    await expect(services.review.approve(one.id, colleague)).rejects.toThrow('другим сотрудником');
    await expect(services.review.requestRevision(one.id, 'Дополнить', colleague)).rejects.toThrow('другим сотрудником');
    await services.workQueues.claim(colleague, TEST_CHATS.review);
    expect(await prisma.actionLock.count({ where: { action: 'review-queue' } })).toBe(2);
    await services.workQueues.release(actor, TEST_CHATS.review, one.id);
    await services.workQueues.release(colleague, TEST_CHATS.review, two.id);
    await services.workQueues.claim(actor, TEST_CHATS.review);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await services.workQueues.claim(colleague, TEST_CHATS.review);
    expect((await prisma.actionLock.findUniqueOrThrow({ where: { key: `review-queue:${one.id}` } })).maxUserId).toBe(colleague.maxUserId);
  });
  it('removes actions from review originals and all copies after delivery and from sector copies after submission', async () => {
    const i = await create(); await services.workQueues.open(actor, TEST_CHATS.sector, i.id);
    await services.answers.submit(i.id, actor, 'Работы выполнены.', []);
    await services.workQueues.claim(actor, TEST_CHATS.review); await services.workQueues.open(colleague, TEST_CHATS.review, i.id);
    const copies = await prisma.outboundMessage.findMany({ where: { incidentId: i.id, dedupeKey: { startsWith: 'work-copy:' } } });
    await services.review.approve(i.id, actor); await services.messages.flush();
    const fresh = await services.repository.findById(i.id);
    for (const mid of [fresh!.reviewMessageId!, ...copies.map(c => c.firstMessageId!)]) expect(lastEdit(mid)[2]).toEqual([]);
    expect(lastEdit(fresh!.reviewMessageId!)[1]).toContain('доставлен');
    expect(await prisma.actionLock.count({ where: { incidentId: i.id, action: 'review-queue' } })).toBe(0);
    await services.workQueues.list(actor, TEST_CHATS.review); expect(sent.at(-1)!.text).toContain('Всего: 0');
  });
  it('retires revision buttons and does not resurrect an old review version after resubmission', async () => {
    const i = await reviewing(); const original = (await services.repository.findById(i.id))!.reviewMessageId!;
    await services.review.requestRevision(i.id, 'Укажите дату', actor); await services.messages.flush();
    const revision = await prisma.outboundMessage.findFirstOrThrow({ where: { dedupeKey: { startsWith: `revision:${i.id}:` } } });
    expect(lastEdit(original)[2]).toEqual([]); expect(lastEdit(revision.firstMessageId!)[2].length).toBeGreaterThan(0);
    await services.answers.submit(i.id, actor, 'Работы выполнены сегодня.', []); await services.messages.flush();
    expect(lastEdit(original)[2]).toEqual([]); expect(lastEdit(revision.firstMessageId!)[2]).toEqual([]);
    const current = (await services.repository.findById(i.id))!.reviewMessageId!; expect(lastEdit(current)[2].length).toBeGreaterThan(0);
  });
  it('tracks and retires the final fragment of a long review card without removing answer text', async () => {
    const i = await create();
    await services.answers.submit(i.id, actor, 'Первоначальный подробный текст. '.repeat(200), []);
    await services.review.requestRevision(i.id, 'Добавьте результаты обследования.', actor);
    await services.answers.submit(i.id, actor, 'Подробный ответ. '.repeat(350), []);
    const latest = (await services.repository.findById(i.id))!.answers.at(-1)!;
    await services.workQueues.open(actor, TEST_CHATS.review, i.id);
    const publications = await prisma.outboundMessage.findMany({ where: { incidentId: i.id, answerId: latest.id, OR: [{ trackingType: 'REVIEW_CARD' }, { dedupeKey: { startsWith: 'work-copy:review:' } }] } });
    expect(publications).toHaveLength(2);
    for (const row of publications) {
      expect((row.payload as any).keyboardMessageId).not.toBe(row.firstMessageId);
      expect((row.payload as any).text).toContain('Первоначальный ответ (версия 1):');
      expect((row.payload as any).text).toContain('Причина доработки версии 1:\nДобавьте результаты обследования.');
      expect((row.payload as any).text).toContain('НОВЫЙ ОТВЕТ (версия 2):');
    }
    expect(sent.filter(s => s.chat === TEST_CHATS.review).every(s => Array.from(s.text).length <= 4000)).toBe(true);
    await services.workQueues.claimReview(actor, TEST_CHATS.review, i.id);
    for (const row of publications) {
      expect(lastEdit(row.firstMessageId!)[1]).not.toContain('Свободно');
      expect(lastEdit((row.payload as any).keyboardMessageId)[1]).toContain(actor.displayName);
    }
    await services.review.approve(i.id, actor); await services.messages.flush();
    for (const row of publications) {
      const last = lastEdit((row.payload as any).keyboardMessageId);
      expect(last[2]).toEqual([]); expect(last[1]).toContain('Подробный ответ.');
    }
  });
  it('separates delivered and approved-but-pending answers in daily totals', async () => {
    const a = await reviewing(); const b = await reviewing();
    await services.review.approve(a.id, actor); await services.review.approve(b.id, actor);
    await prisma.incidentAnswer.updateMany({ where: { incidentId: b.id }, data: { deliveredAt: null } });
    await services.workQueues.list(actor, TEST_CHATS.review, 0, false, true);
    await services.messages.flush();
    const summary = sent.findLast(s => s.chat === TEST_CHATS.review && s.text.includes('ОБРАЩЕНИЯ ЗА СЕГОДНЯ'))!;
    expect(summary.text).toContain('Отработано: 1'); expect(summary.text).toContain('Ожидает доставки: 1');
    await services.workQueues.list(actor, TEST_CHATS.distribution, 0, false, true); await services.messages.flush();
    const routing = sent.findLast(s => s.chat === TEST_CHATS.distribution && s.text.includes('ОБРАЩЕНИЯ ЗА СЕГОДНЯ'))!.text;
    expect(routing).toContain('🟢 Распределено: 2'); expect(routing).toContain('🔴 Не распределено: 0');
    expect(routing).not.toMatch(/Отработано|Ожидает доставки|На согласовании/);
  });
  it('recreates only confirmed missing panels even when MAX would accept editing deleted messages', async () => {
    await services.workQueues.refresh(actor, TEST_CHATS.sector);
    const first = (await prisma.systemSetting.findUniqueOrThrow({ where: { key: workPanelKey(TEST_CHATS.sector) } })).value;
    max.api.getMessage.mockRejectedValueOnce(new MaxError(404, { code: 'message.not.found', message: 'Gone' }));
    await services.workQueues.refresh(actor, TEST_CHATS.sector);
    const second = (await prisma.systemSetting.findUniqueOrThrow({ where: { key: workPanelKey(TEST_CHATS.sector) } })).value;
    expect(second).not.toBe(first);
    await Promise.all([services.workQueues.refresh(actor, TEST_CHATS.sector), services.workQueues.refresh(colleague, TEST_CHATS.sector)]);
    await services.messages.flush();
    expect((await prisma.systemSetting.findUniqueOrThrow({ where: { key: workPanelKey(TEST_CHATS.sector) } })).value).toBe(second);
    expect(sent.filter(s => s.text.includes('ОЧЕРЕДЬ ПРОФИЛЬНОГО')).length).toBe(2);
    max.api.getMessage.mockRejectedValueOnce(new Error('Network timeout'));
    await services.workQueues.refresh(actor, TEST_CHATS.sector);
    expect(sent.filter(s => s.text.includes('ОЧЕРЕДЬ ПРОФИЛЬНОГО')).length).toBe(2);
  });
  it('uses Moscow creation-day boundaries, paginates, and keeps profile daily summaries scoped', async () => {
    const mine = await create(); const foreign = await create(0, GROUP_CODES.it);
    const previous = await create(); const start = new Date(Date.now()); start.setUTCHours(-3, 0, 0, 0);
    await prisma.incident.update({ where: { id: previous.id }, data: { createdAt: new Date(start.getTime() - 1) } });
    await prisma.incident.update({ where: { id: mine.id }, data: { createdAt: start } });
    await services.workQueues.list(actor, TEST_CHATS.sector, 0, false, true);
    expect(sent.at(-1)!.text).toContain(mine.publicCode); expect(sent.at(-1)!.text).not.toContain(foreign.publicCode); expect(sent.at(-1)!.text).not.toContain(previous.publicCode);
    for (let n = 0; n < 8; n++) await create();
    await services.workQueues.list(actor, TEST_CHATS.review, 1, false, true);
    expect(sent.at(-1)!.text).toContain('Всего: 10. Страница 2 из 2');
    await expect(services.workQueues.list(actor, 555n, 0, false, true)).rejects.toThrow();
  });
  it('clears obsolete answer/review sessions while preserving valid drafts and repairs late published cards', async () => {
    const i = await reviewing();
    const session = await services.sessions.start({ maxUserId: actor.maxUserId, chatId: TEST_CHATS.sector, incidentId: i.id, type: 'WAITING_FOR_ANSWER' });
    expect(await discardObsoleteSession(services, session)).toBe(true);
    const report = await services.sessions.start({ maxUserId: actor.maxUserId, chatId: TEST_CHATS.sector, type: 'WAITING_REPORT_PERIOD' });
    expect(await discardObsoleteSession(services, report)).toBe(false);
    await services.review.approve(i.id, actor);
    const answer = (await services.repository.findById(i.id))!.answers.at(-1)!;
    await services.messages.send({ chatId: TEST_CHATS.review }, { text: 'Late card', keyboard: [[{ type: 'callback', text: 'Согласовать', payload: 'old' }]], delivery: { dedupeKey: `work-copy:review:${i.id}:late`, tracking: { type: 'REVIEW_CARD', incidentId: i.id, answerId: answer.id } } });
    await services.messages.flush();
    const late = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: `work-copy:review:${i.id}:late` } });
    expect(lastEdit(late.firstMessageId!)[2]).toEqual([]);
    await prisma.$transaction(tx => queueStaffRefresh(tx, i.id)); await services.messages.flush();
    expect(await services.sessions.find(actor.maxUserId, TEST_CHATS.sector)).not.toBeNull();
  });
});
