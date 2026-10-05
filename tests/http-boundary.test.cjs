'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {httpMax}=require('../panel-swap.cjs');
const cfg={MAX_API_BASE_URL:'https://max.invalid',BOT_TOKEN:'SYNTHETIC_ONLY',REVIEW_CHAT_ID:-1002n};
test('HTTP boundary: raw Authorization, no controls, notify=false, single POST',async()=>{
 const calls=[];const original=global.fetch;
 global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({message:{body:{mid:'mid.synthetic'}}})};};
 try {assert.equal((await httpMax(cfg).send('Synthetic panel')).body.mid,'mid.synthetic');} finally{global.fetch=original;}
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://max.invalid/messages?chat_id=-1002');
 assert.equal(calls[0].options.headers.Authorization,'SYNTHETIC_ONLY');assert.equal(calls[0].options.redirect,'error');
 assert.deepEqual(JSON.parse(calls[0].options.body),{text:'Synthetic panel',notify:false});
});
test('lost HTTP ACK has no automatic retry and no leaked error body',async()=>{
 const original=global.fetch;let count=0;global.fetch=async()=>{count++;throw Error('private server details');};
 try{await assert.rejects(httpMax(cfg).send('Synthetic'),e=>e.message==='MAX_RESULT_UNKNOWN');assert.equal(count,1);}finally{global.fetch=original;}
});
test('HTTP error and unparseable success stay safe and are not retried',async()=>{
 const original=global.fetch;let count=0;
 try{
  global.fetch=async()=>{count++;return {ok:false,status:403,json:async()=>{throw Error('must not read private body');}};};
  await assert.rejects(httpMax(cfg).send('Synthetic'),/^Error: MAX_HTTP_403$/);assert.equal(count,1);
  global.fetch=async()=>{count++;return {ok:true,json:async()=>{throw Error('private body');}};};
  await assert.rejects(httpMax(cfg).send('Synthetic'),/^Error: MAX_RESULT_UNKNOWN$/);assert.equal(count,2);
 }finally{global.fetch=original;}
});
test('HTTP boundary rejects plaintext and exposes no edit/delete/unpin methods',()=>{
 assert.throws(()=>httpMax({...cfg,MAX_API_BASE_URL:'http://max.invalid'}),/HTTPS_MAX_REQUIRED/);
 assert.deepEqual(Object.keys(httpMax(cfg)).sort(),['get','history','me','pin','send']);
});
