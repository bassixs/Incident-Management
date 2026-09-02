import { IncidentStatus, type PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { findCommand } from '../../src/bot/commands';
import { getConfig } from '../../src/config';
import { HistoryAction } from '../../src/incidents/incident-history.service';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import {
  actorFor,
  createHarness,
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';

describeIntegration('incident history and administrator audit', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  it('records a successful administrative change and shows it through /audit', async () => {
    const { services, messages } = await createHarness(prisma);
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Главный администратор', [UserRole.ADMIN]);

    await findCommand('category_add')!({
      services,
      actor,
      chatId: actor.maxUserId,
      isDialog: true,
      args: ['TEST_AREA', 'Тестовая', 'сфера'],
    });

    const stored = await prisma.adminAuditLog.findFirstOrThrow();
    expect(stored).toMatchObject({
      action: 'CATEGORY_CREATED',
      actorMaxUserId: TEST_USERS.admin,
      actorName: 'Главный администратор',
      targetId: 'TEST_AREA',
    });

    await findCommand('audit')!({
      services,
      actor,
      chatId: actor.maxUserId,
      isDialog: true,
      args: [],
    });
    expect(messages.toUser(actor.maxUserId).at(-1)?.message.text).toContain('Создана сфера TEST_AREA');
    expect(messages.toUser(actor.maxUserId).at(-1)?.message.text).toContain('Главный администратор');
  });

  it('shows the persisted incident timeline through /history in a working chat', async () => {
    const { services, messages } = await createHarness(prisma);
    const actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
    const incident = await prisma.incident.create({
      data: {
        publicCode: 'INC-20260902-0099',
        requesterId: actor.userId,
        requesterMaxUserId: actor.maxUserId,
        requesterName: actor.displayName,
        text: 'Проверка истории',
        deadlineAt: new Date('2026-09-05T12:00:00.000Z'),
      },
    });
    await services.history.record({
      incidentId: incident.id,
      action: HistoryAction.INCIDENT_CREATED,
      toStatus: IncidentStatus.DISTRIBUTION,
      actorMaxUserId: actor.maxUserId,
      actorRole: 'REQUESTER',
    });
    await services.history.record({
      incidentId: incident.id,
      action: HistoryAction.ASSIGNED,
      fromStatus: IncidentStatus.DISTRIBUTION,
      toStatus: IncidentStatus.ASSIGNED,
      actorMaxUserId: actor.maxUserId,
      actorRole: 'ADMIN',
      metadata: { categoryCode: 'TEST_AREA', dispatcher: actor.displayName },
    });

    await findCommand('history')!({
      services,
      actor,
      chatId: TEST_CHATS.distribution,
      isDialog: false,
      args: [incident.publicCode],
    });
    const text = messages.toChat(TEST_CHATS.distribution).at(-1)?.message.text;
    expect(text).toContain('История INC-20260902-0099');
    expect(text).toContain('Обращение создано');
    expect(text).toContain('Обращение распределено');
    expect(text).toContain('Администратор');
    expect(text).toContain('Сфера: TEST_AREA');
  });

  it('keeps working context in the audit but redacts secrets', async () => {
    const { services } = await createHarness(prisma);
    const config = getConfig();
    await services.audit.record({
      action: 'TEST_SECRET_REDACTION',
      actorMaxUserId: TEST_USERS.admin,
      actorName: 'Администратор Иванов',
      targetType: 'пользователь',
      targetId: '9001',
      summary: `Причина для Иванова; token=${config.BOT_TOKEN}; password=temporary-pass`,
      metadata: { requesterName: 'Иванов', secret: 'must-not-be-stored' },
    });

    const stored = await prisma.adminAuditLog.findFirstOrThrow();
    expect(stored.summary).toContain('Иванова');
    expect(stored.summary).not.toContain(config.BOT_TOKEN);
    expect(stored.summary).not.toContain('temporary-pass');
    expect(stored.metadata).toMatchObject({ requesterName: 'Иванов', secret: '[скрыто]' });
  });
});
