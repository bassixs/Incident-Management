import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { type PrismaClient, UserRole } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleMembershipUpdate } from '../../src/bot/handlers/membership.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { resolveActor } from '../../src/bot/handlers/helpers';
import { assertApprover, assertDispatcher, assertResponder, requirePermission } from '../../src/bot/middleware/authorize';
import { chatInfoText } from '../../src/bot/views/chat-info';
import { incidentCallback } from '../../src/max/callback-payload';
import { SUBSCRIBED_UPDATE_TYPES, type Update } from '../../src/max/max-types';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { buildServices } from '../../src/app/container';
import { registerHandlers } from '../../src/bot/bot';
import { MaxMessageService } from '../../src/max/max-message.service';
import { createHarness, createTestPrisma, describeIntegration, GROUP_CODES, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { TEST_CHATS } from '../helpers/setup-env';

const person = (id = 86001) => ({ user_id: id, name: `Сотрудник ${id}`, is_bot: false, username: null, last_activity_time: 0 });
const membership = (chatId: bigint, type: 'user_added' | 'user_removed' = 'user_added', id = 86001, timestamp = 1): Update =>
  ({ update_type: type, chat_id: Number(chatId), user: person(id), timestamp, is_channel: false }) as Update;

describeIntegration('automatic access in configured work chats', () => {
  let prisma: PrismaClient; let h: TestHarness;
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    h.services.max = { answerCallback: vi.fn(async () => undefined) } as never;
  });
  async function command(chatId: bigint, text: string, dialog = false, id = 86001) {
    await handleMessageUpdate(h.services, { update: { update_type: 'message_created', timestamp: Date.now(),
      message: { sender: person(id), recipient: { chat_id: Number(chatId), chat_type: dialog ? 'dialog' : 'chat' },
        body: { mid: randomUUID(), text } } } } as never);
  }
  async function click(chatId: bigint, payload: string, id = 86001) {
    await handleCallbackUpdate(h.services, { update: { update_type: 'message_callback', timestamp: Date.now(),
      callback: { callback_id: randomUUID(), user: person(id), payload },
      message: { sender: { ...person(999), is_bot: true }, recipient: { chat_id: Number(chatId), chat_type: 'chat' }, body: { mid: randomUUID() } } } } as never);
  }
  async function incident() {
    return h.services.incidents.create({ requester: { maxUserId: 87001n, name: 'Житель Тест', phone: '+79001112233' }, text: 'Не горит фонарь' });
  }
  const lastText = () => h.messages.sent.at(-1)!.message.text;

  it('derives roles independently in every chat, never granting global or administrator access', async () => {
    const [dispatch, review, sector, regional, delivery, privateActor, stranger] = await Promise.all([
      TEST_CHATS.distribution, TEST_CHATS.review, TEST_CHATS.sector, TEST_CHATS.regional, -1005n, undefined, -99999n,
    ].map(chat => resolveActor(h.services, person(), chat)));
    expect(dispatch!.roles).toContain(UserRole.DISPATCHER);
    expect(() => assertDispatcher(h.services, dispatch!, TEST_CHATS.distribution)).not.toThrow();
    expect(review!.roles).toContain(UserRole.APPROVER);
    expect(() => assertApprover(h.services, review!, TEST_CHATS.review)).not.toThrow();
    expect(sector!.roles).toEqual([UserRole.REQUESTER, UserRole.RESPONDER]);
    expect(regional!.roles).toContain(UserRole.DISPATCHER);
    expect(() => requirePermission(delivery!, 'delivery.manage')).not.toThrow();
    for (const actor of [dispatch, review, sector, regional, delivery, privateActor, stranger]) expect(() => requirePermission(actor!, 'admin.manage')).toThrow();
    expect(privateActor!.roles).toEqual([UserRole.REQUESTER]); expect(stranger!.workingChat).toBeUndefined();
    expect(() => assertApprover(h.services, dispatch!, TEST_CHATS.review)).toThrow();
    expect((await prisma.user.findUniqueOrThrow({ where: { maxUserId: 86001n } })).roles).toEqual([]);
  });

  it('runs assignment, answering and approval through real routers for employees without manual roles', async () => {
    const row = await incident();
    const group = (await h.services.responsibleGroups.findByCode(GROUP_CODES.facility))!;
    await click(TEST_CHATS.distribution, incidentCallback('assign-group', row.id, group.id));
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('ASSIGNED');
    await click(TEST_CHATS.sector, incidentCallback('answer', row.id), 86002);
    expect((await h.services.sessions.find(86002n, TEST_CHATS.sector))?.type).toBe('WAITING_FOR_ANSWER');
    await command(TEST_CHATS.sector, 'Фонарь отремонтирован', false, 86002);
    const answer = await prisma.incidentAnswer.findFirstOrThrow({ where: { incidentId: row.id } });
    expect(answer.text).toBe('Фонарь отремонтирован');
    await click(TEST_CHATS.review, incidentCallback('approve', row.id, answer.id), 86003);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('RESOLVED');
    expect(await prisma.user.count({ where: { roles: { isEmpty: false } } })).toBe(0);
  });

  it('welcomes a new member once despite webhook duplicates and supports a later rejoin', async () => {
    const max = { sendToChat: vi.fn(async () => ({ body: { mid: randomUUID() } })) };
    const messages = new MaxMessageService(max as never, { prisma, storage: {} as never });
    const services = buildServices(prisma, { messages });
    registerHandlers(services);
    const dispatcher = new UpdateDispatcher(prisma, services.max, 8);
    const joined = membership(TEST_CHATS.review);
    expect(SUBSCRIBED_UPDATE_TYPES).toContain('user_added'); expect(SUBSCRIBED_UPDATE_TYPES).toContain('user_removed');
    await Promise.all([dispatcher.reserve(joined), dispatcher.reserve(joined)]);
    await dispatcher.kick(); await messages.flush();
    expect(max.sendToChat).toHaveBeenCalledTimes(1);
    expect(max.sendToChat.mock.calls[0]).toEqual(expect.arrayContaining([expect.stringContaining('согласующий')]));
    expect(await prisma.inboundUpdate.count({ where: { status: 'PROCESSED' } })).toBe(1);
    await dispatcher.reserve(membership(TEST_CHATS.review, 'user_removed', 86001, 2));
    await dispatcher.reserve(membership(TEST_CHATS.review, 'user_added', 86001, 3));
    await dispatcher.kick(); await messages.flush();
    expect(max.sendToChat).toHaveBeenCalledTimes(2);
  });

  it('existing members get suitable info and working commands on their first message without rejoining', async () => {
    await command(TEST_CHATS.distribution, '/info');
    expect(lastText()).toContain('Распределение обращений'); expect(lastText()).toContain('/queue');
    expect(lastText()).toContain('/report'); expect(lastText()).not.toContain('/role');
    await command(TEST_CHATS.distribution, '/report');
    expect(lastText()).toContain('За какой период');
    await command(TEST_CHATS.review, '/info');
    expect(lastText()).toContain('Согласование ответов'); expect(lastText()).not.toContain('/queue');
    expect(lastText()).not.toContain('/report');
    await command(TEST_CHATS.sector, '/help');
    expect(lastText()).toContain('Хозяйственная группа'); expect(lastText()).toContain('срок приостановлен');
    expect(lastText()).not.toContain('/delivery_retry'); expect(lastText()).not.toContain('/role');
    await command(TEST_CHATS.regional, '/info'); expect(lastText()).toContain('без отдельного согласования');
  });

  it('grants delivery commands in the alert chat without granting administrative commands', async () => {
    await command(-1005n, '/info'); expect(lastText()).toContain('/delivery_retry'); expect(lastText()).not.toContain('/role');
    await command(-1005n, '/delivery_status'); expect(lastText()).toContain('Очереди доставки:');
    await command(-1005n, '/delivery_retry'); expect(lastText()).toContain('Неудачных исходящих доставок нет');
    await command(-1005n, '/role 86001 ADMIN'); expect(lastText()).toContain('нет прав');
    await command(TEST_CHATS.sector, '/delivery_status'); expect(lastText()).toContain('нет прав');
    await command(86001n, '/delivery_status', true); expect(lastText()).toContain('нет прав');
  });

  it('automatically lets existing and new system-chat members build reports by command, buttons and custom dates', async () => {
    const row = await incident();
    await prisma.incident.update({ where: { id: row.id }, data: { deadlineAt: new Date(Date.now() - 3_600_000) } });
    await handleMembershipUpdate(h.services, { update: membership(-1005n) } as never);
    expect(lastText()).toContain('аналитика и отчёты'); expect(lastText()).toContain('/info');
    await command(-1005n, '/info'); expect(lastText()).toContain('/report'); expect(lastText()).toContain('Excel придёт в этот же чат');
    await command(-1005n, '/report', false, 86002);
    expect(lastText()).toContain('За какой период');
    await command(-1005n, '/report 7d', false, 86002);
    await click(-1005n, 'report:all');
    await click(-1005n, 'report:custom');
    expect((await h.services.sessions.find(86001n, -1005n))?.type).toBe('WAITING_REPORT_PERIOD');
    await command(-1005n, '01.01.2020 - 31.12.2099');
    expect(await h.services.sessions.find(86001n, -1005n)).toBeNull();
    const files = h.messages.sent.filter(m => m.message.attachments?.some(a => a.type === 'FILE'));
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect(file.target).toEqual({ chatId: -1005n });
      const attachment = file.message.attachments![0]!;
      if (!('body' in attachment)) throw new Error('Missing report body');
      const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(attachment.body as never);
      expect(workbook.worksheets.map(s => s.name)).toEqual(['Обращения', 'Просроченные']);
      expect(workbook.worksheets[1]!.getCell(4, 1).value).toBe(row.publicCode);
    }
    expect((await resolveActor(h.services, person())).roles).toEqual([UserRole.REQUESTER]);
    await command(TEST_CHATS.sector, '/report'); expect(lastText()).toContain('нет прав');
    await command(86001n, '/report', true); expect(lastText()).toContain('нет прав');
    expect(h.messages.sent.filter(m => m.message.attachments?.length)).toHaveLength(3);
  });

  it('does not expose other sectors via lookup, history, resend or copied buttons', async () => {
    const row = await incident(); const group = (await h.services.responsibleGroups.findByCode(GROUP_CODES.facility))!;
    const actor = await resolveActor(h.services, person(), TEST_CHATS.distribution);
    await h.services.distribution.assign(row.id, group.id, actor);
    for (const name of ['incident', 'history', 'resend']) {
      await command(TEST_CHATS.otherSector, `/${name} ${row.publicCode}`); expect(lastText()).toContain('только обращения');
    }
    await command(TEST_CHATS.sector, `/incident ${row.publicCode}`);
    expect(lastText()).toContain(row.publicCode); expect(lastText()).toContain('Хозяйственная группа');
    await click(TEST_CHATS.otherSector, incidentCallback('answer', row.id));
    expect(await h.services.sessions.find(86001n, TEST_CHATS.otherSector)).toBeNull();
    expect(h.services.max.answerCallback).toHaveBeenLastCalledWith(expect.any(String), expect.stringContaining('профильном чате'));
  });

  it('removes contextual access when a group is disabled or moved, while preserving manual ADMIN', async () => {
    await command(TEST_CHATS.sector, '/whoami'); expect(lastText()).toContain('RESPONDER');
    const group = (await h.services.responsibleGroups.findByCode(GROUP_CODES.facility))!;
    await prisma.responsibleGroup.update({ where: { id: group.id }, data: { isActive: false } });
    expect((await resolveActor(h.services, person(), TEST_CHATS.sector)).roles).toEqual([UserRole.REQUESTER]);
    await prisma.responsibleGroup.update({ where: { id: group.id }, data: { isActive: true, maxChatId: -1019n } });
    expect((await resolveActor(h.services, person(), TEST_CHATS.sector)).workingChat).toBeUndefined();
    expect((await resolveActor(h.services, person(), -1019n)).roles).toContain(UserRole.RESPONDER);
    await prisma.user.update({ where: { maxUserId: 86001n }, data: { roles: [UserRole.ADMIN] } });
    await handleMembershipUpdate(h.services, { update: membership(-1019n, 'user_removed') } as never);
    expect((await resolveActor(h.services, person())).roles).toContain(UserRole.ADMIN);
  });

  it('ignores bot/channel/foreign joins and clears only the leaving employee’s session in that chat', async () => {
    await handleMembershipUpdate(h.services, { update: membership(-99999n) } as never);
    await handleMembershipUpdate(h.services, { update: { ...membership(TEST_CHATS.review), is_channel: true } } as never);
    await handleMembershipUpdate(h.services, { update: { ...membership(TEST_CHATS.review), user: { ...person(), is_bot: true } } } as never);
    expect(h.messages.sent).toHaveLength(0); expect(await prisma.user.count()).toBe(0);
    for (const [id, chat] of [[86001n, TEST_CHATS.review], [86001n, TEST_CHATS.sector], [86002n, TEST_CHATS.review]]) {
      await h.services.sessions.start({ maxUserId: id!, chatId: chat!, type: 'WAITING_REPORT_PERIOD' });
    }
    await handleMembershipUpdate(h.services, { update: membership(TEST_CHATS.review, 'user_removed') } as never);
    expect(await h.services.sessions.find(86001n, TEST_CHATS.review)).toBeNull();
    expect(await prisma.operatorSession.count()).toBe(2);
  });

  it('gives a public explanation in private/unknown chats and combines configured chat purposes', async () => {
    await command(86001n, '/info', true); expect(lastText()).toContain('/my'); expect(lastText()).not.toContain('/queue');
    await command(-99999n, '/info'); expect(lastText()).toContain('пока не настроен'); expect(lastText()).not.toContain('/report');
    const combined = { ...h.services, config: { ...h.services.config, REVIEW_CHAT_ID: TEST_CHATS.distribution } };
    const actor = await resolveActor(combined, person(), TEST_CHATS.distribution);
    const text = await chatInfoText(combined, actor, TEST_CHATS.distribution, false);
    expect(text).toContain('Распределение обращений'); expect(text).toContain('Согласование ответов');
    expect(actor.roles).toEqual(expect.arrayContaining([UserRole.DISPATCHER, UserRole.APPROVER]));
    const assigned = { assignedGroup: { maxChatId: TEST_CHATS.regional, bypassReview: true }, publicCode: 'test' };
    const regionalActor = await resolveActor(h.services, person(), TEST_CHATS.regional);
    expect(() => assertResponder(regionalActor, assigned as never, TEST_CHATS.regional)).not.toThrow();
  });
});
