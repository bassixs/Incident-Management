"""Real Prisma history + narrow R4 regression subset; exact prebuilt images.

Only disposable Actions. Original LF schema manifest remains immutable.
"""
import hashlib,json,os,shutil,subprocess,unittest
from pathlib import Path
import ops_test as lab
from ops_test import o,g,run,sql,probe,wait,ROOT,OUT,NET,PG,MOCK

class HistoricalDocker(lab.MigrationKit):
 database_template='history_11'
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  fixed=json.loads((ROOT/'installation-kit/schema-expectations.json').read_text())
  generated=json.loads(cls.manifest.read_text())
  if fixed!=generated:raise RuntimeError('Reviewed manifest differs from isolated pinned LF schema')
  # Use the original downloaded manifest, never a production-derived reference.
  cls.manifest=ROOT/'installation-kit/schema-expectations.json'
  cls.histories={};names=list(g.HISTORICAL_CRLF)
  for mode in ['00','01','10','11','sqlchanged']:
   db='history_'+mode;sql('postgres',f'CREATE DATABASE "{db}";')
   directory=cls.root/db;shutil.copytree(cls.root/'old-schema',directory)
   sourcehashes={}
   for index,name in enumerate(names):
    path=directory/'prisma/migrations'/name/'migration.sql';raw=path.read_bytes()
    if mode!='sqlchanged' and mode[index]=='1':raw=raw.replace(b'\n',b'\r\n')
    if mode=='sqlchanged' and index==0:raw+=b'\n-- Synthetic SQL edit: must be refused, even with unchanged structure.\n'
    path.write_bytes(raw);sourcehashes[name]=hashlib.sha256(raw).hexdigest()
   env=cls.root/(db+'.env');env.write_text('DATABASE_URL=postgresql://lab:synthetic-only@postgres:5432/'+db+'\n')
   result=run('docker','run','--rm','--network',NET,'--env-file',env,'-v',f'{directory}:/historical:ro','--entrypoint','node','incident-lab:main','node_modules/prisma/build/index.js','migrate','deploy','--schema','/historical/prisma/schema.prisma')
   (OUT/(db+'-real-prisma.log')).write_text(result.stdout+result.stderr)
   observed=probe(env)
   for row in observed['schema']['migrations']:
    if row[0] in sourcehashes and row[1]!=sourcehashes[row[0]]:raise RuntimeError('Prisma did not record actual file hash')
   cls.histories[mode]={'env':str(env),'identity':observed['identity'],'schema':observed['schema'],'hashes':sourcehashes}
  (OUT/'historical-application.json').write_text(json.dumps(cls.histories,indent=2))

 def test_actual_history_matrix_and_sql_edit(self):
  expected=json.loads(self.manifest.read_text())['old']
  for mode,row in self.histories.items():
   with self.subTest(mode=mode):
    self.assertEqual(g.schema_matches(row['schema'],expected),mode!='sqlchanged')
    # Exact old implementation reproduces the prior refusal for every CRLF combination.
    self.assertEqual(row['schema']==expected,mode=='00')
    trial=dict(self.s,install=str(self.rootcase/('probe-'+mode)))
    runtime=Path(trial['install'])/'private/runtime.env';runtime.parent.mkdir(parents=True)
    runtime.write_bytes(Path(row['env']).read_bytes());trial['runtime_sha256']=o.sha(runtime.read_bytes())
    trial['migration']=dict(self.s['migration'],identity=row['identity'])
    if mode=='sqlchanged':
     with self.assertRaisesRegex(o.Refusal,'DATABASE_SCHEMA_NOT_OLD'):g.assert_schema(trial,'old')
    else:g.assert_schema(trial,'old')

 def test_unknown_checksum_incomplete_and_schema_drift_before_stop(self):
  first=next(iter(g.HISTORICAL_CRLF));original=g.HISTORICAL_CRLF[first][1]
  variants=[("UPDATE _prisma_migrations SET checksum=repeat('0',64) WHERE migration_name='"+first+"';","UPDATE _prisma_migrations SET checksum='"+original+"' WHERE migration_name='"+first+"';"),
   ("UPDATE _prisma_migrations SET rolled_back_at=now() WHERE migration_name='"+first+"';","UPDATE _prisma_migrations SET rolled_back_at=NULL WHERE migration_name='"+first+"';"),
   ('ALTER TABLE "InboundUpdate" ADD COLUMN synthetic_drift TEXT;','ALTER TABLE "InboundUpdate" DROP COLUMN synthetic_drift;')]
  for change,restore in variants:
   sql(self.db,change)
   try:
    with o.backup_lock(self.s) as fd:self.cli(fd,'stop-app.py',self.images['old'],'run',code=2,contains='DATABASE_SCHEMA_NOT_OLD')
    self.assertTrue(o.app(self.s)['State']['Running']);self.assertEqual(o.app(self.s)['Id'],self.initial)
   finally:sql(self.db,restore)

 def control(self,**body):
  script="fetch('http://localhost:8080/control',process.argv[1]==='{}'?{}:{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>{if(!r.ok)throw Error(r.status);return r.json()}).then(x=>console.log(JSON.stringify(x)))"
  return json.loads(run('docker','exec',MOCK,'node','-e',script,json.dumps(body)).stdout)
 def job(self):return json.loads(sql(self.db,"SELECT row_to_json(t) FROM (SELECT * FROM \"OutboundMessage\" WHERE id='partial-history')t;"))
 def historical_rows(self):return sql(self.db,"SELECT json_agg(json_build_array(migration_name,checksum,finished_at IS NOT NULL,rolled_back_at IS NOT NULL) ORDER BY migration_name) FROM _prisma_migrations WHERE migration_name<'202610';")
 def test_crlf_upgrade_partial_main_reserve_main(self):
  history=self.historical_rows()
  with o.backup_lock(self.s) as fd:
   self.stop(fd);self.migrate(fd)
   self.assertEqual(self.historical_rows(),history)
   sql(self.db,"""INSERT INTO "SystemSetting" (key,value,"updatedAt") VALUES
('retention.file-fence.v1:'||encode(sha256(convert_to('unknown-delete.txt','UTF8')),'hex'),'PERMANENT_STORAGE_KEY_RETIREMENT_V1',now()),
('retention.file-delete.v1:'||encode(sha256(convert_to('unknown-delete.txt','UTF8')),'hex'),'{"version":1,"storageKey":"unknown-delete.txt","size":18,"publicCode":"INC-SYNTHETIC"}',now()),
('retention.file-state.v1:'||encode(sha256(convert_to('unknown-delete.txt','UTF8')),'hex'),'{"version":1,"attempts":1,"status":"unknown","nextAttemptAt":0,"reason":"STORAGE_RESULT_UNKNOWN"}',now());
INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"updatedAt") VALUES
('partial-history','user',4242,jsonb_build_object('text',repeat('x',5000),'keyboard','[[{"type":"callback","text":"Synthetic","payload":"noop"}]]'::jsonb),'[]','PENDING',now()),
('failed-progress','user',4243,'{"text":"Synthetic","deliveryProgress":{"version":1,"planHash":"synthetic-not-dispatched","totalParts":2,"mids":["already-confirmed"]}}','[]','FAILED',now());""")
   (self.uploads/'unknown-delete.txt').write_text('synthetic deletion')
   preserve_sql='''SELECT jsonb_build_object('journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY key) FROM "SystemSetting" t WHERE key LIKE 'retention.file-%'),'failed',(SELECT to_jsonb(t) FROM "OutboundMessage" t WHERE id='failed-progress'));'''
   protected=sql(self.db,preserve_sql)
   self.control(op='rule',target='user:4242',mode='error',status=503,**{'from':2})
   self.apply(fd);self.cli(fd,'start-app.py',self.images['main'],'run')
   wait(lambda:self.job()['status']=='PENDING' and len(self.job()['payload'].get('deliveryProgress',{}).get('mids',[]))==1)
   prefix=self.job()['payload']['deliveryProgress']['mids']
   for number,(old,new) in enumerate([('main','reserve'),('reserve','main')]):
    name='switch'+str(number);(self.prepared/name).mkdir()
    self.cli(fd,'stop-app.py',self.images[old],name)
    if number==0:
     self.control(op='clear',target='user:4242');sql(self.db,"UPDATE \"OutboundMessage\" SET \"nextAttemptAt\"=now() WHERE id='partial-history';")
    self.cli(fd,'apply-config.py',self.images[old],self.images[new],self.s['images'][old]['compose_sha256'],self.s['images'][new]['candidate'],name)
    self.cli(fd,'start-app.py',self.images[new],name)
    wait(lambda:self.job()['status']=='SENT')
    self.assertEqual(self.job()['payload']['deliveryProgress']['mids'][:1],prefix)
    self.assertEqual(len([r for r in self.control()['ledger'] if r['target']=='user:4242']),2)
    self.assertEqual(sql(self.db,preserve_sql),protected);self.assertEqual(self.historical_rows(),history)
    self.assertEqual((self.uploads/'unknown-delete.txt').read_text(),'synthetic deletion')
    refused=run('docker','exec',PG,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','lab','-d',self.db,'-c',"INSERT INTO \"OutboundMessage\"(id,\"targetType\",\"targetId\",payload,attachments,\"updatedAt\") VALUES ('forbidden','user',9,'{}','[{\"storageKey\":\"unknown-delete.txt\"}]',now());",check=False)
    self.assertNotEqual(refused.returncode,0);self.assertIn('STORAGE_KEY_RETIRED',refused.stderr)
   (OUT/'switch-preservation.json').write_text(json.dumps({'historyUnchanged':True,'confirmedPrefix':prefix,'acceptedParts':2,'failedJournalFencePreserved':True,'images':self.images},indent=2))

if __name__=='__main__':
 names=['test_actual_history_matrix_and_sql_edit','test_unknown_checksum_incomplete_and_schema_drift_before_stop','test_crlf_upgrade_partial_main_reserve_main','test_cancel_before_migrations_same_container','test_identity_mismatch_preserves_running_old','test_interrupted_migration_denies_old_and_new','test_lost_cli_result_and_late_migration_completion','test_complete_migrations_old_compose_no_old_resume']
 result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(HistoricalDocker(n) for n in names))
 (OUT/'historical-result.json').write_text(json.dumps({'testsRun':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'success':result.wasSuccessful()},indent=2))
 raise SystemExit(not result.wasSuccessful())
