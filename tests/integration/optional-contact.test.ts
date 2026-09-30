import { createHmac } from 'node:crypto';
import ExcelJS from 'exceljs';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { InboxStatus, UserRole, type PrismaClient } from '@prisma/client';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';
import { minimiseInbound } from '../../src/privacy/inbound-privacy';
import { revealResidentContact } from '../../src/privacy/staff-contact';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { getConfig } from '../../src/config';
import { TEST_CHATS } from '../helpers/setup-env';
import { distributionCard, sectorCard } from '../../src/bot/views/cards';
import { personalAction } from '../../src/work-queues/private-workspace';
import type { SessionData } from '../../src/sessions/operator-session.service';
import type { UserAction } from '../../src/max/callback-payload';

describeIntegration('optional per-message contact', () => {
  let prisma: PrismaClient; let h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  const phone = '+7 999 123-45-67';
  const draft = { selectedCategoryId: null, problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга', problemLocality: null, draftText: 'Яма у дома 12 на улице Ленина', draftMedia: [] };
  beforeAll(async () => { pushSchemaOnce(); prisma = createTestPrisma(); await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); actor = await actorFor(prisma, 555n, 'Житель', []); });
  const data = async () => (await prisma.operatorSession.findUniqueOrThrow({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } })).data as SessionData;
  const preview = async (values = draft) => showIncidentDraftPreview(h.services, 555n, 555n, values);
  const click = async (action: UserAction, argument?: string) => handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: `cb-${Math.random()}`, messageId: undefined }, { kind: 'user', action, argument: argument ?? (await data()).previewToken });
  const rawContact = (overrides: Record<string, unknown> = {}) => {
    const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nTEL;TYPE=cell:79991234567\r\nFN:Private Name\r\nEND:VCARD\r\n';
    return { update_type: 'message_created', timestamp: Date.now(), message: { timestamp: Date.now(), sender: { user_id: 555, name: 'Private Name', username: 'private-username' }, recipient: { chat_type: 'dialog', chat_id: 555 }, body: { mid: 'own-contact', text: null, attachments: [{ type: 'contact', payload: { vcf_info: vcf, hash: createHmac('sha256', getConfig().BOT_TOKEN).update(vcf).digest('hex'), max_info: { user_id: 555 }, ...overrides } }] } } };
  };
  const receive = async () => {
    const value = await minimiseInbound(rawContact() as never, prisma) as any;
    expect(value.privacyRejected).toBeUndefined();
    await handleRequesterMessage(h.services, actor, 555n, value.message, value.verifiedDraftContact);
    return value;
  };
  const withPhone = async () => { await preview(); await receive(); };
  const removePhone = async () => { await click('draft-edit'); await click('draft-phone-remove'); };
  const register = async () => { await click('draft-confirm'); return prisma.incident.findFirstOrThrow(); };

  it('keeps the no-phone path and does not consume quota for previews', async () => {
    await preview(); expect(await prisma.incident.count()).toBe(0);
    const incident = await register(); expect(incident.requesterPhone).toBeNull();
    expect(await prisma.legalAcceptance.count()).toBe(0);
  });
  it('starts with only the topic prompt and topic buttons', async () => {
    await click('new', 'unused');
    expect(h.messages.toUser(555n).at(-1)?.message.text).toBe('Выберите тему сообщения');
    expect(h.messages.toUser(555n).at(-1)?.message.keyboard?.flat().length).toBeGreaterThan(0);
    expect(await data()).toEqual({});
  });
  it('removes via correction and offers contact again, then adds it again without confirmation', async () => {
    await withPhone();
    await expect(click('draft-phone-remove')).rejects.toThrow('устарела');
    await click('draft-edit');
    const removal = h.messages.toUser(555n).at(-1)?.message.keyboard?.flat().find(b => b.text === 'Убрать номер');
    expect(removal).toMatchObject({ type: 'callback', payload: `user:draft-phone-remove:${(await data()).previewToken}` });
    const oldEditToken = (await data()).previewToken;
    await click('draft-phone-remove');
    expect((await data()).requesterPhone).toBeUndefined();
    expect(h.messages.toUser(555n).at(-1)?.message.keyboard?.flat()).toContainEqual({ type: 'request_contact', text: '📞 Поделиться контактом' });
    await receive();
    expect((await data()).requesterPhone).toBe(phone);
    expect((await minimiseInbound(rawContact() as never, prisma) as any).privacyRejected).toBe(true);
    await expect(click('draft-phone-use')).rejects.toThrow('устарела');
    await click('draft-edit');
    await expect(click('draft-phone-remove', oldEditToken)).rejects.toThrow('устарела');
    expect((await data()).requesterPhone).toBe(phone);
    expect(await prisma.incident.count()).toBe(0);
  });
  it('does not attach a delayed verified contact after submission or to a later draft', async () => {
    await preview();
    const old = await minimiseInbound(rawContact() as never, prisma) as any;
    const incident = await register();
    expect(incident.requesterPhone).toBeNull();
    await handleRequesterMessage(h.services, actor, 555n, old.message, old.verifiedDraftContact);
    expect(await prisma.operatorSession.count()).toBe(0);
    expect((await minimiseInbound(rawContact() as never, prisma) as any).privacyRejected).toBe(true);
    await preview();
    await handleRequesterMessage(h.services, actor, 555n, old.message, old.verifiedDraftContact);
    expect((await data()).requesterPhone).toBeUndefined();
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).requesterPhone).toBeNull();
  });
  it.each(['cancel', 'submit', 'replace', 'expire'] as const)('rechecks the database before saving a contact racing with %s', async (action) => {
    await preview();
    const value = await minimiseInbound(rawContact() as never, prisma) as any;
    const replace = h.services.sessions.replaceCurrent.bind(h.services.sessions);
    const spy = vi.spyOn(h.services.sessions, 'replaceCurrent').mockImplementationOnce(async (...args) => {
      if (action === 'submit') await register();
      else if (action === 'expire') await prisma.operatorSession.updateMany({ data: { expiresAt: new Date(0) } });
      else { await click('draft-cancel'); if (action === 'replace') await preview(); }
      return replace(...args);
    });
    await expect(handleRequesterMessage(h.services, actor, 555n, value.message, value.verifiedDraftContact)).rejects.toThrow('Черновик изменился');
    expect(spy).toHaveBeenCalledTimes(1);
    const sessions = await prisma.operatorSession.findMany();
    expect(sessions.every(s => !(s.data as SessionData).requesterPhone)).toBe(true);
    expect((await prisma.incident.findMany()).every(i => i.requesterPhone === null)).toBe(true);
  });
  it.each(['cancel', 'replace', 'submit'] as const)('does not recreate the old session when MAX finishes sending after %s', async (action) => {
    await preview();
    let lateMessageId: string | undefined;
    const send = h.services.messages.send.bind(h.services.messages);
    vi.spyOn(h.services.messages, 'send').mockImplementationOnce(async (...args) => {
      const result = await send(...args);
      lateMessageId = result.firstMessageId;
      if (action === 'submit') await register();
      else {
        await h.services.sessions.clear(555n, 555n);
        if (action === 'replace') await preview();
      }
      return result;
    });
    await receive();
    expect(await prisma.operatorSession.count()).toBe(action === 'replace' ? 1 : 0);
    if (action === 'replace') expect((await data()).requesterPhone).toBeUndefined();
    expect(h.messages.deleted).toContain(lateMessageId);
    expect(await prisma.incident.count()).toBe(action === 'submit' ? 1 : 0);
    if (action === 'submit') expect((await prisma.incident.findFirstOrThrow()).requesterPhone).toBe(phone);
  });
  it('rejects contacts timestamped before the preview but cannot identify an old native button pressed now', async () => {
    await preview(); const old = rawContact();
    old.message.timestamp = Number((await data()).previewStartedAt) - 1;
    expect((await minimiseInbound(old as never, prisma) as any).privacyRejected).toBe(true);
    await click('draft-cancel'); await preview();
    // MAX provides no draft/button ID. A fresh signed event from an old button
    // is indistinguishable from pressing the current native button.
    await receive(); expect((await data()).requesterPhone).toBe(phone);
    expect(await prisma.incident.count()).toBe(0);
  });
  it('falls back to removing controls when MAX refuses to delete an obsolete preview', async () => {
    await preview(); const oldId = (await data()).previewMessageId!;
    vi.spyOn(h.services.messages, 'deleteCard').mockResolvedValue(false);
    await receive();
    expect(h.messages.edits).toContainEqual({ messageId: oldId, text: 'Карточка устарела. Используйте текущую карточку сообщения.', mode: 'finalize' });
    const currentId = (await data()).previewMessageId!;
    await register();
    expect(h.messages.edits.some(edit => edit.messageId === currentId && edit.mode === 'finalize')).toBe(true);
  });
  it('drops an old pending phone on upgrade instead of binding it or keeping the old confirmation', async () => {
    await preview();
    await prisma.operatorSession.updateMany({ data: { data: { ...(await data()), pendingPhone: phone } } });
    await click('draft-confirm');
    expect((await data()).requesterPhone).toBeUndefined();
    expect((await data()).pendingPhone).toBeUndefined();
    expect(await prisma.incident.count()).toBe(0);
    expect(h.messages.toUser(555n).at(-1)?.message.text).not.toContain(phone);
  });
  it('minimizes before the inbox, immediately attaches own contact and waits for ordinary submission', async () => {
    await preview(); const value = await receive();
    expect(JSON.stringify(value)).not.toMatch(/Private Name|private-username|vcf_info|hash|79991234567/);
    expect((await data()).requesterPhone).toBe(phone); expect((await data()).pendingPhone).toBeUndefined();
    expect(await prisma.incident.count()).toBe(0);
    expect(h.messages.toUser(555n).at(-1)?.message.text).toContain(`Телефон для связи: ${phone}`);
    expect(h.messages.toUser(555n).at(-1)?.message.keyboard?.flat().map(b => b.text)).toEqual(['✅ Всё верно', '✏️ Исправить', 'Отмена']);
    const incident = await register(); expect(incident.requesterPhone).toBe(phone);
    const user = await prisma.user.findUniqueOrThrow({ where: { maxUserId: 555n } });
    expect(user.requesterPhone).toBeNull(); expect(user.requesterName).toBeNull();
    await h.services.users.upsertFromMax({ user_id: 555, name: 'ignored', username: null });
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).requesterPhone).toBe(phone);
    await click('new', 'unused'); expect(await data()).toEqual({});
  });
  it('removes a phone, cancels the draft and ignores delayed contact from the old preview', async () => {
    await withPhone(); await removePhone(); expect((await data()).requesterPhone).toBeUndefined();
    const old = await minimiseInbound(rawContact() as never, prisma) as any;
    const oldToken = (await data()).previewToken;
    await click('draft-cancel'); expect(await prisma.operatorSession.count()).toBe(0);
    expect((await minimiseInbound(rawContact() as never, prisma) as any).privacyRejected).toBe(true);
    await preview();
    await handleRequesterMessage(h.services, actor, 555n, old.message, old.verifiedDraftContact);
    expect((await data()).requesterPhone).toBeUndefined();
    await expect(click('draft-cancel', oldToken)).rejects.toThrow('устарела');
    await expect(click('draft-confirm', oldToken)).rejects.toThrow('устарела');
    expect(await prisma.incident.count()).toBe(0);
  });
  it('preserves an attached phone through text, category, location and photo previews', async () => {
    await withPhone();
    await click('draft-edit'); await click('draft-field', 'text');
    await handleRequesterMessage(h.services, actor, 555n, { body: { mid: 'edit', text: 'Не горит фонарь у дома 12', attachments: [] } } as never);
    expect((await data()).requesterPhone).toBe(phone);
    await click('draft-edit'); await click('draft-field', 'category');
    const categoryId = (await prisma.category.findFirstOrThrow()).id;
    await click('category', categoryId); expect((await data()).requesterPhone).toBe(phone);
    await click('draft-edit'); await click('draft-field', 'location');
    await click('municipality', `${categoryId}~KALUGA_CITY`);
    // A city without subordinate localities returns directly to the preview.
    const location = await prisma.operatorSession.findFirstOrThrow();
    if (location.type === 'WAITING_INCIDENT_SELECTION') await click('locality', `${categoryId}~KALUGA_CITY~skip`);
    expect((await data()).requesterPhone).toBe(phone);
    await click('draft-edit'); await click('draft-field', 'photo'); await click('draft-photo', 'replace');
    await handleRequesterMessage(h.services, actor, 555n, { body: { mid: 'photo', text: null, attachments: [{ type: 'image', payload: { token: 'photo' } }] } } as never);
    expect((await data()).requesterPhone).toBe(phone);
    const incident = await register(); expect(incident.requesterPhone).toBe(phone);
  });
  it('removes phone even when MAX cannot deliver the refreshed preview', async () => {
    await withPhone(); await click('draft-edit'); const oldToken = (await data()).previewToken;
    vi.spyOn(h.services.messages, 'send').mockRejectedValueOnce(new Error('MAX unavailable'));
    await expect(click('draft-phone-remove')).rejects.toThrow('MAX unavailable');
    expect((await data()).requesterPhone).toBeUndefined(); expect((await data()).pendingPhone).toBeUndefined();
    await expect(click('draft-confirm', oldToken)).rejects.toThrow('устарела');
  });
  it('deduplicates incoming contact and double registration without leaking raw contact', async () => {
    await preview(); const update = rawContact();
    const dispatch = new UpdateDispatcher(prisma, { dispatch: async (value: any) => handleRequesterMessage(h.services, actor, 555n, value.message, value.verifiedDraftContact) } as never, 2);
    const result = await Promise.all([dispatch.handle(update as never), dispatch.handle(update as never)]);
    expect(result.sort()).toEqual(['duplicate', 'processed']);
    expect((await prisma.inboundUpdate.findFirstOrThrow()).payload).toEqual({});
    expect((await data()).requesterPhone).toBe(phone);
    const token = (await data()).previewToken;
    await Promise.allSettled([click('draft-confirm', token), click('draft-confirm', token)]);
    expect(await prisma.incident.count()).toBe(1); expect((await prisma.incident.findFirstOrThrow()).requesterPhone).toBe(phone);
  });
  it('fails closed for foreign or unsigned contact, wrong step, text PII and expired preview', async () => {
    await preview();
    for (const override of [{ hash: undefined }, { max_info: { user_id: 999 } }]) {
      const value = await minimiseInbound(rawContact(override) as never, prisma) as any;
      expect(value.privacyRejected).toBe(true); expect(JSON.stringify(value)).not.toContain(phone);
    }
    const text = rawContact(); text.message.body = { ...text.message.body, text: 'Телефон +79991234567', attachments: [] } as never;
    expect((await minimiseInbound(text as never, prisma) as any).privacyRejected).toBe(true);
    await click('draft-edit'); expect((await minimiseInbound(rawContact() as never, prisma) as any).privacyRejected).toBe(true);
    await preview(); await prisma.operatorSession.updateMany({ data: { expiresAt: new Date(0) } });
    expect((await minimiseInbound(rawContact() as never, prisma) as any).privacyRejected).toBe(true);
    expect(await h.services.sessions.find(555n, 555n)).toBeNull(); expect(await prisma.operatorSession.count()).toBe(0);
  });
  it('clears minimal contact payload even when processing fails', async () => {
    await preview();
    const dispatcher = new UpdateDispatcher(prisma, { dispatch: async () => { throw new Error('sensitive failure'); } } as never);
    await dispatcher.handle(rawContact() as never);
    const row = await prisma.inboundUpdate.findFirstOrThrow();
    expect(row.payload).toEqual({}); expect(row.lastError).not.toContain('sensitive failure');
  });
  it.each([InboxStatus.PROCESSING, InboxStatus.FAILED])('scrubs contact in %s on dispatcher startup without changing pending contacts or ordinary diagnostics', async (status) => {
    await preview();
    const dispatch = vi.fn();
    const dispatcher = new UpdateDispatcher(prisma, { dispatch } as never);
    const reservation = await dispatcher.reserve(rawContact() as never);
    const contact = await prisma.inboundUpdate.update({
      where: { id: reservation.id! },
      data: { status, lockedAt: new Date(), lastError: `Interrupted contact ${phone}` },
    });
    expect(contact.payload).toHaveProperty('verifiedDraftContact.phone', phone);
    const pending = await prisma.inboundUpdate.create({ data: {
      externalUpdateKey: 'pending-contact', updateType: contact.updateType,
      payload: contact.payload as object, status: InboxStatus.PENDING,
    } });
    const diagnostic = { update_type: 'message_created', diagnostic: 'keep for investigation' };
    const ordinaryFailed = await prisma.inboundUpdate.create({ data: {
      externalUpdateKey: 'ordinary-failed', updateType: contact.updateType,
      payload: diagnostic, status: InboxStatus.FAILED, lastError: 'Original diagnostic error',
    } });
    const ordinaryProcessing = await prisma.inboundUpdate.create({ data: {
      externalUpdateKey: 'ordinary-processing', updateType: contact.updateType,
      payload: diagnostic, status: InboxStatus.PROCESSING, lockedAt: new Date(),
    } });
    dispatcher.pauseProcessing();
    try { await dispatcher.start(); }
    finally { dispatcher.stop(); await dispatcher.waitForIdle(); }

    const recovered = await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: contact.id } });
    expect(recovered.status).toBe(InboxStatus.FAILED);
    expect(recovered.payload).toEqual({});
    expect(recovered.lockedAt).toBeNull();
    expect(recovered.lastError).toBe('Не удалось обработать контакт; номер очищен. Повторите передачу контакта.');
    expect(recovered.lastError).not.toMatch(/\d/);
    expect(await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(pending);
    expect(await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: ordinaryFailed.id } })).toEqual(ordinaryFailed);
    expect(await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: ordinaryProcessing.id } })).toMatchObject({
      status: InboxStatus.FAILED, payload: diagnostic, lockedAt: null,
      lastError: 'Обработка была прервана перезапуском; требуется безопасная ручная проверка.',
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('never includes the optional phone in Excel including overdue rows', async () => {
    await withPhone(); const incident = await register();
    await prisma.incident.update({ where: { id: incident.id }, data: { deadlineAt: new Date(0) } });
    const report = await h.services.reports.build({ slug: 'all', title: 'Все сообщения' });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(report.buffer as never);
    let text = '';
    workbook.eachSheet(sheet => sheet.eachRow(row => { text += JSON.stringify(row.values); }));
    expect(text).toContain(incident.publicCode); expect(text).not.toContain(phone); expect(text).not.toContain('79991234567');
  });
  it('grants dispatcher/current executor only, revokes former organization and keeps phone out of common cards', async () => {
    await withPhone(); const incident = await register();
    const staff = await actorFor(prisma, 556n, 'Сотрудник', [UserRole.DISPATCHER]);
    const member = vi.spyOn(h.services.max.api, 'getChatMembers').mockResolvedValue({ members: [{ user_id: 556, is_bot: false }] } as never);
    await revealResidentContact(h.services, staff, TEST_CHATS.distribution, incident.id);
    expect(h.messages.toUser(556n).at(-1)?.message.text).toContain(phone);
    expect(h.messages.toUser(556n).at(-1)?.message.immediatePreview).toBe(true);
    const group = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'FACILITY' } });
    await h.services.distributionQueue.claim(staff, TEST_CHATS.distribution, incident.id);
    await expect(h.services.distribution.assign(incident.id, group.id, staff)).rejects.toThrow('персональных');
    await h.services.distribution.confirmPrivacyCheck(incident.id, staff);
    await h.services.distribution.assign(incident.id, group.id, staff);
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.distribution, incident.id)).rejects.toThrow();
    await revealResidentContact(h.services, staff, TEST_CHATS.sector, incident.id);
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.otherSector, incident.id)).rejects.toThrow();
    const row = (await h.services.repository.findById(incident.id))!;
    expect(distributionCard(row)).not.toContain(phone); expect(sectorCard(row, group)).not.toContain(phone);
    expect(h.messages.toChat(TEST_CHATS.distribution).concat(h.messages.toChat(TEST_CHATS.sector)).map(m => m.message.text).join(' ')).not.toContain(phone);
    const next = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'IT' } });
    await prisma.incident.update({ where: { id: incident.id }, data: { assignedGroupId: next.id } });
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.sector, incident.id)).rejects.toThrow();
    await revealResidentContact(h.services, staff, TEST_CHATS.otherSector, incident.id);
    member.mockResolvedValue({ members: [] } as never);
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.otherSector, incident.id)).rejects.toThrow();
    member.mockRejectedValue(new Error('network unavailable'));
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.otherSector, incident.id)).rejects.toThrow();
  });
  it('rechecks membership for personal workspace contact and forbids review even for administrators', async () => {
    await withPhone(); const incident = await register();
    const staff = await actorFor(prisma, 556n, 'Сотрудник', [UserRole.ADMIN, UserRole.DISPATCHER]);
    const member = vi.spyOn(h.services.max.api, 'getChatMembers').mockResolvedValue({ members: [{ user_id: 556, is_bot: false }] } as never);
    const item = await prisma.privateWorkItem.create({ data: { maxUserId: 556n, incidentId: incident.id, originChatId: TEST_CHATS.distribution, data: {}, selected: true } });
    await personalAction(h.services, staff, item.id, 'run', `incident:contact:${incident.id}`);
    expect(h.messages.toUser(556n).some(m => m.message.text.includes(phone))).toBe(true);
    member.mockResolvedValue({ members: [] } as never);
    await expect(personalAction(h.services, staff, item.id, 'run', `incident:contact:${incident.id}`)).rejects.toThrow();
    member.mockResolvedValue({ members: [{ user_id: 556, is_bot: false }] } as never);
    await prisma.incident.update({ where: { id: incident.id }, data: { status: 'WAITING_REVIEW' } });
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.review, incident.id)).rejects.toThrow();
    await expect(revealResidentContact(h.services, staff, TEST_CHATS.distribution, incident.id)).rejects.toThrow();
  });
  it('erases phone on rejection and leaves no phone in history or durable outgoing jobs', async () => {
    await withPhone(); const incident = await register();
    const staff = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    await h.services.distributionQueue.claim(staff, TEST_CHATS.distribution, incident.id);
    await h.services.distribution.reject(incident.id, 'Фото содержит персональные данные', staff);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).requesterPhone).toBeNull();
    const json = JSON.stringify([await prisma.incidentHistory.findMany(), await prisma.outboundMessage.findMany()], (_k, v) => typeof v === 'bigint' ? String(v) : v);
    expect(json).not.toContain(phone); expect(json).not.toContain('vcf_info');
  });
  it.each([false, true])('completes distribution, response and review with phone=%s without including it in review', async (hasPhone) => {
    if (hasPhone) await withPhone(); else await preview();
    const incident = await register();
    const dispatcher = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    const responder = await actorFor(prisma, 557n, 'Исполнитель', [UserRole.RESPONDER]);
    const approver = await actorFor(prisma, 558n, 'Куратор', [UserRole.APPROVER]);
    const group = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'FACILITY' } });
    await h.services.distributionQueue.claim(dispatcher, TEST_CHATS.distribution, incident.id);
    await h.services.distribution.confirmPrivacyCheck(incident.id, dispatcher);
    await h.services.distribution.assign(incident.id, group.id, dispatcher);
    await h.services.sector.takeInWork(incident.id, responder);
    const { answer } = await h.services.answers.submit(incident.id, responder, 'Ремонт выполнен.');
    expect(h.messages.toChat(TEST_CHATS.review).map(m => m.message.text).join(' ')).not.toContain(phone);
    await h.services.workQueues.claimReview(approver, TEST_CHATS.review, incident.id);
    await h.services.review.approve(incident.id, approver, answer.id);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('RESOLVED');
    expect(h.messages.toUser(555n).some(m => m.message.text.includes('Ремонт выполнен.'))).toBe(true);
  });
});
