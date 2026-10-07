"""Only the changed operational gates; exact prebuilt applications, local MAX mock."""
import json,os,sys,unittest,shutil
from pathlib import Path
import ops_test as lab
from ops_test import o,g,run,sql,probe,ROOT,OUT,NET,PG
sys.path.insert(0,str(lab.SCRIPTS))
from data_check import compare

class UpdateKit(lab.MigrationKit):
 target_policy='WORKING_HOURS_V1'
 @classmethod
 def setUpClass(cls):
  super().setUpClass()
  old=cls.root/'crlf-schema';shutil.copytree(cls.root/'old-schema',old)
  for name in g.HISTORICAL_CRLF:
   p=old/'prisma/migrations'/name/'migration.sql';p.write_bytes(p.read_bytes().replace(b'\n',b'\r\n'))
  sql('postgres','CREATE DATABASE template_crlf;')
  env=cls.root/'crlf.env';env.write_text('DATABASE_URL=postgresql://lab:synthetic-only@postgres:5432/template_crlf\n')
  run('docker','run','--rm','--network',NET,'--env-file',env,'-v',f'{old}:/old:ro','--entrypoint','node',cls.images['main'],'node_modules/prisma/build/index.js','migrate','deploy','--schema','/old/prisma/schema.prisma')
  actual=probe(env)['schema']
  if not g.schema_matches(actual,json.loads(cls.manifest.read_text())['old']):raise RuntimeError('REAL_CRLF_HISTORY_REFUSED')
  (OUT/'real-crlf-history.json').write_text(json.dumps(actual['migrations'],indent=2))
 def setUp(self):
  if self._testMethodName=='test_activation_and_complete_backup_restore_switch':self.database_template='template_crlf'
  super().setUp()

 def snapshot(self):
  return json.loads(run('docker','run','--rm','-i','--network',NET,'--env-file',self.install/'private/runtime.env','-v',f'{lab.SCRIPTS}:/ops:ro','--entrypoint','node',self.images['main'],'/ops/data-snapshot.cjs').stdout)
 def activate(self,fd):self.cli(fd,'activate-policy.py','activate-WORKING_HOURS_V1-for-new-incidents')
 def migrate(self,fd):super().migrate(fd);self.activate(fd)
 def seed(self):
  sql(self.db,"""INSERT INTO "User" (id,"maxUserId","displayName","updatedAt") VALUES ('control-user',88001,'Synthetic',now());
INSERT INTO "ResponsibleGroup" (id,code,name,kind,"isActive","updatedAt") VALUES ('control-group','SYNTHETIC','Synthetic','REGIONAL',false,now());
INSERT INTO "Incident" (id,"publicCode","requesterId","requesterMaxUserId","requesterName","requesterPhone",text,status,"assignedGroupId","deadlineAt","updatedAt") VALUES ('control-incident','INC-SYNTHETIC','control-user',88001,'Synthetic','+79000000000','Synthetic','ASSIGNED','control-group','2099-01-01',now());
INSERT INTO "IncidentAnswer" (id,"incidentId",version,text,status,"createdByUserId","updatedAt") VALUES ('control-answer','control-incident',1,'Synthetic','DRAFT','control-user',now());
INSERT INTO "IncidentAttachment" (id,"incidentId",type,"storageKey") VALUES ('control-photo','control-incident','FILE','preserved.txt');
INSERT INTO "IncidentHistory" (id,"incidentId",action,"fromStatus","toStatus","actorMaxUserId") VALUES ('control-history','control-incident','ASSIGNED','DISTRIBUTION','ASSIGNED',88001);
INSERT INTO "SystemSetting" (key,value,"updatedAt") VALUES ('retention.file-fence.v1:synthetic','PERMANENT_STORAGE_KEY_RETIREMENT_V1',now());""")
 def seed_new(self):
  sql(self.db,"""INSERT INTO "IncidentAssignmentCycle" (id,"incidentId",sequence,"groupId","groupCode","groupName","assignedAt","preparationDueAt","returnDueAt") VALUES ('control-cycle','control-incident',1,'control-group','SYNTHETIC','Synthetic',now(),'2099-01-02','2099-01-01');
INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"nextAttemptAt","cancelledAt","cancelReason","deliveryProgress","updatedAt") VALUES ('control-deferred','chat',-88001,'{}','[]','DEFERRED','2099-01-01',NULL,NULL,NULL,now()),('control-cancelled','chat',-88001,'{}','[]','CANCELLED',now(),now(),'ANSWER_ALREADY_DELIVERED',NULL,now()),('control-progress','chat',-88002,'{}','[]','FAILED',now(),NULL,NULL,'{"version":1,"parts":[{"mid":"synthetic-confirmed"}]}',now());""")
 def test_activation_and_complete_backup_restore_switch(self):
  self.seed()
  with o.backup_lock(self.s) as fd:
   fresh=self.rootcase/'fresh'
   self.cli(fd,'backup-data.py','capture','--schema','old','--output',str(fresh))
   self.cli(fd,'backup-data.py','verify','--output',str(fresh))
   self.stop(fd)
   final=self.rootcase/'final'
   self.cli(fd,'backup-data.py','capture','--schema','old','--final-run','run','--output',str(final))
   self.cli(fd,'backup-data.py','verify','--output',str(final))
   before=self.snapshot();lab.MigrationKit.migrate(self,fd)
   self.assertEqual(compare(before,self.snapshot(),migrated=True),[])
   self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='INVALID_JSON')
   self.activate(fd)
   self.cli(fd,'activate-policy.py','activate-WORKING_HOURS_V1-for-new-incidents',code=2,contains='POLICY_ALREADY_ATTEMPTED')
   self.seed_new();protected=self.snapshot()
   self.apply(fd);self.cli(fd,'start-app.py',self.images['main'],'run')
   for n,(old,new) in enumerate([('main','reserve'),('reserve','main')]):
    name='policy-switch-'+str(n);(self.prepared/name).mkdir()
    self.cli(fd,'stop-app.py',self.images[old],name)
    self.cli(fd,'apply-config.py',self.images[old],self.images[new],self.s['images'][old]['compose_sha256'],self.s['images'][new]['candidate'],name)
    self.cli(fd,'start-app.py',self.images[new],name)
    env=dict(x.split('=',1) for x in o.app(self.s)['Config']['Env'] if '=' in x)
    self.assertEqual(env['INCIDENT_SLA_POLICY'],'WORKING_HOURS_V1')
   current=self.snapshot()
   # Runtime may create technical settings; all original rows/fields remain exact.
   self.assertEqual([d for d in compare(protected,current) if d[-1]!='NEW_ROW'],[])
   self.assertEqual(sql(self.db,'SELECT "slaPolicy" FROM "Incident" WHERE id=\'control-incident\';').strip(),'LEGACY')
   complete=self.rootcase/'complete'
   self.cli(fd,'backup-data.py','capture','--schema','new','--output',str(complete))
   self.cli(fd,'backup-data.py','verify','--output',str(complete))
   (OUT/'backup-restore-result.json').write_text((complete/'restore-result.json').read_text())
 def test_enum_drift_and_old_kit_refused(self):
  with o.backup_lock(self.s) as fd:
   self.stop(fd);self.migrate(fd)
   sql(self.db,'ALTER TYPE "OutboxStatus" ADD VALUE \'SYNTHETIC_UNREVIEWED\';')
   self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='DATABASE_SCHEMA_NOT_NEW')
  old=dict(self.s);old.pop('kit');self.settings.write_text(json.dumps(old))
  with o.backup_lock(self.s) as fd:self.cli(fd,'wait-ready.py',self.images['old'],code=2,contains='KIT_EDITION_MISMATCH')

if __name__=='__main__':
 # Changed schema/activation and affected R4 gates, not the full app regression.
 names=['test_activation_and_complete_backup_restore_switch','test_enum_drift_and_old_kit_refused',
 'test_cancel_before_migrations_same_container','test_interrupted_migration_denies_old_and_new',
 'test_lost_cli_result_and_late_migration_completion','test_complete_migrations_old_compose_no_old_resume',
 'test_partial_local_receipt_blocks_old_resume','test_second_instance_refuses_stop',
 'test_controlled_create_failure_selects_real_reserve','test_controlled_container_exit_selects_real_reserve']
 result=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(UpdateKit(n) for n in names))
 (OUT/'operational-result.json').write_text(json.dumps({'run':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'cases':names},indent=2))
 sys.exit(not result.wasSuccessful())
