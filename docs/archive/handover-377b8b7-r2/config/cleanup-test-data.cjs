'use strict';
// Offline maintenance tool. Never starts the bot, never sends messages.
const { fs, req, json, hash, save, api, safeError, panel } = require('./common.cjs');
const { PrismaClient } = req('@prisma/client');
const DRAFTS = new Set(['WAITING_REQUESTER_NAME','WAITING_REQUESTER_PHONE','WAITING_INCIDENT_SELECTION','WAITING_INCIDENT_TEXT','WAITING_CUSTOM_LOCALITY','WAITING_INCIDENT_CONFIRMATION','WAITING_INCIDENT_EDIT_SELECTION','WAITING_INCIDENT_EDIT_VALUE']);
function walk(value, predicate, key = '') {
  if (typeof value === 'string') return predicate(key,value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(v => walk(v, predicate, key));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k,v]) => walk(v,predicate,k));
}
const files = v => walk(v, (k,s) => k === 'storageKey' && !s.startsWith('max-photo:'));
// Includes operation.messageIds in distribution-refresh, scalar card IDs,
// firstMessageId/keyboardMessageId, session previews and history metadata.
const mids = v => walk(v, (k,s) => /(?:^mid$|messageIds?$)/i.test(k) && s.length > 0);
async function plan(db) {
  const incidents = await db.incident.findMany({ orderBy: { id: 'asc' }, include: { attachments: true, answers: { include: { attachments: true } }, clarifications: { include: { attachments: true } }, history: true } });
  const ids = new Set(incidents.map(x => x.id));
  const sessionsAll = await db.operatorSession.findMany({ orderBy: { id: 'asc' } });
  const sessions = sessionsAll.filter(s => ids.has(s.incidentId) || DRAFTS.has(s.type));
  const privateItems = await db.privateWorkItem.findMany({ where: { incidentId: { in: [...ids] } }, orderBy: { id: 'asc' } });
  const refs = new Set([...ids, ...incidents.map(x => x.publicCode), ...incidents.flatMap(i => i.answers.map(a => a.id)), ...sessions.flatMap(s => [s.id,s.data?.draftToken,s.data?.previewToken].filter(Boolean))]);
  const referenced = value => [...json(value).matchAll(/INC-(?:\d{8}-\d+|\d{6})\b|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].some(m => refs.has(m[0]));
  const settings = await db.systemSetting.findMany({ orderBy: { key: 'asc' } });
  const panels = settings.filter(panel);
  const protectedMids = new Set([...panels.map(p => p.value), ...settings.filter(s => s.key.startsWith('panel-recovery:')).flatMap(s => { try { const v=JSON.parse(s.value); return [v.missingId,...(v.retire||[])].filter(Boolean); } catch { return []; } })]);
  const outAll = await db.outboundMessage.findMany({ orderBy: { id: 'asc' } });
  const outbox = outAll.filter(o => !['distribution-panel','work-panel','bot-status'].includes(o.payload?.operation?.type) && (ids.has(o.incidentId) || refs.has(o.answerId) || referenced(o.payload)));
  const draftActors = new Set(sessions.map(s => `${s.maxUserId}:${s.chatId}`));
  const inboxAll = await db.inboundUpdate.findMany({ orderBy: { id: 'asc' } });
  const inbox = inboxAll.filter(i => {
    const p=i.payload, m=p?.message;
    return referenced(p) || (['PENDING','PROCESSING','FAILED'].includes(i.status) && m && draftActors.has(`${m.sender?.user_id}:${m.recipient?.chat_id}`));
  });
  const selectedInbox = new Set(inbox.map(i => i.id));
  // Unknown unfinished user/staff input may recreate deleted test messages: stop, do not clear it blindly.
  const blockers = inboxAll.filter(i => ['PENDING','PROCESSING'].includes(i.status) && ['message_created','message_callback'].includes(i.updateType) && !selectedInbox.has(i.id)).map(i => ({ queue:'inbox', id:i.id, type:i.updateType, status:i.status }));
  const chosenOut = new Set(outbox.map(o => o.id)), chosenSessions = new Set(sessions.map(s => s.id));
  // Untracked pending reports/files can still contain removed incident data.
  // Their scope cannot be inferred safely from a generic report caption.
  blockers.push(...outAll.filter(o => !chosenOut.has(o.id) && ['PENDING','SENDING'].includes(o.status) && Array.isArray(o.attachments) && o.attachments.length)
    .map(o => ({queue:'outbox',id:o.id,type:'unclassified-attachments',status:o.status})));
  const candidates = [...new Set(files([incidents,sessions,privateItems,outbox]))];
  const preserved = new Set(files([outAll.filter(o => !chosenOut.has(o.id)),sessionsAll.filter(s => !chosenSessions.has(s.id))]));
  const fileKeys = candidates.filter(f => !preserved.has(f));
  const messageIds = [...new Set(mids([incidents,sessions,privateItems,outbox]))].filter(mid => !protectedMids.has(mid));
  const locks = await db.actionLock.findMany({ where: { incidentId: { in: [...ids] } }, orderBy: { key: 'asc' } });
  return { version: 2, fingerprint: hash({ version:2, incidents,sessions,privateItems,outbox,inbox,locks,panels,messageIds,protectedMids:[...protectedMids] }),
    incidentIds:[...ids], codes:incidents.map(i=>i.publicCode), sessionIds:sessions.map(s=>s.id), outboxIds:outbox.map(o=>o.id), inboxIds:inbox.map(i=>i.id),
    messageIds, fileKeys, protectedMids:[...protectedMids], blockers,
    counts: { incidents:incidents.length, active:incidents.filter(i=>!['RESOLVED','REJECTED'].includes(i.status)).length, drafts:sessions.filter(s=>DRAFTS.has(s.type)).length, sessions:sessions.length, outbox:outbox.length, inbox:inbox.length, cards:messageIds.length, files:fileKeys.length, sharedFilesPreserved:preserved.size } };
}
async function apply(db, expected) {
  if (expected.version !== 2) throw Object.assign(new Error('Legacy cleanup plan requires audit'), { cleanupCode:'LEGACY_PLAN_REQUIRES_AUDIT' });
  if (expected.blockers.length) throw Error('Unclassified pending input');
  const key=`maintenance.package-cleanup:${expected.fingerprint}`;
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL lock_timeout = \'5s\'');
    await tx.$executeRawUnsafe('LOCK TABLE "Incident", "IncidentAnswer", "IncidentAttachment", "AnswerAttachment", "Clarification", "ClarificationAttachment", "IncidentHistory", "OperatorSession", "PrivateWorkItem", "OutboundMessage", "InboundUpdate", "ActionLock", "SystemSetting" IN SHARE ROW EXCLUSIVE MODE');
    const previous = await tx.systemSetting.findUnique({ where: { key } });
    if (previous) {
      const journal=JSON.parse(previous.value);
      if (journal.version !== 2) throw Object.assign(new Error('Legacy cleanup journal requires audit'), { cleanupCode:'LEGACY_PLAN_REQUIRES_AUDIT' });
      return journal;
    }
    const current = await plan(tx);
    if (current.fingerprint !== expected.fingerprint || current.blockers.length) throw Error('Plan changed');
    const journal = { ...current, key, committedAt: new Date().toISOString(), remainingMessages:current.messageIds, remainingFiles:current.fileKeys };
    await tx.systemSetting.create({ data: { key, value:json(journal) } });
    // Retain inbox identity tombstones so redelivery cannot resurrect the same event.
    await tx.inboundUpdate.updateMany({ where: { id: { in: current.inboxIds } }, data: { status:'PROCESSED', payload:{}, lockedAt:null, processedAt:new Date(), lastError:'Test data removed by confirmed maintenance plan' } });
    await tx.outboundMessage.deleteMany({ where: { id: { in: current.outboxIds } } });
    await tx.operatorSession.deleteMany({ where: { id: { in: current.sessionIds } } });
    await tx.actionLock.deleteMany({ where: { incidentId: { in: current.incidentIds } } });
    await tx.incident.deleteMany({ where: { id: { in: current.incidentIds } } });
    return journal;
  }, { timeout:60000, isolationLevel:'Serializable' });
}
async function finish(db, journal, max, storage, persist) {
  if (journal.version !== 2) throw Object.assign(new Error('Legacy cleanup journal requires audit'), { cleanupCode:'LEGACY_PLAN_REQUIRES_AUDIT' });
  const botId=(await max.me()).user_id;
  const protectedNow=(await db.systemSetting.findMany()).filter(panel).map(p=>p.value);
  journal.messageResults ??= {};
  for (const mid of [...journal.remainingMessages]) {
    const result=journal.messageResults[mid] ??= { outcome:'pending', attempts:[] };
    const record=async(stage,code)=>{
      result.attempts.push({stage,code,at:new Date().toISOString()});
      await persist(journal);
    };
    if (protectedNow.includes(mid) || journal.protectedMids.includes(mid)) {
      await record('protect','PANEL_PROTECTED'); continue;
    }
    let m;
    try {
      m=await max.get(mid);
    } catch(e) {
      // A GET 404 does not prove deletion and cannot verify authorship.
      await record('read',safeError(e)); continue;
    }
    if (m.sender?.user_id !== botId || !m.sender?.is_bot || /📋 ОЧЕРЕДЬ|Панель обновляется каждую минуту/.test(m.body?.text||'')) {
      await record('protect','OWNERSHIP_OR_PANEL_MISMATCH'); continue;
    }
    // Persist intent first: a crash/lost response must remain unresolved on retry.
    await record('delete','REQUEST_STARTED');
    let response;
    try { response=await max.remove(mid); }
    catch(e) { await record('delete',safeError(e)); continue; }
    // Neither DELETE 404 nor an empty/ambiguous success body is confirmation.
    if (response?.success !== true) { await record('delete','UNCONFIRMED_RESPONSE'); continue; }
    result.outcome='deleted-confirmed';
    journal.remainingMessages=journal.remainingMessages.filter(x=>x!==mid);
    await record('delete','SUCCESS_TRUE');
  }
  for (const file of [...journal.remainingFiles]) {
    try { await storage.remove(file); journal.remainingFiles=journal.remainingFiles.filter(x=>x!==file); } catch {}
    await persist(journal);
  }
  return journal;
}
module.exports={walk,mids,plan,apply,finish};
if(require.main===module) {
  const db=new PrismaClient({log:[]});
  (async()=>{
    const [mode,file,confirm]=process.argv.slice(2);
    if(mode==='plan' && file) { const p=await plan(db); save(file,p); console.log(json({fingerprint:p.fingerprint,counts:p.counts,blockers:p.blockers})); return; }
    if(!['apply','retry'].includes(mode)||!file||process.env.CLEANUP_APP_STOPPED!=='YES') throw Error('Need stopped application and plan file');
    const p=JSON.parse(fs.readFileSync(file,'utf8'));
    if(confirm!==p.fingerprint) throw Error('Explicit fingerprint required');
    let j=await apply(db,p);
    save(file+'.journal.json',j);
    const persist=async value=>{ await db.systemSetting.update({where:{key:value.key},data:{value:json(value)}}); save(file+'.journal.json',value); };
    const {createMediaStorage}=req('./dist/media/media.service');
    j=await finish(db,j,{me:()=>api('GET','/me'),get:mid=>api('GET',`/messages/${encodeURIComponent(mid)}`),remove:mid=>api('DELETE',`/messages?message_id=${encodeURIComponent(mid)}`)},createMediaStorage(),persist);
    console.log(json({databaseDeleted:true,remainingMessages:j.remainingMessages.length,remainingFiles:j.remainingFiles.length,journal:file+'.journal.json'}));
    if(j.remainingMessages.length||j.remainingFiles.length)process.exitCode=2;
  })().catch(e=>{console.error(e?.cleanupCode==='LEGACY_PLAN_REQUIRES_AUDIT'
    ? 'Cleanup stopped: LEGACY_PLAN_REQUIRES_AUDIT. Do not retry an old plan. See PATCH-TOOLS.md; audit any previously applied cleanup.'
    : 'Cleanup stopped; inspect saved plan/journal, backup and stopped workers. '+safeError(e));process.exitCode=1;}).finally(()=>db.$disconnect());
}
