import { execFileSync } from 'node:child_process';

import { PrismaClient, UserRole } from '@prisma/client';
import { describe } from 'vitest';

import { buildServices, type AppServices } from '../../src/app/container';
import { FakeMediaService, FakeMessageService } from './fakes';
import { TEST_CHATS } from './setup-env';

/**
 * Integration tests need a real PostgreSQL — the guarantees under test
 * (advisory locks, conditional UPDATEs, unique indexes) cannot be faked.
 *
 * Run them with:
 *   TEST_DATABASE_URL=postgresql://... npm test
 * Without that variable the suite is skipped rather than silently passing.
 */
export const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL;

export const describeIntegration = INTEGRATION_DB_URL ? describe : describe.skip;

let schemaPushed = false;

export function pushSchemaOnce(): void {
  if (schemaPushed || !INTEGRATION_DB_URL) return;
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    env: { ...process.env, DATABASE_URL: INTEGRATION_DB_URL },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  schemaPushed = true;
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: INTEGRATION_DB_URL! } } });
}

/** Order matters: children before parents. */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AdminAuditLog",
      "IncidentHistory",
      "AnswerAttachment",
      "IncidentAnswer",
      "IncidentAttachment",
      "OperatorSession",
      "Incident",
      "Ban",
      "ActionLock",
      "OutboundMessage",
      "InboundUpdate",
      "ProcessedUpdate",
      "IncidentCounter",
      "SystemSetting",
      "Category",
      "User"
    RESTART IDENTITY CASCADE
  `);
}

export type TestHarness = {
  prisma: PrismaClient;
  services: AppServices;
  messages: FakeMessageService;
};

export async function createHarness(prisma: PrismaClient): Promise<TestHarness> {
  const messages = new FakeMessageService();
  const services = buildServices(prisma, {
    messages: messages as never,
    media: new FakeMediaService() as never,
  });
  return { prisma, services, messages };
}

export const CATEGORY_CODES = { facility: 'FACILITY', it: 'IT' } as const;

export async function seedCategories(prisma: PrismaClient): Promise<void> {
  await prisma.category.createMany({
    data: [
      {
        code: CATEGORY_CODES.facility,
        name: 'Хозяйственные вопросы',
        maxChatId: TEST_CHATS.sector,
        sortOrder: 10,
      },
      {
        code: CATEGORY_CODES.it,
        name: 'IT',
        maxChatId: TEST_CHATS.otherSector,
        sortOrder: 20,
        answerTemplate: 'Обращение № {{incidentCode}}\n{{result}}',
      },
    ],
  });
}

export async function ensureUser(
  prisma: PrismaClient,
  maxUserId: bigint,
  displayName: string,
  roles: UserRole[] = [],
) {
  return prisma.user.upsert({
    where: { maxUserId },
    create: { maxUserId, displayName, roles },
    update: { displayName, roles },
  });
}

export async function actorFor(prisma: PrismaClient, maxUserId: bigint, displayName: string, roles: UserRole[]) {
  const user = await ensureUser(prisma, maxUserId, displayName, roles);
  return {
    userId: user.id,
    maxUserId: user.maxUserId,
    displayName: user.displayName,
    role: roles.join('|'),
    roles: [UserRole.REQUESTER, ...roles],
  };
}
