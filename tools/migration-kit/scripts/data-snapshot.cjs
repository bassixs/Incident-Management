'use strict';
// Private fingerprints only: no resident text, phone, callback or environment.
const {PrismaClient}=require('/app/node_modules/@prisma/client');
const {createHash}=require('node:crypto');
const readline=require('node:readline');
const p=new PrismaClient();
const hash=v=>createHash('sha256').update(v).digest('hex');
const sorted=v=>Array.isArray(v)?v.map(sorted):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
const quote=s=>'"'+s.replaceAll('"','""')+'"';
(async()=>{
 const rl=readline.createInterface({input:process.stdin});
 const release=new Promise(resolve=>{rl.once('line',resolve);rl.once('close',resolve)});
 await p.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10000ms'");
  if(process.argv.includes('--export')) console.log(JSON.stringify({snapshot:(await tx.$queryRawUnsafe('SELECT pg_export_snapshot() AS id'))[0].id}));
  const tables=await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  const result={format:'pr14-18-data-v1',tables:{}};
  for(const {tablename:t} of tables){
   const rows=await tx.$queryRawUnsafe(`SELECT coalesce(j->>'id',j->>'key',j->>'day') AS id, (SELECT jsonb_object_agg(key,value::text) FROM jsonb_each(j)) AS fields FROM (SELECT to_jsonb(t) j FROM ${quote(t)} t) q`);
   const records={};
   for(const {id,fields} of rows){
    if(typeof id!=='string') throw Error('UNKNOWN_ROW_ID');
    if(records[id]) throw Error('DUPLICATE_ROW_ID');
    records[id]=Object.fromEntries(Object.keys(fields).sort().map(k=>[k,hash(fields[k])]));
   }
   result.tables[t]=records;
  }
  console.log(JSON.stringify(result));
  if(process.argv.includes('--export')) await release;
 },{isolationLevel:'RepeatableRead',timeout:180000});
 rl.close();
})().catch(()=>{console.error('DATA_SNAPSHOT_FAILED');process.exitCode=2}).finally(()=>p.$disconnect());
