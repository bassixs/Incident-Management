"""Exact-image exporter failures + complete backup/restore, synthetic only."""
import hashlib,json,os,sys,time,unittest
from pathlib import Path
import ops_test as lab
from ops_test import run,sql,OUT,SCRIPTS
from exporter_baseline_test import seed_volume
import ops_common as o

class ExporterChecks(lab.MigrationKit):
 def test_complete_backup_and_exporter_failures(self):
  seed_volume(self.db)
  (OUT/'component-versions.json').write_text(json.dumps({'postgres':sql(self.db,'SELECT version();').strip(),'imageNodePrisma':json.loads(run('docker','run','--rm','--network','none','--entrypoint','node',self.images['main'],'-e',"console.log(JSON.stringify({node:process.version,prisma:require('@prisma/client/package.json').version}))").stdout)},indent=2))
  faults=self.rootcase/'faults';faults.mkdir(mode=0o755)
  # Represent external photographs locally with synthetic bytes only.
  for i in range(207):(self.uploads/f'photo-{i}.bin').write_bytes(b'synthetic-photo-'+str(i).encode())
  sql(self.db,"""INSERT INTO "SystemSetting"(key,value,"updatedAt") VALUES
('storage-key-fence:v1:synthetic-retired', '{"storageKey":"synthetic-retired"}',now());""")
  initial=o.identity(o.app(self.s));volumes=run('docker','volume','ls','-q').stdout
  cases={
   'before-first':("process.kill(process.pid,'SIGSEGV');",'EXPORTER_SNAPSHOT_EOF',139),
   'after-first':("console.log(JSON.stringify({snapshot:'000-FFF-1'}));setImmediate(()=>process.kill(process.pid,'SIGSEGV'));",'EXPORTER_DATA_EOF',139),
   'stderr-flood':("process.stderr.write('SYNTHETIC_SECRET resident-text '.repeat(20000),()=>process.exit(2));",'EXPORTER_SNAPSHOT_EOF',2),
   'invalid-second':("console.log(JSON.stringify({snapshot:'000-FFF-1'}));console.log('SYNTHETIC_SECRET invalid-json');",'EXPORTER_DATA_INVALID_JSON',0),
   'after-data':("require('/ops/data-snapshot.cjs');process.exitCode=17;",'EXPORTER_EXIT_FAILED',17),
   'timeout-first':("setInterval(()=>{},1000);",'EXPORTER_SNAPSHOT_TIMEOUT',None),
   'timeout-second':("console.log(JSON.stringify({snapshot:'000-FFF-1'}));setInterval(()=>{},1000);",'EXPORTER_DATA_TIMEOUT',None),
  }
  results=[]
  for name,(js,expected,exitcode) in cases.items():
   with self.subTest(case=name):
    fixture=faults/(name+'.cjs');fixture.write_text(js);os.chmod(fixture,0o644)
    dest=self.rootcase/('failed-'+name);started=time.monotonic()
    p=run(sys.executable,SCRIPTS/'locked-session.py','--settings',self.settings,'--',sys.executable,Path(__file__).with_name('exporter_fault_driver.py'),self.settings,dest,fixture,check=False)
    (OUT/('fault-'+name+'.log')).write_text(p.stdout+p.stderr)
    self.assertEqual(p.returncode,2,p.stdout+p.stderr);self.assertIn(expected,p.stdout+p.stderr)
    self.assertNotIn('SYNTHETIC_SECRET',p.stdout+p.stderr);self.assertNotIn('resident-text',p.stdout+p.stderr)
    diagnostic=json.loads((dest/'exporter-result.json').read_text())
    self.assertFalse(diagnostic['success']);self.assertEqual(diagnostic['cleanup'],'confirmed')
    self.assertEqual(diagnostic['error'],expected)
    if exitcode is not None:self.assertEqual(diagnostic['containerState']['ExitCode'],exitcode)
    self.assertFalse(diagnostic['containerState']['Running'])
    for marker in ['checksums.json','backup.json','restore-result.json']:self.assertFalse((dest/marker).exists())
    self.assertEqual(run('docker','ps','-aq','--filter','label=incident.ops.snapshot-export').stdout.strip(),'')
    with o.backup_lock(self.s):pass
    self.assertEqual(o.identity(o.app(self.s)),initial);o.wait_ready(self.s,self.images['old'])
    self.assertEqual(sql(self.db,self.protected_sql),self.protected)
    self.assertEqual(run('docker','volume','ls','-q').stdout,volumes)
    result={'case':name,'elapsedSeconds':time.monotonic()-started,'diagnostic':diagnostic,'lockReleased':True,'appUnchanged':True,'backupAccepted':False,'temporaryContainersRemaining':0}
    results.append(result);(OUT/('exporter-fault-'+name+'.json')).write_text(json.dumps(result,indent=2))
    print(json.dumps(result),flush=True)
  self.assertEqual(len(results),len(cases),'Every injected fault must reach its intended assertion')
  # A failed attempt is retained. A new directory is mandatory for success.
  dest=self.rootcase/'fresh-success';started=time.monotonic()
  with o.backup_lock(self.s) as fd:
   self.cli(fd,'backup-data.py','capture','--schema','old','--output',dest)
   self.cli(fd,'backup-data.py','verify','--output',dest)
  restored=json.loads((dest/'restore-result.json').read_text())
  self.assertEqual(restored['databaseRows'],'exact');self.assertEqual(restored['files'],'exact');self.assertEqual(restored['schema'],'exact')
  self.assertFalse(restored['applicationStarted']);self.assertFalse(restored['sourceDatabaseWritten'])
  diagnostic=json.loads((dest/'exporter-result.json').read_text());self.assertTrue(diagnostic['success'])
  self.assertEqual(diagnostic['containerState']['ExitCode'],0);self.assertEqual(diagnostic['cleanup'],'confirmed')
  with o.backup_lock(self.s):pass
  self.assertEqual(o.identity(o.app(self.s)),initial);o.wait_ready(self.s,self.images['old'])
  self.assertEqual(sql(self.db,self.protected_sql),self.protected)
  self.assertFalse(any(x.startswith(('incident-snapshot-','incident-restore-')) for x in run('docker','ps','-a','--format','{{.Names}}').stdout.splitlines()))
  fingerprint=json.loads((dest/'data.json').read_text())
  result={'passed':True,'faults':len(results),'elapsedSeconds':time.monotonic()-started,'restore':restored,'exporter':diagnostic,'rows':{t:len(v) for t,v in fingerprint['tables'].items()},'files':len(json.loads((dest/'files.json').read_text())),'limits':{'exporterCpu':0.5,'exporterMemoryMiB':384,'pids':128,'restoreCpu':0.5,'restoreMemoryMiB':768},'appUnchanged':True,'lockReleased':True}
  (OUT/'backup-restore-result.json').write_text(json.dumps(result,indent=2))
  (OUT/'operational-result.json').write_text(json.dumps({'passed':True,'scope':'exporter only; lifecycle/migrations unchanged','faults':results,'fullBackupRestore':True},indent=2))
  print(json.dumps(result),flush=True)

if __name__=='__main__':
 r=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([ExporterChecks('test_complete_backup_and_exporter_failures')]))
 sys.exit(not r.wasSuccessful())
