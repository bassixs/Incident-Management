'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const tool=process.env.CLEANUP_TOOL || path.resolve('output/update-main-377b8b7-r2/Na-svyazi-region40/config/cleanup-test-data.cjs');
const {mids,apply,finish}=require(tool);
const error=code=>Object.assign(Error('private text +79001234567 token=never-log'),{safeCode:code});
function fixture(){
 const j={version:2,remainingMessages:['mid.copy'],remainingFiles:[],protectedMids:[]};
 const saved=[],deleted=[];
 const db={systemSetting:{findMany:async()=>[]}};
 const max={me:async()=>({user_id:777}),get:async()=>({sender:{user_id:777,is_bot:true},body:{text:'Synthetic'}}),remove:async mid=>{deleted.push(mid);return{success:true}}};
 const persist=async value=>saved.push(structuredClone(value));
 const run=()=>finish(db,j,max,{remove:async()=>{}},persist);
 return{j,saved,deleted,db,max,run};
}
test('array-only message ID and scalar firstMessageId are collected',()=>{
 assert.deepEqual(mids({operation:{messageIds:['mid.known-copy']},firstMessageId:'mid.first'}),['mid.known-copy','mid.first']);
});
test('known nested structures; unrelated arrays are not message IDs',()=>{
 assert.deepEqual(mids({data:{previewMessageId:'preview',keyboardMessageId:'keyboard',attachments:[{payload:{mid:'nested'}}]},text:['not-mid'],storageKey:'not-mid',operation:{messageIds:['a','b']}}),['preview','keyboard','nested','a','b']);
});
test('GET 404 remains unresolved across retries, never DELETE',async()=>{
 const f=fixture();f.max.get=async()=>{throw error('MAX_HTTP_404')};
 await f.run();await f.run();assert.deepEqual(f.j.remainingMessages,['mid.copy']);assert.equal(f.deleted.length,0);
 assert.deepEqual(f.j.messageResults['mid.copy'].attempts.map(a=>[a.stage,a.code]),[['read','MAX_HTTP_404'],['read','MAX_HTTP_404']]);
});
test('DELETE 404 remains; later GET 404 does not turn it into success',async()=>{
 const f=fixture();f.max.remove=async()=>{throw error('MAX_HTTP_404')};await f.run();
 f.max.get=async()=>{throw error('MAX_HTTP_404')};await f.run();
 assert.deepEqual(f.j.remainingMessages,['mid.copy']);assert.equal(f.j.messageResults['mid.copy'].outcome,'pending');
 assert.deepEqual(f.j.messageResults['mid.copy'].attempts.map(a=>[a.stage,a.code]),[['delete','REQUEST_STARTED'],['delete','MAX_HTTP_404'],['read','MAX_HTTP_404']]);
});
test('successful retry requires verified author and explicit success=true',async()=>{
 const f=fixture(),get=f.max.get;f.max.get=async()=>{throw error('MAX_HTTP_404')};await f.run();
 f.max.get=get;await f.run();assert.deepEqual(f.j.remainingMessages,[]);assert.deepEqual(f.deleted,['mid.copy']);
 assert.equal(f.j.messageResults['mid.copy'].outcome,'deleted-confirmed');
 await f.run();assert.equal(f.deleted.length,1);
});
for(const response of [undefined,{}, {success:false},{success:'true'}])test('ambiguous DELETE body retained '+JSON.stringify(response),async()=>{
 const f=fixture();f.max.remove=async()=>response;await f.run();assert.deepEqual(f.j.remainingMessages,['mid.copy']);
 assert.equal(f.j.messageResults['mid.copy'].attempts.at(-1).code,'UNCONFIRMED_RESPONSE');
});
test('intent persisted before delete, confirmed outcome after acknowledgment',async()=>{
 const f=fixture();f.max.remove=async()=>{assert.equal(f.saved.at(-1).messageResults['mid.copy'].attempts.at(-1).code,'REQUEST_STARTED');assert.deepEqual(f.saved.at(-1).remainingMessages,['mid.copy']);return{success:true}};
 await f.run();assert.deepEqual(f.saved.at(-1).remainingMessages,[]);
});
test('failure persisting deletion intent prevents DELETE',async()=>{
 const f=fixture();await assert.rejects(finish(f.db,f.j,f.max,{},async()=>{throw Error('DB down')}));assert.equal(f.deleted.length,0);
});
test('unknown network error sanitized, no private contents in journal',async()=>{
 const f=fixture();f.max.get=async()=>{throw error('unsafe +79001234567')};await f.run();
 const encoded=JSON.stringify(f.saved);assert(!encoded.includes('79001234567'));assert(!encoded.includes('never-log'));assert(encoded.includes('CHECK_FAILED'));
});
for(const mode of ['current-panel','planned-panel','foreign-author','not-bot','panel-text'])test('protected '+mode,async()=>{
 const f=fixture();
 if(mode==='current-panel')f.db.systemSetting.findMany=async()=>[{key:'work-panel:-900',value:'mid.copy'}];
 if(mode==='planned-panel')f.j.protectedMids=['mid.copy'];
 if(mode==='foreign-author')f.max.get=async()=>({sender:{user_id:888,is_bot:true}});
 if(mode==='not-bot')f.max.get=async()=>({sender:{user_id:777,is_bot:false}});
 if(mode==='panel-text')f.max.get=async()=>({sender:{user_id:777,is_bot:true},body:{text:'📋 ОЧЕРЕДЬ'}});
 await f.run();assert.equal(f.deleted.length,0);assert.deepEqual(f.j.remainingMessages,['mid.copy']);
});
test('legacy plans and journals blocked before use',async()=>{
 const f=fixture();await assert.rejects(apply({}, {version:1}),{cleanupCode:'LEGACY_PLAN_REQUIRES_AUDIT'});
 f.j.version=1;await assert.rejects(f.run(),{cleanupCode:'LEGACY_PLAN_REQUIRES_AUDIT'});assert.equal(f.deleted.length,0);
});
test('crash after acknowledged DELETE but before durable success stays unresolved on restart',async()=>{
 const f=fixture();let durable;
 await assert.rejects(finish(f.db,f.j,f.max,{},async j=>{
  if(j.messageResults['mid.copy'].outcome==='deleted-confirmed')throw Error('DB commit unavailable');
  durable=structuredClone(j);
 }));
 assert.equal(f.deleted.length,1);assert.deepEqual(durable.remainingMessages,['mid.copy']);
 f.max.get=async()=>{throw error('MAX_HTTP_404')};
 await finish(f.db,durable,f.max,{},async j=>{durable=structuredClone(j)});
 assert.deepEqual(durable.remainingMessages,['mid.copy']);assert.equal(durable.messageResults['mid.copy'].outcome,'pending');
});
