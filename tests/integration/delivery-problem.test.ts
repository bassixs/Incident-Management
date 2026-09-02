import { InboxStatus, OutboxStatus, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { DeliveryProblemService } from '../../src/delivery/delivery-problem.service';
import {
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';

describeIntegration('delivery problem management', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  it('lists delivery context and retries only the selected outgoing failure', async () => {
    await prisma.outboundMessage.createMany({
      data: [
        {
          id: 'abcdef01-0000-4000-8000-000000000001',
          targetType: 'user',
          targetId: 9001n,
          payload: { text: 'Ответ для Ивана, телефон +7 900 000-00-00' },
          attachments: [],
          status: OutboxStatus.FAILED,
          attempts: 12,
          lastError: 'MAX unavailable',
          deliveryAlertedAt: new Date(),
        },
        {
          id: '12345678-0000-4000-8000-000000000002',
          targetType: 'chat',
          targetId: -1001n,
          payload: { text: 'Вторая ошибка' },
          attachments: [],
          status: OutboxStatus.FAILED,
          attempts: 12,
        },
      ],
    });
    await prisma.inboundUpdate.create({
      data: {
        id: 'fedcba98-0000-4000-8000-000000000003',
        externalUpdateKey: 'callback:user:9001',
        updateType: 'message_callback',
        payload: { callback: true },
        status: InboxStatus.FAILED,
        attempts: 1,
      },
    });

    const service = new DeliveryProblemService(prisma);
    const problems = await service.recent(10);
    expect(problems).toHaveLength(3);
    expect(problems.find((problem) => problem.reference === 'abcdef01')).toMatchObject({
      direction: 'outbound',
      targetId: 9001n,
      textPreview: 'Ответ для Ивана, телефон +7 900 000-00-00',
    });

    const result = await service.retryFailedOutbound('abcdef01');
    expect(result).toMatchObject({ status: 'retried', count: 1, reference: 'abcdef01' });
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: 'abcdef01-0000-4000-8000-000000000001' } }),
    ).toMatchObject({ status: OutboxStatus.PENDING, attempts: 0, deliveryAlertedAt: null });
    expect(
      await prisma.outboundMessage.findUniqueOrThrow({ where: { id: '12345678-0000-4000-8000-000000000002' } }),
    ).toMatchObject({ status: OutboxStatus.FAILED });
  });
});
