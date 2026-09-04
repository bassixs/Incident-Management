import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import type { PrismaClient } from '@prisma/client';

import { loadConfig } from '../../src/config';
import {
  LEGAL_CONFIRMATION_TEXT,
  LegalAcceptanceService,
} from '../../src/legal/legal-acceptance.service';
import {
  createTestPrisma,
  describeIntegration,
  ensureUser,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';
import { TEST_USERS } from '../helpers/setup-env';

describeIntegration('explicit legal acceptance (PostgreSQL)', () => {
  let prisma: PrismaClient;
  const hash = 'a'.repeat(64);

  function service(version = '1.0') {
    return new LegalAcceptanceService(
      prisma,
      loadConfig({
        ...process.env,
        LEGAL_CONSENT_REQUIRED: 'true',
        LEGAL_DOCUMENTS_BASE_URL: 'https://example.test/documents/',
        LEGAL_DOCUMENT_VERSION: version,
        LEGAL_USER_AGREEMENT_SHA256: hash,
        LEGAL_PRIVACY_POLICY_SHA256: 'b'.repeat(64),
        LEGAL_PERSONAL_DATA_CONSENT_SHA256: 'c'.repeat(64),
      }),
    );
  }

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
  });

  it('requires two separate confirmations and preserves evidence of the first click', async () => {
    const user = await ensureUser(prisma, TEST_USERS.requesterA, 'Requester A');
    const legal = service();
    const evidence = {
      userId: user.id,
      maxUserId: user.maxUserId,
      sourceMessageId: 'message-1',
      sourceChatId: user.maxUserId,
    };

    await expect(
      legal.acceptPersonalDataConsent({ ...evidence, sourceCallbackId: 'consent-too-early' }),
    ).rejects.toThrow('Сначала примите Пользовательское соглашение');

    await legal.acceptUserAgreement({ ...evidence, sourceCallbackId: 'agreement-first-click' });
    await legal.acceptUserAgreement({ ...evidence, sourceCallbackId: 'agreement-repeated-click' });
    expect((await legal.status(user.id)).ready).toBe(false);

    await legal.acceptPersonalDataConsent({ ...evidence, sourceCallbackId: 'consent-first-click' });
    expect((await legal.status(user.id)).ready).toBe(true);

    const rows = await prisma.legalAcceptance.findMany({
      where: { userId: user.id },
      orderBy: { acceptedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.confirmationText).sort()).toEqual(
      Object.values(LEGAL_CONFIRMATION_TEXT).sort(),
    );
    expect(rows.find((row) => row.type === 'USER_AGREEMENT')?.sourceCallbackId).toBe(
      'agreement-first-click',
    );
    expect(rows.every((row) => row.documentUrl.startsWith('https://example.test/documents/'))).toBe(
      true,
    );
  });

  it('requires fresh confirmations after the configured document version changes', async () => {
    const user = await ensureUser(prisma, TEST_USERS.requesterA, 'Requester A');
    const current = service('1.0');
    await current.acceptUserAgreement({
      userId: user.id,
      maxUserId: user.maxUserId,
      sourceCallbackId: 'agreement-v1',
    });
    await current.acceptPersonalDataConsent({
      userId: user.id,
      maxUserId: user.maxUserId,
      sourceCallbackId: 'consent-v1',
    });

    expect((await current.status(user.id)).ready).toBe(true);
    expect((await service('2.0').status(user.id)).ready).toBe(false);
  });
});
