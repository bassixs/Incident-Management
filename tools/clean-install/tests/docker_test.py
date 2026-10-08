"""Actual Docker/PostgreSQL handover test. Disposable runner only, no production secrets."""
import sys,os,json,pathlib,subprocess,time,hashlib,tarfile,shutil,fcntl,datetime
ROOT=pathlib.Path(__file__).resolve().parents[3];T=pathlib.Path(__file__).resolve().parent;S=T.parent/'scripts';sys.path.insert(0,str(S));import clean as c
from snapshot_exporter import Exporter
from data_stream import receive,report
OUT=ROOT/'clean-results';OUT.mkdir(exist_ok=True);results=[];owned=[];networks=[]
def run(*a,check=True,input=None,timeout=180):
 r=subprocess.run([str(x) for x in a],input=input,capture_output=True,timeout=timeout);text=r.stdout.decode(errors='replace')+r.stderr.decode(errors='replace')
 if check and r.returncode:raise RuntimeError('COMMAND_FAILED '+str(a[:3])+' '+text[-3000:])
 return r
def check(name,ok,evidence=None):
 results.append({'name':name,'passed':bool(ok),'evidence':evidence});print(json.dumps(results[-1]),flush=True)
 if not ok:raise RuntimeError(name)
def wait(f,seconds=60):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if f():return
  time.sleep(.2)
 raise RuntimeError('CONDITION_TIMEOUT')
def invoke(root,action,*args,ok=True,env=None):
 r=subprocess.run([sys.executable,str(S/'clean.py'),'--root',str(root),action,*map(str,args)],capture_output=True,env=env,timeout=240)
 (OUT/'commands.log').open('ab').write(r.stdout+r.stderr)
 if ok and r.returncode:raise RuntimeError(r.stdout.decode()+r.stderr.decode())
 return r

def init(root,port,*extra):
 invoke(root,'init','--domain','synthetic.localhost','--pg-image',PGIMAGE,'--caddy-image',CADDY,'--port',port,'--http-port',port+100,'--https-port',port+101,*extra)
 conf=c.load(root/'settings.json');owned.extend([conf['project']+'-postgres',conf['project']+'-caddy',conf['project']+'-app']);networks.extend([conf['project']+'_db',conf['project']+'_front'])
 invoke(root,'infra');return conf

