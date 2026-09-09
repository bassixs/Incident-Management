import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { buildServices } from '../../src/app/container';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { MaxClient } from '../../src/max/max-client';
import { MaxMessageService } from '../../src/max/max-message.service';
import { MediaService } from '../../src/media/media.service';
import { photoToken } from '../../src/media/max-photo-reference';
import type { SendMessageExtra, Update } from '../../src/max/max-types';
import { UpdateDispatcher, updatePartition } from '../../src/server/update-dispatcher';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

const user = (id: number) => ({ user_id: id, name: 'Житель Тест', is_bot: false });
const tokensFor = (id: number, prefix = 'photo') => Array.from({ length: 4 }, (_, i) => `${prefix}-${id}-${i}`);
function photoUpdate(id: number, prefix = 'photo'): Update {
  return { update_type: 'message_created', timestamp: 1,
    message: { sender: user(id), recipient: { chat_id: id, chat_type: 'dialog' },
      body: { mid: `${prefix}-${id}`, text: `Не горит фонарь ${id}`, attachments: tokensFor(id, prefix).map(token => ({ type: 'image', payload: { token, url: `https://unused.invalid/${token}` } })) } },
  } as unknown as Update;
}
function confirmUpdate(id: number, prefix = 'confirm'): Update {
  return { update_type: 'message_callback', timestamp: 2,
    callback: { callback_id: `${prefix}-${id}`, user: user(id), payload: 'user:draft-confirm' },
    message: { sender: { ...user(999), is_bot: true }, recipient: { chat_id: id, chat_type: 'dialog' }, body: { mid: `preview-${prefix}-${id}` } },
  } as unknown as Update;
}
type Recorded = { id: number; target: 'user' | 'chat'; text: string; tokens: string[]; at: number };

