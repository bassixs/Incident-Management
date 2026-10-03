import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { MaxError } from '@maxhub/max-bot-api';
import { actorFor, createHarness, createTestPrisma, describeIntegration, pushSchemaOnce, resetDatabase, seedCategories, type TestHarness } from '../helpers/integration';
import { handleMessageUpdate } from '../../src/bot/handlers/message.handler';
import { handleCallbackUpdate } from '../../src/bot/callbacks';
import { parseCallbackPayload } from '../../src/max/callback-payload';
import { UpdateDispatcher } from '../../src/server/update-dispatcher';
import type { SessionData } from '../../src/sessions/operator-session.service';
import { RESIDENT_PHOTO_LIMIT_MESSAGE } from '../../src/incidents/resident-photo-limit';
import { MaxMessageService } from '../../src/max/max-message.service';
import { MediaService } from '../../src/media/media.service';
import { photoReference } from '../../src/media/max-photo-reference';
import { buildServices } from '../../src/app/container';
import type { SendMessageExtra } from '../../src/max/max-types';

describeIntegration('resident photo admission limit through inbox', () => {
  let prisma: PrismaClient; let h: TestHarness; let inbox: UpdateDispatcher;
  const workers: MaxMessageService[] = [];
  beforeAll(() => { pushSchemaOnce(); prisma = createTestPrisma(); });
  afterAll(() => prisma.$disconnect());
  afterEach(async () => { for (const worker of workers) worker.stop(); await Promise.all(workers.map(w => w.waitForIdle())); workers.length = 0; vi.restoreAllMocks(); });
  beforeEach(async () => {
    await resetDatabase(prisma); await seedCategories(prisma); h = await createHarness(prisma);
    h.services.max = { answerCallback: vi.fn(async () => undefined) } as never;
    vi.spyOn(h.services.media, 'ingestAll').mockImplementation(async (_prefix, photos) => photos.map(photo => ({
      type: 'IMAGE', storageKey: photoReference(photo.token!), maxToken: photo.token, size: 0,
    })));
    inbox = new UpdateDispatcher(prisma, { dispatch: async (update: any) => update.update_type === 'message_callback'
      ? handleCallbackUpdate(h.services, { update } as never) : handleMessageUpdate(h.services, { update } as never) } as never);
  });
  const session = () => prisma.operatorSession.findUniqueOrThrow({ where: { maxUserId_chatId: { maxUserId: 555n, chatId: 555n } } });
  const data = async () => (await session()).data as SessionData;
  const message = (count = 0, text = 'Яма у дома 12', prefix = 'photo') => ({ update_type: 'message_created', timestamp: Date.now(), message: {
    timestamp: Date.now(), sender: { user_id: 555, name: 'Житель' }, recipient: { chat_type: 'dialog', chat_id: 555 },
    body: { mid: randomUUID(), text, attachments: Array.from({ length: count }, (_, i) => ({ type: 'image', payload: { token: `${prefix}-${i}` } })) },
  } });
  const press = (payload: string) => inbox.handle({ update_type: 'message_callback', timestamp: Date.now(),
    callback: { callback_id: randomUUID(), user: { user_id: 555, name: 'Житель' }, payload }, message: message().message } as never);
  const button = async (action: string, argument?: string) => {
    const d = await data(); const index = d.screenActions?.findIndex(raw => {
      const p = parseCallbackPayload(raw); return p?.kind === 'user' && p.action === action && (argument === undefined || p.argument === argument || p.argument?.endsWith('~'+argument));
    }) ?? -1;
    expect(index).toBeGreaterThanOrEqual(0); return `user:draft-action:${d.screenToken}~${index}`;
  };
  const click = async (action: string, argument?: string) => press(await button(action, argument));
  const input = (count: number, text?: string, prefix?: string) => inbox.handle(message(count, text, prefix) as never);
  const start = async () => { await press('user:new'); await click('category','none'); await click('municipality','KALUGA_CITY'); };
  const last = () => h.messages.toUser(555n).at(-1)!.message;

  it.each([0, 1, 4])('accepts %i photos through inbox and registers only on confirmation', async count => {
    await start(); await input(count);
    expect((await data()).draftMedia).toHaveLength(count);
    expect(last().attachments ?? []).toHaveLength(count);
    expect(await prisma.incident.count()).toBe(0);
    await click('draft-confirm');
    expect(await prisma.incident.count()).toBe(1);
    expect(await prisma.incidentAttachment.count()).toBe(count);
    expect(await prisma.inboundUpdate.count({ where: { status: { not: 'PROCESSED' } } })).toBe(0);
  });

  it.each([5, 9])('rejects %i initial photos without draft mutation/quota; a valid retry succeeds', async count => {
    await start(); const before = await session(); const quota = await h.services.incidents.remainingDailyQuota(555n);
    await input(count);
    expect(last().text).toContain(RESIDENT_PHOTO_LIMIT_MESSAGE);
    expect(last().text).toContain('Повторно отправьте текст сообщения вместе с выбранными фото');
    expect(last().attachments).toBeUndefined(); expect(await session()).toEqual(before);
    expect(h.services.media.ingestAll).not.toHaveBeenCalled();
    expect(await h.services.incidents.remainingDailyQuota(555n)).toBe(quota);
    expect(await prisma.incident.count()).toBe(0);
    await input(4); await click('draft-confirm');
    expect(await prisma.incidentAttachment.count()).toBe(4);
    expect(await prisma.incident.count()).toBe(1);
  });

  it.each([0,2])('rejects oversized addition/replacement of %i old photos preserving all fields and accepts retry', async oldCount => {
    await start(); await input(oldCount); await click('draft-phone-enter'); await input(0,'8 (900) 123-45-67');
    await click('draft-edit'); await click('draft-field','photo'); await click('draft-photo','replace');
    const before = await session(); const mediaBefore = (await data()).draftMedia;
    await input(5,'','bad');
    expect(await session()).toEqual(before); expect(last().text).toContain('Повторно отправьте только выбранные фотографии');
    expect(last().attachments).toBeUndefined(); expect((await data()).draftMedia).toEqual(mediaBefore);
    await input(4,'','replacement'); expect((await data()).requesterPhone).toBe('+7 900 123-45-67');
    await click('draft-confirm');
    const incident = await prisma.incident.findFirstOrThrow({ include: { attachments: true } });
    expect(incident).toMatchObject({ text:'Яма у дома 12', requesterPhone:'+7 900 123-45-67', problemMunicipalityCode:'KALUGA_CITY' });
    expect(incident.attachments.map(a => a.maxToken).sort()).toEqual(['replacement-0','replacement-1','replacement-2','replacement-3']);
  });

  it.each(['resume-replace','resume-remove','confirm-replace','confirm-remove'])('repairs oversized legacy draft via %s without partial registration', async scenario => {
    await start(); await input(4); await click('draft-phone-enter'); await input(0,'89001234567');
    const old = await data(); const legacy = { ...old, draftMedia: Array.from({ length: 7 },(_,i) => ({ kind:'IMAGE' as const, token:`legacy-${i}` })) };
    await prisma.operatorSession.update({ where:{ id:(await session()).id }, data:{ data:legacy as never } });
    const obsoleteConfirm = await button('draft-confirm');
    if (scenario.startsWith('resume')) { await press('user:new'); await click('draft-resume'); }
    else await press(obsoleteConfirm);
    expect((await session()).type).toBe('WAITING_INCIDENT_EDIT_SELECTION');
    expect(await data()).toMatchObject({ draftMedia:legacy.draftMedia, draftText:old.draftText, requesterPhone:old.requesterPhone, selectedCategoryId:old.selectedCategoryId, problemMunicipalityCode:old.problemMunicipalityCode });
    expect(last().attachments).toBeUndefined(); expect(last().text).toContain(RESIDENT_PHOTO_LIMIT_MESSAGE);
    expect(await prisma.incident.count()).toBe(0);
    await press(obsoleteConfirm); expect(await prisma.incident.count()).toBe(0);
    if(scenario.endsWith('replace')) { await click('draft-photo','replace'); await input(4,'','corrected'); }
    else await click('draft-photo','remove');
    const confirm = await button('draft-confirm'); await press(confirm); await press(confirm);
    const incident = await prisma.incident.findFirstOrThrow({ include:{attachments:true} });
    expect(await prisma.incident.count()).toBe(1);
    expect(incident).toMatchObject({ text:old.draftText,requesterPhone:old.requesterPhone,problemMunicipalityCode:old.problemMunicipalityCode });
    expect(incident.attachments).toHaveLength(scenario.endsWith('replace')?4:0);
  });

  it('rejects direct registration before ingestion or any counter/quota/history changes', async () => {
    await actorFor(prisma,555n,'Житель',[]); const quota=await h.services.incidents.remainingDailyQuota(555n);
    await expect(h.services.incidents.create({ requester:{ maxUserId:555n }, text:'Яма у дома 12', media:Array.from({length:5},()=>({kind:'IMAGE',token:'too-many'})) })).rejects.toMatchObject({ details:{reason:'too_many_photos'} });
    expect(h.services.media.ingestAll).not.toHaveBeenCalled();
    expect(await prisma.incident.count()).toBe(0); expect(await prisma.incidentCounter.count()).toBe(0); expect(await prisma.incidentHistory.count()).toBe(0);
    expect(await h.services.incidents.remainingDailyQuota(555n)).toBe(quota);
  });

  it('sends the short resident preview with four photos and buttons in exactly one MAX call', async () => {
    await start();
    const sendToUser=vi.fn(async () => ({body:{mid:'one-preview'}}));
    const worker=new MaxMessageService({sendToUser} as never,{prisma,storage:{save:vi.fn(),load:vi.fn(),remove:vi.fn()} as never});
    workers.push(worker);h.services.messages=worker;
    await input(4);
    expect(sendToUser).toHaveBeenCalledTimes(1);
    const call=vi.mocked(sendToUser).mock.calls[0] as unknown as [bigint,string,SendMessageExtra];
    expect(call[1]).toContain('Яма у дома 12');
    expect(call[2].attachments?.filter(a=>a.type==='image')).toHaveLength(4);
    expect(call[2].attachments?.some(a=>a.type==='inline_keyboard')).toBe(true);
    expect((await session()).type).toBe('WAITING_INCIDENT_CONFIRMATION');
    expect(await prisma.incident.count()).toBe(0);
  });

  it.each([4,7])('delivers a registered card with %i photos; legacy data/outbox survive retry and restart', async count => {
    const actor=await actorFor(prisma,555n,'Житель',[]);
    // Restore-like fixture: a historical registered record awaiting card publication.
    // create() would already snapshot its empty attachment set into a deduplicated job.
    const incident=await prisma.incident.create({data:{publicCode:'INC-HISTORICAL',requesterId:actor.userId,
      requesterMaxUserId:555n,requesterName:'Житель',text:'Яма у дома 12',deadlineAt:new Date(Date.now()+86400000)}});
    await prisma.incidentAttachment.createMany({data:Array.from({length:count},(_,i)=>({incidentId:incident.id,type:'IMAGE' as const,storageKey:photoReference(`saved-${i}`),maxToken:`saved-${i}`}))});
    const before=await prisma.incidentAttachment.findMany({where:{incidentId:incident.id},orderBy:{id:'asc'}});
    let seq=0; const delivered: {text:string;extra?:SendMessageExtra}[]=[];
    const max={
      sendToChat:vi.fn(async (_id:bigint,text:string,extra?:SendMessageExtra)=>{delivered.push({text,extra});return {body:{mid:`delivered-${++seq}`}};}),
      editCardWithKeyboard:vi.fn(async () => undefined),
    };
    const storage={save:vi.fn(),load:vi.fn(),remove:vi.fn()};
    const worker=()=>{const w=new MaxMessageService(max as never,{prisma,storage:storage as never});workers.push(w);return w;};
    const first=worker(); const services=buildServices(prisma,{messages:first,media:new MediaService(storage as never,max as never)});
    if(count>4)max.sendToChat.mockRejectedValueOnce(new MaxError(503,{code:'unavailable',message:'temporary'}));
    await services.distribution.publishCard(incident.id); await first.flush();
    if(count>4){
      first.stop();await first.waitForIdle();
      const queued=await prisma.outboundMessage.findFirstOrThrow();expect(queued.status).toBe('PENDING');
      expect(delivered).toHaveLength(0);
      await prisma.outboundMessage.update({where:{id:queued.id},data:{nextAttemptAt:new Date(0)}});
      await worker().flush();
      expect((await prisma.outboundMessage.findUniqueOrThrow({where:{id:queued.id}})).status).toBe('SENT');
    }
    expect(delivered).toHaveLength(count===4?1:2);
    expect(delivered[0]!.text).toContain('Яма у дома 12');
    expect(delivered.some(x=>x.extra?.attachments?.some(a=>a.type==='inline_keyboard'))).toBe(true);
    expect(delivered.flatMap(x=>(x.extra?.attachments??[]).flatMap(a=>a.type==='image'?[a.payload.token]:[]))).toEqual(Array.from({length:count},(_,i)=>`saved-${i}`));
    expect(await prisma.incidentAttachment.findMany({where:{incidentId:incident.id},orderBy:{id:'asc'}})).toEqual(before);
    expect(await prisma.outboundMessage.count({where:{dedupeKey:`distribution-card:${incident.id}`}})).toBe(1);
    expect((await prisma.outboundMessage.findUniqueOrThrow({where:{dedupeKey:`distribution-card:${incident.id}`}})).status).toBe('SENT');
    // Successful tracking also persists the ordinary refresh of distribution copies.
    expect(await prisma.outboundMessage.count()).toBe(2);
    expect((await prisma.outboundMessage.findFirstOrThrow({where:{dedupeKey:{startsWith:`distribution-refresh:${incident.id}:`}}})).payload)
      .toMatchObject({operation:{type:'distribution-refresh',incidentId:incident.id,refreshActive:true}});
  });
});
