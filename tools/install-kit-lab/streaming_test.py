"""Real exact-image memory/backup/restore regression; entirely synthetic."""
import hashlib,importlib.util,json,os,subprocess,sys,threading,time,unittest
from pathlib import Path
import ops_test as lab
from ops_test import run,sql,OUT,SCRIPTS,PG
from exporter_baseline_test import seed_volume
from exporter_test import ExporterChecks
from update_kit_test import UpdateKit
import ops_common as o
from data_stream import opened,differences

class Memory:
 def __init__(self):self.stop=threading.Event();self.values={};self.thread=threading.Thread(target=self.loop)
 def __enter__(self):self.thread.start();return self
 def __exit__(self,*args):self.stop.set();self.thread.join()
 def loop(self):
  while not self.stop.is_set():
   try:
    ids=run('docker','ps','-q').stdout.split()
    if ids:
     for c in json.loads(run('docker','inspect',*ids).stdout):
      name=c['Name'].lstrip('/')
      if not name.startswith(('incident-snapshot-','stream-baseline','incident-restore-')) and name!=PG:continue
      pid=c['State']['Pid'];base=Path('/proc')/str(pid)
      group=(base/'cgroup').read_text().split('0::',1)[1].strip();cg=Path('/sys/fs/cgroup')/group.lstrip('/')
      peak=int((cg/'memory.peak').read_text());rss=next(int(v.split()[1])*1024 for v in (base/'status').read_text().splitlines() if v.startswith('VmRSS:'))
      v=self.values.setdefault(name,{'cgroupPeakBytes':0,'sampledProcessRssBytes':0,'samples':0,'limit':c['HostConfig']['Memory'],'image':c['Image']})
      v['cgroupPeakBytes']=max(v['cgroupPeakBytes'],peak);v['sampledProcessRssBytes']=max(v['sampledProcessRssBytes'],rss);v['samples']+=1
   except (FileNotFoundError,ProcessLookupError,StopIteration):pass
   self.stop.wait(.25)

def heavy(db):
 seed_volume(db)
 sql(db,'''UPDATE "InboundUpdate" SET payload=jsonb_build_object('synthetic',repeat('inbound synthetic payload ',400));
UPDATE "OutboundMessage" SET payload=payload||jsonb_build_object('text',repeat('outbound synthetic text ',400)) WHERE id LIKE 'bulk-out-%';
UPDATE "Incident" SET text=repeat('long synthetic incident ',4000);
UPDATE "IncidentAnswer" SET text=repeat('long synthetic answer ',4000);''')
 logical=sql(db,'''SELECT json_build_object('inboundBytes',(SELECT sum(octet_length(payload::text)) FROM "InboundUpdate"),'outboundBytes',(SELECT sum(octet_length(payload::text)) FROM "OutboundMessage"),'incidentTextBytes',(SELECT sum(octet_length(text)) FROM "Incident"),'answerTextBytes',(SELECT sum(octet_length(text)) FROM "IncidentAnswer"),'physicalDatabaseBytes',pg_database_size(current_database()));''')
 (OUT/'heavy-volume.json').write_text(logical)

