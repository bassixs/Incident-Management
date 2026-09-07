import { type PrismaClient, UserRole } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices, type AppServices } from '../../src/app/container';
import { MaxMessageService } from '../../src/max/max-message.service';
import { DistributionQueueService } from '../../src/distribution/distribution-queue.service';
import { queueSnapshot, panelSettingKey } from '../../src/distribution/queue-state';
import { handleQueueCallback } from '../../src/bot/callbacks/queue.callbacks';
import * as outbox from '../../src/delivery/workflow-outbox';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('persistent distribution queue', () => {
  let prisma: PrismaClient;
  let services: AppServices;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  let colleague: typeof actor;
  let sends: Array<{ target: bigint; text: string; extra: any }>;
  let max: any;
  let requesterSequence = 0;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    vi.useFakeTimers({ toFake: ['Date'] });
    // DB defaults must be earlier than the fake clock so queued jobs are eligible.
    const tomorrow = new Date(Date.now() + 86_400_000);
    tomorrow.setUTCHours(9, 0, 0, 0);
    vi.setSystemTime(tomorrow);
    sends = [];
    requesterSequence = 0;
    const send = async (target: bigint, text: string, extra: any) => {
      sends.push({ target, text, extra }); return { body: { mid: `mid-${sends.length}` } };
    };
    max = { sendToChat: vi.fn(send), sendToUser: vi.fn(send), editMessage: vi.fn(async () => undefined),
      api: { getPinnedMessage: vi.fn(async () => ({ message: null })), pinMessage: vi.fn(async () => ({})) } };
    const storage = { load: async () => Buffer.from('photo'), remove: vi.fn(async () => undefined) };
    services = buildServices(prisma, { messages: new MaxMessageService(max, { prisma, storage: storage as never }), storage: storage as never });
    actor = await actorFor(prisma, TEST_USERS.admin, 'Диспетчер 1', [UserRole.ADMIN]);
    colleague = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер 2', [UserRole.DISPATCHER]);
  });
  const advance = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000);
  async function create(age = 0) {
    const incident = await services.incidents.create({ requester: { maxUserId: 6000n + BigInt(++requesterSequence), name: 'Иванов Иван', phone: '+79001112233' }, text: 'Не работает фонарь' });
    return prisma.incident.update({ where: { id: incident.id }, data: { createdAt: new Date(Date.now() - age * 60_000), distributionMessageId: `original-${incident.id}` } });
  }
  const claim = (who = actor) => services.distributionQueue.claim(who, TEST_CHATS.distribution, undefined, true);
  const copies = (id: string) => prisma.outboundMessage.findMany({ where: { incidentId: id, dedupeKey: { startsWith: `distribution-claim:${id}:` } } });

  it('finalizes both the original and the issued copy after assignment, then shows delivery on both', async () => {
    const incident = await create();
    await claim();
    const copy = (await copies(incident.id))[0]!;
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, actor);
    for (const mid of [incident.distributionMessageId, copy.firstMessageId]) {
      expect(max.editMessage).toHaveBeenCalledWith(mid, expect.stringContaining('🟡 РАСПРЕДЕЛЕНО'), []);
      expect(max.editMessage).toHaveBeenCalledWith(mid, expect.stringContaining(group.name), []);
    }
    await services.answers.submit(incident.id, actor, 'Фонарь отремонтирован', []);
    await services.review.approve(incident.id, actor);
    await services.messages.flush();
    for (const mid of [incident.distributionMessageId, copy.firstMessageId]) {
      const last = max.editMessage.mock.calls.filter((call: any[]) => call[0] === mid).at(-1);
      expect(last[1]).toContain('ОТРАБОТАНО'); expect(last[2]).toEqual([]);
    }
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ASSIGNED' } })).toBe(1);
  });

  it('retires released and expired copies without disabling the original or the new operator copy', async () => {
    const incident = await create();
    await claim();
    const old = (await copies(incident.id))[0]!;
    await services.distributionQueue.release(actor, TEST_CHATS.distribution, incident.id);
    expect(max.editMessage).toHaveBeenCalledWith(old.firstMessageId, expect.stringContaining('закрепление по этой карточке завершено'), []);
    advance(1);
    await claim(colleague);
    const current = (await copies(incident.id)).find(c => c.id !== old.id)!;
    expect(max.editMessage.mock.calls.some((call: any[]) => call[0] === current.firstMessageId)).toBe(false);
    advance(15);
    await services.distributionQueue.sweep(); await services.messages.flush();
    expect(max.editMessage).toHaveBeenCalledWith(current.firstMessageId, expect.stringContaining('/queue'), []);
    expect(max.editMessage.mock.calls.some((call: any[]) => call[0] === incident.distributionMessageId)).toBe(false);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).distributionClaimedBy).toBeNull();
  });

  it('retries failed edits after worker restart and renders the latest state without reassigning', async () => {
    const incident = await create(); await claim();
    const copy = (await copies(incident.id))[0]!;
    max.editMessage.mockImplementation(async (mid: string) => { if (mid === copy.firstMessageId) throw new Error('MAX unavailable'); });
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, actor);
    expect(await prisma.outboundMessage.count({ where: { incidentId: incident.id, status: 'PENDING', dedupeKey: { startsWith: 'distribution-refresh:' } } })).toBeGreaterThan(0);
    max.editMessage.mockResolvedValue(undefined);
    advance(10);
    const worker = new MaxMessageService(max, { prisma, storage: { remove: async () => undefined } as never });
    await worker.flush();
    expect(max.editMessage).toHaveBeenCalledWith(copy.firstMessageId, expect.stringContaining('🟡 РАСПРЕДЕЛЕНО'), []);
    expect(sends.filter(s => s.target === group.maxChatId)).toHaveLength(1);
    expect(await prisma.outboundMessage.count({ where: { incidentId: incident.id, status: 'PENDING' } })).toBe(0);
  });

  it('repairs a copy whose delayed send completes only after assignment', async () => {
    const incident = await create();
    const send = max.sendToChat.getMockImplementation();
    let delayed = true;
    max.sendToChat.mockImplementation(async (...args: any[]) => {
      if (args[1].includes('Закреплено на 15 минут') && delayed) { delayed = false; throw new Error('MAX unavailable'); }
      return send(...args);
    });
    await claim();
    expect((await copies(incident.id))[0]!.firstMessageId).toBeNull();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await services.distribution.assign(incident.id, group.id, actor);
    advance(10); await services.messages.flush();
    const copy = (await copies(incident.id))[0]!;
    expect(copy.firstMessageId).not.toBeNull();
    expect(max.editMessage).toHaveBeenCalledWith(copy.firstMessageId, expect.stringContaining('🟡 РАСПРЕДЕЛЕНО'), []);
  });

  it('rejects every copy and ignores a deleted copy while refreshing the others', async () => {
    const incident = await create(); await claim();
    const old = (await copies(incident.id))[0]!;
    advance(15); await claim(colleague);
    const current = (await copies(incident.id)).find(c => c.id !== old.id)!;
    max.editMessage.mockImplementation(async (mid: string) => {
      if (mid === old.firstMessageId) throw new MaxError(404, { code: 'message.not.found', message: 'Deleted' });
    });
    await services.distribution.reject(incident.id, 'Дублирующее обращение', colleague);
    expect(max.editMessage).toHaveBeenCalledWith(current.firstMessageId, expect.stringContaining('Дублирующее обращение'), []);
    expect(await prisma.outboundMessage.count({ where: { incidentId: incident.id, status: { in: ['PENDING', 'FAILED'] } } })).toBe(0);
  });

  it('rolls back assignment if its durable card refresh cannot be saved', async () => {
    const incident = await create(); await claim();
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    vi.spyOn(outbox, 'queueDistributionRefresh').mockRejectedValueOnce(new Error('cannot queue edit'));
    await expect(services.distribution.assign(incident.id, group.id, actor)).rejects.toThrow('cannot queue edit');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('DISTRIBUTION');
    expect(await prisma.incidentHistory.count({ where: { incidentId: incident.id, action: 'ASSIGNED' } })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sector-card:${incident.id}` } })).toBe(0);
  });

  it('gives oldest distinct incidents to concurrent operators and reuses the same operator claim', async () => {
    const newest = await create(1);
    const older = await create(30);
    const oldest = await create(60);
    const claimed = await Promise.all([claim(), claim(colleague)]);
    expect(new Set(claimed.map(i => i!.id))).toEqual(new Set([older.id, oldest.id]));
    expect((await claim())!.id).toBe(claimed[0]!.id);
    expect(sends.filter(s => s.text.includes('Закреплено на 15 минут'))).toHaveLength(2);
    expect(sends.filter(s => s.text.includes('Закреплено на 15 минут')).every(s => s.extra.link.type === 'reply')).toBe(true);
    expect((await queueSnapshot(prisma, new Date())).reserved).toBe(2);
    await expect(services.distributionQueue.claim(actor, TEST_CHATS.distribution, newest.id)).rejects.toThrow('Сначала распределите');
  });

  it('returns an abandoned claim after 15 minutes and blocks stale assignment, rejection and release', async () => {
    const incident = await create(20);
    await claim();
    advance(14);
    expect(await claim(colleague)).toBeNull();
    advance(1);
    expect((await claim(colleague))!.id).toBe(incident.id);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: GROUP_CODES.facility } });
    await expect(services.distribution.assign(incident.id, group.id, actor)).rejects.toThrow('Диспетчер 2');
    await expect(services.distribution.reject(incident.id, 'Отклонить', actor)).rejects.toThrow('Диспетчер 2');
    await expect(services.distributionQueue.release(actor, TEST_CHATS.distribution, incident.id)).rejects.toThrow('другим оператором');
    await services.distribution.assign(incident.id, group.id, colleague);
    const done = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
    expect(done.distributionClaimedBy).toBeNull();
    expect(done.deadlineAt).toEqual(incident.deadlineAt);
    expect((await queueSnapshot(prisma, new Date())).total).toBe(0);
  });

  it('rolls back the claim and history if queueing its card fails, and enforces role/chat', async () => {
    const incident = await create();
    vi.spyOn(outbox, 'queueMessage').mockRejectedValueOnce(new Error('queue failed'));
    await expect(claim()).rejects.toThrow('queue failed');
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).distributionClaimedBy).toBeNull();
    expect(await prisma.incidentHistory.count({ where: { action: 'DISTRIBUTION_CLAIMED' } })).toBe(0);
    await expect(services.distributionQueue.claim(actor, TEST_CHATS.sector)).rejects.toThrow('чате');
    const resident = await actorFor(prisma, TEST_USERS.requesterA, 'Житель', []);
    await expect(handleQueueCallback(services, resident, TEST_CHATS.distribution, { kind: 'queue', action: 'next' })).rejects.toThrow('прав');
    await claim();
    await handleQueueCallback(services, actor, TEST_CHATS.distribution, { kind: 'queue', action: 'release', argument: incident.id });
    expect((await claim(colleague))!.id).toBe(incident.id);
  });

  it('keeps one panel across concurrent refreshes and restarts, and shows a live ordered list', async () => {
    const old = await create(90);
    await create(1);
    await Promise.all([services.distributionQueue.refresh(), services.distributionQueue.refresh()]);
    await services.messages.flush();
    const setting = await prisma.systemSetting.findUniqueOrThrow({ where: { key: panelSettingKey(TEST_CHATS.distribution) } });
    expect(sends.filter(s => s.text.includes('ОЧЕРЕДЬ РАСПРЕДЕЛЕНИЯ'))).toHaveLength(1);
    expect(max.api.pinMessage).toHaveBeenCalledWith(Number(TEST_CHATS.distribution), setting.value, { notify: false });
    await new DistributionQueueService(prisma, services.messages).refresh();
    await services.messages.flush();
    expect(sends.filter(s => s.text.includes('ОЧЕРЕДЬ РАСПРЕДЕЛЕНИЯ'))).toHaveLength(1);
    expect(max.editMessage).toHaveBeenCalledWith(setting.value, expect.stringContaining('Ожидают распределения: 2'), expect.any(Array));
    await services.distributionQueue.list(actor, TEST_CHATS.distribution, 0);
    const list = sends.at(-1)!;
    expect(list.text).toContain(old.publicCode);
    expect(list.extra.attachments[0].payload.buttons[0][0].payload).toBe(`queue:open:${old.id}`);
  });

  it('coalesces overdue summaries, escalates at two hours and suppresses night-time retries', async () => {
    await create(121);
    await Promise.all([services.distributionQueue.sweep(), services.distributionQueue.sweep()]);
    await services.messages.flush();
    expect(sends.filter(s => s.text.includes('требует внимания'))).toHaveLength(1);
    expect(sends.filter(s => s.text.includes('Нужна помощь'))).toHaveLength(1);
    await new DistributionQueueService(prisma, services.messages).sweep();
    await services.messages.flush();
    expect(sends.filter(s => s.text.includes('требует внимания'))).toHaveLength(1);
    // Queue before closing time, deliver after 22:00 Moscow: nothing new is sent.
    const evening = new Date(); evening.setUTCHours(18, 59, 0, 0); vi.setSystemTime(evening);
    await services.distributionQueue.sweep();
    advance(1);
    const count = sends.length;
    await services.messages.flush();
    await services.distributionQueue.sweep();
    expect(sends.length).toBe(count);
  });

  it('does not deliver stale alerts after the queue is handled, and repairs only missing card jobs', async () => {
    const incident = await create(125);
    await services.distributionQueue.sweep();
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'REJECTED' } });
    await services.messages.flush();
    expect(sends.some(s => s.text.includes('требует внимания') || s.text.includes('Нужна помощь'))).toBe(false);
    const missing = await create();
    await prisma.incident.update({ where: { id: missing.id }, data: { distributionMessageId: null } });
    await services.distributionQueue.sweep();
    await services.distributionQueue.sweep();
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `distribution-card:${missing.id}` } })).toBe(1);
    await services.messages.flush();
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: missing.id } })).distributionMessageId).not.toBeNull();
  });

  it('alerts on a fresh overloaded queue and paginates every incident without dropping the tail', async () => {
    const first = await create();
    await prisma.incident.createMany({ data: Array.from({ length: 29 }, (_, index) => ({
      ...first, id: randomUUID(), publicCode: `INC-OVERLOAD-${index.toString().padStart(4, '0')}`,
    })) });
    await services.distributionQueue.sweep();
    await services.messages.flush();
    expect(sends.some(s => s.text.includes('достигла порога 30'))).toBe(true);
    const ids: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      await services.distributionQueue.list(actor, TEST_CHATS.distribution, page);
      ids.push(...sends.at(-1)!.extra.attachments[0].payload.buttons.flat()
        .filter((b: any) => b.payload.startsWith('queue:open:')).map((b: any) => b.payload));
    }
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });
});
