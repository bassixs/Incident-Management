import { type PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { buildServices } from '../../src/app/container';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { loadConfig } from '../../src/config';
import { LegalAcceptanceService } from '../../src/legal/legal-acceptance.service';
import { MaxMessageService } from '../../src/max/max-message.service';
import type { Message, SendMessageExtra } from '../../src/max/max-types';
import { MediaService } from '../../src/media/media.service';
import { photoToken } from '../../src/media/max-photo-reference';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('mixed resident and employee workflows', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterAll(() => prisma.$disconnect());

  // Real DB, handlers, photo references and outbox; only the MAX network is simulated.
  // Sequential and concurrent runs must have the same observable results.
  for (const concurrency of [1, 8]) {
    it(`24 complete profiles with six outcome branches, ${concurrency} workflows at once`, async () => {
      const sent: { target: string; text: string; tokens: string[] }[] = [];
      const storage = { save: vi.fn(), load: vi.fn(), remove: vi.fn() };
      const send = async (target: string, text: string, extra?: SendMessageExtra) => {
        await new Promise(resolve => setTimeout(resolve, 2));
        sent.push({ target, text, tokens: (extra?.attachments ?? []).flatMap(a => a.type === 'image' && a.payload.token ? [a.payload.token] : []) });
        return { body: { mid: `mixed-${sent.length}` } };
      };
      const max = {
        sendToUser: (id: bigint, text: string, extra?: SendMessageExtra) => send(`user:${id}`, text, extra),
        sendToChat: (id: bigint, text: string, extra?: SendMessageExtra) => send(`chat:${id}`, text, extra),
        editCardWithKeyboard: async () => undefined, editMessage: async () => ({ success: true }), deleteMessage: async () => ({ success: true }),
        downloadFromUrl: vi.fn().mockRejectedValue(new Error('No photo downloads allowed')),
        uploadImage: vi.fn().mockRejectedValue(new Error('No photo uploads allowed')),
      };
      const messages = new MaxMessageService(max as never, { prisma, storage: storage as never }, 8);
      const services = buildServices(prisma, { messages, media: new MediaService(storage as never, max as never), storage: storage as never });
      services.legal = new LegalAcceptanceService(prisma, loadConfig({ ...process.env,
        LEGAL_CONSENT_REQUIRED: 'true', LEGAL_DOCUMENTS_BASE_URL: 'https://example.test/documents',
        LEGAL_USER_AGREEMENT_SHA256: 'a'.repeat(64), LEGAL_PRIVACY_POLICY_SHA256: 'b'.repeat(64),
        LEGAL_PERSONAL_DATA_CONSENT_SHA256: 'c'.repeat(64),
      }));
      const dispatcher = await actorFor(prisma, TEST_USERS.dispatcher, 'Распределитель', [UserRole.DISPATCHER]);
      const responder = await actorFor(prisma, TEST_USERS.responder, 'Исполнитель', [UserRole.RESPONDER]);
      const approver = await actorFor(prisma, TEST_USERS.approver, 'Согласующий', [UserRole.APPROVER]);
      const groups = await prisma.responsibleGroup.findMany();
      const category = await prisma.category.findFirstOrThrow();
      const stages = new Map<number, string>(); let peakStages = 0; let peakWorkflows = 0;
      const stage = (i: number, value: string) => {
        stages.set(i, value); peakStages = Math.max(peakStages, new Set(stages.values()).size);
        peakWorkflows = Math.max(peakWorkflows, stages.size);
      };
      const resultIds = new Map<number, string>();
      let next = 0;
      const workflow = async (i: number) => {
        const id = BigInt(85000 + i); const branch = i % 6;
        const actor = await actorFor(prisma, id, 'Тестовый житель', []);
        let step = 0;
        const callback = async (action: Parameters<typeof handleUserCallback>[1]['action'], argument?: string) => {
          await handleUserCallback({ services, actor, chatId: id, messageId: undefined, callbackId: `mixed-${i}-${++step}` }, { kind: 'user', action, argument });
        };
        const message = async (text: string, photo = false) => {
          await handleRequesterMessage(services, actor, id, {
            sender: { user_id: Number(id), name: 'Тестовый житель' },
            recipient: { chat_id: Number(id), chat_type: 'dialog' },
            body: { mid: `input-${i}-${++step}`, text, attachments: photo ? [{ type: 'image', payload: { token: `resident-${i}` } }] : [] },
          } as unknown as Message);
        };
        stage(i, 'profile');
        await callback('new'); await callback('accept-agreement');
        expect(await services.sessions.find(id, id)).toBeNull();
        await callback('accept-consent');
        await message(`Тестов Иван ${i % 2 ? 'Иванович' : 'Петрович'}`);
        await message(`+7900000${String(i).padStart(4, '0')}`);
        const topic = i % 2 ? category.id : 'none';
        await callback('category', topic); await callback('municipality', `${topic}~KALUGA_CITY`);
        await message(`Не горит фонарь у дома ${i + 1}. Маркер ${i}.`, true);
        expect(await prisma.incident.count({ where: { requesterMaxUserId: id } })).toBe(0);
        await callback('draft-confirm');
        const incident = await prisma.incident.findFirstOrThrow({ where: { requesterMaxUserId: id } });
        resultIds.set(i, incident.id);
        stage(i, 'distribution');
        if (branch === 0) {
          await services.distribution.reject(incident.id, `Причина отказа ${i}`, dispatcher);
          stages.delete(i); return;
        }
        const group = groups.find(g => g.code === (branch === 5 ? 'REGIONAL' : i % 2 ? 'IT' : 'FACILITY'))!;
        await services.distribution.assign(incident.id, group.id, dispatcher);
        stage(i, 'answer');
        const author = branch === 5 ? dispatcher : responder;
        await services.sector.takeInWork(incident.id, author);
        const firstText = `Ответ исполнителя ${i}, версия 1`;
        const first = await services.answers.submit(incident.id, author, firstText, [{ kind: 'IMAGE', token: `answer-${i}-1` }]);
        stage(i, 'review');
        if (branch === 2 || branch === 3) {
          await services.review.requestRevision(incident.id, `Доработать ответ ${i}`, approver, first.answer.id);
          if (branch === 2) {
            stage(i, 'revision');
            const second = await services.answers.submit(incident.id, author, `Ответ исполнителя ${i}, версия 2`, [{ kind: 'IMAGE', token: `answer-${i}-2` }]);
            await expect(services.review.approve(incident.id, approver, first.answer.id)).rejects.toThrow('устарела');
            await services.review.approve(incident.id, approver, second.answer.id);
          }
        } else if (branch === 1) {
          await services.review.approve(incident.id, approver, first.answer.id);
        }
        if ([1, 2, 5].includes(branch)) {
          await messages.flush();
          await services.incidents.rateAnswer(incident.id, id, i % 5 + 1);
        }
        stages.delete(i);
      };
      const results = await Promise.allSettled(Array.from({ length: concurrency }, async () => {
        while (next < 24) await workflow(next++);
      }));
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      await messages.flush();
      expect(peakWorkflows).toBe(concurrency);
      if (concurrency > 1) expect(peakStages).toBeGreaterThan(1);
      const incidents = await prisma.incident.findMany({ include: { attachments: true, answers: { include: { attachments: true }, orderBy: { version: 'asc' } } } });
      expect(incidents).toHaveLength(24);
      expect(new Set(incidents.map(row => row.publicCode)).size).toBe(24);
      expect(await prisma.legalAcceptance.count()).toBe(48);
      expect(await prisma.operatorSession.count()).toBe(0);
      const outcomes = ['REJECTED', 'RESOLVED', 'RESOLVED', 'REVISION_REQUIRED', 'WAITING_REVIEW', 'RESOLVED'];
      for (let i = 0; i < 24; i++) {
        const incident = incidents.find(row => row.id === resultIds.get(i))!;
        expect(incident.status).toBe(outcomes[i % 6]);
        expect(incident.text).toContain(`Маркер ${i}.`);
        expect(incident.requesterPhone?.replace(/\D/g, '')).toBe(`7900000${String(i).padStart(4, '0')}`);
        expect(incident.attachments.map(a => photoToken(a.storageKey))).toEqual([`resident-${i}`]);
        const approved = incident.answers.filter(a => a.status === 'APPROVED');
        const final = sent.filter(row => row.target === `user:${incident.requesterMaxUserId}` && row.text.includes('Получен ответ по вашему обращению'));
        expect(final).toHaveLength(incident.status === 'RESOLVED' ? 1 : 0);
        if (incident.status === 'RESOLVED') {
          expect(approved).toHaveLength(1); expect(approved[0]!.deliveredAt).not.toBeNull();
          expect(final[0]!.text).toContain(approved[0]!.text);
          expect(final[0]!.tokens).toEqual([`answer-${i}-${i % 6 === 2 ? 2 : 1}`]);
          expect(incident.responseRating).toBe(i % 5 + 1);
        } else expect(approved).toHaveLength(0);
        if (i % 6 !== 0) {
          const group = groups.find(g => g.id === incident.assignedGroupId)!;
          const cards = sent.filter(row => row.target === `chat:${group.maxChatId}` && row.text.includes(incident.publicCode) && row.tokens.includes(`resident-${i}`));
          expect(cards.length).toBeGreaterThan(0);
          expect(sent.filter(row => row.target.startsWith('chat:') && row.tokens.includes(`resident-${i}`)).every(row => [String(TEST_CHATS.distribution), String(group.maxChatId)].some(chat => row.target === `chat:${chat}`))).toBe(true);
        }
      }
      expect(await prisma.outboundMessage.count({ where: { status: { not: 'SENT' } } })).toBe(0);
      for (const fn of [...Object.values(storage), max.downloadFromUrl, max.uploadImage]) expect(fn).not.toHaveBeenCalled();
    }, 120_000);
  }

  it('simultaneous approval and revision can produce only one decision on each answer', async () => {
    const { services } = await createHarness(prisma);
    const admin = await actorFor(prisma, TEST_USERS.admin, 'Администратор', [UserRole.ADMIN]);
    const group = await prisma.responsibleGroup.findUniqueOrThrow({ where: { code: 'FACILITY' } });
    await Promise.all(Array.from({ length: 12 }, async (_, i) => {
      const incident = await services.incidents.create({ requester: { maxUserId: BigInt(86000 + i), name: 'Тестов Иван', phone: '+79001112233' }, text: `Спорное согласование ${i}` });
      await services.distribution.assign(incident.id, group.id, admin);
      const { answer } = await services.answers.submit(incident.id, admin, `Ответ ${i}`);
      const decisions = await Promise.allSettled([
        services.review.approve(incident.id, admin, answer.id),
        services.review.requestRevision(incident.id, 'Требуется доработка', admin, answer.id),
      ]);
      expect(decisions.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      const fresh = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id }, include: { answers: true } });
      expect(['RESOLVED', 'REVISION_REQUIRED']).toContain(fresh.status);
      expect(fresh.answers).toHaveLength(1);
      expect(fresh.answers[0]!.status).toBe(fresh.status === 'RESOLVED' ? 'APPROVED' : 'REVISION_REQUIRED');
      expect(fresh.deadlineAt).toEqual(incident.deadlineAt);
    }));
  }, 60_000);
});