class StreamingDocker(lab.MigrationKit):
 def measured(self,fd,action,phase,dest):
  log=OUT/f'{phase}-{action}.log';rss=OUT/f'{phase}-{action}-rss.txt'
  args=[sys.executable,SCRIPTS/'backup-data.py','--settings',self.settings,action,'--output',dest]
  if action=='capture':args+=['--schema',phase]
  started=time.monotonic()
  with Memory() as memory:
   p=run('/usr/bin/time','-f','%M', '-o',rss,*args,check=False,env=dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd)),pass_fds=(fd,))
  log.write_text(p.stdout+p.stderr)
  result={'exitCode':p.returncode,'elapsedSeconds':time.monotonic()-started,'pythonPeakRssKiB':int(rss.read_text().splitlines()[-1]),'containers':memory.values}
  (OUT/f'{phase}-{action}-memory.json').write_text(json.dumps(result,indent=2))
  self.assertEqual(p.returncode,0,p.stdout+p.stderr);self.assertLess(result['pythonPeakRssKiB'],128*1024,'Receiver/comparator must stay bounded, not merely move Node allocation')
  self.assertTrue(any(n.startswith('incident-snapshot-') for n in memory.values),'Exporter memory sampling required')
  return result
 def baseline(self):
  folder=self.rootcase/'baseline';folder.mkdir();script=folder/'data-snapshot.cjs'
  # Exact bytes from the reviewed fc baseline, not a rewritten baseline.
  script.write_bytes(subprocess.check_output(['git','show','fc656d247ae0d8921a606c8dfd97e4684932ea02:tools/migration-kit/scripts/data-snapshot.cjs']))
  out=self.rootcase/'baseline.stdout';err=self.rootcase/'baseline.stderr';start=time.monotonic()
  with Memory() as memory, out.open('wb') as stdout,err.open('wb') as stderr:
   p=subprocess.Popen(['docker','run','-i','--name','stream-baseline','--network',lab.NET,'--cpus','0.5','--memory','384m','--pids-limit','128','--env-file',str(self.install/'private/runtime.env'),'--mount',f'type=bind,src={folder},dst=/ops,readonly','--entrypoint','node',self.images['main'],'/ops/data-snapshot.cjs','--export'],stdin=subprocess.PIPE,stdout=stdout,stderr=stderr)
   p.communicate(b'release\n',timeout=150)
  state=o.inspect('stream-baseline')['State'];run('docker','rm','stream-baseline')
  from snapshot_exporter import clean_stderr
  result={'exitCode':p.returncode,'state':state,'elapsedSeconds':time.monotonic()-start,'scriptSha256':hashlib.sha256(script.read_bytes()).hexdigest(),'stdoutBytes':out.stat().st_size,'stderr':clean_stderr(err.read_text(errors='replace')),'containers':memory.values}
  (OUT/'heavy-baseline-memory.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
  self.assertNotEqual(p.returncode,0,'Heavy original-exporter failure must be reproduced, not presumed')
  self.assertIn('JS_HEAP_OOM',result['stderr']['markers'])
 def test_heavy_old_and_new_backup_restore(self):
  heavy(self.db);self.baseline()
  (self.uploads/'long-photo.bin').write_bytes(b'photo'*300000)
  UpdateKit.seed(self)
  self.protected=sql(self.db,self.protected_sql)
  initial=o.identity(o.app(self.s));measurements={}
  with o.backup_lock(self.s) as fd:
   for phase in ['old','new']:
    if phase=='new':
     self.stop(fd);self.migrate(fd)
     UpdateKit.seed_new(self)
     # Stay stopped during this synthetic backup. No old runtime on new schema.
    dest=self.rootcase/('heavy-'+phase)
    measurements[phase]={action:self.measured(fd,action,phase,dest) for action in ['capture','verify']}
    restoration=json.loads((dest/'restore-result.json').read_text());self.assertEqual(restoration['databaseRows'],'exact')
    self.assertEqual(json.loads((dest/'restore-differences.json').read_text())['differenceCount'],0)
    self.assertEqual(list(differences(dest/'data.json',dest/'restored-data/data.json')),[])
    c=opened(dest/'data.json')
    self.assertGreater(c.execute('SELECT count(*) FROM rows').fetchone()[0],65000)
    if phase=='new':
     self.assertIsNotNone(c.execute("SELECT fields FROM rows WHERE t='IncidentAssignmentCycle' AND id='control-cycle'").fetchone())
     for key in ['control-deferred','control-cancelled','control-progress']:self.assertIsNotNone(c.execute("SELECT fields FROM rows WHERE t='OutboundMessage' AND id=?",(key,)).fetchone())
    c.close()
    if phase=='old':self.assertEqual(o.identity(o.app(self.s)),initial)
    (OUT/f'heavy-{phase}-restore.json').write_text(json.dumps(restoration,indent=2))
  with o.backup_lock(self.s):pass
  (OUT/'streaming-result.json').write_text(json.dumps({'passed':True,'measurements':measurements,'oldAndNewExact':True,'lockReleased':True},indent=2))

if __name__=='__main__':
 r=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([StreamingDocker('test_heavy_old_and_new_backup_restore')]))
 sys.exit(not r.wasSuccessful())
