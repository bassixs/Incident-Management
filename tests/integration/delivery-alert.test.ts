import { InboxStatus, OutboxStatus, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { DeliveryAlertService } from '../../src/delivery/delivery-alert.service';
import {
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';

describeIntegration('delivery problem alerts', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  it('retries an alert after MAX recovers and does not report the same failures twice', async () => {
    await prisma.outboundMessage.create({
      data: {
        targetType: 'chat',
        targetId: -1001n,
        payload: { text: 'hidden business text' },
        attachments: [],
        status: OutboxStatus.FAILED,
        attempts: 12,
      },
    });
    await prisma.inboundUpdate.create({
      data: {
        externalUpdateKey: 'failed:update:one',
        updateType: 'message_callback',
        payload: { hidden: 'private payload' },
        status: InboxStatus.FAILED,
      },
    });

    const sent: Array<{ chatId: bigint; text: string }> = [];
    let available = false;
    const max = {
      sendToChat: async (chatId: bigint, text: string) => {
        if (!available) throw new Error('MAX unavailable');
        sent.push({ chatId, text });
        return {};
      },
    };
    const alerts = new DeliveryAlertService(prisma, max as never, -1005n);

    await alerts.checkNow();
    expect(await prisma.outboundMessage.count({ where: { deliveryAlertedAt: { not: null } } })).toBe(0);
    expect(await prisma.inboundUpdate.count({ where: { deliveryAlertedAt: { not: null } } })).toBe(0);

    available = true;
    await alerts.checkNow();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(-1005n);
    expect(sent[0]?.text).toContain('Исходящие сообщения: 1');
    expect(sent[0]?.text).toContain('Входящие события: 1');
    expect(sent[0]?.text).not.toContain('hidden business text');
    expect(sent[0]?.text).not.toContain('private payload');

    await alerts.checkNow();
    expect(sent).toHaveLength(1);
  });
});
