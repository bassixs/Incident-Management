'use strict';
// Bounded private per-field fingerprints. Raw values never leave PostgreSQL.
const {PrismaClient}=require('/app/node_modules/@prisma/client');
const {createHash}=require('node:crypto');
const {once}=require('node:events');
const readline=require('node:readline');
const p=new PrismaClient();
const quote=s=>'"'+s.replaceAll('"','""')+'"';
const digest=createHash('sha256');
async function emit(value,covered=true){
 const line=JSON.stringify(value)+'\n';
 if(Buffer.byteLength(line)>65536) throw Error('FRAME_TOO_LARGE');
 if(covered) digest.update(line);
 if(!process.stdout.write(line)) await once(process.stdout,'drain');
}
(async()=>{
 const rl=readline.createInterface({input:process.stdin});
 const release=new Promise(resolve=>{rl.once('line',resolve);rl.once('close',resolve)});
 try{await p.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='10000ms'");
  if(process.argv.includes('--export')) await emit({snapshot:(await tx.$queryRawUnsafe('SELECT pg_export_snapshot() AS id'))[0].id},false);
  const tables=await tx.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  await emit({format:'pr14-18-data-v2',type:'begin'});
  let rows=0,fields=0;
  for(const {tablename:t} of tables){
   const columns=await tx.$queryRawUnsafe("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name",t);
   await emit({type:'table',table:t,columns:columns.map(c=>c.column_name)});
   // Same value::text hash as v1; built-in SHA-256 needs no extension.
   // NO SCROLL avoids materializing a table in Prisma/Node. Each FETCH returns
   // at most 128 rows of digests, independent of text/payload size.
   await tx.$executeRawUnsafe(`DECLARE snapshot_rows NO SCROLL CURSOR FOR SELECT coalesce(j->>'id',j->>'key',j->>'day') AS id, (SELECT jsonb_object_agg(key,encode(sha256(convert_to(value::text,'UTF8')),'hex')) FROM jsonb_each(j)) AS fields FROM (SELECT to_jsonb(t) j FROM ${quote(t)} t) q`);
   while(true){
    const batch=await tx.$queryRawUnsafe('FETCH FORWARD 128 FROM snapshot_rows');
    if(!batch.length) break;
    for(const row of batch){
     if(typeof row.id!=='string') throw Error('UNKNOWN_ROW_ID');
     await emit({type:'row',table:t,id:row.id,fields:row.fields});
     rows++;fields+=Object.keys(row.fields).length;
    }
   }
   await tx.$executeRawUnsafe('CLOSE snapshot_rows');
  }
  await emit({type:'end',tables:tables.length,rows,fields,sha256:digest.digest('hex')},false);
  if(process.argv.includes('--export')) await release;
 },{isolationLevel:'RepeatableRead',timeout:180000});}finally{rl.close();}
})().catch(()=>{console.error('DATA_SNAPSHOT_FAILED');process.exitCode=2}).finally(()=>p.$disconnect());
