"""Read-only exporter baseline on exact images; all data synthetic."""
import hashlib,json,os,subprocess,sys,time,unittest
from pathlib import Path
import ops_test as lab
from ops_test import run,sql,OUT,NET,SCRIPTS

def seed_volume(db):
 sql(db,'''INSERT INTO "User"(id,"maxUserId","displayName","updatedAt")
SELECT 'bulk-user-'||g,100000+g,'Synthetic',now() FROM generate_series(1,700) g;
INSERT INTO "Incident"(id,"publicCode","requesterId","requesterMaxUserId","requesterName",text,status,"deadlineAt","updatedAt")
SELECT 'bulk-incident-'||g,'INC-SYNTH-'||g,'bulk-user-'||g,100000+g,'Synthetic',repeat('synthetic incident ',70),'ASSIGNED','2099-01-01',now() FROM generate_series(1,700) g;
INSERT INTO "IncidentAnswer"(id,"incidentId",version,text,status,"createdByUserId","updatedAt")
SELECT 'bulk-answer-'||g,'bulk-incident-'||g,1,repeat('synthetic answer ',90),'DRAFT','bulk-user-'||g,now() FROM generate_series(1,700) g;
INSERT INTO "IncidentHistory"(id,"incidentId",action) SELECT 'bulk-history-'||g,'bulk-incident-'||((g-1)%700+1),'SYNTHETIC' FROM generate_series(1,6000) g;
INSERT INTO "InboundUpdate"(id,"externalUpdateKey","updateType","partitionKey",payload,status,"processedAt","updatedAt")
SELECT 'bulk-in-'||g,'synthetic-event-'||g,'message_created','synthetic-user-'||(g%700),jsonb_build_object('synthetic',repeat('x',512)),'PROCESSED',now(),now() FROM generate_series(1,26474) g;
INSERT INTO "OutboundMessage"(id,"targetType","targetId",payload,attachments,status,"sentAt","updatedAt")
SELECT 'bulk-out-'||g,'user',100000+g%700,jsonb_build_object('text',repeat('x',700),'deliveryProgress',jsonb_build_object('version',1,'planHash',repeat('0',64),'totalParts',1,'mids',jsonb_build_array('synthetic-mid-'||g))),'[]','SENT',now(),now() FROM generate_series(1,31091) g;''')

def raw_export(s,script,tag):
 name='export-baseline-'+tag
 env=Path(s['install'])/'private/runtime.env'
 code=Path(script)
 started=time.monotonic()
 proc=subprocess.Popen(['docker','run','--name',name,'--network',s['migration']['network'],'--cpus','0.5','--memory','384m','--pids-limit','128','--env-file',str(env),'--mount',f'type=bind,src={code.parent},dst=/ops,readonly','--entrypoint','node',s['images']['main']['id'],'/ops/'+code.name,'--export'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 # Release may be queued immediately: exporter still produces both lines within
 # its transaction; the CLI exits only after serializing the full snapshot.
 try:
  stdout,stderr=proc.communicate('release\n',timeout=150)
 except subprocess.TimeoutExpired:
  run('docker','stop','-t','10',name,check=False)
  stdout,stderr=proc.communicate(timeout=20)
 rows=stdout.splitlines()
 parsed=[]
 for line in rows:
  try:parsed.append(json.loads(line))
  except ValueError:parsed.append(None)
 inspect=json.loads(run('docker','inspect',name).stdout)[0]
 result={'tag':tag,'exitCode':proc.returncode,'containerState':inspect['State'],'limits':{k:inspect['HostConfig'][k] for k in ['Memory','NanoCpus','PidsLimit']},'elapsedSeconds':time.monotonic()-started,'stdoutBytes':len(stdout.encode()),'jsonLines':len(parsed),'snapshotLine':bool(parsed and isinstance(parsed[0],dict) and 'snapshot' in parsed[0]),'dataLine':bool(len(parsed)>1 and isinstance(parsed[1],dict) and parsed[1].get('format')=='pr14-18-data-v1'),'stderr':stderr,'scriptSha256':hashlib.sha256(code.read_bytes()).hexdigest()}
 if result['dataLine']:result['rowCounts']={k:len(v) for k,v in parsed[1]['tables'].items()}
 (OUT/('baseline-'+tag+'.json')).write_text(json.dumps(result,indent=2))
 run('docker','rm','-v',name)
 print(json.dumps({k:v for k,v in result.items() if k not in ['stderr','rowCounts','containerState']}),flush=True)
 return result

class Baseline(lab.MigrationKit):
 def test_exact_baseline_volume(self):
  seed_volume(self.db)
  versions=run('docker','run','--rm','--network','none','--entrypoint','node',self.images['main'],'-e',"console.log(JSON.stringify({node:process.version,versions:process.versions,prisma:require('@prisma/client/package.json').version}))").stdout
  (OUT/'component-versions.json').write_text(versions)
  counts=sql(self.db,'SELECT count(*) FROM "InboundUpdate"; SELECT count(*) FROM "OutboundMessage"; SELECT pg_database_size(current_database());')
  (OUT/'synthetic-volume.txt').write_text(counts)
  baseline=self.rootcase/'baseline';baseline.mkdir()
  script=baseline/'data-snapshot.cjs'
  script.write_bytes(run('git','show','e1c15c777b8123c85f683cf2528aab2b7a03bfae:tools/migration-kit/scripts/data-snapshot.cjs').stdout.encode())
  results=[raw_export(self.s,script,str(i)) for i in range(3)]
  (OUT/'baseline-summary.json').write_text(json.dumps({'runs':results,'failures':sum(v['exitCode']!=0 or not v['dataLine'] for v in results)},indent=2))
  # Baseline failure is evidence, not a green regression claim.
  self.assertTrue(all(r['scriptSha256']==hashlib.sha256(script.read_bytes()).hexdigest() for r in results))
if __name__=='__main__':
 r=unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite([Baseline('test_exact_baseline_volume')]))
 sys.exit(not r.wasSuccessful())

