import { InboxStatus, OutboxStatus, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';

import { ActionGuardService } from '../../src/actions/action-guard.service';
import { MaxMessageService } from '../../src/max/max-message.service';
import type { Update } from '../../src/max/max-types';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import type { MediaStorage } from '../../src/media/media-storage.interface';
import {
  createTestPrisma,
  describeIntegration,
  pushSchemaOnce,
  resetDatabase,
} from '../helpers/integration';

describeIntegration('durable delivery and button guards', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    pushSchemaOnce();
    prisma = createTestPrisma();
    await prisma.$connect();
  });
  afterAll(async () => prisma.$disconnect());
  beforeEach(() => resetDatabase(prisma));

  it('allows only one concurrent press and reclaims an expired lease', async () => {
    const guard = new ActionGuardService(prisma);
    const now = new Date('2026-09-02T12:00:00.000Z');
    const lease = {
      key: 'incident-global:one:approve:-',
      maxUserId: 123n,
      incidentId: 'one',
      action: 'approve',
      ttlMs: 60_000,
    };

    const results = await Promise.all(Array.from({ length: 10 }, () => guard.acquire(lease, now)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await guard.acquire(lease, new Date(now.getTime() + 60_001))).toBe(true);
  });

  it('keeps a failed MAX message in the outbox and sends it on a later drain', async () => {
    const stored = new Map<string, Buffer>();
    const storage: MediaStorage = {
      save: async ({ key, body }) => {
        stored.set(key, body);
        return { storageKey: key, size: body.length };
      },
      load: async (key) => stored.get(key)!,
      exists: async (key) => stored.has(key),
      remove: async (key) => {
        stored.delete(key);
      },
    };
    let fail = true;
    const max = {
      sendToUser: async () => {
        if (fail) throw new Error('MAX unavailable');
        return { body: { mid: 'mid-after-retry' } };
      },
    };
    const messages = new MaxMessageService(max as never, { prisma, storage });

    const first = await messages.send(
      { userId: 777n },
      { text: 'Надёжное сообщение', delivery: { dedupeKey: 'test:delivery:one' } },
    );
    expect(first.state).toBe('queued');
    const queued = await prisma.outboundMessage.findUniqueOrThrow({ where: { dedupeKey: 'test:delivery:one' } });
    expect(queued.status).toBe(OutboxStatus.PENDING);
    expect(queued.attempts).toBe(1);

    fail = false;
    await prisma.outboundMessage.update({
      where: { id: queued.id },
      data: { nextAttemptAt: new Date(0) },
    });
    await messages.flush();

    const sent = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: queued.id } });
    expect(sent.status).toBe(OutboxStatus.SENT);
    expect(sent.firstMessageId).toBe('mid-after-retry');
  });

  it('stores an inbound update before processing and ignores a redelivery', async () => {
    const processed: Update[] = [];
    const max = { dispatch: async (update: Update) => processed.push(update) };
    const dispatcher = new UpdateDispatcher(prisma, max as never);
    const update = {
      update_type: 'message_created',
      timestamp: 1,
      message: {
        sender: { user_id: 5, name: 'User' },
        recipient: { chat_id: 5, chat_type: 'dialog' },
        body: { mid: 'reliable-mid', text: 'Привет' },
      },
    } as unknown as Update;

    const reservation = await dispatcher.reserve(update);
    expect(reservation.fresh).toBe(true);
    expect(await prisma.inboundUpdate.count({ where: { status: InboxStatus.PENDING } })).toBe(1);
    expect((await dispatcher.reserve(update)).fresh).toBe(false);

    await dispatcher.kick();
    expect(processed).toHaveLength(1);
    expect(await prisma.inboundUpdate.count({ where: { status: InboxStatus.PROCESSED } })).toBe(1);
  });
});
