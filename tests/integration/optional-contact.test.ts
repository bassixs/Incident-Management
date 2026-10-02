import { COMMANDS } from '../../src/bot/commands';
import { MaxError } from '@maxhub/max-bot-api';
import ExcelJS from 'exceljs';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { InboxStatus, UserRole, type PrismaClient } from '@prisma/client';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { handleUserCallback } from '../../src/bot/callbacks/user.callbacks';
import { rejectionDraft } from '../../src/bot/callbacks/rejection-flow';
import { REJECTION_REASONS } from '../../src/distribution/rejection-reasons';
import { handleIncidentCallback } from '../../src/bot/callbacks/incident.callbacks';
import { handleRequesterMessage } from '../../src/bot/handlers/requester.handler';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { CONTACT_REJECTION, PHONE_INPUT_ERROR, PHONE_INPUT_PROMPT } from '../../src/privacy/optional-contact';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';
import { minimiseInbound } from '../../src/privacy/inbound-privacy';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { TEST_CHATS } from '../helpers/setup-env';
import { distributionCard, sectorCard, reviewCard, incidentLookupCard, finalAnswerToRequester } from '../../src/bot/views/cards';
import { personalAction, showPersonalWork, invitePersonalWork } from '../../src/work-queues/private-workspace';
import type { SessionData } from '../../src/sessions/operator-session.service';
import type { UserAction } from '../../src/max/callback-payload';

