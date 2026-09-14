import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { UserRole, type PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { buildServices } from '../../src/app/container';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { pendingConfirmation } from '../../src/bot/callbacks/staff-confirmation';
import { handleOperatorMessage } from '../../src/bot/handlers/operator.handler';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { MaxMessageService } from '../../src/max/max-message.service';
import { reviewEditDraft } from '../../src/review/review-edit';
import { actorFor, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, GROUP_CODES } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

describeIntegration('concurrent employee load with arriving incidents', () => {
  let prisma: PrismaClient;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); });
  afterAll(() => prisma.$disconnect());

  it('96 arrivals, 24 employees, confirmations, revisions, redistribution, reports and delivery', async () => {
    const total = 96, lanes = 8;
    const sent = new Map<string, { target: bigint; text: string; attachments: any[] }>();
    const pins = new Map<bigint, string>(); let seq = 0;
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const send = async (target: bigint, text: string, extra: any = {}) => {
      await delay(2); const mid = `load-${++seq}`;
      sent.set(mid, { target, text, attachments: extra.attachments ?? [] }); return { body: { mid } };
    };
    const max = {
      sendToChat: send, sendToUser: send,
      getMessage: async (mid: string) => { const m = sent.get(mid)!; return { recipient: { chat_id: Number(m.target) }, body: { mid, text: m.text, attachments: m.attachments } }; },
      editMessage: async (mid: string, text: string, attachments: any[]) => { const m = sent.get(mid)!; m.text = text; m.attachments = attachments; return { success: true }; },
      editCardWithKeyboard: async (mid: string, text: string, buttons: any[]) => { const m = sent.get(mid)!; m.text = text; m.attachments = buttons.length ? [{ type: 'inline_keyboard', payload: { buttons } }] : []; },
      getPinnedMessage: async (chat: bigint) => ({ message: pins.has(chat) ? { body: { mid: pins.get(chat) } } : null }),
      pinMessage: async (chat: bigint, mid: string) => { pins.set(chat, mid); return { success: true }; },
    };
    const storage = { load: async () => Buffer.alloc(0), remove: async () => undefined };
    const messages = new MaxMessageService(max as never, { prisma, storage: storage as never }, 8);
    const services = buildServices(prisma, { messages, storage: storage as never });
    const staff = await Promise.all(Array.from({ length: lanes }, async (_, n) => ({
      dispatcher: await actorFor(prisma, BigInt(92000 + n), `Распределитель ${n}`, [UserRole.DISPATCHER]),
      executor: await actorFor(prisma, BigInt(93000 + n), `Исполнитель ${n}`, [UserRole.RESPONDER]),
      reviewer: await actorFor(prisma, BigInt(94000 + n), `Куратор ${n}`, [UserRole.APPROVER]),
    })));
    const outsider = await actorFor(prisma, 95000n, 'Проверка чужого закрепления', [UserRole.ADMIN]);
    const groups = await prisma.responsibleGroup.findMany();
    const group = (code: string) => groups.find(g => g.code === code)!;
    type Actor = typeof outsider;
    const click = async (actor: Actor, chatId: bigint, id: string, action: string, arg?: string) => {
      const payload = parseCallbackPayload(`incident:${action}:${id}${arg ? ':' + arg : ''}`);
      if (!payload || payload.kind !== 'incident') throw Error('Invalid test callback');
      return handleIncidentCallback({ services, actor, chatId }, payload);
    };
    let duplicateChecks = 0;
    const confirm = async (actor: Actor, chat: bigint, id: string, duplicate = false) => {
      const session = (await services.sessions.find(actor.maxUserId, chat))!;
      const token = pendingConfirmation(session)!.token;
      if (!duplicate) { await click(actor, chat, id, 'action-confirm', token); return; }
      const results = await Promise.allSettled([click(actor, chat, id, 'action-confirm', token), click(actor, chat, id, 'action-confirm', token)]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); duplicateChecks++;
    };
    const input = async (actor: Actor, chat: bigint, text: string) => {
      const session = (await services.sessions.find(actor.maxUserId, chat))!;
      await handleOperatorMessage(services, actor, chat, { body: { mid: randomUUID(), text, attachments: [] } } as never, session);
    };
    const answer = async (actor: Actor, chat: bigint, id: string, text: string) => {
      await click(actor, chat, id, 'answer'); await input(actor, chat, text); await confirm(actor, chat, id);
      return (await services.repository.findById(id))!.answers.at(-1)!;
    };
    let next = 0, created = 0, completed = 0, active = 0, peakActive = 0, arrivalsDuringWork = 0, joined = 0;
    let stop = false; const durations: number[] = [], claimed = new Set<string>(), redistributed = new Set<string>();
    const start = performance.now();
    const checkTime = () => { if (performance.now() - start > 180_000) throw Error('Mixed load exceeded three minutes'); };
    const producers = Array.from({ length: 4 }, async () => {
      while (!stop) {
        checkTime();
        const n = next++; if (n >= total) return;
        // Keep arrivals going after every staff lane has started, even on a fast producer.
        while (n >= lanes && joined < lanes && !stop) { checkTime(); await delay(10); }
        if (stop) return;
        await services.incidents.create({ requester: { maxUserId: BigInt(100000 + n), name: 'Тестовый Житель', phone: '+79001112233' }, text: `Обращение нагрузки ${n}` });
        created++; if (active) arrivalsDuringWork++;
        await delay(150);
      }
    });
    const workers = staff.map(async ({ dispatcher, executor, reviewer }) => {
      let firstRun = true;
      while (!stop) {
        checkTime();
        const incident = await services.distributionQueue.claim(dispatcher, TEST_CHATS.distribution);
        if (!incident) { if (completed === total) return; await delay(20); continue; }
        if (claimed.has(incident.id)) expect(redistributed.has(incident.id)).toBe(true);
        claimed.add(incident.id);
        active++; peakActive = Math.max(peakActive, active); const begun = performance.now();
        // Start the first eight staff workflows together, rather than relying on scheduler timing.
        if (firstRun) {
          firstRun = false; joined++;
          while (joined < lanes && !stop) { checkTime(); await delay(10); }
          if (stop) return;
        }
        const id = incident.id, n = Number(incident.text.split(' ').at(-1)), branch = n % 8;
        await expect(services.distribution.assign(id, group(GROUP_CODES.facility).id, outsider)).rejects.toThrow();
        if (branch === 0) {
          await services.distribution.reject(id, `Причина отказа ${n}`, dispatcher);
        } else {
          const destination = group(branch === 7 ? GROUP_CODES.regional : redistributed.has(id) ? GROUP_CODES.it : GROUP_CODES.facility);
          await click(dispatcher, TEST_CHATS.distribution, id, 'assign-group', destination.id);
          if (branch === 1) {
            const draft = (await services.sessions.find(dispatcher.maxUserId, TEST_CHATS.distribution))!;
            await click(dispatcher, TEST_CHATS.distribution, id, 'action-cancel', pendingConfirmation(draft)!.token);
            expect((await services.repository.findById(id))!.status).toBe('DISTRIBUTION');
            await click(dispatcher, TEST_CHATS.distribution, id, 'assign-group', destination.id);
          }
          await confirm(dispatcher, TEST_CHATS.distribution, id, branch === 2);
          if (branch === 3 && !redistributed.has(id)) {
            await services.sector.takeInWork(id, executor);
            redistributed.add(id);
            await services.sector.returnToDistribution(id, executor, destination.maxChatId!, `Перенаправить ${n}`);
            active--; continue;
          }
          const author = branch === 7 ? dispatcher : executor;
          let current = await answer(author, destination.maxChatId!, id, `Ответ обращения ${n}, версия 1`);
          if (branch !== 7) {
            await services.workQueues.claimReview(reviewer, TEST_CHATS.review, id);
            await expect(services.review.approve(id, outsider, current.id)).rejects.toThrow();
            if (branch === 4 || branch === 5) {
              for (let cycle = 1; cycle <= (branch === 5 ? 2 : 1); cycle++) {
                await click(reviewer, TEST_CHATS.review, id, 'revision', current.id);
                await input(reviewer, TEST_CHATS.review, `Замечание ${n}, круг ${cycle}`);
                await confirm(reviewer, TEST_CHATS.review, id);
                const old = current;
                current = await answer(executor, destination.maxChatId!, id, `Ответ обращения ${n}, версия ${cycle + 1}`);
                await expect(services.review.approve(id, reviewer, old.id)).rejects.toThrow();
                await services.workQueues.claimReview(reviewer, TEST_CHATS.review, id);
              }
            }
            if (branch === 6) {
              await click(reviewer, TEST_CHATS.review, id, 'review-edit', current.id);
              await input(reviewer, TEST_CHATS.review, `Ответ обращения ${n}, правка куратора`);
              const session = (await services.sessions.find(reviewer.maxUserId, TEST_CHATS.review))!;
              await click(reviewer, TEST_CHATS.review, id, 'review-edit-save', reviewEditDraft(session).editToken);
              current = (await services.repository.findById(id))!.answers.at(-1)!;
            }
            await click(reviewer, TEST_CHATS.review, id, 'approve', current.id);
            await confirm(reviewer, TEST_CHATS.review, id, branch === 2);
          }
          // Approval queues delivery; a resident can rate only after actually receiving it.
          await messages.flush();
          const ready = await services.repository.findById(id);
          expect(ready!.answers.at(-1)!.deliveredAt).not.toBeNull();
          await services.incidents.rateAnswer(id, incident.requesterMaxUserId, 5);
        }
        expect((await services.repository.findById(id))!.deadlineAt).toEqual(incident.deadlineAt);
        completed++; active--; durations.push(performance.now() - begun);
        if (completed % 12 === 0) console.log(JSON.stringify({ completed, created, peakActive }));
      }
    });
    const background = (async () => {
      await delay(400);
      await services.workQueues.sweep();
      await services.distributionQueue.refresh();
      await services.workQueues.list(staff[0]!.reviewer, TEST_CHATS.review, 0, false, true);
      await services.reports.build({ title: 'Во время работы', slug: 'load' });
      await services.sla.sweep();
    })();
    const tasks = [...producers, ...workers, background].map(p => p.catch(error => { stop = true; throw error; }));
    const results = await Promise.allSettled(tasks);
    for (const r of results) if (r.status === 'rejected') throw r.reason;
    await messages.flush();
    expect(completed).toBe(total); expect(claimed.size).toBe(total);
    expect(peakActive).toBe(lanes); expect(arrivalsDuringWork).toBeGreaterThan(0); expect(duplicateChecks).toBe(24);
    const incidents = await prisma.incident.findMany({ include: { answers: { orderBy: { version: 'asc' } } } });
    expect(new Set(incidents.map(i => i.publicCode)).size).toBe(total);
    for (const i of incidents) {
      const n = Number(i.text.split(' ').at(-1));
      const delivered = [...sent.values()].filter(s => s.target === i.requesterMaxUserId && s.text.includes('Получен ответ по вашему обращению'));
      if (n % 8 === 0) { expect(i.status).toBe('REJECTED'); expect(delivered).toHaveLength(0); }
      else {
        expect(i.status).toBe('RESOLVED'); expect(i.responseRating).toBe(5);
        expect(delivered).toHaveLength(1); expect(delivered[0]!.text).toContain(i.answers.at(-1)!.text);
        expect(delivered[0]!.text).not.toContain('Замечание');
        expect(i.answers.filter(a => a.deliveredAt)).toHaveLength(1);
      }
    }
    expect(await prisma.outboundMessage.count({ where: { status: { not: 'SENT' } } })).toBe(0);
    expect(await prisma.operatorSession.count({ where: { maxUserId: { lt: 100000n } } })).toBe(0);
    expect(await prisma.actionLock.count({ where: { action: { in: ['review-queue', 'sector-queue'] } } })).toBe(0);
    durations.sort((a, b) => a - b);
    const metrics = { incidents: total, employees: lanes * 3, peakConcurrentWorkflows: peakActive, arrivalsDuringWork, duplicateConfirmationsChecked: duplicateChecks,
      resolved: incidents.filter(i => i.status === 'RESOLVED').length, rejected: incidents.filter(i => i.status === 'REJECTED').length,
      seconds: (performance.now() - start) / 1000, workflowP95Ms: durations[Math.ceil(durations.length * .95) - 1], messages: sent.size, errors: 0,
      boundary: 'Real PostgreSQL and application handlers/outbox; MAX transport simulated, 2 ms per send. Resident registration enters through IncidentService; webhook ingress is tested separately.' };
    mkdirSync('tmp/load-results', { recursive: true }); writeFileSync('tmp/load-results/concurrent-staff.json', JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics));
  }, 240_000);
});
