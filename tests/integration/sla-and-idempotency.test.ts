import { IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

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

  beforeEach(async () => {
    await resetDatabase(prisma);
    await seedCategories(prisma);
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

  it('warns exactly at elapsed 24h and 48h, replies to the sector card and expires at 72h', async () => {
    const incident = await routedIncident('Проверка SLA');
    const deadline = incident.deadlineAt;

    const at24h = new Date(incident.createdAt.getTime() + 24 * 3_600_000);
    expect((await harness.services.sla.sweep(new Date(at24h.getTime() - 1))).warned24).toBe(0);
    let result = await harness.services.sla.sweep(at24h);
    expect(result.warned24).toBe(1);
    expect((await harness.services.sla.sweep(at24h)).warned24).toBe(0);

    const at48h = new Date(incident.createdAt.getTime() + 48 * 3_600_000);
    expect((await harness.services.sla.sweep(new Date(at48h.getTime() - 1))).warned48).toBe(0);
    result = await harness.services.sla.sweep(at48h);
    expect(result.warned48).toBe(1);
    expect((await harness.services.sla.sweep(at48h)).warned48).toBe(0);

    const afterDeadline = new Date(deadline.getTime());
    result = await harness.services.sla.sweep(afterDeadline);
    expect(result.overdue).toBe(1);
    expect((await harness.services.sla.sweep(afterDeadline)).overdue).toBe(0);

    const fresh = await harness.services.repository.findById(incident.id);
    expect(fresh!.isOverdue).toBe(true);
    // §14: an overdue incident keeps its workflow status and stays open.
    expect(fresh!.status).toBe(IncidentStatus.ASSIGNED);

    const reminders = harness.messages.toChat(TEST_CHATS.sector).filter(entry => entry.message.operation?.type === 'sla-reminder');
    expect(reminders).toHaveLength(3);
    for (const entry of reminders) {
      expect(entry.message.replyToMessageId).toBe(fresh!.sectorMessageId);
      expect(entry.message.text).toContain('Хозяйственная группа');
    }
    expect((await harness.services.sla.sweep(new Date(deadline.getTime() + 86_400_000))).overdue).toBe(0);

    const events = await prisma.incidentHistory.findMany({ where: { incidentId: incident.id } });
    const actions = events.map((event) => event.action);
    expect(actions).toContain(HistoryAction.SLA_REMINDER_24H);
    expect(actions).toContain(HistoryAction.SLA_REMINDER_48H);
    expect(actions).toContain(HistoryAction.SLA_OVERDUE);

    expect(harness.messages.toChat(TEST_CHATS.sector).some((entry) => entry.message.text.includes('ПРОСРОЧЕНО'))).toBe(
      true,
    );
  });

  it('sends only the latest due stage after downtime and survives concurrent sweeps', async () => {
    const incident = await routedIncident('Пропущены первые сутки');
    const now = new Date(incident.createdAt.getTime() + 50 * 3_600_000);
    const results = await Promise.all([harness.services.sla.sweep(now), harness.services.sla.sweep(now)]);
    expect(results.reduce((sum, item) => sum + item.warned48, 0)).toBe(1);
    expect(results.every(item => item.warned24 === 0)).toBe(true);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `sla:${incident.id}:24` } })).toBe(1);
  });

  it('preserves the legacy two-day mark without sending a duplicate', async () => {
    const incident = await routedIncident('Существующее напоминание');
    await prisma.incident.update({ where: { id: incident.id }, data: { slaWarn24SentAt: new Date() } });
    expect((await harness.services.sla.sweep(new Date(incident.createdAt.getTime() + 49 * 3_600_000))).warned48).toBe(0);
  });

  it('replies to the distribution card while no group is assigned', async () => {
    const incident = await harness.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+7 900 111-22-33' }, text: 'Нужно распределить' });
    await harness.services.distribution.publishCard(incident.id);
    await harness.services.sla.sweep(new Date(incident.createdAt.getTime() + 24 * 3_600_000));
    const fresh = await harness.services.repository.findById(incident.id);
    const reminder = harness.messages.toChat(TEST_CHATS.distribution).find(entry => entry.message.operation?.type === 'sla-reminder');
    expect(reminder?.message.replyToMessageId).toBe(fresh!.distributionMessageId);
    expect(reminder?.message.text).toContain('требуется распределение');
  });

  for (const status of ['WAITING_REVIEW', 'REVISION_REQUIRED', 'REJECTED'] as const) it(`handles status ${status}`, async () => {
    const incident = await routedIncident('Проверка статуса');
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Анна Ответственная', [UserRole.RESPONDER]);
    await prisma.incident.update({ where: { id: incident.id }, data: { status, currentResponderId: responder.userId } });
    const result = await harness.services.sla.sweep(new Date(incident.createdAt.getTime() + 24 * 3_600_000));
    expect(result.warned24).toBe(status === 'REJECTED' ? 0 : 1);
    if (status !== 'REJECTED') expect(harness.messages.sent.at(-1)?.message.text).toContain('Анна Ответственная');
  });

  for (const outcome of ['retry', 'closed', 'superseded', 'missing-card'] as const) it(`durable reminder: ${outcome}`, async () => {
    const original = await routedIncident('Доставка напоминания');
    const incident = await prisma.incident.update({ where: { id: original.id }, data: {
      createdAt: new Date(Date.now() - 25 * 3_600_000), deadlineAt: new Date(Date.now() + 47 * 3_600_000),
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
    if (outcome === 'superseded') await prisma.incident.update({ where: { id: incident.id }, data: { createdAt: new Date(Date.now() - 49 * 3_600_000) } });
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
    for (const code of codes) expect(code).toMatch(/^INC-\d{8}-\d{4}$/);
  });
});
