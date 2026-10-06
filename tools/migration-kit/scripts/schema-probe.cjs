'use strict';
// Read-only schema/identity probe. No payloads, environment or residents in output.
const {PrismaClient}=require('/app/node_modules/@prisma/client');
const p=new PrismaClient();
(async()=>{
 const result=await p.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  await tx.$executeRawUnsafe("SET LOCAL statement_timeout='5000ms'");
  return tx.$queryRawUnsafe(`SELECT jsonb_build_object(
   'identity',jsonb_build_object('system', (SELECT system_identifier::text FROM pg_control_system()),'database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database())),
   'schema',jsonb_build_object(
    'migrations',(SELECT jsonb_agg(jsonb_build_array(migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NOT NULL) ORDER BY migration_name,id) FROM _prisma_migrations),
    'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type,udt_name,is_nullable,column_default) ORDER BY table_name,ordinal_position) FROM information_schema.columns WHERE table_schema='public'),
    'indexes',(SELECT jsonb_agg(indexdef ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='public'),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid)) ORDER BY c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgenabled,pg_get_triggerdef(t.oid)) ORDER BY c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public'),
    'guardFunction',(SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='guard_retired_storage_reference')
   )) AS value`);
 },{isolationLevel:'RepeatableRead',timeout:10000});
 console.log(JSON.stringify(result[0].value));
})().catch(()=>{console.error('SCHEMA_PROBE_FAILED');process.exitCode=2}).finally(()=>p.$disconnect());
