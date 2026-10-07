import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import * as outbox from '../../src/delivery/workflow-outbox';
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

describeIntegration('staff reservations and redistribution', () => {
  let prisma: PrismaClient;
  let services: AppServices;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  let colleague: typeof actor;
  let max: any;
  let sent: Array<{ chat: bigint; text: string; extra: any; mid: string }>;
  let sequence: number;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(async () => { services.messages.stop(); await services.messages.waitForIdle(); vi.useRealTimers(); vi.restoreAllMocks(); });
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
    await services.distribution.assign(i.id, group.id, actor); await services.messages.flush();
    return prisma.incident.update({ where: { id: i.id }, data: { createdAt: new Date(Date.now() - age * 60_000) } });
  }
  async function reviewing(age = 0) { const i = await create(age); await services.answers.submit(i.id, actor, 'Освещение восстановлено.', []); return i; }
  const lastEdit = (mid: string) => max.editCardWithKeyboard.mock.calls.filter((c: any[]) => c[0] === mid).at(-1);

  it('shows distribution owner on the original, then makes it free after release', async () => {
    const i = await services.incidents.create({ requester: { maxUserId: 7100n, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Фонарь' });
    await services.distributionQueue.claim(actor, TEST_CHATS.distribution, i.id); await services.messages.flush();
    const fresh = (await services.repository.findById(i.id))!;
    expect(lastEdit(fresh.distributionMessageId!)[1]).toContain(actor.displayName);
    expect(lastEdit(fresh.distributionMessageId!)[1]).toContain('До ');
    await services.distributionQueue.release(actor, TEST_CHATS.distribution, i.id); await services.messages.flush();
    expect(lastEdit(fresh.distributionMessageId!)[1]).toContain('Свободно');
    expect(lastEdit(fresh.distributionMessageId!)[1]).not.toContain(actor.displayName);
  });
  it('claims when preparing an answer and blocks a colleague from submitting or releasing it', async () => {
    const i = await create();
    await handleIncidentCallback({ services, actor, chatId: TEST_CHATS.sector }, { kind: 'incident', action: 'answer', incidentId: i.id }); await services.messages.flush();
    const fresh = (await services.repository.findById(i.id))!;
    expect(lastEdit(fresh.sectorMessageId!)[1]).toContain(`Закреплено за: ${actor.displayName}`);
    await expect(services.answers.submit(i.id, colleague, 'Чужой ответ')).rejects.toThrow('закреплено');
    await expect(services.workQueues.release(colleague, TEST_CHATS.sector, i.id)).rejects.toThrow();
    await services.workQueues.release(actor, TEST_CHATS.sector, i.id); await services.messages.flush();
    expect((await services.repository.findById(i.id))!.status).toBe('ASSIGNED');
    expect(await services.sessions.find(actor.maxUserId, TEST_CHATS.sector)).toBeNull();
    await services.sector.takeInWork(i.id, colleague); await services.messages.flush();
    expect(lastEdit(fresh.sectorMessageId!)[1]).toContain(colleague.displayName);
  });
  it('expires sector claims, rejects an expired input and lets another employee claim', async () => {
    const i = await create();
    await handleIncidentCallback({ services, actor, chatId: TEST_CHATS.sector }, { kind: 'incident', action: 'answer', incidentId: i.id }); await services.messages.flush();
    const session = (await services.sessions.find(actor.maxUserId, TEST_CHATS.sector))!;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(await discardObsoleteSession(services, session)).toBe(true);
    await services.actionGuard.purgeExpired();
    expect(await prisma.actionLock.count({ where: { incidentId: i.id, action: 'sector-queue' } })).toBe(1);
    await services.workQueues.sweep(); await services.messages.flush();
    const fresh = (await services.repository.findById(i.id))!;
    expect(fresh.currentResponderId).toBeNull(); expect(fresh.status).toBe('ASSIGNED');
    expect(lastEdit(fresh.sectorMessageId!)[1]).toContain('Свободно');
    await services.workQueues.claim(colleague, TEST_CHATS.sector); await services.messages.flush();
    expect((await services.repository.findById(i.id))!.currentResponderId).toBe(colleague.userId);
  });
  it('claims review from the original card and displays the reviewer in card and queue', async () => {
    const i = await reviewing(); const fresh = (await services.repository.findById(i.id))!;
    await handleIncidentCallback({ services, actor, chatId: TEST_CHATS.review }, { kind: 'incident', action: 'revision', incidentId: i.id, argument: fresh.answers.at(-1)!.id }); await services.messages.flush();
    expect(lastEdit(fresh.reviewMessageId!)[1]).toContain(actor.displayName);
    expect(lastEdit(fresh.reviewMessageId!)[2].flat().some((b: any) => b.text === 'Освободить сообщение')).toBe(true);
    await services.workQueues.list(colleague, TEST_CHATS.review); await services.messages.flush();
    expect(sent.at(-1)!.text).toContain(`Закреплено за: ${actor.displayName}`);
    await services.workQueues.release(actor, TEST_CHATS.review, i.id); await services.messages.flush();
    expect(lastEdit(fresh.reviewMessageId!)[1]).toContain('Свободно');
  });
  it('returns without changing deadline/history, keeps original queue order and supports repeated reassignment', async () => {
    const i = await create(60); const before = (await services.repository.findById(i.id))!;
    const group = before.assignedGroup!;
    await services.sector.takeInWork(i.id, actor); await services.messages.flush(); await services.workQueues.open(actor, TEST_CHATS.sector, i.id); await services.messages.flush();
    const copies = await prisma.outboundMessage.findMany({ where: { incidentId: i.id, dedupeKey: { startsWith: 'work-copy:sector:' } } });
    await services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Не относится к полномочиям'); await services.messages.flush();
    const returned = (await services.repository.findById(i.id))!;
    expect(returned.status).toBe('DISTRIBUTION'); expect(returned.assignedGroupId).toBeNull();
    expect(returned.deadlineAt).toEqual(before.deadlineAt); expect(returned.createdAt).toEqual(before.createdAt);
    expect(returned.history[0]!.metadata).toMatchObject({ reason: 'Не относится к полномочиям', groupId: group.id });
    for (const mid of [before.sectorMessageId, ...copies.map(c => c.firstMessageId)]) expect(lastEdit(mid!)[2]).toEqual([]);
    expect(lastEdit(before.distributionMessageId!)[1]).toContain('ВОЗВРАЩЕНО');
    expect(sent.filter(m => m.text.includes('ВОЗВРАЩЕНО НА ПЕРЕРАСПРЕДЕЛЕНИЕ')).length).toBeGreaterThan(0);
    await services.incidents.create({ requester: { maxUserId: 7101n, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Новое сообщение' });
    expect((await services.distributionQueue.claim(actor, TEST_CHATS.distribution))!.id).toBe(i.id); await services.messages.flush();
    await services.distribution.assign(i.id, group.id, actor); await services.messages.flush();
    const returnNotice = await prisma.outboundMessage.findFirstOrThrow({ where: { incidentId: i.id, dedupeKey: { startsWith: 'redistribution-notice:' } } });
    expect(max.editMessage.mock.calls.filter((c: any[]) => c[0] === returnNotice.firstMessageId).at(-1)[2]).toEqual([]);
    const reassigned = (await services.repository.findById(i.id))!;
    expect(reassigned.sectorMessageId).not.toBe(before.sectorMessageId); expect(reassigned.sectorMessageId).toBeTruthy();
    await services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Нужно другое ведомство'); await services.messages.flush();
    await services.distribution.assign(i.id, group.id, actor); await services.messages.flush();
    expect((await services.repository.findById(i.id))!.sectorMessageId).not.toBe(reassigned.sectorMessageId);
    expect(await prisma.incidentHistory.count({ where: { incidentId: i.id, action: 'REDISTRIBUTION_REQUESTED' } })).toBe(2);
  });
  it('rejects returns from another chat/owner and after review; queue failures roll everything back', async () => {
    const i = await create(); await services.sector.takeInWork(i.id, actor); await services.messages.flush();
    await expect(services.sector.returnToDistribution(i.id, colleague, TEST_CHATS.sector, 'Ошибка')).rejects.toThrow();
    await expect(services.sector.returnToDistribution(i.id, actor, TEST_CHATS.review, 'Ошибка')).rejects.toThrow();
    vi.spyOn(outbox, 'queueDistributionRefresh').mockRejectedValueOnce(new Error('Queue failed'));
    await expect(services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Ошибка')).rejects.toThrow('Queue failed');
    expect((await services.repository.findById(i.id))!.status).toBe('IN_PROGRESS');
    expect(await prisma.incidentHistory.count({ where: { incidentId: i.id, action: 'REDISTRIBUTION_REQUESTED' } })).toBe(0);
    await services.answers.submit(i.id, actor, 'Ответ');
    await expect(services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Ошибка')).rejects.toThrow();
  });
  it('serializes return against answer submission with only one winning operation', async () => {
    const i = await create(); await services.sector.takeInWork(i.id, actor); await services.messages.flush();
    const result = await Promise.allSettled([services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Ошибка'), services.answers.submit(i.id, actor, 'Ответ')]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const fresh = (await services.repository.findById(i.id))!;
    expect(['DISTRIBUTION', 'WAITING_REVIEW']).toContain(fresh.status);
    expect(fresh.answers.length).toBe(fresh.status === 'DISTRIBUTION' ? 0 : 1);
  });
  it('accepts a return reason through the real input session and keeps it across card refreshes', async () => {
    const i = await create();
    await handleIncidentCallback({ services, actor, chatId: TEST_CHATS.sector }, { kind: 'incident', action: 'redistribute', incidentId: i.id }); await services.messages.flush();
    await prisma.$transaction(tx => queueStaffRefresh(tx, i.id)); await services.messages.flush();
    const session = (await services.sessions.find(actor.maxUserId, TEST_CHATS.sector))!;
    expect(session).toBeTruthy();
    await handleOperatorMessage(services, actor, TEST_CHATS.sector, { body: { text: '', attachments: [] } } as never, session);
    expect((await services.repository.findById(i.id))!.status).toBe('IN_PROGRESS');
    await handleOperatorMessage(services, actor, TEST_CHATS.sector, { body: { text: 'Дорога в ведении другой организации', attachments: [] } } as never, session);
    expect((await services.repository.findById(i.id))!.status).toBe('IN_PROGRESS');
    const confirmation = (await services.sessions.find(actor.maxUserId, TEST_CHATS.sector))!.data as any;
    await handleIncidentCallback({ services, actor, chatId: TEST_CHATS.sector }, { kind: 'incident', action: 'action-confirm', incidentId: i.id, argument: confirmation.confirmation.token }); await services.messages.flush();
    expect((await services.repository.findById(i.id))!.status).toBe('DISTRIBUTION');
    expect(await services.sessions.find(actor.maxUserId, TEST_CHATS.sector)).toBeNull();
  });
  it.each([GROUP_CODES.facility, GROUP_CODES.it])('does not restore old sector pointers or buttons when an old publication finishes after reassignment to %s', async (nextGroupCode) => {
    const i = await services.incidents.create({ requester: { maxUserId: 7110n, name: 'Иван Иванов', phone: '+79001112233' }, text: 'Дорога' });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    const nextGroup = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: nextGroupCode } });
    const legacyPointerWrite = vi.spyOn(services.incidents, 'setSectorMessageId');
    let unblock!: () => void, blocked = false;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let reachedSend!: () => void, reachedSecondPublication!: () => void;
    const sending = new Promise<void>(resolve => { reachedSend = resolve; });
    const secondPublication = new Promise<void>(resolve => { reachedSecondPublication = resolve; });
    const publish = services.sector.publishCard.bind(services.sector);
    let publicationsStarted = 0;
    vi.spyOn(services.sector, 'publishCard').mockImplementation(async id => {
      // assign() calls this only after the assignment transaction has committed.
      if (++publicationsStarted === 2) reachedSecondPublication();
      return publish(id);
    });
    const originalSend = max.sendToChat.getMockImplementation();
    max.sendToChat.mockImplementation(async (...args: any[]) => {
      if (args[0] === group.maxChatId && !blocked) { blocked = true; reachedSend(); await gate; }
      return originalSend(...args);
    });
    const first = services.distribution.assign(i.id, group.id, actor);
    let second: typeof first | undefined;
    try {
      await sending;
      await services.sector.returnToDistribution(i.id, actor, TEST_CHATS.sector, 'Нужна проверка получателя');
      expect((await services.repository.findById(i.id))!.status).toBe('DISTRIBUTION');
      second = services.distribution.assign(i.id, nextGroup.id, actor);
      await secondPublication;
      expect((await services.repository.findById(i.id))!).toMatchObject({ status: 'ASSIGNED', assignedGroupId: nextGroup.id });
    } finally {
      unblock(); await Promise.all([first, second]);
    }
    await services.messages.flush(); await services.messages.waitForIdle();
    const publications = await prisma.outboundMessage.findMany({ where: { incidentId: i.id, trackingType: 'SECTOR_CARD' }, orderBy: { createdAt: 'asc' } });
    expect(publications).toHaveLength(2);
    const old = publications.find(p => p.dedupeKey === `sector-card:${i.id}`)!;
    const current = publications.find(p => p.id !== old.id)!;
    expect(old).toMatchObject({ status: 'SENT', trackingApplied: false });
    expect(current).toMatchObject({ status: 'SENT', trackingApplied: true, targetId: nextGroup.maxChatId });
    expect((await services.repository.findById(i.id))!.sectorMessageId).toBe(current.firstMessageId);
    expect(legacyPointerWrite).not.toHaveBeenCalled();
    const history = await prisma.incidentHistory.findMany({ where: { incidentId: i.id, action: 'SECTOR_CARD_SENT' } });
    expect(history).toHaveLength(1);
    expect(history[0]!.metadata).toMatchObject({ messageId: current.firstMessageId, outboxId: current.id });
    expect(lastEdit(old.firstMessageId!)[2]).toEqual([]);
    expect(lastEdit(current.firstMessageId!)[2].length).toBeGreaterThan(0);
    // A later ownership change must still refresh only the current actionable card.
    await services.sector.takeInWork(i.id, colleague); await services.messages.flush();
    expect(lastEdit(old.firstMessageId!)[2]).toEqual([]);
    expect(lastEdit(current.firstMessageId!)[1]).toContain(colleague.displayName);
    expect((await services.repository.findById(i.id))!.sectorMessageId).toBe(current.firstMessageId);
  });

});
