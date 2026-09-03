import { AnswerStatus, IncidentStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { MediaStorage } from '../../src/media/media-storage.interface';
import { RetentionService } from '../../src/retention/retention.service';
import {
  createTestPrisma,
  describeIntegration,
  ensureUser,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

describeIntegration('90-day incident retention', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  beforeEach(() => resetDatabase(prisma));
  afterAll(() => prisma.$disconnect());

  it('deletes only expired terminal incidents and both sides attachments', async () => {
    const oldRequester = await ensureUser(prisma, 7101n, 'Старый заявитель');
    const recentRequester = await ensureUser(prisma, 7102n, 'Недавний заявитель');
    const activeRequester = await ensureUser(prisma, 7103n, 'Активный заявитель');
    const responder = await ensureUser(prisma, 7201n, 'Сотрудник', [UserRole.RESPONDER]);
    await prisma.user.update({ where: { id: oldRequester.id }, data: { updatedAt: daysAgo(120) } });

    const expired = await prisma.incident.create({
      data: {
        publicCode: 'INC-20260501-0001',
        requesterId: oldRequester.id,
        requesterMaxUserId: oldRequester.maxUserId,
        requesterName: oldRequester.displayName,
        text: 'Старое завершённое обращение',
        status: IncidentStatus.RESOLVED,
        createdAt: daysAgo(120),
        deadlineAt: daysAgo(117),
        answeredAt: daysAgo(100),
      },
    });
    await prisma.incidentAttachment.create({
      data: { incidentId: expired.id, type: 'IMAGE', storageKey: 'incidents/old.jpg', size: 100 },
    });
    const answer = await prisma.incidentAnswer.create({
      data: {
        incidentId: expired.id,
        version: 1,
        text: 'Старый ответ',
        createdByUserId: responder.id,
        status: AnswerStatus.APPROVED,
        approvedAt: daysAgo(100),
      },
    });
    await prisma.answerAttachment.create({
      data: { answerId: answer.id, type: 'FILE', storageKey: 'answers/old.pdf', size: 200 },
    });
    await prisma.outboundMessage.create({
      data: {
        targetType: 'user',
        targetId: oldRequester.maxUserId,
        payload: { text: 'Старый ответ' },
        attachments: [],
        incidentId: expired.id,
        answerId: answer.id,
      },
    });
    await prisma.actionLock.create({
      data: {
        key: 'old-action',
        maxUserId: responder.maxUserId,
        incidentId: expired.id,
        action: 'approve',
        lockedUntil: daysAgo(99),
      },
    });

    const recent = await prisma.incident.create({
      data: {
        publicCode: 'INC-20260820-0001',
        requesterId: recentRequester.id,
        requesterMaxUserId: recentRequester.maxUserId,
        requesterName: recentRequester.displayName,
        text: 'Недавнее завершённое обращение',
        status: IncidentStatus.REJECTED,
        createdAt: daysAgo(20),
        deadlineAt: daysAgo(17),
        answeredAt: daysAgo(10),
      },
    });
    const active = await prisma.incident.create({
      data: {
        publicCode: 'INC-20260201-0001',
        requesterId: activeRequester.id,
        requesterMaxUserId: activeRequester.maxUserId,
        requesterName: activeRequester.displayName,
        text: 'Старое, но активное обращение',
        status: IncidentStatus.IN_PROGRESS,
        createdAt: daysAgo(200),
        deadlineAt: daysAgo(197),
      },
    });

    const removed: string[] = [];
    const storage = {
      remove: vi.fn(async (key: string) => void removed.push(key)),
    } as unknown as MediaStorage;
    const result = await new RetentionService(prisma, storage).run(NOW);

    expect(result).toMatchObject({
      deletedIncidents: 1,
      deletedFiles: 2,
      deletedBytes: 300,
      failures: [],
    });
    expect(removed).toEqual(['incidents/old.jpg', 'answers/old.pdf']);
    expect(await prisma.incident.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.incident.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.incident.findUnique({ where: { id: active.id } })).not.toBeNull();
    expect(await prisma.outboundMessage.count({ where: { incidentId: expired.id } })).toBe(0);
    expect(await prisma.actionLock.count({ where: { incidentId: expired.id } })).toBe(0);
    expect(await prisma.incidentHistory.count({ where: { incidentId: expired.id } })).toBe(0);
    expect(await prisma.user.findUnique({ where: { id: oldRequester.id } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { id: responder.id } })).not.toBeNull();
  });
});
