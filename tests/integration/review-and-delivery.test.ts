import { AnswerStatus, IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { HistoryAction } from '../../src/incidents/incident-history.service';
import { ConflictError, ValidationError } from '../../src/utils/errors';
import {
  actorFor,
  CATEGORY_CODES,
  GROUP_CODES,
  createHarness,
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
  seedCategories,
  type TestHarness,
} from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('review, revision and delivery (PostgreSQL)', () => {
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

  /** Register → distribute → answer, i.e. everything up to WAITING_REVIEW. */
  async function incidentAwaitingReview(requesterMaxUserId: bigint, text: string, answerText: string) {
    const incident = await harness.services.incidents.create({
      requester: { maxUserId: requesterMaxUserId, name: 'Иван Иванов', phone: '+7 900 111-22-33' },
      text,
    });
    const category = (await harness.services.responsibleGroups.findByCode(CATEGORY_CODES.facility))!;
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, category.id, dispatcher);
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Ответственный', [UserRole.RESPONDER]);
    const { answer } = await harness.services.answers.submit(incident.id, responder, answerText);
    return { incident, answer, responder, dispatcher };
  }

  it('lets a dispatcher answer for Kaluga Region without review', async () => {
    const incident = await harness.services.incidents.create({
      requester: { maxUserId: TEST_USERS.requesterA, name: 'Иван Иванов', phone: '+7 900 111-22-33' },
      text: 'Общий вопрос по области',
      problemMunicipalityCode: 'KALUGA_REGION',
      problemMunicipalityName: 'Калужская область (общий вопрос)',
    });
    const regional = (await harness.services.responsibleGroups.findByCode(GROUP_CODES.regional))!;
    const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Диспетчер', [UserRole.DISPATCHER]);
    await harness.services.distribution.assign(incident.id, regional.id, dispatcher);

    const result = await harness.services.answers.submit(
      incident.id,
      dispatcher,
      'Ответ подготовлен распределителями.',
    );

    expect(result.sentDirectly).toBe(true);
    expect(result.deliveryFailed).toBe(false);
    expect(result.answer.status).toBe(AnswerStatus.APPROVED);
    expect(result.incident.status).toBe(IncidentStatus.RESOLVED);
    expect(result.incident.approvedByUserId).toBeNull();
    expect(harness.messages.toChat(TEST_CHATS.review)).toHaveLength(0);
    expect(
      harness.messages
        .toUser(TEST_USERS.requesterA)
        .some((entry) => entry.message.text.includes('Ответ подготовлен распределителями.')),
    ).toBe(true);
    expect(
      await prisma.incidentHistory.count({
        where: { incidentId: incident.id, action: HistoryAction.ANSWER_SENT_DIRECT },
      }),
    ).toBe(1);
  });

  it('approves an answer and delivers it to the requester', async () => {
    const { incident } = await incidentAwaitingReview(
      TEST_USERS.requesterA,
      'Не работает освещение возле входа.',
      'Освещение восстановлено. Выполнена замена светильника.',
    );
    await harness.services.incidents.setDistributionMessageId(incident.id, 'distribution-mid');
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);

    const resolved = await harness.services.review.approve(incident.id, approver);

    expect(resolved.status).toBe(IncidentStatus.RESOLVED);
    expect(resolved.answeredAt).not.toBeNull();
    expect(resolved.approvedByUserId).toBe(approver.userId);

    const stored = await prisma.incidentAnswer.findFirst({ where: { incidentId: incident.id } });
    expect(stored!.status).toBe(AnswerStatus.APPROVED);
    expect(stored!.deliveredAt).not.toBeNull();

    const delivered = harness.messages.toUser(TEST_USERS.requesterA);
    expect(delivered.at(-1)!.message.text).toContain('Получен ответ по вашему обращению');
    expect(delivered.at(-1)!.message.text).toContain(incident.publicCode);
    expect(harness.messages.edits).toContainEqual({
      messageId: 'distribution-mid',
      text: expect.stringContaining('🟢 РАСПРЕДЕЛЕНО'),
      mode: 'finalize',
    });
  });

  it('stores only the requester first rating and includes it in the Excel report', async () => {
    const { incident } = await incidentAwaitingReview(TEST_USERS.requesterA, 'Текст обращения', 'Итоговый ответ');
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.review.approve(incident.id, approver);

    const rated = await harness.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5);
    expect(rated.responseRating).toBe(5);
    expect(rated.ratedAt).not.toBeNull();
    await expect(
      harness.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 2),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      harness.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterB, 4),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await prisma.incidentHistory.count({
        where: { incidentId: incident.id, action: HistoryAction.ANSWER_RATED },
      }),
    ).toBe(1);

    const report = await harness.services.reports.build({ title: 'за всё время', slug: 'all' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(report.buffer as never);
    const sheet = workbook.getWorksheet('Обращения')!;
    const headers = (sheet.getRow(1).values as unknown[]).map(String);
    const ratingColumn = headers.indexOf('Оценка ответа (1–5)');
    expect(ratingColumn).toBeGreaterThan(0);
    expect(sheet.getRow(2).getCell(ratingColumn).value).toBe(5);
  });

  it('accepts just one of simultaneous rating button presses', async () => {
    const { incident } = await incidentAwaitingReview(TEST_USERS.requesterA, 'Текст', 'Ответ');
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.review.approve(incident.id, approver);

    const results = await Promise.allSettled([
      harness.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 1),
      harness.services.incidents.rateAnswer(incident.id, TEST_USERS.requesterA, 5),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect([1, 5]).toContain((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).responseRating);
    expect(await prisma.outboundMessage.count({ where: { dedupeKey: `subscription-invite:${incident.id}` } })).toBe(1);
  });

  it('refuses a second approval', async () => {
    const { incident } = await incidentAwaitingReview(TEST_USERS.requesterA, 'Текст', 'Ответ');
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.review.approve(incident.id, approver);

    await expect(harness.services.review.approve(incident.id, approver)).rejects.toBeInstanceOf(ConflictError);
    expect(harness.messages.toUser(TEST_USERS.requesterA).filter((entry) =>
      entry.message.text.includes('Получен ответ'),
    )).toHaveLength(1);
  });

  it('lets only one of two simultaneous approvals through', async () => {
    const { incident } = await incidentAwaitingReview(TEST_USERS.requesterA, 'Текст', 'Ответ');
    const one = await actorFor(prisma, TEST_USERS.approver, 'Согласующий 1', [UserRole.APPROVER]);
    const two = await actorFor(prisma, TEST_USERS.admin, 'Согласующий 2', [UserRole.ADMIN]);

    const results = await Promise.allSettled([
      harness.services.review.approve(incident.id, one),
      harness.services.review.approve(incident.id, two),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.incidentHistory.count({
        where: { incidentId: incident.id, action: HistoryAction.ANSWER_SENT },
      }),
    ).toBe(1);
  });

  it('runs the full revision loop without moving the deadline', async () => {
    const { incident } = await incidentAwaitingReview(
      TEST_USERS.requesterA,
      'Не работает освещение возле входа.',
      'Починили.',
    );
    const originalDeadline = incident.deadlineAt.getTime();
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    const responder = await actorFor(prisma, TEST_USERS.responder, 'Ответственный', [UserRole.RESPONDER]);

    const returned = await harness.services.review.requestRevision(
      incident.id,
      'Необходимо уточнить срок устранения проблемы.',
      approver,
    );
    expect(returned.status).toBe(IncidentStatus.REVISION_REQUIRED);
    expect(returned.revisionCount).toBe(1);
    expect(returned.deadlineAt.getTime()).toBe(originalDeadline);
    expect(harness.messages.toChat(TEST_CHATS.sector).at(-1)!.message.text).toContain('Срок ответа НЕ изменён');

    const second = await harness.services.answers.submit(incident.id, responder, 'Починили, срок — до пятницы.');
    expect(second.answer.version).toBe(2);
    expect(second.incident.deadlineAt.getTime()).toBe(originalDeadline);

    const returnedAgain = await harness.services.review.requestRevision(incident.id, 'Ещё раз', approver);
    expect(returnedAgain.revisionCount).toBe(2);
    expect(returnedAgain.deadlineAt.getTime()).toBe(originalDeadline);

    const third = await harness.services.answers.submit(incident.id, responder, 'Финальный ответ.');
    expect(third.answer.version).toBe(3);

    const resolved = await harness.services.review.approve(incident.id, approver);
    expect(resolved.status).toBe(IncidentStatus.RESOLVED);
    expect(resolved.deadlineAt.getTime()).toBe(originalDeadline);

    // §67: no version of the answer is ever deleted.
    const versions = await prisma.incidentAnswer.findMany({
      where: { incidentId: incident.id },
      orderBy: { version: 'asc' },
    });
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(versions[0]!.text).toBe('Починили.');
  });

  /**
   * §61 / §68 scenario 7 — the acceptance test.
   * Two requesters, two incidents, two answers: each answer must reach exactly
   * its own author.
   */
  it('delivers each answer to its own requester and nobody else', async () => {
    const first = await incidentAwaitingReview(
      TEST_USERS.requesterA,
      'Не работает освещение возле входа.',
      'Освещение восстановлено. Выполнена замена светильника.',
    );
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.review.approve(first.incident.id, approver);

    const second = await incidentAwaitingReview(
      TEST_USERS.requesterB,
      'Не открывается дверь на складе.',
      'Замок отремонтирован, доступ восстановлен.',
    );
    await harness.services.review.approve(second.incident.id, approver);

    const toA = harness.messages
      .toUser(TEST_USERS.requesterA)
      .filter((entry) => entry.message.text.includes('Получен ответ'));
    const toB = harness.messages
      .toUser(TEST_USERS.requesterB)
      .filter((entry) => entry.message.text.includes('Получен ответ'));

    expect(toA).toHaveLength(1);
    expect(toB).toHaveLength(1);

    expect(toA[0]!.message.text).toContain(first.incident.publicCode);
    expect(toA[0]!.message.text).toContain('Освещение восстановлено');
    expect(toA[0]!.message.text).not.toContain(second.incident.publicCode);
    expect(toA[0]!.message.text).not.toContain('Замок отремонтирован');

    expect(toB[0]!.message.text).toContain(second.incident.publicCode);
    expect(toB[0]!.message.text).toContain('Замок отремонтирован');
    expect(toB[0]!.message.text).not.toContain(first.incident.publicCode);
    expect(toB[0]!.message.text).not.toContain('Освещение восстановлено');
  });

  it('can resend an approved answer that failed to deliver', async () => {
    const { incident } = await incidentAwaitingReview(TEST_USERS.requesterA, 'Текст', 'Ответ');
    const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
    await harness.services.review.approve(incident.id, approver);

    // Already delivered: a resend must be a no-op rather than a duplicate.
    expect(await harness.services.review.resend(incident.id)).toBe('already-sent');

    await prisma.incidentAnswer.updateMany({ where: { incidentId: incident.id }, data: { deliveredAt: null } });
    expect(await harness.services.review.resend(incident.id)).toBe('sent');
  });
});