describeIntegration('manual per-message phone', () => {
  let prisma: PrismaClient; let h: TestHarness;
  let actor: Awaited<ReturnType<typeof actorFor>>;
  const phone = '+7 999 123-45-67';
  const draft = { selectedCategoryId: null, problemMunicipalityCode: 'KALUGA_CITY', problemMunicipalityName: 'Город Калуга', problemLocality: null, draftText: 'Яма у дома 12 на улице Ленина', draftMedia: [] };
  beforeAll(async () => { pushSchemaOnce(); prisma = createTestPrisma(); await prisma.$connect(); });
  afterAll(async () => { await prisma.$disconnect(); });
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => { await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma); actor = await actorFor(prisma, 555n, 'Житель', []); });
  const data = async () => (await prisma.operatorSession.findUniqueOrThrow({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } })).data as SessionData;
  const preview = async (values: SessionData = draft) => showIncidentDraftPreview(h.services, 555n, 555n, values);
  const click = async (action: UserAction, argument?: string) => handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: `cb-${Math.random()}`, messageId: undefined }, { kind: 'user', action, argument: argument ?? (await data()).previewToken });
  const enter = () => click('draft-phone-enter');
  const rawPhone = (text = '8 (999) 123-45-67') => ({ update_type: 'message_created', timestamp: Date.now(), message: { timestamp: Date.now(), sender: { user_id: 555, name: 'Private Name', username: 'private-username' }, recipient: { chat_type: 'dialog', chat_id: 555 }, body: { mid: `phone-${Math.random()}`, text, attachments: [] as any[] } } });
  const rawContact = (overrides: Record<string, unknown> = {}) => {
    const update = rawPhone('Иванов Иван Иванович +79991234567');
    update.message.body.attachments = [{ type:'contact', payload:{ vcf_info:'FN:Private Name\nTEL:79991234567', hash:'legacy', max_info:{user_id:555}, ...overrides } }];
    return update;
  };
  const router = () => new UpdateDispatcher(prisma, { dispatch: async (value: any) => handleMessageUpdate(h.services, { update:value } as never) } as never);
  const receive = async (text?: string) => {
    if ((await data()).draftEditField !== 'phone') await enter();
    const value = await minimiseInbound(rawPhone(text) as never, prisma) as any;
    expect(value.privacyRejected).toBeUndefined();
    await handleMessageUpdate(h.services, { update:value } as never); return value;
  };
  const withPhone = async () => { await preview(); await receive(); };
  const removePhone = async () => { await click('draft-edit'); await click('draft-phone-remove'); };
  const register = async () => { await click('draft-confirm'); return prisma.incident.findFirstOrThrow(); };

  it('allows registration without a phone and preserves topic-only start', async()=>{
    await click('new','unused');expect(h.messages.toUser(555n).at(-1)?.message.text).toBe('Выберите тему сообщения');
    await preview();const incident=await register();expect(incident.requesterPhone).toBeNull();expect(await prisma.legalAcceptance.count()).toBe(0);
  });
  it('adds, changes, removes and re-adds phone without registering or losing photos/text', async()=>{
    await preview({...draft,draftMedia:[{kind:'IMAGE',token:'photo'}]});await enter();
    expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(PHONE_INPUT_PROMPT);
    await receive();expect((await data()).requesterPhone).toBe(phone);
    expect((await data()).draftMedia).toEqual([{kind:'IMAGE',token:'photo'}]);expect((await data()).draftText).toBe(draft.draftText);
    expect(h.messages.toUser(555n).at(-1)?.message.keyboard?.flat().map(b=>b.text)).toEqual(['✅ Всё верно','✏️ Исправить','Отмена']);
    await click('draft-edit');await enter();await receive('+7 900 111-22-33');expect((await data()).requesterPhone).toBe('+7 900 111-22-33');
    await removePhone();expect((await data()).requesterPhone).toBeUndefined();await receive();
    expect(await prisma.incident.count()).toBe(0);const incident=await register();expect(incident.requesterPhone).toBe(phone);
    expect((await prisma.user.findUniqueOrThrow({where:{maxUserId:555n}})).requesterPhone).toBeNull();
    await click('new','unused');expect(await data()).toEqual({});
  });
  it.each(['not a number','+1 234 5678901','890012345678','паспорт 45 12 123456'])('rejects invalid phone without turning it into problem text: %s',async text=>{
    await preview();await enter();await router().handle(rawPhone(text) as never);
    expect((await data()).draftText).toBe(draft.draftText);expect((await data()).requesterPhone).toBeUndefined();
    expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(PHONE_INPUT_ERROR);
    expect((await prisma.inboundUpdate.findFirstOrThrow()).payload).toEqual({});expect(await prisma.incident.count()).toBe(0);
    await receive();expect((await data()).requesterPhone).toBe(phone);
  });
  it.each([false,true])('returns from input without modifying the existing phone (%s)',async existing=>{
    if(existing)await withPhone();else await preview();
    if(existing)await click('draft-edit');await enter();await click('draft-phone-back');
    expect((await data()).requesterPhone).toBe(existing?phone:undefined);expect(await prisma.incident.count()).toBe(0);
  });
  it.each(['cancel','replace','expire','submit'] as const)('does not apply captured input after %s',async action=>{
    await preview();const oldButton=(await data()).previewToken;await enter();
    const value=await minimiseInbound(rawPhone() as never,prisma) as any;
    if(action==='expire')await prisma.operatorSession.updateMany({data:{expiresAt:new Date(0)}});
    else if(action==='submit'){await click('draft-phone-back');await register();}
    else {await click('draft-cancel');if(action==='replace'){await preview();await enter();}}
    await handleMessageUpdate(h.services,{update:value} as never);
    const sessions=await prisma.operatorSession.findMany();expect(sessions.every(s=>!(s.data as SessionData).requesterPhone)).toBe(true);
    expect((await prisma.incident.findMany()).every(i=>i.requesterPhone===null)).toBe(true);
    await expect(click('draft-phone-enter',oldButton)).rejects.toThrow();
  });
  it('does not clear a different clarification session when old phone input arrives', async () => {
    await preview(); await enter(); const value = await minimiseInbound(rawPhone() as never, prisma);
    await h.services.sessions.start({ maxUserId: 555n, chatId: 555n, type: 'WAITING_CLARIFICATION_REPLY', data: { clarificationId: 'new-session' } });
    const before = await h.services.sessions.find(555n, 555n);
    await handleMessageUpdate(h.services, { update: value } as never);
    expect(await h.services.sessions.find(555n, 555n)).toEqual(before);
    expect(await prisma.incident.count()).toBe(0);
  });
  it('does not bind a delayed text timestamp or old callback to a new phone step',async()=>{
    await preview();await enter();const old=rawPhone();old.message.timestamp=Number((await data()).phoneInputStartedAt)-1;
    const token=(await data()).previewToken;await click('draft-cancel');await preview();await enter();
    await expect(click('draft-phone-back',token)).rejects.toThrow('устарела');
    await router().handle(old as never);expect((await data()).requesterPhone).toBeUndefined();
  });
  it('compares current session again before saving input racing with a new draft',async()=>{
    await preview();await enter();const value=await minimiseInbound(rawPhone() as never,prisma) as any;
    const replace=h.services.sessions.replaceCurrent.bind(h.services.sessions);
    vi.spyOn(h.services.sessions,'replaceCurrent').mockImplementationOnce(async(...args)=>{
      await click('draft-cancel');await preview();return replace(...args);
    });
    await expect(handleMessageUpdate(h.services,{update:value} as never)).rejects.toThrow('Черновик изменился');
    expect((await data()).requesterPhone).toBeUndefined();expect(await prisma.incident.count()).toBe(0);
  });
  it('deduplicates text input and confirmation, with exactly one registration',async()=>{
    await preview();await enter();const update=rawPhone(),dispatcher=router();
    expect((await Promise.all([dispatcher.handle(update as never),dispatcher.handle(update as never)])).sort()).toEqual(['duplicate','processed']);
    expect((await data()).requesterPhone).toBe(phone);expect(await prisma.incident.count()).toBe(0);
    const token=(await data()).previewToken;await Promise.allSettled([click('draft-confirm',token),click('draft-confirm',token)]);
    expect(await prisma.incident.count()).toBe(1);expect((await prisma.incident.findFirstOrThrow()).requesterPhone).toBe(phone);
  });
  it('does not route captured resident input to a selected employee response',async()=>{
    await preview();await enter();const value=await minimiseInbound(rawPhone() as never,prisma) as any;
    const incident=await h.services.incidents.create({requester:{maxUserId:666n},text:'Не горит фонарь'});
    await prisma.privateWorkItem.create({data:{maxUserId:555n,incidentId:incident.id,originChatId:TEST_CHATS.sector,selected:true,data:{}}});
    await handleMessageUpdate(h.services,{update:value} as never);
    expect((await data()).requesterPhone).toBe(phone);expect(await prisma.incidentAnswer.count()).toBe(0);
  });
  it.each([false, true])('mode switch: preserves new employee text with expired resident phone step=%s', async expired => {
    actor = await actorFor(prisma, 555n, 'Сотрудник', [UserRole.ADMIN]);
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: {
      getMyInfo: vi.fn(async () => ({ username: 'test_bot' })),
      getChatMembers: vi.fn(async () => ({ members: [{ user_id: 555, is_bot: false }] })),
    } } as never;
    const callback = async (payload: string) => {
      const update = { ...rawPhone(), update_type: 'message_callback', callback: {
        callback_id: `switch-${Math.random()}`, user: { user_id: 555, name: 'Сотрудник' }, payload,
      } };
      await handleCallbackUpdate(h.services, { update: await minimiseInbound(update as never, prisma) } as never);
    };
    const dispatcher = router();
    await preview({ ...draft, draftMedia: [{ kind: 'IMAGE', token: 'resident-photo' }] });
    await callback(`user:draft-phone-enter:${(await data()).previewToken}`);
    if (expired) await prisma.operatorSession.updateMany({ where: { maxUserId: 555n, chatId: 555n }, data: { expiresAt: new Date(0) } });
    const residentBefore = await prisma.operatorSession.findUniqueOrThrow({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } });
    const incident = await h.services.incidents.create({ requester: { maxUserId: 666n }, text: 'Не горит фонарь' });
    const group = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'FACILITY' } });
    await h.services.distribution.assign(incident.id, group.id, actor);
    await invitePersonalWork(h.services, actor, TEST_CHATS.sector, incident.id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { maxUserId: 555n, incidentId: incident.id } });
    await callback(`personal:open:${item.id}`);
    await callback(`personal:run:${item.id}:incident:answer:${incident.id}`);
    expect((await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).selected).toBe(true);
    const text = 'Ответ подготовил Иванов Иван Иванович. Подробности https://example.org';
    const event = rawPhone(text); event.message.body.attachments = [{ type: 'image', payload: { token: 'staff-photo' } }];
    const reserved = await dispatcher.reserve(event as never);
    const inbox = await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reserved.id! } });
    expect(inbox.payload).not.toHaveProperty('draftPhoneInput');
    expect(inbox.payload).not.toHaveProperty('privacyRejected');
    expect(inbox.payload).toMatchObject({ message: { body: { text, attachments: event.message.body.attachments } } });
    await dispatcher.kick(); await dispatcher.waitForIdle();
    expect((await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reserved.id! } })).status).toBe('PROCESSED');
    const work = await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(work.data).toMatchObject({ draft: { text, attachments: event.message.body.attachments } });
    expect(await prisma.incidentAnswer.count()).toBe(0);
    expect(await prisma.operatorSession.findUniqueOrThrow({ where: { id: residentBefore.id } })).toEqual(residentBefore);
    await callback('personal:resident');
    expect((await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).selected).toBe(false);
    expect((await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).data).toEqual(work.data);
    if (expired) {
      // Normal TTL cleanup on returning; switching to work must not revive the expired draft.
      expect(await prisma.operatorSession.findUnique({ where: { id: residentBefore.id } })).toBeNull();
      expect(h.messages.toUser(555n).at(-1)!.message.text).not.toBe(PHONE_INPUT_PROMPT);
    } else {
      expect(await data()).toEqual(residentBefore.data);
      expect(h.messages.toUser(555n).at(-1)!.message.text).toBe(PHONE_INPUT_PROMPT);
      await callback(`user:draft-phone-back:${(await data()).previewToken}`);
      expect((await data()).draftText).toBe(draft.draftText);
      expect((await data()).draftMedia).toEqual([{ kind: 'IMAGE', token: 'resident-photo' }]);
      expect((await data()).requesterPhone).toBeUndefined();
    }
    expect(await prisma.incident.count()).toBe(1);
  });
  it.each([false, true])('mode switch: an admitted phone stays resident input when consumed after entering work, expired=%s', async expired => {
    actor = await actorFor(prisma, 555n, 'Сотрудник', [UserRole.ADMIN]);
    h.services.max = { answerCallback: vi.fn(async () => undefined), api: {
      getMyInfo: vi.fn(async () => ({ username: 'test_bot' })),
      getChatMembers: vi.fn(async () => ({ members: [{ user_id: 555, is_bot: false }] })),
    } } as never;
    const callback = async (payload: string) => handleCallbackUpdate(h.services, { update: {
      ...rawPhone(), update_type: 'message_callback', callback: { callback_id: `queued-switch-${Math.random()}`, user: { user_id: 555, name: 'Сотрудник' }, payload },
    } } as never);
    await preview(); await callback(`user:draft-phone-enter:${(await data()).previewToken}`);
    const dispatcher = router(); const phoneEvent = rawPhone(); const reserved = await dispatcher.reserve(phoneEvent as never);
    expect((await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reserved.id! } })).payload).toHaveProperty('draftPhoneInput.phone', phone);
    if (expired) await prisma.operatorSession.updateMany({ where: { maxUserId: 555n, chatId: 555n }, data: { expiresAt: new Date(0) } });
    const incident = await h.services.incidents.create({ requester: { maxUserId: 666n }, text: 'Не горит фонарь' });
    const group = await prisma.responsibleGroup.findFirstOrThrow({ where: { code: 'FACILITY' } });
    await h.services.distribution.assign(incident.id, group.id, actor);
    await invitePersonalWork(h.services, actor, TEST_CHATS.sector, incident.id);
    const item = await prisma.privateWorkItem.findFirstOrThrow({ where: { maxUserId: 555n, incidentId: incident.id } });
    await callback(`personal:open:${item.id}`); await callback(`personal:run:${item.id}:incident:answer:${incident.id}`);
    const workBefore = await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } });
    await dispatcher.kick(); await dispatcher.waitForIdle();
    expect(await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).toEqual(workBefore);
    expect(await prisma.incidentAnswer.count()).toBe(0); expect(await prisma.incident.count()).toBe(1);
    expect(await dispatcher.handle(phoneEvent as never)).toBe('duplicate');
    expect((await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reserved.id! } })).status).toBe('PROCESSED');
    if (!expired) expect((await data()).requesterPhone).toBe(phone);
    else expect(await prisma.operatorSession.findUnique({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } })).toBeNull();
    const staffEvent = rawPhone('Освещение восстановлено, ответ сотрудника.');
    expect(await dispatcher.handle(staffEvent as never)).toBe('processed');
    expect((await prisma.privateWorkItem.findUniqueOrThrow({ where: { id: item.id } })).data).toMatchObject({ draft: { text: staffEvent.message.body.text } });
    await callback('personal:resident');
    if (!expired) {
      await callback(`user:draft-edit:${(await data()).previewToken}`);
      await callback('user:draft-edit:back');
      expect(h.messages.toUser(555n).at(-1)!.message.text).toContain(`Телефон для связи: ${phone}`);
      expect((await data()).draftText).toBe(draft.draftText);
    }
  });
  it('rejects a queued verified native contact from the old version without mutating draft',async()=>{
    await preview();const before=await data();const value=rawPhone();
    Object.assign(value,{verifiedDraftContact:{phone,draftToken:before.draftToken,previewToken:before.previewToken}});
    await handleMessageUpdate(h.services,{update:value} as never);expect(await data()).toEqual(before);
    expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(CONTACT_REJECTION);
  });
  it('does not turn a delayed standalone number into a new problem description',async()=>{
    await preview();await enter();const old=rawPhone();await click('draft-cancel');
    await h.services.sessions.start({maxUserId:555n,chatId:555n,type:'WAITING_INCIDENT_TEXT',data:{problemMunicipalityCode:'KALUGA_CITY',problemMunicipalityName:'Город Калуга'}});
    const before=await data();await router().handle(old as never);expect(await data()).toEqual(before);
    expect(await prisma.incident.count()).toBe(0);
  });
  it('recovers a failed phone prompt with /start without losing fields',async()=>{
    await preview();vi.spyOn(h.services.messages,'send').mockRejectedValueOnce(new MaxError(503,{code:'unavailable',message:'temporary'}));
    await expect(enter()).rejects.toThrow();vi.restoreAllMocks();
    await router().handle(rawPhone('/start') as never);
    expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(PHONE_INPUT_PROMPT);
    expect((await data()).draftText).toBe(draft.draftText);await receive();expect((await data()).requesterPhone).toBe(phone);
  });
  it('does not delete a concurrently renewed draft when removing an expired session',async()=>{
    await preview();await prisma.operatorSession.updateMany({data:{expiresAt:new Date(0)}});
    const find=prisma.operatorSession.findUnique.bind(prisma.operatorSession);
    vi.spyOn(prisma.operatorSession,'findUnique').mockImplementationOnce((async(args:any)=>{
      const expired=await find(args);
      await prisma.operatorSession.updateMany({data:{expiresAt:new Date(Date.now()+60_000),data:{...draft,draftToken:'new-draft'}}});
      return expired;
    }) as typeof prisma.operatorSession.findUnique);
    expect(await h.services.sessions.find(555n,555n)).toBeNull();expect(await prisma.operatorSession.count()).toBe(1);
    expect((await data()).draftToken).toBe('new-draft');
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
  it.each(['contact', 'draft-edit', 'draft-cancel', 'draft-confirm', 'new'] as const)(
    'retires only the owner draft preview during %s, including the keyboard-removal fallback', async (action) => {
      await preview(); const ownId = (await data()).previewMessageId!;
      await showIncidentDraftPreview(h.services, 556n, 556n, draft);
      await showIncidentDraftPreview(h.services, 555n, 777n, draft);
      const otherSessions = await prisma.operatorSession.findMany({ where: { NOT: { maxUserId: 555n, chatId: 555n } } });
      expect(otherSessions).toHaveLength(2);
      const workCard = await h.services.messages.send({ chatId: TEST_CHATS.sector }, { text: 'Рабочая карточка' });
      const deleteSpy = vi.spyOn(h.services.messages, 'deleteCard').mockResolvedValue(false);
      if (action === 'contact') await receive();
      else await handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: 'scope', messageId: workCard.firstMessageId },
        { kind: 'user', action, argument: (await data()).previewToken });
      expect(deleteSpy.mock.calls).toEqual([[ownId]]);
      expect(h.messages.edits).toEqual([{ messageId: ownId, text: 'Карточка устарела. Используйте текущую карточку сообщения.', mode: 'finalize' }]);
      for (const session of otherSessions) {
        expect(await prisma.operatorSession.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
      }
    },
  );
  it('never falls back to the callback message when a preview ID is missing', async () => {
    await preview(); const withoutId = await data(); delete withoutId.previewMessageId;
    await prisma.operatorSession.updateMany({ data: { data: withoutId as never } });
    await handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: 'missing-preview', messageId: 'unrelated-card' },
      { kind: 'user', action: 'draft-confirm', argument: withoutId.previewToken });
    expect(await prisma.incident.count()).toBe(1);
    expect(h.messages.deleted).toEqual([]);
    expect(h.messages.edits).toEqual([]);
  });
  it('does not finalize arbitrary callback messages when removing a phone or returning from corrections', async () => {
    await withPhone(); await click('draft-edit');
    const deleted = [...h.messages.deleted]; const edits = [...h.messages.edits];
    await handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: 'remove', messageId: 'unrelated-card' },
      { kind: 'user', action: 'draft-phone-remove', argument: (await data()).previewToken });
    expect((await data()).requesterPhone).toBeUndefined();
    expect(h.messages.deleted).toEqual(deleted); expect(h.messages.edits).toEqual(edits);
    await click('draft-edit'); const beforeBack = [...h.messages.deleted];
    await handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: 'back', messageId: 'unrelated-card' },
      { kind: 'user', action: 'draft-edit', argument: 'back' });
    expect(h.messages.deleted).toEqual(beforeBack); expect(h.messages.edits).toEqual(edits);
  });
  it('rejects obsolete callbacks without retiring the new draft preview', async () => {
    await preview(); const old = await data(); await click('draft-cancel'); await preview();
    const current = await data(); const deleted = [...h.messages.deleted]; const edits = [...h.messages.edits];
    for (const action of ['draft-confirm', 'draft-cancel', 'draft-edit'] as const) {
      await expect(handleUserCallback({ services: h.services, actor, chatId: 555n, callbackId: action, messageId: old.previewMessageId },
        { kind: 'user', action, argument: old.previewToken })).rejects.toThrow('устарела');
    }
    expect(await data()).toEqual(current);
    expect(h.messages.deleted).toEqual(deleted); expect(h.messages.edits).toEqual(edits);
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
    await click('draft-phone-remove');
    expect((await data()).previewDeliveryPending).toBe(true);
    expect((await data()).requesterPhone).toBeUndefined(); expect((await data()).pendingPhone).toBeUndefined();
    await expect(click('draft-confirm', oldToken)).rejects.toThrow('устарела');
  });
  const failContactPreview = async (operation: 'add' | 'remove', withPhotos = false) => {
    await preview();
    if (withPhotos) await prisma.operatorSession.updateMany({ data: { data: { ...(await data()), draftMedia: [{ kind: 'IMAGE', token: 'preserved-photo' }] } } });
    if (operation === 'remove') { await receive(); await click('draft-edit'); } else await enter();
    const failure = new MaxError(503, { code: 'service.unavailable', message: 'Retry later' });
    const send = vi.spyOn(h.services.messages, 'send').mockRejectedValueOnce(failure);
    if (operation === 'add') await receive(); else await click('draft-phone-remove');
    expect(send).toHaveBeenCalled(); send.mockRestore();
    const saved = await data();
    expect(saved.previewDeliveryPending).toBe(true);
    expect(saved.requesterPhone).toBe(operation === 'add' ? phone : undefined);
    expect(saved.draftText).toBe(draft.draftText);
    expect(saved.previewMessageId).toBeUndefined();
    expect(saved.draftPhotoRetry).toBeUndefined();
    expect(await prisma.incident.count()).toBe(0);
    return saved;
  };
  const continueMessage = () => handleRequesterMessage(h.services, actor, 555n, { body: { mid: 'continue', text: 'Продолжить' } } as never);
  it.each(['add', 'remove'] as const)('recovers %s after 503 without photos through the retry button, then confirms exactly once', async operation => {
    const saved = await failContactPreview(operation);
    const hint = h.messages.toUser(555n).at(-1)!.message;
    expect(hint.keyboard?.flat()).toContainEqual({ type: 'callback', text: 'Повторить показ карточки', payload: `user:draft-retry:${saved.previewToken}` });
    expect(hint.immediatePreview).toBe(true);
    await expect(click('draft-confirm')).rejects.toThrow('Сначала восстановите');
    await click('draft-retry', saved.previewToken);
    const recovered = await data();
    expect(recovered.previewDeliveryPending).toBeUndefined();
    expect(recovered.previewMessageId).toBeTruthy();
    expect(recovered.draftToken).toBe(saved.draftToken);
    const card = h.messages.toUser(555n).at(-1)!.message;
    expect(card.keyboard?.flat()).toContainEqual({ type: 'callback', text: '✅ Всё верно', payload: `user:draft-confirm:${recovered.previewToken}`, intent: 'positive' });
    expect(card.text.includes(phone)).toBe(operation === 'add');
    expect(card.keyboard?.flat().some(b => b.type === 'callback' && b.payload.startsWith('user:draft-phone-enter:'))).toBe(operation === 'remove');
    expect(await prisma.incident.count()).toBe(0);
    const incident = await register(); expect(incident.requesterPhone).toBe(operation === 'add' ? phone : null);
    await expect(click('draft-confirm', recovered.previewToken)).rejects.toThrow();
    await expect(click('draft-retry', saved.previewToken)).rejects.toThrow();
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.operatorSession.count()).toBe(0);
  });
  it.each(['add', 'remove'] as const)('recovers %s using /start or text even when MAX also loses the recovery notice', async operation => {
    const saved = await failContactPreview(operation);
    const send = vi.spyOn(h.services.messages, 'send').mockRejectedValue(new MaxError(503, { code: 'unavailable', message: 'offline' }));
    await click('draft-retry', saved.previewToken); expect(send).toHaveBeenCalledTimes(2); send.mockRestore();
    if (operation === 'add') await COMMANDS.start!({ services: h.services, actor, chatId: 555n, isDialog: true, args: [] }); else await continueMessage();
    expect((await data()).previewDeliveryPending).toBeUndefined();
    const incident = await register(); expect(incident.requesterPhone).toBe(operation === 'add' ? phone : null);
    expect(await prisma.incident.count()).toBe(1);
  });
  it.each(['add', 'remove'] as const)('keeps photos on temporary failure while recovering %s', async operation => {
    const saved = await failContactPreview(operation, true);
    expect(saved.draftMedia).toEqual([{ kind: 'IMAGE', token: 'preserved-photo' }]);
    await click('draft-retry');
    expect(h.messages.toUser(555n).at(-1)!.message.attachments).toEqual([{ type: 'IMAGE', maxToken: 'preserved-photo', originalName: undefined }]);
    expect((await data()).draftMedia).toEqual(saved.draftMedia);
    expect(await prisma.incident.count()).toBe(0);
    const incident = await register(); expect(incident.requesterPhone).toBe(operation === 'add' ? phone : null);
  });
  it.each(['add', 'remove'] as const)('does not resurrect %s recovery after cancellation or replacement', async operation => {
    const saved = await failContactPreview(operation);
    await click('draft-cancel');
    const sends = h.messages.sent.length;
    await expect(click('draft-retry', saved.previewToken)).rejects.toThrow('устарела');
    expect(h.messages.sent).toHaveLength(sends); expect(await prisma.operatorSession.count()).toBe(0);
    await click('new', 'unused'); await preview(); const next = await data();
    const nextSends = h.messages.sent.length; const nextDeletes = [...h.messages.deleted];
    await expect(click('draft-retry', saved.previewToken)).rejects.toThrow('устарела');
    expect(await data()).toEqual(next); expect(h.messages.sent).toHaveLength(nextSends);
    expect(h.messages.deleted).toEqual(nextDeletes); expect(await prisma.incident.count()).toBe(0);
  });
  it.each(['add', 'remove'] as const)('retires only the late recovery preview when a new draft replaces %s during MAX send', async operation => {
    await failContactPreview(operation);
    const send = h.services.messages.send.bind(h.services.messages); let late: string | undefined;
    vi.spyOn(h.services.messages, 'send').mockImplementationOnce(async (...args) => {
      const result = await send(...args); late = result.firstMessageId;
      await expect(click('draft-confirm')).rejects.toThrow('Сначала восстановите');
      await click('draft-cancel'); await preview(); return result;
    });
    await click('draft-retry');
    const next = await data(); expect(next.requesterPhone).toBeUndefined();
    expect(h.messages.deleted).toContain(late); expect(h.messages.deleted).not.toContain(next.previewMessageId);
    expect(await prisma.incident.count()).toBe(0);
  });
  it.each(['add', 'remove'] as const)('ignores stale recovery after directly replacing the failed %s draft', async operation => {
    const saved = await failContactPreview(operation);
    await click('new', 'unused');
    const next = await data(); const sends = h.messages.sent.length; const deleted = [...h.messages.deleted];
    await expect(click('draft-retry', saved.previewToken)).rejects.toThrow('устарела');
    expect(await data()).toEqual(next); expect(h.messages.sent).toHaveLength(sends); expect(h.messages.deleted).toEqual(deleted);
    expect(next.requesterPhone).toBeUndefined(); expect(await prisma.incident.count()).toBe(0);
  });
  it('recovers /start in the actual dialog scope when chat ID differs from user ID', async () => {
    await failContactPreview('add');
    await prisma.operatorSession.updateMany({ data: { chatId: 999n } });
    await COMMANDS.start!({ services: h.services, actor, chatId: 999n, isDialog: true, args: [] });
    const saved = await prisma.operatorSession.findFirstOrThrow();
    expect(saved.chatId).toBe(999n); expect((saved.data as SessionData).previewDeliveryPending).toBeUndefined();
    expect((saved.data as SessionData).requesterPhone).toBe(phone);
    expect(await prisma.operatorSession.count()).toBe(1); expect(await prisma.incident.count()).toBe(0);
  });
  it.each(['unsigned', 'foreign', 'cancel', 'sent', 'edit', 'repeat'] as const)(
    'routes %s contact to a contact-specific refusal without processing its caption as text', async reason => {
      await preview();
      if (reason === 'cancel') await click('draft-cancel');
      if (reason === 'sent') await register();
      if (reason === 'edit') { await click('draft-edit'); await click('draft-field', 'text'); }
      if (reason === 'repeat') await receive();
      const before = await prisma.operatorSession.findMany();
      const count = await prisma.incident.count();
      const update = rawContact(reason === 'unsigned' ? { hash: undefined } : reason === 'foreign' ? { max_info: { user_id: 999 } } : {});
      update.message.body.text = 'Иванов Иван Иванович +79991234567' as never;
      const dispatcher = new UpdateDispatcher(prisma, { dispatch: async (value: any) => handleMessageUpdate(h.services, { update: value } as never) } as never);
      const reservation = await dispatcher.reserve(update as never);
      const pending = await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: reservation.id } });
      expect(pending.payload).toHaveProperty('contactRejected', true);
      expect(JSON.stringify(pending.payload)).not.toMatch(/Иванов|79991234567|vcf_info|Private Name/);
      await dispatcher.kick();
      expect(h.messages.toUser(555n).at(-1)?.message.text).toBe(CONTACT_REJECTION);
      expect(await prisma.operatorSession.findMany()).toEqual(before);
      expect(await prisma.incident.count()).toBe(count);
      expect((await prisma.inboundUpdate.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PROCESSED');
    },
  );
  it.each([
    ...['+7 (900) 123-45-67', '8 900 123 45 67', '79001234567', '89001234567', '+7 4842 123456']
      .map(phone => `Яма у дома 12 по ул. Ленина. Для связи ${phone}`),
    'Яма, Ленина 12. 89001234567',
    'Телефон 89001234567. 12 подъезд',
    'Для связи 89001234567 89007654321',
  ])(
    'preserves phone text through inbox and normal delivery without extracting a private contact: %s', async text => {
      await preview(); await click('draft-edit'); await click('draft-field', 'text');
      const update = rawContact();
      update.message.body = { ...update.message.body, mid: 'text-phone', text, attachments: [] } as never;
      const dispatch = vi.fn(async (value: any) => handleMessageUpdate(h.services, { update: value } as never));
      const dispatcher = new UpdateDispatcher(prisma, { dispatch } as never);
      await dispatcher.handle(update as never);
      expect(dispatch).toHaveBeenCalledTimes(1);
      const delivered = dispatch.mock.calls[0]![0];
      expect(delivered).not.toHaveProperty('privacyRejected');
      expect(delivered).toHaveProperty('message.body.text', text);
      const inbox = await prisma.inboundUpdate.findFirstOrThrow();
      expect(inbox.status).toBe(InboxStatus.PROCESSED);
      expect(inbox.payload).toEqual({});
      expect((await data()).draftText).toBe(text);
      expect((await data()).requesterPhone).toBeUndefined();
      expect(await prisma.incident.count()).toBe(0);
      const token = (await data()).previewToken;
      const incident = await register();
      expect(incident.text).toBe(text); expect(incident.requesterPhone).toBeNull();
      expect(h.messages.toChat(TEST_CHATS.distribution).some(m => m.message.text.includes(text))).toBe(true);
      await expect(click('draft-confirm', token)).rejects.toThrow();
      expect(await prisma.incident.count()).toBe(1);
    },
  );
  it('clears minimal contact payload even when processing fails', async () => {
    await preview(); await enter();
    const dispatcher = new UpdateDispatcher(prisma, { dispatch: async () => { throw new Error('sensitive failure'); } } as never);
    await dispatcher.handle(rawPhone() as never);
    const row = await prisma.inboundUpdate.findFirstOrThrow();
    expect(row.payload).toEqual({}); expect(row.lastError).not.toContain('sensitive failure');
  });
  it.each([InboxStatus.PROCESSING, InboxStatus.FAILED])('scrubs contact in %s on dispatcher startup without changing pending contacts or ordinary diagnostics', async (status) => {
    await preview(); await enter();
    const dispatch = vi.fn();
    const dispatcher = new UpdateDispatcher(prisma, { dispatch } as never);
    const reservation = await dispatcher.reserve(rawPhone() as never);
    const contact = await prisma.inboundUpdate.update({
      where: { id: reservation.id! },
      data: { status, lockedAt: new Date(), lastError: `Interrupted contact ${phone}` },
    });
    expect(contact.payload).toHaveProperty('draftPhoneInput.phone', phone);
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
    expect(recovered.lastError).toBe('Не удалось обработать номер; данные события очищены. Проверьте текущую карточку и при необходимости введите номер снова.');
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
  it('erases phone on rejection and leaves no phone in history or durable outgoing jobs', async () => {
    await withPhone(); const incident = await register();
    const staff = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    await h.services.distributionQueue.claim(staff, TEST_CHATS.distribution, incident.id);
    await h.services.distribution.reject(incident.id, 'Фото содержит персональные данные', staff);
    expect((await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } })).requesterPhone).toBeNull();
    const json = JSON.stringify([await prisma.incidentHistory.findMany(), await prisma.outboundMessage.findMany()], (_k, v) => typeof v === 'bigint' ? String(v) : v);
    expect(json).not.toContain(phone); expect(json).not.toContain('vcf_info');
  });
  it('rejects through the privacy reason and confirmation buttons and clears phone, text and photos', async () => {
    await preview({ ...draft, draftMedia: [{ kind: 'IMAGE', token: 'private-photo' }] });
    await receive(); const incident = await register();
    const staff = await actorFor(prisma, 556n, 'Диспетчер', [UserRole.DISPATCHER]);
    const context = { services: h.services, actor: staff, chatId: TEST_CHATS.distribution };
    await handleIncidentCallback(context, { kind: 'incident', incidentId: incident.id, action: 'reject' });
    const session = () => h.services.sessions.find(staff.maxUserId, TEST_CHATS.distribution);
    const reason = REJECTION_REASONS.find(r => r.id === '9')!;
    expect(h.messages.sent.at(-1)!.message.keyboard!.flat().map(b => b.text)).toContain(reason.label);
    let token = rejectionDraft((await session())!).rejectionToken;
    await handleIncidentCallback(context, { kind: 'incident', incidentId: incident.id, action: 'reject-reason', argument: `${token}.9` });
    expect((await h.services.repository.findById(incident.id))!.status).toBe('DISTRIBUTION');
    token = rejectionDraft((await session())!).rejectionToken;
    await handleIncidentCallback(context, { kind: 'incident', incidentId: incident.id, action: 'reject-confirm', argument: token });
    const current = (await h.services.repository.findById(incident.id))!;
    expect(current.status).toBe('REJECTED'); expect(current.requesterPhone).toBeNull();
    expect(current.text).not.toContain(draft.draftText);
    expect(await prisma.incidentAttachment.count({ where: { incidentId: incident.id } })).toBe(0);
    expect(h.messages.toUser(555n).at(-1)!.message.text).toContain(reason.reason);
    await expect(handleIncidentCallback(context, { kind: 'incident', incidentId: incident.id, action: 'reject-confirm', argument: token })).rejects.toThrow('устарела');
  });
  it.each([false,true])('full lifecycle including revision, phone=%s in full cards only',async hasPhone=>{
    if(hasPhone)await withPhone();else await preview();const incident=await register();
    const dispatcher=await actorFor(prisma,556n,'Диспетчер',[UserRole.DISPATCHER]);
    const responder=await actorFor(prisma,557n,'Исполнитель',[UserRole.RESPONDER]);
    const approver=await actorFor(prisma,558n,'Куратор',[UserRole.APPROVER]);
    const group=await prisma.responsibleGroup.findFirstOrThrow({where:{code:'FACILITY'}});
    await h.services.distributionQueue.claim(dispatcher,TEST_CHATS.distribution,incident.id);
    const distribution=(await h.services.repository.findById(incident.id))!;
    expect(distributionCard(distribution).includes(phone)).toBe(hasPhone);
    await h.services.distribution.assign(incident.id,group.id,dispatcher);
    expect(await prisma.incidentHistory.count({where:{action:'PRIVACY_CHECK_PASSED'}})).toBe(0);
    await h.services.sector.takeInWork(incident.id,responder);
    const {answer}=await h.services.answers.submit(incident.id,responder,'Ремонт запланирован.');
    let row=(await h.services.repository.findById(incident.id))!;
    expect(sectorCard(row,group).includes(phone)).toBe(hasPhone);
    expect(reviewCard(row,row.answers.at(-1)!,group).includes(phone)).toBe(hasPhone);
    expect(incidentLookupCard(row).includes(phone)).toBe(hasPhone);
    await h.services.workQueues.claimReview(approver,TEST_CHATS.review,incident.id);
    await h.services.review.requestRevision(incident.id,'Уточните результат',approver,answer.id);
    await h.services.sector.takeInWork(incident.id,responder);
    const revised=await h.services.answers.submit(incident.id,responder,'Ремонт выполнен.');
    await h.services.workQueues.claimReview(approver,TEST_CHATS.review,incident.id);
    await h.services.review.approve(incident.id,approver,revised.answer.id);
    row=(await h.services.repository.findById(incident.id))!;expect(row.status).toBe('RESOLVED');
    expect(h.messages.toUser(555n).some(m=>m.message.text.includes('Ремонт выполнен.'))).toBe(true);
    expect(finalAnswerToRequester(row,revised.answer,new Date())).not.toContain(phone);
    expect(JSON.stringify(await prisma.incidentHistory.findMany(), (_key,value)=>typeof value==='bigint'?String(value):value)).not.toContain(phone);
  });
  it.each(['distribution','sector','review'] as const)('shows phone in authorized personal %s cards, blocks a former member',async kind=>{
    await withPhone();const incident=await register();
    const staff=await actorFor(prisma,556n,'Сотрудник',[UserRole.ADMIN,UserRole.DISPATCHER,UserRole.RESPONDER,UserRole.APPROVER]);
    const member=vi.spyOn(h.services.max.api,'getChatMembers').mockResolvedValue({members:[{user_id:556,is_bot:false}]} as never);
    const group=await prisma.responsibleGroup.findFirstOrThrow({where:{code:'FACILITY'}});
    await h.services.distributionQueue.claim(staff,TEST_CHATS.distribution,incident.id);
    if(kind!=='distribution'){
      await h.services.distribution.assign(incident.id,group.id,staff);await h.services.sector.takeInWork(incident.id,staff);
      if(kind==='review'){await h.services.answers.submit(incident.id,staff,'Ответ');await h.services.workQueues.claimReview(staff,TEST_CHATS.review,incident.id);}
    }
    const chat=kind==='distribution'?TEST_CHATS.distribution:kind==='review'?TEST_CHATS.review:TEST_CHATS.sector;
    const item=await prisma.privateWorkItem.create({data:{maxUserId:556n,incidentId:incident.id,originChatId:chat,selected:true,data:{}}});
    for(const details of [false,true]){
      await showPersonalWork(h.services,staff,item.id,details);
      const card=h.messages.toUser(556n).at(-1)!.message;
      expect(card.text).toContain(`Телефон для связи: ${phone}`);
      expect(card.keyboard?.flat().some(b=>b.type==='callback'&&/incident:(contact|privacy-pass):/.test(b.payload))).toBe(false);
    }
    const before=h.messages.toUser(556n).length;
    await personalAction(h.services,staff,item.id,'run',`incident:contact:${incident.id}`);
    expect(h.messages.toUser(556n).slice(before).every(m=>!m.message.text.includes(phone))).toBe(true);
    expect(h.messages.toUser(556n).at(-1)!.message.text).toContain('устарело');
    member.mockResolvedValue({members:[]} as never);
    await expect(showPersonalWork(h.services,staff,item.id,true)).rejects.toThrow();
  });
  it('old privacy callback does not create a mark, lease, or message; history remains',async()=>{
    await withPhone();const incident=await register();const staff=await actorFor(prisma,556n,'Диспетчер',[UserRole.DISPATCHER]);
    await prisma.incidentHistory.create({data:{incidentId:incident.id,action:'PRIVACY_CHECK_PASSED'}});
    const before=await prisma.incident.findUniqueOrThrow({where:{id:incident.id}}),history=await prisma.incidentHistory.findMany(),sent=h.messages.sent.length;
    for(const action of ['privacy-pass','contact'] as const)expect(await handleIncidentCallback({services:h.services,actor:staff,chatId:TEST_CHATS.distribution},{kind:'incident',action,incidentId:incident.id,argument:'confirm'})).toContain('устарело');
    expect(await prisma.incident.findUniqueOrThrow({where:{id:incident.id}})).toEqual(before);
    expect(await prisma.incidentHistory.findMany()).toEqual(history);expect(h.messages.sent.length).toBe(sent);
  });
});