def source_backup(conf,root,container):
 b=root/'final';b.mkdir(mode=0o700)
 schema=json.loads(c.run(c.node(conf,'schema-probe.cjs')))
 with Exporter(c.node(conf,'data-snapshot.cjs')+['--export'],b) as e:
  snap=e.read_json('snapshot',30)['snapshot'];v=receive(e,b/'data.sqlite')
  with (b/'database.dump').open('wb') as f:
   r=subprocess.run(['docker','exec',c.pg(conf),'pg_dump','-U','onlink_admin','-d','onlink40','-Fc','--snapshot='+snap],stdout=f,capture_output=False,stderr=subprocess.PIPE,timeout=120);check('source pg_dump snapshot',r.returncode==0)
  e.finish()
 c.save(b/'data.json',v);files={f.relative_to(root/'uploads').as_posix():c.sha(f) for f in (root/'uploads').rglob('*') if f.is_file()};c.save(b/'files.json',files)
 with tarfile.open(b/'uploads.tar.gz','w:gz') as t:
  for n in files:t.add(root/'uploads'/n,arcname=n)
 with tarfile.open(b/'configuration.tar.gz','w:gz') as t:
  t.add(root/'private/runtime.env',arcname='runtime.env');t.add(root/'main.compose.json',arcname='compose.yml')
 identity=c.o.identity(c.inspect(container));c.save(b/'backup.json',{'kit':'pr14-18-v1','phase':'new','schema':schema['schema'],'identity':schema['identity'],'application':identity,'finalRun':'synthetic-stopped','createdAt':c.stamp()})
 c.save(b/'checksums.json',{f.name:c.sha(f) for f in b.iterdir() if f.is_file()})
 # Independent genuine restore before issuing a success marker.
 cid=run('docker','run','-d','--name','clean-source-verify','--network',conf['project']+'_db','-e','POSTGRES_PASSWORD=synthetic-only',PGIMAGE).stdout.decode().strip();owned.append('clean-source-verify')
 wait(lambda:run('docker','exec',cid,'pg_isready','-h','127.0.0.1',check=False).returncode==0)
 with (b/'database.dump').open('rb') as f:
  r=subprocess.run(['docker','exec','-i',cid,'pg_restore','-U','postgres','-d','postgres','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],stdin=f,capture_output=True);check('source independent restore',r.returncode==0)
 c.text(root/'private/verify.env','DATABASE_URL=postgresql://postgres:synthetic-only@127.0.0.1:5432/postgres\n')
 cmd=c.node(conf,'data-snapshot.cjs',env='verify.env',network='container:'+cid)+['--export'];d=b/'source-verified';d.mkdir()
 with Exporter(cmd,d) as e:e.read_json('snapshot',30);v=receive(e,d/'data.sqlite');e.finish()
 c.save(d/'data.json',v);check('source genuine restore data exact',report(b/'data.json',d/'data.json',b/'restore-differences.json')==0)
 restored=json.loads(c.run(c.node(conf,'schema-probe.cjs',env='verify.env',network='container:'+cid)));check('source genuine restore schema exact',c.mg.schema_matches(restored['schema'],c.load(S/'schema-expectations.json')['new']))
 extracted=b/'verify-files';extracted.mkdir();c.untar(b/'uploads.tar.gz',extracted,files)
 c.save(b/'restore-result.json',{'databaseRows':'exact','schema':'exact','files':'exact','backupChecksumsSha256':c.sha(b/'checksums.json')})
 # Source receipt models the existing reviewed graceful stop receipt, from actual Docker state.
 x=c.inspect(container);c.save(root/'source-stop.json',{'clean':True,'identity':identity,'finishedAt':x['State']['FinishedAt']})
 run(sys.executable,S/'seal-source.py','--backup',b,'--stop-receipt',root/'source-stop.json','--output',root/'source-envelope.json')
 return b,root/'source-envelope.json'

def main():
 global PGIMAGE,CADDY
 check('empty disposable daemon',not run('docker','ps','-aq').stdout.strip());need=os.environ.get('GITHUB_ACTIONS')=='true';check('disposable Actions only',need)
 PGIMAGE=c.inspect('postgres:16.15-alpine')['Id'];CADDY=c.inspect('caddy:2-alpine')['Id']
 (OUT/'environment.txt').write_bytes(run('docker','version').stdout+run('docker','compose','version').stdout+run('python3','--version').stdout)
 source=OUT/'source';sc=init(source,23001)
 os.chown(source/'uploads',1000,1000)
 fixture=ROOT/'tools/reserve-container-lab';mock='clean-max-mock';owned.append(mock)
 run('docker','run','-d','--name',mock,'--network',sc['project']+'_front','--network-alias','mock','--mount',f'type=bind,src={fixture},dst=/lab,readonly','--entrypoint','node',sc['images']['main'],'/lab/mock.cjs')
 def control(body=None):
  js="fetch('http://127.0.0.1:8080/control',process.argv[1]==='null'?{}:{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))"
  return json.loads(run('docker','exec',mock,'node','-e',js,json.dumps(body)).stdout)
 env=c.envread(source/'private/app-db.env');env.update(NODE_ENV='production',BOT_TOKEN='synthetic-container-token',MAX_API_BASE_URL='http://mock:8080',BOT_MODE='webhook',WEBHOOK_URL='https://synthetic.invalid/webhook/max',WEBHOOK_SECRET='synthetic-secret',WEBHOOK_AUTO_REGISTER='false',HTTP_PORT='3000',HTTP_HOST='0.0.0.0',MEDIA_STORAGE='local',MEDIA_LOCAL_PATH='/app/data/uploads',INCIDENT_SLA_POLICY='WORKING_HOURS_V1',SLA_ENABLED='false',DISTRIBUTION_QUEUE_ENABLED='false',ADMINS='9001',LOG_PRETTY='false',BOT_STATUS_USER_IDS='')
 c.text(source/'private/runtime.env',''.join(k+'='+v+'\n' for k,v in env.items()))
 run('docker','run','--rm','--network',sc['project']+'_db','--env-file',source/'private/runtime.env','--entrypoint','npx',sc['images']['main'],'prisma','migrate','deploy')
 run('docker','run','--rm','--network',sc['project']+'_db','--env-file',source/'private/runtime.env','--mount',f'type=bind,src={T},dst=/tests,readonly','--mount',f'type=bind,src={source / "uploads"},dst=/app/data/uploads','--entrypoint','node',sc['images']['main'],'/tests/seed.cjs')
 source_compose=c.load(source/'main.compose.json');source_compose['services']['app']['environment']={'SYNTHETIC_COMPOSE_ONLY':'preserved','SYNTHETIC_SPECIAL':'literal-$$NEVER_SET-#-"quoted"'};c.save(source/'main.compose.json',source_compose)
 control({'op':'rule','target':'user:10001','mode':'error','from':2,'status':503})
 c.compose(sc,'main',['create','--no-build','--pull','never','app']);app=c.app(sc)['Id'];run('docker','start',app);c.ready(sc,app)
 def row(conf):return json.loads(c.psql(conf,"SELECT row_to_json(t) FROM (SELECT status,payload,\"firstMessageId\" FROM \"OutboundMessage\" WHERE id='partial') t;"))
 wait(lambda:len(row(sc)['payload'].get('deliveryProgress',{}).get('mids',[]))==1)
 run('docker','kill','--signal=TERM',app);wait(lambda:not c.inspect(app)['State']['Running'],75);check('real source graceful stop',c.inspect(app)['State']['ExitCode']==0 and b'graceful shutdown completed' in run('docker','logs',app).stdout)
 partial=row(sc)['payload']['deliveryProgress'];check('actual first ACK saved',len(partial['mids'])==1)
 # Same-container return before transfer, then a NEW final backup.
 run('docker','start',app);c.ready(sc,app);check('source same-container resume before handover',c.app(sc)['Id']==app)
 run('docker','kill','--signal=TERM',app);wait(lambda:not c.inspect(app)['State']['Running'],75)
 backup,envelope=source_backup(sc,source,app);code=c.load(envelope)['handoffCode']
 cancel=OUT/'cancel';cc=init(cancel,25001);invoke(cancel,'restore','--backup',backup,'--envelope',envelope);invoke(cancel,'abandon');check('abandon before first start',c.load(cancel/'state/abandon-proof.json')['everStartAttempted'] is False);check('cannot start abandoned target',invoke(cancel,'start','--confirm-source-stopped',code,ok=False).returncode!=0);check('cannot repeat abandon',invoke(cancel,'abandon',ok=False).returncode!=0)
 target=OUT/'target';tc=init(target,24001);run('docker','network','connect','--alias','mock',tc['project']+'_front',mock)
 check('preparation never starts target app',c.app(tc) is None)
 invoke(target,'restore','--backup',backup,'--envelope',envelope);check('new identity, exact new schema',c.schema(tc)!=c.schema(sc))
 before=c.psql(tc,"SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM \"Incident\" t;");failed=c.psql(tc,"SELECT row_to_json(t) FROM \"OutboundMessage\" t WHERE id IN ('FAILED','CANCELLED','DEFERRED') ORDER BY id;")
 # Actual Caddy TLS with synthetic local CA, not public ACME attestation.
 wait(lambda:(target/'caddy-data/caddy/pki/authorities/local/root.crt').is_file())
 tls=run('curl','--silent','--show-error','--noproxy','*','--cacert',target/'caddy-data/caddy/pki/authorities/local/root.crt','--resolve','synthetic.localhost:24102:127.0.0.1','https://synthetic.localhost:24102/handover-check');check('Caddy HTTPS challenge with trusted synthetic CA',tls.stdout.decode()==tc['challenge'])
 original=(target/'main.compose.json').read_bytes();(target/'main.compose.json').write_bytes(original+b' ');check('changed configuration refuses',invoke(target,'status',ok=False).returncode!=0);(target/'main.compose.json').write_bytes(original)
 check('effective Compose override preserved',c.envread(target/'private/runtime.env').get('SYNTHETIC_COMPOSE_ONLY')=='preserved')
 check('restored partial ACK unchanged',row(tc)['payload']['deliveryProgress']==partial)
 check('duplicate restore refuses',invoke(target,'restore','--backup',backup,'--envelope',envelope,ok=False).returncode!=0)
 check('wrong source confirmation refuses',invoke(target,'start','--confirm-source-stopped','wrong',ok=False).returncode!=0)
 dummy='clean-second-instance';owned.append(dummy);run('docker','run','-d','--name',dummy,'--network','none','-e','BOT_TOKEN=synthetic-container-token','--entrypoint','node',tc['images']['main'],'-e','setInterval(()=>{},1000)');check('second token instance refuses before create',invoke(target,'start','--confirm-source-stopped',code,ok=False).returncode!=0);run('docker','stop',dummy);run('docker','rm',dummy)
 # Actual Docker create failure through disappearing bind source, no weakened guard.
 wrapper=OUT/'wrapper';wrapper.mkdir();docker=shutil.which('docker');flag=OUT/'fail-create-once';flag.touch();script=wrapper/'docker'
 script.write_text('#!/usr/bin/env python3\nimport os,sys,pathlib\na=sys.argv[1:]\nif "compose" in a and "create" in a and pathlib.Path('+repr(str(flag))+').exists():\n pathlib.Path('+repr(str(flag))+').unlink();pathlib.Path('+repr(str(target/'uploads'))+').rename('+repr(str(target/'uploads-held'))+')\nos.execv('+repr(docker)+',['+repr(docker)+']+a)\n');script.chmod(0o755)
 r=invoke(target,'start','--confirm-source-stopped',code,ok=False,env=dict(os.environ,PATH=str(wrapper)+':'+os.environ['PATH']));check('real create failure refuses and records',r.returncode!=0 and c.load(target/'state/state.json')['phase']=='start-failed')
 (target/'uploads-held').rename(target/'uploads');control({'op':'clear','target':'user:10001'})
 invoke(target,'start','--role','reserve','--confirm-source-stopped',code);wait(lambda:row(tc)['status']=='SENT');check('partial delivery skips confirmed first MID',row(tc)['payload']['deliveryProgress']['mids'][0]==partial['mids'][0]);accepted=control()['ledger'];check('confirmed first fragment not resent',sum(x['message']['body']['mid']==partial['mids'][0] for x in accepted)==1 and len([x for x in accepted if x['target']=='user:10001'])==row(tc)['payload']['deliveryProgress']['totalParts'])
 check('FAILED CANCELLED DEFERRED preserved',failed==c.psql(tc,"SELECT row_to_json(t) FROM \"OutboundMessage\" t WHERE id IN ('FAILED','CANCELLED','DEFERRED') ORDER BY id;"))
 for role in ['main','reserve','main']:
  started=time.monotonic();invoke(target,'stop');elapsed=time.monotonic()-started;check('actual SIGTERM '+role,elapsed<75,{'seconds':elapsed});invoke(target,'start','--role',role,'--confirm-source-stopped',code);check('ready '+role,c.app(tc)['State']['Running'] and c.app(tc)['Image']==tc['images'][role])
 # Genuine failed start: occupied loopback port, then reserve on unchanged DB.
 invoke(target,'stop')
 holder=subprocess.Popen([sys.executable,'-m','http.server','24001','--bind','127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 try:
  wait(lambda: __import__('socket').socket().connect_ex(('127.0.0.1',24001))==0)
  r=invoke(target,'start','--role','main','--confirm-source-stopped',code,ok=False);check('real start port bind failure',r.returncode!=0 and c.load(target/'state/state.json')['phase']=='start-failed')
 finally:holder.terminate();holder.wait(5)
 invoke(target,'start','--role','reserve','--confirm-source-stopped',code)
 check('reserve after failed start ready',c.app(tc)['State']['Running']);check('effective dollar/hash/quotes preserved in container',dict(v.split('=',1) for v in c.app(tc)['Config']['Env'] if '=' in v)['SYNTHETIC_SPECIAL']=='literal-$NEVER_SET-#-"quoted"')
 check('incident data preserved after switches',before==c.psql(tc,"SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM \"Incident\" t;"))
 check('policy retained',c.envread(target/'private/runtime.env')['INCIDENT_SLA_POLICY']=='WORKING_HOURS_V1')
 from operations_test import exercise
 exercise(globals(),tc,target,code,mock)
 c.psql(tc,"UPDATE \"Incident\" SET text=text||' after-target-start' WHERE id='new';");current=c.psql(tc,"SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM \"Incident\" t;")
 invoke(target,'stop')
 run(sys.executable,S/'snapshot.py','--root',target,'--output',target/'current-final','--final')
 check('new target backup restored exactly',c.load(target/'current-final/restore-differences.json')['differenceCount']==0)
 run(sys.executable,S/'seal-source.py','--backup',target/'current-final','--stop-receipt',target/'state/stop-receipt.json','--output',target/'reverse-envelope.json')
 # Return uses a NEW DB and the pre-existing edge Caddy, not a second proxy.
 edge=sc['project']+'_front';alias='synthetic-return-app'
 reverse=OUT/'reverse';rc=init(reverse,26001,'--edge-network',edge,'--edge-alias',alias)
 check('return preparation creates no second Caddy',run('docker','ps','-aq','--filter','name=^/'+rc['project']+'-caddy$',check=False).stdout.strip()==b'')
 run('docker','network','connect','--alias','mock',rc['project']+'_front',mock)
 invoke(reverse,'restore','--backup',target/'current-final','--envelope',target/'reverse-envelope.json')
 invoke(reverse,'start','--confirm-source-stopped',c.load(target/'reverse-envelope.json')['handoffCode'])
 check('reverse transfer uses CURRENT target data',current==c.psql(rc,"SELECT md5(string_agg(row_to_json(t)::text,'' ORDER BY id)) FROM \"Incident\" t;"))
 proxy=sc['project']+'-caddy';proxy_before=c.inspect(proxy);active=source/'Caddyfile'
 # Fixture-only unrelated route, established before testing replacement.
 original=active.read_text().replace(' handle {',' handle /documents/control {\n  respond "other-service-preserved" 200\n }\n handle {')
 active.write_text(original);run('docker','exec',proxy,'caddy','reload','--config','/etc/caddy/Caddyfile')
 route=OUT/'route-review';run(sys.executable,S/'prepare-route.py','--config',active,'--sha256',c.sha(active),'--old','app:3000','--new',alias+':3000','--count','1','--output',route)
 check('changed Caddy refuses preparation',run(sys.executable,S/'prepare-route.py','--config',active,'--sha256','0'*64,'--old','app:3000','--new',alias+':3000','--count','1','--output',OUT/'refused-route',check=False).returncode!=0)
 candidate=route/'Caddyfile.candidate'
 run('docker','run','--rm','--network','none','--mount',f'type=bind,src={candidate},dst=/etc/caddy/Caddyfile,readonly','--entrypoint','caddy',CADDY,'validate','--config','/etc/caddy/Caddyfile')
 run('docker','exec','-i',proxy,'caddy','validate','--config','/dev/stdin','--adapter','caddyfile',input=candidate.read_bytes())
 check('candidate validated in existing proxy context',True)
 # Preserve bind mount inode; only confirmed route bytes change, no container restart.
 with active.open('wb') as f:f.write(candidate.read_bytes());f.flush();os.fsync(f.fileno())
 run('docker','exec',proxy,'caddy','reload','--config','/etc/caddy/Caddyfile')
 ca=source/'caddy-data/caddy/pki/authorities/local/root.crt'
 def curl(path):return run('curl','--silent','--show-error','--fail','--noproxy','*','--cacert',ca,'--resolve','synthetic.localhost:23102:127.0.0.1','https://synthetic.localhost:23102'+path).stdout
 check('existing Caddy reaches returned app',curl('/ready') and curl('/health'))
 check('existing unrelated Caddy route preserved',curl('/documents/control')==b'other-service-preserved')
 bad=run('docker','exec','-i',proxy,'caddy','reload','--config','/dev/stdin','--adapter','caddyfile',input=b'{ unknown_invalid_directive }',check=False)
 check('refused proxy reload preserves active app and other route',bad.returncode!=0 and bool(curl('/ready')) and curl('/documents/control')==b'other-service-preserved')
 proxy_after=c.inspect(proxy);check('Caddy ID start and restart count unchanged',all(proxy_before[k]==proxy_after[k] for k in ['Id','RestartCount']) and proxy_before['State']['StartedAt']==proxy_after['State']['StartedAt'])
 # External checker runs outside app container and uses independently trusted TLS.
 hosts=pathlib.Path('/etc/hosts');saved=hosts.read_bytes()
 try:
  with hosts.open('ab') as f:f.write(b'\n127.0.0.1 synthetic.localhost\n')
  ev=dict(os.environ,NO_PROXY='synthetic.localhost',no_proxy='synthetic.localhost')
  r=subprocess.run([sys.executable,str(S/'check-external.py'),'--url','https://synthetic.localhost:23102','--ca',str(ca)],env=ev,capture_output=True,timeout=30)
  check('external HTTPS checker observes readiness',r.returncode==0,r.stdout.decode())
  invoke(reverse,'stop')
  r=subprocess.run([sys.executable,str(S/'check-external.py'),'--url','https://synthetic.localhost:23102','--ca',str(ca)],env=ev,capture_output=True,timeout=30)
  check('external checker detects stopped returned app',r.returncode!=0)
 finally:hosts.write_bytes(saved)
 check('cannot abandon after any target start',invoke(target,'abandon',ok=False).returncode!=0)
 # Lock ownership and release on refusal.
 with (target/'backup.lock').open('rb') as f:
  fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);check('busy backup lock refuses',invoke(target,'status',ok=False).returncode!=0);fcntl.flock(f,fcntl.LOCK_UN)
 with (target/'backup.lock').open('rb') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);check('lock free after all errors',True)
 # Existing target contains current writes; no old DB restore is permitted.
 check('restoration over used DB forbidden',invoke(target,'restore','--backup',backup,'--envelope',envelope,ok=False).returncode!=0)
 # Encryption roundtrip uses only a synthetic fixture/passphrase, never production data.
 gd=OUT/'gpg';gd.mkdir(mode=0o700);plain=gd/'plain';plain.write_bytes(b'synthetic-final-package');enc=gd/'data.gpg';dec=gd/'restored';base=['gpg','--homedir',str(gd),'--batch','--yes','--pinentry-mode','loopback','--passphrase-fd','0'];pw=b'synthetic-test-only\n'
 try:
  run(*base,'--symmetric','--cipher-algo','AES256','--output',enc,plain,input=pw);run(*base,'--output',dec,'--decrypt',enc,input=pw);check('encrypted synthetic package roundtrip',plain.read_bytes()==dec.read_bytes());damaged=bytearray(enc.read_bytes());damaged[-10]^=1;(gd/'damaged.gpg').write_bytes(damaged);check('damaged encrypted package rejected',run(*base,'--output',gd/'invalid','--decrypt',gd/'damaged.gpg',input=pw,check=False).returncode!=0)
 finally:run('gpgconf','--homedir',gd,'--kill','all',check=False)
 check('no unexpected webhook mutations',not control()['unexpected'])
 (OUT/'image-ids.json').write_text(json.dumps({'application':tc['images'],'postgres':PGIMAGE,'caddy':CADDY},indent=2))
finally_status=False
try:main();finally_status=True
finally:
 for n in reversed(owned):
  r=run('docker','inspect',n,check=False)
  if r.returncode:continue
  x=json.loads(r.stdout)[0]
  if n.endswith('-caddy'):(OUT/(n+'-caddy.log')).write_bytes(run('docker','logs',x['Id'],check=False).stdout+run('docker','logs',x['Id'],check=False).stderr)
  if x['State']['Running']:run('docker','stop','-t','30',x['Id'],check=False)
  run('docker','rm','-v',x['Id'],check=False)
 for n in reversed(networks):run('docker','network','rm',n,check=False)
 (OUT/'report.json').write_text(json.dumps({'passed':finally_status,'checks':results,'scope':'new controller; real Docker/PostgreSQL and local HTTP mock, no Astra kernel/ACME/public MAX attestation'},indent=2))
 (OUT/'cleanup.txt').write_bytes(run('docker','ps','-a').stdout)
