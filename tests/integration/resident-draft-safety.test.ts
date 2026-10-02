import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UserRole, type PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import { RESIDENT_DRAFT_TTL_MS, OperatorSessionService, type SessionData } from '../../src/sessions/operator-session.service';
import { showIncidentDraftPreview } from '../../src/bot/requester-draft';
import { myIncidentsText } from '../../src/bot/views/cards';
import { TEST_CHATS } from '../helpers/setup-env';

describeIntegration('resident draft screen versions and inactivity', () => {
  let prisma: PrismaClient; let h: TestHarness; let inbox: UpdateDispatcher;
  beforeAll(async () => { pushSchemaOnce(); prisma = createTestPrisma(); await prisma.$connect(); });
  afterAll(() => prisma.$disconnect());
  afterEach(() => vi.restoreAllMocks());
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    h.services.max = { answerCallback: vi.fn(async () => undefined) } as never;
    inbox = new UpdateDispatcher(prisma, { dispatch: async (update: any) => update.update_type === 'message_callback'
      ? handleCallbackUpdate(h.services, { update } as never) : handleMessageUpdate(h.services, { update } as never) } as never);
  });
  const session = () => prisma.operatorSession.findUniqueOrThrow({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } });
  const data = async () => (await session()).data as SessionData;
  const message = (text: string, photo = false) => ({ update_type: 'message_created', timestamp: Date.now(), message: {
    timestamp: Date.now(), sender: { user_id: 555, name: 'Житель' }, recipient: { chat_type: 'dialog', chat_id: 555 },
    body: { mid: randomUUID(), text, attachments: photo ? [{ type: 'image', payload: { token: 'photo-one' } }] : [] },
  } });
  const press = (payload: string, id = randomUUID()) => inbox.handle({ update_type: 'message_callback', timestamp: Date.now(),
    callback: { callback_id: id, user: { user_id: 555, name: 'Житель' }, payload }, message: message('').message } as never);
  const button = async (action: string, argument?: string) => {
    const d = await data();
    const index = d.screenActions?.findIndex(raw => { const p = parseCallbackPayload(raw); return p?.kind === 'user' && p.action === action && (argument === undefined || p.argument === argument || p.argument?.endsWith('~'+argument)); }) ?? -1;
    expect(index).toBeGreaterThanOrEqual(0);
    const payload = `user:draft-action:${d.screenToken}~${index}`;
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(64); return payload;
  };
  const click = async (action: string, argument?: string) => press(await button(action, argument));
  const type = (text: string, photo = false) => inbox.handle(message(text, photo) as never);
  const startText = async () => {
    await press('user:new'); await click('category','none'); await click('municipality','KALUGA_CITY');
    expect((await session()).type).toBe('WAITING_INCIDENT_TEXT');
  };
  const preview = async () => { await startText(); await type('У дома по улице Пушкина А. С. не работает освещение.', true); };
  const withPhone = async () => { await preview(); await click('draft-phone-enter'); await type('8 (900) 123-45-67'); };

  it('keeps all fields on new/start/restart, continues and resets only the selected draft', async () => {
    await withPhone(); const before = await data(); const oldConfirm = await button('draft-confirm');
    await press('user:new'); const reset = await button('draft-reset');
    expect(await data()).toMatchObject({ draftToken: before.draftToken, draftText: before.draftText, draftMedia: before.draftMedia, requesterPhone: before.requesterPhone, selectedCategoryId: before.selectedCategoryId, problemMunicipalityCode: before.problemMunicipalityCode });
    const offered = await data(); await type('Новый текст без выбора', true); expect(await data()).toEqual(offered);
    h.services.sessions = new OperatorSessionService(prisma);
    await type('/start'); await click('draft-resume');
    expect(await data()).toMatchObject({ draftToken: before.draftToken, requesterPhone: before.requesterPhone, draftMedia: before.draftMedia });
    await press(reset); await press(oldConfirm); expect(await prisma.incident.count()).toBe(0);
    await press('user:new'); await click('draft-reset');
    const fresh = await data(); expect(fresh.draftToken).not.toBe(before.draftToken); expect(fresh.requesterPhone).toBeUndefined(); expect(fresh.draftText).toBeUndefined();
    await press(reset); expect(await data()).toEqual(fresh);
    await expect(showIncidentDraftPreview(h.services,555n,555n,before)).rejects.toThrow('Это действие устарело');
    expect(await data()).toEqual(fresh);
  });

  it('uses 24 hours of accepted resident activity, preserves staff TTL and expires old controls', async () => {
    await startText(); const first = await session();
    expect(first.expiresAt.getTime() - Date.now()).toBeGreaterThan(RESIDENT_DRAFT_TTL_MS - 5000);
    await prisma.operatorSession.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now()+1000), data: { ...await data(), draftTouchedAt: Date.now()-RESIDENT_DRAFT_TTL_MS+1000 } as never } });
    await type('Яма у дома 12'); expect((await session()).expiresAt.getTime()-Date.now()).toBeGreaterThan(RESIDENT_DRAFT_TTL_MS-5000);
    const old = await button('draft-confirm'); await prisma.operatorSession.updateMany({ data: { expiresAt: new Date(0) } });
    await press(old); expect(await prisma.incident.count()).toBe(0); expect(await prisma.operatorSession.count()).toBe(0);
    expect(vi.mocked(h.services.max.answerCallback).mock.calls.some(c => JSON.stringify(c).includes('24 часов'))).toBe(true);
    const staff = await h.services.sessions.start({ maxUserId: 556n, chatId: -100n, type: 'WAITING_FOR_ANSWER' });
    expect(staff.expiresAt.getTime()-Date.now()).toBeLessThan(RESIDENT_DRAFT_TTL_MS/2);
  });

  it('rejects stale category, pagination, edit and photo buttons even when the same session type returns', async () => {
    await press('user:new'); const category = await button('category','none');
    await click('category','none'); const page = await button('location-page');
    await click('municipality','KALUGA_CITY'); await type('Яма у дома 2',true);
    await click('draft-edit'); const field = await button('draft-field','text');
    await click('draft-field','photo'); const remove = await button('draft-photo','remove');
    await click('draft-edit'); await click('draft-field','category');
    const before = await data();
    for (const stale of [category,page,field,remove,'user:draft-photo:remove','user:category:none']) await press(stale);
    expect(await data()).toEqual(before);
    await click('category','none'); expect((await data()).draftMedia).toHaveLength(1);
  });

  it('versions locality, custom text, phone back and photo replace controls', async () => {
    await press('user:new'); await click('category','none');
    const municipality = await button('municipality','BOROVSKY'); await press(municipality);
    const locality = await button('locality','BOROVSK'); const other = await button('locality','other');
    await press(other); const delayed = await inbox.reserve(message('Старое село') as never);
    await type('/start'); await click('draft-resume');
    await inbox.kick(); await inbox.waitForIdle(); expect((await session()).type).toBe('WAITING_CUSTOM_LOCALITY');
    expect((await prisma.inboundUpdate.findUniqueOrThrow({where:{id:delayed.id!}})).status).toBe('PROCESSED');
    await type('Новое село'); await type('Яма у дома 2',true);
    await click('draft-phone-enter'); const back = await button('draft-phone-back'); await type('89001234567');
    await click('draft-edit'); await click('draft-field','photo'); const remove = await button('draft-photo','remove');
    await click('draft-photo','replace'); await type('',true);
    const before = await data();
    for (const stale of [municipality,locality,other,back,remove,'session:cancel']) await press(stale);
    expect(await data()).toEqual(before); expect(before.problemLocality).toBe('Новое село');
    expect(before.requesterPhone).toBe('+7 900 123-45-67'); expect(before.draftMedia).toHaveLength(1);
  });

  it('binds queued text/photos to their screen; cannot fill a replacement or cancelled draft', async () => {
    await startText(); const incoming = message('Яма у дома 2',true); const reservation = await inbox.reserve(incoming as never);
    await press('user:new'); await click('draft-reset');
    const before = await data(); await inbox.kick(); await inbox.waitForIdle(); expect((await prisma.inboundUpdate.findUniqueOrThrow({where:{id:reservation.id!}})).status).toBe('PROCESSED'); expect(await data()).toEqual(before);
    await click('category','none'); await click('municipality','KALUGA_CITY'); await type('Яма у дома 3',true);
    const confirm = await button('draft-confirm');
    await Promise.all([press(confirm),press(confirm)]);
    expect(await prisma.incident.count()).toBe(1);
    await press('user:new'); const after = await data(); await press(confirm); expect(await data()).toEqual(after);
  });

  it('does not reinterpret a legacy inbox row without screen binding after an upgrade', async () => {
    await startText(); const old = message('Старое сообщение до обновления', true);
    const queued = await inbox.reserve(old as never);
    await prisma.inboundUpdate.update({where:{id:queued.id!},data:{payload:old as never}});
    await press('user:new'); await click('draft-reset'); await click('category','none'); await click('municipality','KALUGA_CITY');
    const before = await data(); await inbox.kick(); await inbox.waitForIdle();
    expect(await data()).toEqual(before); expect(await prisma.incident.count()).toBe(0);
    expect((await prisma.inboundUpdate.findUniqueOrThrow({where:{id:queued.id!}})).status).toBe('PROCESSED');
    expect(h.messages.toUser(555n).at(-1)?.message.text).toContain('Это действие устарело');
  });

  it('retains photo and phone across text editing, pending preview recovery and explicit confirmation', async () => {
    await withPhone(); await click('draft-edit'); await click('draft-field','text');
    const send = vi.spyOn(h.messages,'send').mockRejectedValueOnce(new MaxError(503,{code:'unavailable',message:'temporary'}));
    await type('Яма у дома 10'); send.mockRestore();
    expect(await data()).toMatchObject({ draftText:'Яма у дома 10', requesterPhone:'+7 900 123-45-67', draftMedia:[{kind:'IMAGE',token:'photo-one'}], previewDeliveryPending:true });
    await click('draft-retry'); await click('draft-edit'); await click('draft-phone-remove');
    expect((await data()).requesterPhone).toBeUndefined(); expect((await data()).draftMedia).toHaveLength(1);
    expect(await prisma.incident.count()).toBe(0); await click('draft-confirm');
    expect((await prisma.incident.findFirstOrThrow()).requesterPhone).toBeNull();
  });

  it.each(['Иванов Иван Иванович','паспорт 45 12 123456','123-456-789 01','test@example.ru','40817810000000000001'])('address exception does not hide %s through inbox',async secret => {
    await startText(); await type(`Улица Пушкина А. С., дом 2. ${secret}`);
    expect((await session()).type).toBe('WAITING_INCIDENT_TEXT'); expect(await prisma.incident.count()).toBe(0);
    expect(h.messages.toUser(555n).at(-1)?.message.text).toContain('Сообщение не принято');
  });

  it('closes only after confirmed delivery of the latest answer; approval date remains unchanged', async () => {
    const incident = await h.services.incidents.create({requester:{maxUserId:555n},text:'Яма у дома 2'});
    const staff = await actorFor(prisma,556n,'Сотрудник',[UserRole.ADMIN]);
    const group = await prisma.responsibleGroup.findFirstOrThrow({where:{code:'FACILITY'}});
    await h.services.distribution.assign(incident.id,group.id,staff);
    const {answer} = await h.services.answers.submit(incident.id,staff,'Работы выполнены');
    const send = vi.spyOn(h.messages,'send').mockRejectedValue(new Error('offline'));
    await expect(h.services.review.approve(incident.id,staff)).rejects.toThrow('offline'); send.mockRestore();
    const approved = await prisma.incident.findUniqueOrThrow({where:{id:incident.id}});
    expect(approved.status).toBe('RESOLVED'); expect(approved.answeredAt).not.toBeNull();
    expect(myIncidentsText(await h.services.incidents.listForRequester(555n))).toContain('Ответ отправляется');
    await h.services.delivery.deliverAnswer(incident.id,answer.id,'Работы выполнены');
    expect(myIncidentsText(await h.services.incidents.listForRequester(555n))).toContain('Закрыто');
    await prisma.incidentAnswer.create({data:{incidentId:incident.id,version:answer.version+1,text:'Уточнённый ответ',createdByUserId:staff.userId,status:'APPROVED'}});
    expect(myIncidentsText(await h.services.incidents.listForRequester(555n))).toContain('Ответ отправляется');
    expect((await prisma.incident.findUniqueOrThrow({where:{id:incident.id}})).answeredAt).toEqual(approved.answeredAt);
  });
});
