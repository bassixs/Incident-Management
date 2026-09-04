import { AnswerStatus, IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { HistoryAction } from '../../src/incidents/incident-history.service';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { ConflictError, RateLimitError } from '../../src/utils/errors';
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

describeIntegration('incident lifecycle (PostgreSQL)', () => {
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

  const requesterA = () => ({ maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов' });
  const requesterB = () => ({ maxUserId: TEST_USERS.requesterB, name: 'Пётр Петров' });

  async function facility() {
    return (await harness.services.responsibleGroups.findByCode(CATEGORY_CODES.facility))!;
  }

  // --- §11 daily limit -----------------------------------------------------

  it('allows two incidents a day and refuses the third', async () => {
    const first = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Первое обращение',
    });
    const second = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Второе обращение',
    });

    expect(first.publicCode).toMatch(/^INC-\d{8}-0001$/);
    expect(second.publicCode).toMatch(/^INC-\d{8}-0002$/);

    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'Третье обращение' }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(await prisma.incident.count()).toBe(2);
  });

  it('does not consume the quota on a format error', async () => {
    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'я'.repeat(151) }),
    ).rejects.toThrow();
    await expect(
      harness.services.incidents.create({
        requester: requesterA(),
        text: 'Есть видео',
        media: [{ kind: 'VIDEO', url: 'https://example.test/v.mp4' }],
      }),
    ).rejects.toThrow();

    expect(await prisma.incident.count()).toBe(0);
    expect(await harness.services.incidents.remainingDailyQuota(TEST_USERS.requesterA)).toBe(2);
  });

  it('holds the limit under concurrent submissions', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        harness.services.incidents.create({ requester: requesterA(), text: `Параллельное ${index}` }),
      ),
    );

    const created = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(created).toHaveLength(2);
    expect(await prisma.incident.count()).toBe(2);

    const codes = await prisma.incident.findMany({ select: { publicCode: true } });
    expect(new Set(codes.map((row) => row.publicCode)).size).toBe(2);
  });

  it('does not let one user consume another user quota', async () => {
    await harness.services.incidents.create({ requester: requesterA(), text: 'A1' });
    await harness.services.incidents.create({ requester: requesterA(), text: 'A2' });
    const forB = await harness.services.incidents.create({ requester: requesterB(), text: 'B1' });
    expect(forB.requesterMaxUserId).toBe(TEST_USERS.requesterB);
  });

  it('refuses a banned user', async () => {
    await harness.services.bans.ban({ maxUserId: TEST_USERS.requesterA, reason: 'флуд' });
    await expect(
      harness.services.incidents.create({ requester: requesterA(), text: 'Попытка' }),
    ).rejects.toThrow('временно недоступна');
    expect(await prisma.incident.count()).toBe(0);
  });

  // --- §13 SLA -------------------------------------------------------------

  it('sets the deadline to createdAt + 72h', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проверка срока',
    });
    expect(incident.deadlineAt.getTime() - incident.createdAt.getTime()).toBe(72 * 3_600_000);
  });

  it('stores the selected municipality and locality independently from the topic', async () => {
    const category = (await harness.services.categories.findByCode(CATEGORY_CODES.facility))!;
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проблема в Балабаново',
      userSelectedCategoryId: category.id,
      problemMunicipalityCode: 'BOROVSKY',
      problemMunicipalityName: 'Боровский округ',
      problemLocality: 'Балабаново',
    });

    expect(incident.userSelectedCategoryId).toBe(category.id);
    expect(incident.problemMunicipalityCode).toBe('BOROVSKY');
    expect(incident.problemMunicipalityName).toBe('Боровский округ');
    expect(incident.problemLocality).toBe('Балабаново');
  });

  // --- §17-§18 distribution ------------------------------------------------

  it('routes an incident to a sector and records who did it', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Не работает освещение возле входа.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    const category = await facility();

    const updated = await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    expect(updated.status).toBe(IncidentStatus.ASSIGNED);
    expect(updated.assignedGroupId).toBe(category.id);
    expect(updated.assignedByUserId).toBe(dispatcher.userId);
    expect(harness.messages.toChat(TEST_CHATS.sector).length).toBeGreaterThan(0);
  });

  it('closes the assignment picker after a group is selected', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Меню не должно остаться активным.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    const category = await facility();

    await handleIncidentCallback(
      {
        services: harness.services,
        actor: dispatcher,
        chatId: TEST_CHATS.distribution,
        messageId: 'assignment-picker-mid',
      },
      { kind: 'incident', action: 'assign-group', incidentId: incident.id, argument: category.id },
    );

    expect(harness.messages.edits).toContainEqual({
      messageId: 'assignment-picker-mid',
      text: expect.stringContaining('🟡 РАСПРЕДЕЛЕНО'),
      mode: 'finalize',
    });
  });

  it('reuses the same picker message when a distribution branch is opened', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Проверка перехода в список групп.',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    await handleIncidentCallback(
      {
        services: harness.services,
        actor: dispatcher,
        chatId: TEST_CHATS.distribution,
        messageId: 'assignment-picker-mid',
      },
      { kind: 'incident', action: 'assign-branch', incidentId: incident.id, argument: 'local' },
    );

    expect(harness.messages.edits).toContainEqual({
      messageId: 'assignment-picker-mid',
      text: expect.stringContaining('🔴 НЕ РАСПРЕДЕЛЕНО'),
      mode: 'keyboard',
    });
  });

  it('lets only one of two simultaneous dispatchers win', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Гонка распределения',
    });
    const category = await facility();
    const first = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер 1', [UserRole.DISPATCHER]);
    const second = await actorFor(prisma, TEST_USERS.admin, 'Диспетчер 2', [UserRole.ADMIN]);

    const results = await Promise.allSettled([
      harness.services.distribution.assign(incident.id, category.id, first),
      harness.services.distribution.assign(incident.id, category.id, second),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    const assignedEvents = await prisma.incidentHistory.count({
      where: { incidentId: incident.id, action: HistoryAction.ASSIGNED },
    });
    expect(assignedEvents).toBe(1);
  });

  it('refuses a repeated distribution callback', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Повторное нажатие',
    });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    await expect(
      harness.services.distribution.assign(incident.id, category.id, dispatcher),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('rejects an incident with a reason and tells the author', async () => {
    const incident = await harness.services.incidents.create({
      requester: requesterA(),
      text: 'Не по теме',
    });
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);

    const rejected = await harness.services.distribution.reject(incident.id, 'Не относится к работе', dispatcher);

    expect(rejected.status).toBe(IncidentStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('Не относится к работе');
    const toRequester = harness.messages.toUser(TEST_USERS.requesterA);
    expect(toRequester.at(-1)!.message.text).toContain('отклонено');
    // §11: a rejected incident still counts against the daily limit.
    expect(await harness.services.incidents.remainingDailyQuota(TEST_USERS.requesterA)).toBe(1);
  });

  it('cannot reject an incident that was already routed', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Тест' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    await expect(
      harness.services.distribution.reject(incident.id, 'Передумал', dispatcher),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  // --- §22-§24 work and answers -------------------------------------------

  it('claims an incident for one responder only', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'В работу' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    const responder = await actorFor(prisma, TEST_USERS.responder, 'Пётр Петров', [UserRole.RESPONDER]);
    const taken = await harness.services.sector.takeInWork(incident.id, responder);
    expect(taken.status).toBe(IncidentStatus.IN_PROGRESS);
    expect(taken.currentResponderId).toBe(responder.userId);

    await expect(harness.services.sector.takeInWork(incident.id, responder)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('creates answer versions and refuses video attachments', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Ответ' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Ответственный', [UserRole.RESPONDER]);

    await expect(
      harness.services.answers.submit(incident.id, responder, 'С видео', [
        { kind: 'VIDEO', url: 'https://example.test/v.mp4' },
      ]),
    ).rejects.toThrow('Видео');

    const { answer } = await harness.services.answers.submit(incident.id, responder, 'Освещение восстановлено.');
    expect(answer.version).toBe(1);
    expect(answer.status).toBe(AnswerStatus.WAITING_REVIEW);

    const fresh = await harness.services.repository.findById(incident.id);
    expect(fresh!.status).toBe(IncidentStatus.WAITING_REVIEW);
    expect(harness.messages.toChat(TEST_CHATS.review).length).toBeGreaterThan(0);
    expect(harness.messages.edits.some((edit) =>
      edit.mode === 'finalize' && edit.text.startsWith('🟢 ОТРАБОТАНО'),
    )).toBe(true);
  });

  it('lets only one of two concurrent answer submissions through', async () => {
    const incident = await harness.services.incidents.create({ requester: requesterA(), text: 'Гонка ответов' });
    const category = await facility();
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);

    const one = await actorFor(prisma, TEST_USERS.responder, 'Ответственный 1', [UserRole.RESPONDER]);
    const two = await actorFor(prisma, TEST_USERS.admin, 'Ответственный 2', [UserRole.ADMIN]);

    const results = await Promise.allSettled([
      harness.services.answers.submit(incident.id, one, 'Вариант 1'),
      harness.services.answers.submit(incident.id, two, 'Вариант 2'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.incidentAnswer.count({ where: { incidentId: incident.id } })).toBe(1);
  });
});
