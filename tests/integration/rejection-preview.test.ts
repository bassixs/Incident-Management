import { type PrismaClient, UserRole } from '@prisma/client';
import ExcelJS from 'exceljs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { randomUUID } from 'node:crypto';
import { acceptRejectionText, rejectionDraft, resumeRejection } from '../../src/bot/callbacks/rejection-flow';
import { REJECTION_REASONS } from '../../src/distribution/rejection-reasons';
import { parseCallbackPayload, type IncidentAction } from '../../src/max/callback-payload';
import { discardObsoleteSession } from '../../src/bot/handlers/session-guard';
import * as outbox from '../../src/delivery/workflow-outbox';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS, TEST_USERS } from '../helpers/setup-env';

describeIntegration('rejection reasons, preview and employee report', () => {
  let prisma: PrismaClient, h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>, colleague: typeof actor;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    actor = await actorFor(prisma, TEST_USERS.admin, 'Иванов Иван Иванович', [UserRole.ADMIN]);
    colleague = await actorFor(prisma, 9999n, 'Петров Пётр Петрович', [UserRole.ADMIN]);
  });
  const create = () => h.services.incidents.create({ requester: { maxUserId: TEST_USERS.requesterA, name: 'Иванов Алексей', phone: '+79001234567' }, text: 'Проблема во дворе' });
  const session = async () => (await h.services.sessions.find(actor.maxUserId, TEST_CHATS.distribution))!;
  const click = (id: string, action: IncidentAction, argument?: string, who = actor, chatId = TEST_CHATS.distribution) =>
    handleIncidentCallback({ services: h.services, actor: who, chatId }, { kind: 'incident', incidentId: id, action, argument });
  async function choose(id: string, rule = '5') { const data = rejectionDraft(await session()); await click(id, 'reject-reason', `${data.rejectionToken}.${rule}`); }
  const rejected = () => h.messages.toUser(TEST_USERS.requesterA).filter(m => m.message.text.includes('отклонено'));

  it('offers all eight rule reasons plus Other and sends nothing before explicit confirmation', async () => {
    const i = await create(); await click(i.id, 'reject');
    const buttons = h.messages.sent.at(-1)!.message.keyboard!.flat();
    expect(buttons.map(b => b.text)).toEqual([...REJECTION_REASONS.map(r => r.label), 'Иное', 'Отмена']);
    expect(buttons.every(b => parseCallbackPayload((b as { payload: string }).payload))).toBe(true);
    await choose(i.id);
    expect(h.messages.sent.at(-1)!.message.text).toContain('пункт 5');
    expect(h.messages.sent.at(-1)!.message.keyboard!.flat().map(b => b.text)).toEqual(['Верно', 'Исправить', 'Отмена']);
    expect((await h.services.repository.findById(i.id))!.status).toBe('DISTRIBUTION'); expect(rejected()).toHaveLength(0);
    const token = rejectionDraft(await session()).rejectionToken;
    await click(i.id, 'reject-confirm', token);
    expect(rejected()).toHaveLength(1); expect(rejected()[0]!.message.text).toContain(REJECTION_REASONS[4]!.reason);
    expect(await session()).toBeNull();
    await expect(click(i.id, 'reject-confirm', token)).rejects.toThrow('устарела'); expect(rejected()).toHaveLength(1);
  });

  it('previews Other, allows editing, rejects old preview and sends exactly the corrected text', async () => {
    const i = await create(); await click(i.id, 'reject'); await choose(i.id, 'other');
    await acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), 'Причина сотрудника');
    const old = rejectionDraft(await session()).rejectionToken;
    await click(i.id, 'reject-edit', old);
    await expect(click(i.id, 'reject-confirm', old)).rejects.toThrow('устарела');
    await acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), 'Исправленная причина');
    expect(rejected()).toHaveLength(0);
    await click(i.id, 'reject-confirm', rejectionDraft(await session()).rejectionToken);
    expect(rejected()[0]!.message.text).toContain('Исправленная причина'); expect(rejected()[0]!.message.text).not.toContain('Причина сотрудника');
  });

  it('cancels without rejecting and prevents a cancelled or foreign card being confirmed', async () => {
    const i = await create(); await click(i.id, 'reject'); await choose(i.id);
    const token = rejectionDraft(await session()).rejectionToken;
    await expect(click(i.id, 'reject-confirm', token, colleague)).rejects.toThrow();
    await expect(click(i.id, 'reject-confirm', token, actor, TEST_CHATS.sector)).rejects.toThrow();
    await click(i.id, 'reject-cancel', token);
    await expect(click(i.id, 'reject-confirm', token)).rejects.toThrow();
    expect((await h.services.repository.findById(i.id))!.status).toBe('DISTRIBUTION'); expect(rejected()).toHaveLength(0);
  });

  it('rejects blank/oversized text and accidental text during the choice and preview steps', async () => {
    const i = await create(); await click(i.id, 'reject');
    await expect(acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), 'Случайный текст')).rejects.toThrow('Выберите');
    await choose(i.id, 'other');
    for (const text of ['  ', 'а'.repeat(2001)]) await expect(acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), text)).rejects.toThrow('2000');
    await acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), 'Причина');
    await expect(acceptRejectionText(h.services, actor, TEST_CHATS.distribution, await session(), 'Случайный текст')).rejects.toThrow('Исправить');
    expect(rejected()).toHaveLength(0);
  });

  it('expires a preview with its reservation and resumes a valid preview with buttons', async () => {
    const i = await create(); await click(i.id, 'reject'); await choose(i.id);
    const pending = await session(); await resumeRejection(h.services, pending);
    expect(h.messages.sent.at(-1)!.message.keyboard!.flat().map(b => b.text)).toContain('Верно');
    await prisma.incident.update({ where: { id: i.id }, data: { distributionClaimUntil: new Date(Date.now() - 1) } });
    await expect(click(i.id, 'reject-confirm', rejectionDraft(pending).rejectionToken)).rejects.toThrow('устарела');
    expect(await discardObsoleteSession(h.services, pending)).toBe(true); expect(rejected()).toHaveLength(0);
  });

  it('keeps the draft and incident when queuing the rejection fails', async () => {
    const i = await create(); await click(i.id, 'reject'); await choose(i.id);
    const token = rejectionDraft(await session()).rejectionToken;
    vi.spyOn(outbox, 'queueRejection').mockRejectedValueOnce(new Error('queue failed'));
    await expect(click(i.id, 'reject-confirm', token)).rejects.toThrow('queue failed');
    expect(rejectionDraft(await session()).rejectionToken).toBe(token);
    expect((await h.services.repository.findById(i.id))!.status).toBe('DISTRIBUTION');
    expect(await prisma.incidentHistory.count({ where: { incidentId: i.id, action: 'INCIDENT_REJECTED' } })).toBe(0);
    await click(i.id, 'reject-confirm', token); expect(rejected()).toHaveLength(1);
  });

  it('serializes editing against confirmation so an obsolete text cannot win after the edit', async () => {
    const i = await create(); await click(i.id, 'reject'); await choose(i.id);
    const token = rejectionDraft(await session()).rejectionToken;
    const results = await Promise.allSettled([click(i.id, 'reject-edit', token), click(i.id, 'reject-confirm', token)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const current = (await h.services.repository.findById(i.id))!;
    if (current.status === 'REJECTED') expect(rejected()).toHaveLength(1);
    else { expect(rejectionDraft(await session()).rejectionStage).toBe('text'); expect(rejected()).toHaveLength(0); }
  });

  it('exports the rejection employee snapshot including previous rejections without attributing it to others', async () => {
    const i = await create(); await h.services.distribution.reject(i.id, 'Историческая причина', actor);
    await prisma.user.update({ where: { id: actor.userId }, data: { displayName: 'Новое имя профиля' } });
    const active = await create();
    const result = await h.services.reports.build({ title: 'Все', slug: 'all' });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(result.buffer as never);
    const sheet = workbook.getWorksheet('Обращения')!;
    const headers = sheet.getRow(1).values as string[];
    const column = headers.indexOf('Отклонил (ФИО сотрудника)'); expect(column).toBeGreaterThan(0);
    let found = false;
    sheet.eachRow((row, number) => { if (number === 1) return;
      if (row.getCell(3).value === i.publicCode) { expect(row.getCell(column).value).toBe('Иванов Иван Иванович'); found = true; }
      if (row.getCell(3).value === active.publicCode) expect(row.getCell(column).value ?? '').toBe('');
    });
    expect(found).toBe(true);
  });

  it('runs through real routers and can restart immediately after cancellation', async () => {
    h.services.max = { answerCallback: vi.fn(async () => undefined) } as never;
    const person = { user_id: Number(actor.maxUserId), name: actor.displayName, is_bot: false, username: null, last_activity_time: 0 };
    const recipient = { chat_id: Number(TEST_CHATS.distribution), chat_type: 'chat' };
    const routeClick = async (payload: string) => handleCallbackUpdate(h.services, { update: {
      update_type: 'message_callback', timestamp: Date.now(), callback: { callback_id: randomUUID(), user: person, payload },
      message: { sender: { ...person, is_bot: true }, recipient, body: { mid: randomUUID() } },
    } } as never);
    const i = await create(); await routeClick(`incident:reject:${i.id}`);
    await routeClick(`incident:reject-cancel:${i.id}:${rejectionDraft(await session()).rejectionToken}`);
    await routeClick(`incident:reject:${i.id}`);
    expect(rejectionDraft(await session()).rejectionStage).toBe('choose');
    await routeClick(`incident:reject-reason:${i.id}:${rejectionDraft(await session()).rejectionToken}.other`);
    await handleMessageUpdate(h.services, { update: { update_type: 'message_created', timestamp: Date.now(),
      message: { sender: person, recipient, body: { mid: randomUUID(), text: 'Причина через рабочий чат' } },
    } } as never);
    expect(rejected()).toHaveLength(0); expect(rejectionDraft(await session()).rejectionStage).toBe('preview');
    await routeClick(`incident:reject-confirm:${i.id}:${rejectionDraft(await session()).rejectionToken}`);
    expect(rejected()).toHaveLength(1); expect(rejected()[0]!.message.text).toContain('Причина через рабочий чат');
  });
});
