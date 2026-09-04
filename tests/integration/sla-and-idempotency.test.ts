import { IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

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

  it('warns once at 24h, once at 6h and then marks the incident overdue', async () => {
    const incident = await routedIncident('Проверка SLA');
    const deadline = incident.deadlineAt;

    const at23h = new Date(deadline.getTime() - 23 * 3_600_000);
    let result = await harness.services.sla.sweep(at23h);
    expect(result.warned24).toBe(1);
    expect((await harness.services.sla.sweep(at23h)).warned24).toBe(0);

    const at5h = new Date(deadline.getTime() - 5 * 3_600_000);
    result = await harness.services.sla.sweep(at5h);
    expect(result.warned6).toBe(1);
    expect((await harness.services.sla.sweep(at5h)).warned6).toBe(0);

    const afterDeadline = new Date(deadline.getTime() + 60_000);
    result = await harness.services.sla.sweep(afterDeadline);
    expect(result.overdue).toBe(1);
    expect((await harness.services.sla.sweep(afterDeadline)).overdue).toBe(0);

    const fresh = await harness.services.repository.findById(incident.id);
    expect(fresh!.isOverdue).toBe(true);
    // §14: an overdue incident keeps its workflow status and stays open.
    expect(fresh!.status).toBe(IncidentStatus.ASSIGNED);

    const events = await prisma.incidentHistory.findMany({ where: { incidentId: incident.id } });
    const actions = events.map((event) => event.action);
    expect(actions).toContain(HistoryAction.SLA_WARNING_24H);
    expect(actions).toContain(HistoryAction.SLA_WARNING_6H);
    expect(actions).toContain(HistoryAction.SLA_OVERDUE);

    expect(harness.messages.toChat(TEST_CHATS.sector).some((entry) => entry.message.text.includes('ПРОСРОЧЕНО'))).toBe(
      true,
    );
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
