import { incidentWorkday, workingHours } from '../../src/utils/work-calendar';
import { computeDeadline } from '../../src/utils/datetime';
import { IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { MaxMessageService } from '../../src/max/max-message.service';
import { HistoryAction } from '../../src/incidents/incident-history.service';
import type { Update } from '../../src/max/max-types';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import {
  actorFor,
  CATEGORY_CODES,
  createHarness,
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
  seedCategories,
  type TestHarness,
} from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('SLA and webhook idempotency (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let harness: TestHarness;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
    const friday = new Date(Date.now() + 7 * 86_400_000);
    while (friday.getUTCDay() !== 5) friday.setUTCDate(friday.getUTCDate() + 1);
    friday.setUTCHours(10, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(friday);
    harness = await createHarness(prisma);
  });

  async function routedIncident(text: string) {
    const incident = await harness.services.incidents.create({
      requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+7 900 111-22-33' },
      text,
    });
    const category = (await harness.services.responsibleGroups.findByCode(CATEGORY_CODES.facility))!;
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    return incident;
  }

  it('reminds once after a day, defers weekends, and silently tracks the internal deadline', async () => {
    const incident = await routedIncident('Проверка SLA');
    const deadline = incident.deadlineAt;

    const at24h = incidentWorkday(incident.createdAt, 2).start;
    expect((await harness.services.sla.sweep(new Date(at24h.getTime() - 1))).warned24).toBe(0);
    let result = await harness.services.sla.sweep(at24h);
    expect(result.warned24).toBe(1);
    expect((await harness.services.sla.sweep(at24h)).warned24).toBe(0);

    const at48h = incidentWorkday(incident.createdAt, 3).start;
    expect((await harness.services.sla.sweep(new Date(at48h.getTime() - 1))).warned48).toBe(0);
    result = await harness.services.sla.sweep(at48h);
    expect(result.warned48).toBe(0);
    expect((await harness.services.sla.sweep(at48h)).warned48).toBe(0);

    const afterDeadline = new Date(deadline.getTime());
    result = await harness.services.sla.sweep(afterDeadline);
    expect(result.overdue).toBe(0); // Closing time is already outside the notification window.
    expect((await harness.services.repository.findById(incident.id))!.isOverdue).toBe(true);
    result = await harness.services.sla.sweep(incidentWorkday(afterDeadline, 1).start);
    expect(result.overdue).toBe(0);
    expect((await harness.services.sla.sweep(afterDeadline)).overdue).toBe(0);

    const fresh = await harness.services.repository.findById(incident.id);
    expect(fresh!.isOverdue).toBe(true);
    // §14: an overdue incident keeps its workflow status and stays open.
    expect(fresh!.status).toBe(IncidentStatus.ASSIGNED);

    const reminders = harness.messages.toChat(TEST_CHATS.sector).filter(entry => entry.message.operation?.type === 'sla-reminder');
    expect(reminders).toHaveLength(1);
    for (const entry of reminders) {
      expect(entry.message.replyToMessageId).toBe(fresh!.sectorMessageId);
      expect(entry.message.text).toContain('Хозяйственная группа');
      expect(entry.message.text).not.toMatch(/Срок|ПРОСРОЧЕНО|рабочий день/);
    }
    expect((await harness.services.sla.sweep(new Date(deadline.getTime() + 86_400_000))).overdue).toBe(0);

    const events = await prisma.incidentHistory.findMany({ where: { incidentId: incident.id } });
    const actions = events.map((event) => event.action);
    expect(actions).toContain(HistoryAction.SLA_REMINDER_24H);
    expect(actions).not.toContain(HistoryAction.SLA_REMINDER_48H);
    expect(actions).not.toContain(HistoryAction.SLA_OVERDUE);

    expect(harness.messages.toChat(TEST_CHATS.sector).some((entry) => entry.message.text.includes('ПРОСРОЧЕНО'))).toBe(
      false,
    );
  });

  it('sends one reminder after downtime and survives concurrent sweeps', async () => {
    const incident = await routedIncident('Пропущены первые сутки');
    const now = new Date(incidentWorkday(incident.createdAt, 3).start.getTime() + 3_600_000);
    const results = await Promise.all([harness.services.sla.sweep(now), harness.services.sla.sweep(now)]);
    expect(results.reduce((sum, item) => sum + item.warned24, 0)).toBe(1);
    expect(results.every(item => item.warned48 === 0)).toBe(true);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sla:${incident.id}:elapsed24` } })).toBe(1);
  });

  it('preserves the legacy two-day mark without sending a duplicate', async () => {
    const incident = await routedIncident('Существующее напоминание');
    await prisma.incident.update({ where: { id: incident.id }, data: { slaWarn24SentAt: new Date() } });
    expect((await harness.services.sla.sweep(incidentWorkday(incident.createdAt, 3).start)).warned48).toBe(0);
  });

  it('replies to the distribution card while no group is assigned', async () => {
    const incident = await harness.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+7 900 111-22-33' }, text: 'Нужно распределить' });
    await harness.services.distribution.publishCard(incident.id);
    await harness.services.sla.sweep(incidentWorkday(incident.createdAt, 2).start);
    const fresh = await harness.services.repository.findById(incident.id);
    const reminder = harness.messages.toChat(TEST_CHATS.distribution).find(entry => entry.message.operation?.type === 'sla-reminder');
    expect(reminder?.message.replyToMessageId).toBe(fresh!.distributionMessageId);
    expect(reminder?.message.text).toContain('требуется распределение');
  });

  for (const status of ['WAITING_REVIEW', 'REVISION_REQUIRED', 'REJECTED'] as const) it(`handles status ${status}`, async () => {
    const incident = await routedIncident('Проверка статуса');
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Анна Ответственная', [UserRole.RESPONDER]);
    await prisma.incident.update({ where: { id: incident.id }, data: { status, currentResponderId: responder.userId } });
    const result = await harness.services.sla.sweep(incidentWorkday(incident.createdAt, 2).start);
    expect(result.warned24).toBe(status === 'REJECTED' ? 0 : 1);
    if (status !== 'REJECTED') expect(harness.messages.sent.at(-1)?.message.text).toContain('Анна Ответственная');
  });

  for (const outcome of ['retry', 'closed', 'superseded', 'missing-card'] as const) it(`durable reminder: ${outcome}`, async () => {
    const original = await routedIncident('Доставка напоминания');
    const incident = await prisma.incident.update({ where: { id: original.id }, data: {
      createdAt: new Date(Date.now() - 24 * 3_600_000), deadlineAt: computeDeadline(new Date(Date.now() - 24 * 3_600_000), 3),
    } });
    await harness.services.sla.sweep();
    const key = `sla:${incident.id}:elapsed24`;
    // Deliver just the reminder: workflow cards have already been simulated by the harness.
    await prisma.outboundMessage.updateMany({ where: { dedupeKey: { not: key } }, data: { status: 'SENT' } });
    const max = { sendToChat: vi.fn().mockRejectedValueOnce(new Error('MAX unavailable')).mockResolvedValue({ body: { mid: 'reminder-delivered' } }) };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: key } })).status).toBe('PENDING');
    if (outcome === 'closed') await prisma.incident.update({ where: { id: incident.id }, data: { status: 'RESOLVED' } });
    if (outcome === 'superseded') await prisma.incident.update({ where: { id: incident.id }, data: { slaWarn24SentAt: new Date() } });
    if (outcome === 'missing-card') await prisma.incident.update({ where: { id: incident.id }, data: { sectorMessageId: null } });
    await prisma.outboundMessage.update({ where: { dedupeKey: key }, data: { nextAttemptAt: new Date(0) } });
    const resumed = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await resumed.flush();
    expect(max.sendToChat).toHaveBeenCalledTimes(outcome === 'retry' ? 2 : 1);
    if (outcome === 'missing-card') {
      expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: key } })).status).toBe('PENDING');
      await prisma.incident.update({ where: { id: incident.id }, data: { sectorMessageId: 'restored-card' } });
      await prisma.outboundMessage.update({ where: { dedupeKey: key }, data: { nextAttemptAt: new Date(0) } });
      await resumed.flush();
      expect(max.sendToChat.mock.calls.at(-1)?.[2]).toEqual({ link: { type: 'reply', mid: 'restored-card' } });
    } else if (outcome === 'retry') {
      expect(max.sendToChat.mock.calls.at(-1)?.[2]).toEqual({ link: { type: 'reply', mid: (await harness.services.repository.findById(incident.id))!.sectorMessageId } });
    }
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: key } })).status).toBe('SENT');
  });

  it('waits for 24 elapsed hours even when the next working morning has started', async () => {
    const original = await routedIncident('Позднее обращение');
    const previous = new Date(Date.now() - 86_400_000); previous.setUTCHours(13, 59, 0, 0);
    await prisma.incident.update({ where: { id: original.id }, data: { createdAt: previous, deadlineAt: computeDeadline(previous, 3) } });
    const now = new Date(); now.setUTCHours(5, 0, 0, 0);
    expect(now.getTime() - previous.getTime()).toBeLessThan(86_400_000);
    expect((await harness.services.sla.sweep(now)).warned24).toBe(0);
    expect((await harness.services.sla.sweep(new Date(previous.getTime() + 86_400_000 - 1))).warned24).toBe(0);
    expect((await harness.services.sla.sweep(new Date(previous.getTime() + 86_400_000))).warned24).toBe(1);
  });

  it('keeps weekends quiet and still marks expired incidents overdue', async () => {
    const incident = await routedIncident('Проверка выходных');
    const closing = new Date(); closing.setUTCHours(14, 0, 0, 0);
    await prisma.incident.update({ where: { id: incident.id }, data: { deadlineAt: closing } });
    for (const days of [1, 2]) {
      const result = await harness.services.sla.sweep(new Date(Date.now() + days * 86_400_000));
      expect(result.overdue + result.warned24 + result.warned48).toBe(0);
    }
    expect((await harness.services.repository.findById(incident.id))!.isOverdue).toBe(true);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: { startsWith: `sla:${incident.id}:` } } })).toBe(0);
  });

  it('re-arms an unsent reminder after closing without blocking other messages', async () => {
    const original = await routedIncident('Очередь после закрытия');
    const createdAt = new Date(Date.now() - 86_400_000);
    const incident = await prisma.incident.update({ where: { id: original.id }, data: { createdAt, deadlineAt: computeDeadline(createdAt, 3) } });
    await harness.services.sla.sweep();
    const key = `sla:${incident.id}:elapsed24`;
    await prisma.outboundMessage.updateMany({ where: { dedupeKey: { not: key } }, data: { status: 'SENT' } });
    await prisma.outboundMessage.create({ data: { targetType: 'chat', targetId: TEST_CHATS.sector, payload: { text: 'Обычная карточка' }, attachments: [], dedupeKey: 'after-quiet-reminder' } });
    const closing = new Date(); closing.setUTCHours(14, 0, 0, 0); vi.setSystemTime(closing);
    const max = { sendToChat: vi.fn().mockResolvedValue({ body: { mid: 'sent' } }) };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush(); await worker.flush();
    expect(await prisma.outboundMessage.findUnique({ where: { dedupeKey: key } })).toBeNull();
    const field = 'slaReminder24SentAt';
    expect((await harness.services.repository.findById(incident.id))![field]).toBeNull();
    expect(max.sendToChat).toHaveBeenCalledTimes(1);
    expect(max.sendToChat.mock.calls[0]![1]).toBe('Обычная карточка');
    vi.setSystemTime(incidentWorkday(closing, 1).start); // Monday 08:00.
    expect(workingHours(new Date())).toBe(true);
    await harness.services.sla.sweep(); await worker.flush();
    expect(max.sendToChat).toHaveBeenCalledTimes(2);
    expect(max.sendToChat.mock.calls[1]![1]).toContain('Напоминание об обращении');
  });


  for (const stage of [48, 'overdue'] as const) it(`discards legacy queued ${stage} notifications without re-arming them`, async () => {
    const original = await routedIncident('Старое уведомление');
    const field = stage === 48 ? 'slaWarn24SentAt' : 'overdueNotifiedAt';
    await prisma.incident.update({ where: { id: original.id }, data: { [field]: new Date(), createdAt: new Date(Date.now() - 4 * 86_400_000) } });
    await prisma.outboundMessage.updateMany({ data: { status: 'SENT' } });
    const key = `sla:${original.id}:legacy`;
    await prisma.outboundMessage.create({ data: { targetType: 'chat', targetId: TEST_CHATS.sector, incidentId: original.id,
      payload: { text: 'Старая ступень', operation: { type: 'sla-reminder', incidentId: original.id, stage } }, attachments: [], dedupeKey: key } });
    const closing = new Date(); closing.setUTCHours(14, 0, 0, 0); vi.setSystemTime(closing);
    const max = { sendToChat: vi.fn() };
    const worker = new MaxMessageService(max as never, { prisma, storage: {} as never });
    await worker.flush();
    expect(max.sendToChat).not.toHaveBeenCalled();
    expect((await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: key } })).status).toBe('SENT');
    expect((await harness.services.repository.findById(original.id))![field]).not.toBeNull();
    vi.setSystemTime(incidentWorkday(closing, 1).start);
    expect((await harness.services.sla.sweep()).warned24).toBe(0);
  });

  it('ignores resolved incidents', async () => {
    const incident = await routedIncident('Уже закрыто');
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Ответственный', [UserRole.RESPONDER]);
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.answers.submit(incident.id, responder, 'Готово');
    await harness.services.review.approve(incident.id, approver);

    const result = await harness.services.sla.sweep(new Date(incident.deadlineAt.getTime() + 3_600_000));
    expect(result.overdue).toBe(0);
  });

  it('purges expired operator sessions', async () => {
    const incident = await routedIncident('Сессия');
    await harness.services.sessions.start({
      maxUserId: TEST_USERS.responder,
      chatId: TEST_CHATS.sector,
      type: 'WAITING_FOR_ANSWER',
      incidentId: incident.id,
    });
    await prisma.operatorSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1_000) } });

    const result = await harness.services.sla.sweep();
    expect(result.sessionsPurged).toBe(1);
    expect(await harness.services.sessions.find(TEST_USERS.responder, TEST_CHATS.sector)).toBeNull();
  });

  // --- §48-§49 webhook idempotency ----------------------------------------

  it('processes a redelivered update only once', async () => {
    const dispatcher = new UpdateDispatcher(prisma, harness.services.max);
    const update = {
      update_type: 'message_created',
      timestamp: 1_700_000_000,
      message: {
        sender: { user_id: 5001, name: 'Иван', username: null, is_bot: false, last_activity_time: 0 },
        recipient: { chat_id: 5001, chat_type: 'dialog' },
        timestamp: 1_700_000_000,
        body: { mid: 'mid-duplicate', seq: 1, text: 'привет', attachments: null },
      },
    } as unknown as Update;

    expect((await dispatcher.reserve(update)).fresh).toBe(true);
    expect((await dispatcher.reserve(update)).fresh).toBe(false);
    expect(await prisma.inboundUpdate.count()).toBe(1);
  });

  it('does not create a second incident when the same message arrives twice', async () => {
    const requester = { maxUserId: TEST_USERS.requesterB, name: 'Пётр Петров', phone: '+7 900 444-55-66' } as const;
    await harness.services.incidents.create({ requester, text: 'Единственное обращение' });
    expect(await prisma.incident.count()).toBe(1);

    // Simulate the guard the webhook applies before any handler runs.
    const dispatcher = new UpdateDispatcher(prisma, harness.services.max);
    const update = {
      update_type: 'message_created',
      timestamp: 1,
      message: {
        sender: { user_id: 5002, name: 'Пётр', username: null, is_bot: false, last_activity_time: 0 },
        recipient: { chat_id: 5002, chat_type: 'dialog' },
        timestamp: 1,
        body: { mid: 'mid-once', seq: 1, text: 'Единственное обращение', attachments: null },
      },
    } as unknown as Update;

    expect((await dispatcher.reserve(update)).fresh).toBe(true);
    expect((await dispatcher.reserve(update)).fresh).toBe(false);
    expect(await prisma.incident.count()).toBe(1);
  });

  it('generates unique sequential public codes under load', async () => {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        harness.services.incidents.create({
          requester: { maxUserId: BigInt(6000 + index), name: 'Тестовый Пользователь', phone: `+7 901 000-00-0${index}` },
          text: `Обращение ${index}`,
        }),
      ),
    );
    const codes = created.map((incident) => incident.publicCode);
    expect(new Set(codes).size).toBe(5);
    expect(codes.sort()).toEqual(['INC-000001', 'INC-000002', 'INC-000003', 'INC-000004', 'INC-000005']);
  });
});
