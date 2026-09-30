import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { COMMANDS } from '../../src/bot/commands';
import { handleBotStarted } from '../../src/bot/handlers/message.handler';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { greetingText } from '../../src/bot/views/cards';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';

describeIntegration('approved resident interface', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });

  it('uses the same greeting and current menu for /start and bot_started', async () => {
    const h = await createHarness(prisma);
    const actor = await actorFor(prisma, 555n, 'Житель', []);
    await COMMANDS.start!({ services: h.services, actor, chatId: 555n, isDialog: true, args: [] });
    await handleBotStarted(h.services, { user: { user_id: 555 }, update: { update_type: 'bot_started' } } as never);
    const messages = h.messages.toUser(555n);
    expect(messages).toHaveLength(2);
    for (const { message } of messages) {
      expect(message.text).toBe(greetingText());
      expect(message.keyboard?.flat().map(b => b.text)).toEqual(['📝 Создать сообщение', '🔎 Мои сообщения', 'ℹ️ Правила']);
    }
  });

  it.each(['documents', 'legal-continue', 'accept-agreement', 'accept-consent'] as const)(
    'returns an old %s button to the current menu without changing the draft or consents', async action => {
      const h = await createHarness(prisma);
      const actor = await actorFor(prisma, 555n, 'Житель', []);
      const session = await h.services.sessions.start({ maxUserId: 555n, chatId: 555n,
        type: 'WAITING_INCIDENT_TEXT', data: { draftText: 'Яма у дома 12' } });
      const before = await prisma.operatorSession.findUniqueOrThrow({ where: { id: session.id } });
      await handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: 'legacy', messageId: undefined }, { kind: 'user', action });
      expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(greetingText());
      expect(await prisma.operatorSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(before);
      expect(await prisma.legalAcceptance.count()).toBe(0);
      expect(await prisma.incident.count()).toBe(0);
    },
  );
});
