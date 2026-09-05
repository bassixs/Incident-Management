import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { ValidationError } from '../../src/utils/errors';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';
import { InboxStatus, OutboxStatus, UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { ActionGuardService } from '../../src/actions/action-guard.service';
import { MaxMessageService } from '../../src/max/max-message.service';
import type { Update } from '../../src/max/max-types';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import type { MediaStorage } from '../../src/media/media-storage.interface';
import {
  createTestPrisma, createHarness, seedCategories, actorFor,
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
  afterEach(() => vi.restoreAllMocks());

  for (const route of ['command', 'callback', 'operator', 'requester'] as const) {
    for (const technical of [true, false]) it(`${route}: records ${technical ? 'a technical failure' : 'a validation refusal'} correctly in the inbox`, async () => {
      await seedCategories(prisma);
      const h = await createHarness(prisma);
      const actor = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
      const error = technical ? new Error('database unavailable') : new ValidationError('Проверьте ввод');
      const chatId = route === 'requester' ? actor.maxUserId : TEST_CHATS.distribution;
      const message = { sender: { user_id: Number(actor.maxUserId), name: actor.displayName },
        recipient: { chat_id: Number(chatId), chat_type: route === 'requester' ? 'dialog' : 'chat' },
        body: { mid: `${route}-${technical}`, text: route === 'command' ? '/report all' : route === 'operator' ? 'all' : 'Иван Иванов' } };
      if (route === 'requester') {
        await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: 'WAITING_REQUESTER_NAME' });
        vi.spyOn(h.services.legal, 'hasCurrentAccess').mockResolvedValue(true);
        vi.spyOn(h.services.sessions, 'start').mockRejectedValue(error);
      } else {
        vi.spyOn(h.services.reports, 'build').mockRejectedValue(error);
        if (route === 'operator') await h.services.sessions.start({ maxUserId: actor.maxUserId, chatId, type: 'WAITING_REPORT_PERIOD' });
      }
      vi.spyOn(h.services.max, 'answerCallback').mockResolvedValue(undefined);
      const update = { update_type: route === 'callback' ? 'message_callback' : 'message_created', timestamp: 1, message,
        ...(route === 'callback' ? { callback: { callback_id: 'test-callback', user: message.sender, payload: 'report:all' } } : {}) } as unknown as Update;
      const max = { dispatch: async () => route === 'callback'
        ? handleCallbackUpdate(h.services, { update } as never)
        : handleMessageUpdate(h.services, { update } as never) };
      const dispatcher = new UpdateDispatcher(prisma, max as never);
      const reservation = await dispatcher.reserve(update);
      await dispatcher.kick();
      const stored = await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reservation.id! } });
      expect(stored.status).toBe(technical ? 'FAILED' : 'PROCESSED');
      expect(stored.lastError).toBe(technical ? 'database unavailable' : null);
    });
  }

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
