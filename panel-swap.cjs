'use strict';
// One-shot maintenance, not an app/worker. No POST retry, DELETE, pin or status writes.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const REV = '8dcfa330183e47551446d10cabbd3b493a42ea0b';
const encode = x => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? String(v) : v);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
function need(ok, code) { if (!ok) throw new Refusal(code); }

class Journal {
  constructor(dir) { this.dir = dir; this.file = path.join(dir, 'journal.json'); }
  lock() {
    const st = fs.lstatSync(this.dir);
    need(st.isDirectory() && !st.isSymbolicLink(), 'UNSAFE_STATE_DIRECTORY');
    if (process.platform !== 'win32') need((st.mode & 0o077) === 0 && st.uid === process.getuid(), 'PRIVATE_STATE_DIRECTORY_REQUIRED');
    const p = path.join(this.dir, 'operator.lock');
    let fd;
    try { fd = fs.openSync(p, 'wx', 0o600); } catch { throw new Refusal('OPERATION_LOCKED'); }
    fs.writeFileSync(fd, encode({ pid:process.pid, at:new Date().toISOString() })); fs.fsyncSync(fd); fs.closeSync(fd);
    return () => fs.unlinkSync(p);
  }
  read() {
    need(fs.existsSync(this.file), 'JOURNAL_REQUIRED');
    need(!fs.lstatSync(this.file).isSymbolicLink(), 'UNSAFE_JOURNAL');
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { throw new Refusal('INVALID_JOURNAL'); }
  }
  save(value, previous) {
    const bytes = encode(value);
    if (previous === undefined) need(!fs.existsSync(this.file), 'JOURNAL_EXISTS');
    else need(encode(this.read()) === encode(previous), 'JOURNAL_CHANGED');
    const next = this.file + '.next';
    const fd = fs.openSync(next, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(next, this.file);
    if (process.platform !== 'win32') { const d=fs.openSync(this.dir,'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } }
  }
  update(previous, patch) { const next = {...previous,...patch}; this.save(next, previous); return next; }
}

class PanelSwap {
  constructor({db,max,journal,expected,own,text,buttons,now=()=>Date.now()}) {
    this.db=db; this.max=max; this.j=journal; this.e=expected; this.own=own; this.text=text; this.buttons=buttons; this.now=now;
    need(expected.revision===REV && /^-\d+$/.test(expected.chatId) && expected.oldMid && expected.jobId, 'INVALID_EXPECTATION');
    this.chat=BigInt(expected.chatId); this.key='work-panel:'+expected.chatId;
  }
  state() { const s=this.j.read(); need(s.v===1 && s.expectationHash===hash(encode(this.e)), 'JOURNAL_SCOPE_MISMATCH'); return s; }
  async rows(tx) {
    return {setting:await tx.systemSetting.findUnique({where:{key:this.key}}),
      recovery:await tx.systemSetting.findUnique({where:{key:'panel-recovery:'+this.key}}),
      job:await tx.outboundMessage.findUnique({where:{id:this.e.jobId}})};
  }
  async read() { return this.db.$transaction(async tx=> {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout='3s'"); return this.rows(tx);
  },{isolationLevel:'RepeatableRead',timeout:5000}); }
  stable(job) {
    return hash(encode([job.id,job.dedupeKey,job.targetType,String(job.targetId),job.payload,job.attachments,
      job.trackingType,job.trackingApplied,job.incidentId,job.answerId,String(job.sequence),job.createdAt]));
  }
  guard(r, mid, s) {
    const j=r.job;
    need(r.setting?.value===mid && j?.firstMessageId===mid, 'REFERENCES_CHANGED');
    need(j.id===this.e.jobId && j.dedupeKey===this.key && j.targetType==='chat' && String(j.targetId)===this.e.chatId &&
      j.payload?.operation?.type==='work-panel' && j.incidentId===null && j.answerId===null && j.trackingType===null &&
      Array.isArray(j.attachments) && j.attachments.length===0, 'WRONG_JOB');
    need(!r.recovery, 'RECOVERY_STATE_PRESENT');
    need(j.status==='SENT' && j.lockedAt===null && !j.lastError, 'JOB_NOT_IDLE');
    if(s) need(this.stable(j)===s.jobFingerprint, 'JOB_CHANGED');
  }
  async identity(s) { const me=await this.max.me(); if(s) need(me.user_id===s.botId,'BOT_CHANGED'); return me.user_id; }
  checkMessage(m,id,bot) { need(m?.body?.mid===id && this.own(m,this.chat,bot,false), 'PANEL_IDENTITY_MISMATCH'); }
  async prepare() {
    need(!fs.existsSync(this.j.file),'JOURNAL_EXISTS');
    const r=await this.read(); this.guard(r,this.e.oldMid);
    const botId=await this.identity(); const old=await this.max.get(this.e.oldMid);
    this.checkMessage(old,this.e.oldMid,botId); const pin=await this.max.pin();
    need(pin?.body?.mid===this.e.oldMid,'PIN_CHANGED');
    const text=await this.db.$transaction(async tx=>{ await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY'); return this.text(tx,this.chat); },{timeout:5000});
    const fresh=await this.read(); this.guard(fresh,this.e.oldMid); need(this.stable(r.job)===this.stable(fresh.job),'JOB_CHANGED');
    this.j.save({v:1,expectationHash:hash(encode(this.e)),phase:'prepared',preparedAt:this.now(),botId,
      oldMid:this.e.oldMid,text,jobFingerprint:this.stable(r.job),snapshot:JSON.parse(encode(r)),oldMessage:old,pinMid:pin.body.mid});
    return {phase:'prepared'};
  }
  async send() {
    let s=this.state(); need(s.phase==='prepared','SEND_ALREADY_ATTEMPTED');
    need(this.now()-s.preparedAt<300000,'PREPARATION_EXPIRED');
    this.guard(await this.read(),s.oldMid,s); await this.identity(s);
    this.checkMessage(await this.max.get(s.oldMid),s.oldMid,s.botId);
    need((await this.max.pin())?.body?.mid===s.oldMid,'PIN_CHANGED');
    const before=await this.max.history(this.now()+1000);
    need(Array.isArray(before.messages),'INVALID_HISTORY');
    // Save before POST. All errors after this point leave an irreversible send intent.
    s=this.j.update(s,{phase:'send-intent',intentAt:this.now(),beforeIds:before.messages.map(m=>m.body.mid)});
    const sent=await this.max.send(s.text); // exactly one direct POST, no retry
    this.checkMessage(sent,sent?.body?.mid,s.botId);
    need(sent.body.mid!==s.oldMid && sent.body.text===s.text && !(sent.body.attachments??[]).length,'INVALID_PROVISIONAL');
    this.j.update(s,{phase:'staged',newMid:sent.body.mid}); return {phase:'staged',newMid:sent.body.mid};
  }
  async reconcile() {
    let s=this.state(); await this.identity(s);
    if(s.phase==='send-intent') {
      this.guard(await this.read(),s.oldMid,s);
      let before=this.now()+1000,complete=false; const found=new Map();
      for(let page=0;page<5;page++) {
        const res=await this.max.history(before); need(Array.isArray(res.messages),'INVALID_HISTORY');
        for(const m of res.messages) if(m.timestamp>=s.intentAt && !s.beforeIds.includes(m.body?.mid) &&
          this.own(m,this.chat,s.botId,false) && m.body.text===s.text && !(m.body.attachments??[]).length) found.set(m.body.mid,m);
        const oldest=Math.min(...res.messages.map(m=>m.timestamp));
        if(res.messages.length<100 || oldest<s.intentAt) { complete=true; break; }
        need(oldest<before,'HISTORY_NO_PROGRESS'); before=oldest;
      }
      need(complete,'HISTORY_INCOMPLETE'); need(found.size===1,found.size?'AMBIGUOUS_SEND':'SEND_OUTCOME_UNKNOWN');
      const id=[...found.keys()][0]; this.checkMessage(await this.max.get(id),id,s.botId);
      this.j.update(s,{phase:'staged',newMid:id,reconciled:true}); return {phase:'staged',newMid:id};
    }
    need(['switch-intent','rollback-intent'].includes(s.phase),'NO_UNKNOWN_COMMIT');
    const r=await this.read(); const target=s.phase==='switch-intent'?s.newMid:s.oldMid;
    const prior=s.phase==='switch-intent'?s.oldMid:s.newMid;
    need(r.setting && r.job && !r.recovery && this.stable(r.job)===s.jobFingerprint,'COMMIT_STATE_CHANGED');
    const both=mid=>r.setting.value===mid && r.job.firstMessageId===mid;
    need(both(target)||both(prior),'COMMIT_AMBIGUOUS');
    const phase=both(target)?(s.phase==='switch-intent'?'switched':'rolled-back'):(s.phase==='switch-intent'?'staged':'switched');
    s=this.j.update(s,{phase,commitReconciled:true}); return {phase};
  }
  async swap(rollback=false) {
    let s=this.state(); need(rollback?['switched','verified'].includes(s.phase):s.phase==='staged','INVALID_PHASE');
    await this.identity(s);
    const from=rollback?s.newMid:s.oldMid, to=rollback?s.oldMid:s.newMid;
    this.checkMessage(await this.max.get(to),to,s.botId);
    if(!rollback) { const m=await this.max.get(to); need(m.body.text===s.text && !(m.body.attachments??[]).length,'PROVISIONAL_CHANGED'); }
    this.guard(await this.read(),from,s);
    const intentAt=this.now();
    s=this.j.update(s,{phase:rollback?'rollback-intent':'switch-intent',transitionAt:intentAt,observations:[]});
    // No HTTP under DB locks. NOWAIT also covers an unfinished concurrent COMMIT.
    await this.db.$transaction(async tx=> {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      await tx.$queryRawUnsafe('SELECT id FROM "OutboundMessage" WHERE id=$1 FOR UPDATE NOWAIT',this.e.jobId);
      await tx.$queryRawUnsafe('SELECT key FROM "SystemSetting" WHERE key=$1 FOR UPDATE NOWAIT',this.key);
      this.guard(await this.rows(tx),from,s);
      const a=await tx.systemSetting.updateMany({where:{key:this.key,value:from},data:{value:to}});
      const b=await tx.outboundMessage.updateMany({where:{id:this.e.jobId,firstMessageId:from,status:'SENT',lockedAt:null},data:{firstMessageId:to}});
      need(a.count===1 && b.count===1,'CAS_FAILED');
    },{timeout:4000,maxWait:1000});
    this.j.update(s,{phase:rollback?'rolled-back':'switched'});
    return {phase:rollback?'rolled-back':'switched',activeMid:to};
  }
  async observe() {
    let s=this.state(); need(['switched','verified','rolled-back','rollback-verified'].includes(s.phase),'INVALID_PHASE');
    await this.identity(s); const back=s.phase.startsWith('roll'); const id=back?s.oldMid:s.newMid;
    const r=await this.read(); this.guard(r,id,s);
    need(r.job.sentAt && r.job.sentAt.getTime()>s.transitionAt,'WAIT_FOR_NORMAL_CYCLE');
    const m=await this.max.get(id); this.checkMessage(m,id,s.botId);
    const kb=(m.body.attachments??[]).filter(a=>a.type==='inline_keyboard');
    need(kb.length===1 && isDeepStrictEqual(kb[0].payload.buttons,this.buttons()),'WAIT_FOR_CONTROLS');
    need((await this.max.pin())?.body?.mid===id,'WAIT_FOR_PIN');
    const dates=[...new Set([...(s.observations??[]),r.job.sentAt.toISOString()])];
    const ready=dates.length>=2; this.j.update(s,{observations:dates,phase:ready?(back?'rollback-verified':'verified'):s.phase});
    return {activeMid:id,confirmedCycles:dates.length,ready};
  }
}

function httpMax(config) {
  const base=config.MAX_API_BASE_URL.replace(/\/$/,'');
  need(new URL(base).protocol==='https:','HTTPS_MAX_REQUIRED');
  async function request(method,route,body) {
    let res;
    try { res=await fetch(base+route,{method,redirect:'error',headers:{Authorization:config.BOT_TOKEN,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)}); }
    catch { throw new Refusal('MAX_RESULT_UNKNOWN'); }
    if(!res.ok) throw new Refusal('MAX_HTTP_'+res.status);
    try { return await res.json(); } catch { throw new Refusal('MAX_RESULT_UNKNOWN'); }
  }
  const chat=String(config.REVIEW_CHAT_ID);
  return {me:()=>request('GET','/me'),get:id=>request('GET','/messages/'+encodeURIComponent(id)),
    pin:async()=>(await request('GET','/chats/'+chat+'/pin')).message,
    history:from=>request('GET','/messages?chat_id='+chat+'&count=100&from='+from),
    send:async text=>(await request('POST','/messages?chat_id='+chat,{text,notify:false})).message};
}

async function cli() {
  const [cmd,...flags]=process.argv.slice(2); need(['prepare','send','reconcile','switch','rollback','observe'].includes(cmd),'INVALID_COMMAND');
  need(flags.length===(['send','switch','rollback'].includes(cmd)?2:0),'INVALID_ARGUMENTS');
  if(flags.length) need(flags[0]==='--confirm' && flags[1]===cmd.toUpperCase(),'CONFIRM_REQUIRED');
  const hashes={
    'max/pinned-panel.service.js':'b470305fcaf6f9077f058b90e3234482b9a82fee7b030b2d1cda322d57e1d61c',
    'work-queues/state.js':'4bbd2d3030b42dcd86d51108413d458f7d465c2392447e443761ac56b77a559c',
    'work-queues/work-queue.service.js':'e95b4f7cfcf0d201337c60d61020300bcbf3ad1fb82cb3f7bbbdc4cc994aad1d'};
  for(const [name,digest] of Object.entries(hashes)) need(hash(fs.readFileSync('/app/dist/'+name,'utf8').trim())===digest,'INSTALLED_CODE_CHANGED');
  const expected=JSON.parse(fs.readFileSync('/ops-state/expected.json','utf8'));
  const config=require('/app/dist/config').getConfig();
  need(expected.chatId===String(config.REVIEW_CHAT_ID),'WRONG_REVIEW_CHAT');
  need(new URL(config.DATABASE_URL).pathname==='/'+expected.database,'WRONG_DATABASE');
  const {PrismaClient}=require('/app/node_modules/@prisma/client');
  const {isOwnQueuePanel}=require('/app/dist/max/pinned-panel.service');
  const {workPanelText,workButtons}=require('/app/dist/work-queues/state');
  const db=new PrismaClient(); const journal=new Journal('/ops-state'); const release=journal.lock();
  try {
    const op=new PanelSwap({db,max:httpMax(config),journal,expected,own:isOwnQueuePanel,text:workPanelText,buttons:workButtons});
    const result=cmd==='switch'?await op.swap():cmd==='rollback'?await op.swap(true):await op[cmd]();
    console.log(encode({ok:true,command:cmd,...result}));
  } finally { await db.$disconnect(); release(); }
}
module.exports={PanelSwap,Journal,Refusal,httpMax,REV,hash,encode};
if(require.main===module) cli().catch(e=>{console.error(encode({ok:false,code:e instanceof Refusal?e.code:'UNEXPECTED_FAILURE_READ_JOURNAL'}));process.exitCode=2;});