describeIntegration('parallel users with real photo workflow and simulated MAX transport', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterAll(() => prisma.$disconnect());

  async function harness(ids: number[], intercept?: (entry: Recorded) => Promise<void>) {
    const sent: Recorded[] = []; const calls: number[] = [];
    const storage = { save: vi.fn(), load: vi.fn(), remove: vi.fn() };
    const send = async (target: 'user' | 'chat', id: number, text: string, extra?: SendMessageExtra) => {
      calls.push(Date.now());
      const tokens = (extra?.attachments ?? []).flatMap(item => item.type === 'image' && item.payload.token ? [item.payload.token] : []);
      const entry = { id, target, text, tokens, at: Date.now() };
      await intercept?.(entry);
      sent.push(entry);
      return { body: { mid: `sent-${sent.length}` } };
    };
    const api = {
      sendMessageToUser: (id: number, text: string, extra?: SendMessageExtra) => send('user', id, text, extra),
      sendMessageToChat: (id: number, text: string, extra?: SendMessageExtra) => send('chat', id, text, extra),
      answerOnCallback: async () => { calls.push(Date.now()); return { success: true }; },
      editCardWithKeyboard: async () => undefined, editMessage: async () => { calls.push(Date.now()); return { success: true }; },
      deleteMessage: async () => { calls.push(Date.now()); return { success: true }; },
    };
    const max = new MaxClient({ api } as never);
    const download = vi.spyOn(max, 'downloadFromUrl').mockRejectedValue(new Error('Photo download is forbidden in this test'));
    const upload = vi.spyOn(max, 'uploadImage').mockRejectedValue(new Error('Photo upload is forbidden in this test'));
    const messages = new MaxMessageService(max, { prisma, storage: storage as never });
    const services = buildServices(prisma, { messages, media: new MediaService(storage as never, max), storage: storage as never });
    services.max = max;
    for (const id of ids) {
      const actor = await actorFor(prisma, BigInt(id), 'Житель Тест', []);
      if ((await services.legal.status(actor.userId)).required) {
        const evidence = { userId: actor.userId, maxUserId: actor.maxUserId };
        await services.legal.acceptUserAgreement(evidence); await services.legal.acceptPersonalDataConsent(evidence);
      }
      await services.sessions.start({ maxUserId: BigInt(id), chatId: BigInt(id), type: 'WAITING_INCIDENT_TEXT', data: {
        requesterName: 'Житель Тест', requesterPhone: '+79001112233', selectedCategoryId: null,
        problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга', problemLocality: null,
      } });
    }
    let active = 0; let peak = 0;
    const activeUsers = new Set<string>(); const order: string[] = [];
    const dispatcher = new UpdateDispatcher(prisma, { dispatch: async (update: Update) => {
      const key = updatePartition(update);
      if (activeUsers.has(key)) throw new Error(`Same user overlapped: ${key}`);
      activeUsers.add(key); peak = Math.max(peak, ++active); order.push(`${key}:${update.update_type}`);
      try {
        if (update.update_type === 'message_created') await handleMessageUpdate(services, { update } as never);
        else await handleCallbackUpdate(services, { update } as never);
      } finally { active--; activeUsers.delete(key); }
    } } as never, 8);
    return { services, messages, dispatcher, sent, calls, storage, download, upload, order, peak: () => peak };
  }

  it('24 users send 96 distinct photos and confirm concurrently, preserving ownership and rate limits', async () => {
    const ids = Array.from({ length: 24 }, (_, i) => 81000 + i);
    const h = await harness(ids);
    const events = ids.flatMap(id => [photoUpdate(id), confirmUpdate(id)]);
    // Real webhook reservation receives a burst, including duplicate redelivery.
    const reservations = await Promise.all([...events, ...events].map(event => h.dispatcher.reserve(event)));
    expect(reservations.filter(row => row.fresh)).toHaveLength(48);
    await Promise.all([h.dispatcher.kick(), h.dispatcher.kick()]);
    await h.messages.flush();
    const incidents = await prisma.incident.findMany({ include: { attachments: true } });
    expect(incidents).toHaveLength(24);
    expect(new Set(incidents.map(row => row.publicCode)).size).toBe(24);
    expect(h.peak()).toBe(8);
    for (const incident of incidents) {
      const id = Number(incident.requesterMaxUserId);
      const expected = tokensFor(id).sort();
      expect(incident.attachments.map(a => photoToken(a.storageKey)).sort()).toEqual(expected);
      expect(incident.text).toBe(`Не горит фонарь ${id}`);
      expect(h.order.filter(value => value.startsWith(`user:${id}:`))).toEqual([`user:${id}:message_created`, `user:${id}:message_callback`]);
      const preview = h.sent.filter(entry => entry.target === 'user' && entry.id === id && entry.tokens.length);
      expect(preview).toHaveLength(1); expect(preview[0]!.tokens.sort()).toEqual(expected);
      const cards = h.sent.filter(entry => entry.target === 'chat' && entry.text.includes(incident.publicCode));
      expect(cards).toHaveLength(1); expect(cards[0]!.tokens.sort()).toEqual(expected);
    }
    expect(await prisma.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(48);
    expect(await prisma.inboundUpdate.count({ where: { status: { not: 'PROCESSED' } } })).toBe(0);
    expect(await prisma.outboundMessage.count({ where: { status: { not: 'SENT' } } })).toBe(0);
    expect(await prisma.operatorSession.count()).toBe(0);
    for (const fn of [...Object.values(h.storage), h.download, h.upload]) expect(fn).not.toHaveBeenCalled();
    const chatTimes = h.sent.filter(entry => entry.target === 'chat' && entry.id === Number(TEST_CHATS.distribution)).map(entry => entry.at);
    for (let i = 1; i < chatTimes.length; i++) expect(chatTimes[i]! - chatTimes[i - 1]!).toBeGreaterThanOrEqual(540);
    const apiTimes = [...h.calls].sort((a, b) => a - b);
    for (let i = 1; i < apiTimes.length; i++) expect(apiTimes[i]! - apiTimes[i - 1]!).toBeGreaterThanOrEqual(40);
  }, 120_000);

  it('a slow photo preview does not block another user’s registration and holds its own confirmation', async () => {
    let release!: () => void; let blocked = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const h = await harness([82001, 82002], async entry => {
      if (entry.target === 'user' && entry.id === 82001 && entry.tokens.length) { blocked = true; await pending; }
    });
    for (const id of [82001, 82002]) { await h.dispatcher.reserve(photoUpdate(id)); await h.dispatcher.reserve(confirmUpdate(id)); }
    const running = h.dispatcher.kick();
    try {
      await vi.waitFor(async () => {
        expect(blocked).toBe(true);
        expect(await prisma.incident.count({ where: { requesterMaxUserId: 82002n } })).toBe(1);
      }, { timeout: 10_000 });
      expect(await prisma.incident.count({ where: { requesterMaxUserId: 82001n } })).toBe(0);
      expect(h.order).not.toContain('user:82001:message_callback');
    } finally { release(); await running; }
    expect(await prisma.incident.count()).toBe(2);
  }, 30_000);

  it('one user’s revoked photos do not affect other users, and replacement stays with its owner', async () => {
    const ids = [83001, 83002, 83003, 83004];
    const h = await harness(ids, async entry => {
      if (entry.tokens.some(token => token.startsWith('photo-83001-'))) throw new MaxError(400, { code: 'attachment.invalid', message: 'Invalid image token' });
    });
    await Promise.all(ids.flatMap(id => [photoUpdate(id), confirmUpdate(id)]).map(event => h.dispatcher.reserve(event)));
    await h.dispatcher.kick(); await h.messages.flush();
    expect(await prisma.incident.count()).toBe(3);
    expect((await h.services.sessions.find(83001n, 83001n))?.type).toBe('WAITING_INCIDENT_EDIT_VALUE');
    expect(await prisma.inboundUpdate.count({ where: { status: 'FAILED' } })).toBe(0);
    await h.dispatcher.reserve(photoUpdate(83001, 'replacement'));
    await h.dispatcher.reserve(confirmUpdate(83001, 'replacement-confirm'));
    await h.dispatcher.kick(); await h.messages.flush();
    const restored = await prisma.incident.findFirstOrThrow({ where: { requesterMaxUserId: 83001n }, include: { attachments: true } });
    expect(restored.attachments.map(a => photoToken(a.storageKey)).sort()).toEqual(tokensFor(83001, 'replacement').sort());
    expect(await prisma.incident.count()).toBe(4);
    for (const id of ids.slice(1)) {
      const incident = await prisma.incident.findFirstOrThrow({ where: { requesterMaxUserId: BigInt(id) }, include: { attachments: true } });
      expect(incident.attachments.map(a => photoToken(a.storageKey)).sort()).toEqual(tokensFor(id).sort());
    }
  }, 45_000);
});
