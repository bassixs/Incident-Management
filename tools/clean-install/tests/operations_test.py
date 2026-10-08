"""Real Docker/PostgreSQL operations tests; imported only by disposable-runner harness."""
import sys,os,pathlib,json,subprocess,time,fcntl,tarfile,hashlib,shutil

def exercise(h,conf,root,confirmation,mock):
 c=h['c'];run=h['run'];check=h['check'];wait=h['wait'];invoke=h['invoke'];S=h['S'];OUT=h['OUT']
 def ops(action,*args,ok=True,env=None):
  r=subprocess.run([sys.executable,str(S/'operations.py'),'--root',str(root),action,*map(str,args)],env=env,capture_output=True,timeout=600)
  with (OUT/'operations.log').open('ab') as f:f.write(r.stdout+r.stderr)
  if ok and r.returncode:raise RuntimeError(r.stdout.decode()+r.stderr.decode())
  return r
 def state():return c.load(root/'state/operations.json')
 def availability():return c.load(root/'state/availability.json')
 cid=c.app(conf)['Id'];initial=c.inspect(cid)
 import operations as op
 samples=[c.inspect(cid) for _ in range(20)]
 raw={hashlib.sha256(json.dumps({k:x[k] for k in ['Config','HostConfig','Mounts']},sort_keys=True).encode()).hexdigest() for x in samples}
 normalized={op.container_hash(x) for x in samples}
 evidence={'rawInspectHashes':len(raw),'normalizedHashes':len(normalized),'mountOrders':[list(v) for v in sorted({tuple(m['Destination'] for m in x['Mounts']) for x in samples})]}
 check('Docker mount order canonical without ignoring fields',len(normalized)==1,evidence)
 changed=json.loads(json.dumps(initial));changed['Mounts'].reverse();check('mount reordering is same configuration',op.container_hash(initial)==op.container_hash(changed))
 changed['Mounts'][0]['Source']+='-changed';check('changed mount still changes identity',op.container_hash(initial)!=op.container_hash(changed))
 ops('supervise');check('operations disabled before handover',availability()['status']=='FENCED_NO_AUTOSTART')
 check('wrong handover cannot arm',ops('enable','--confirm-handover-complete','wrong',ok=False).returncode!=0)
 check('no verified daily backup cannot arm',ops('enable','--confirm-handover-complete',confirmation,ok=False).returncode!=0)
 started=time.monotonic();ops('backup','--manual');b=c.load(root/'state/backup-success.json')
 check('daily full capture restore and single archive',b['status']=='SUCCESS' and b['restoreDifferences']==0 and c.sha(b['archive'])==b['sha256'],{'seconds':round(time.monotonic()-started,2)})
 check('private daily archive no world access',pathlib.Path(b['archive']).stat().st_mode & 0o777==0o600 and root.stat().st_mode & 0o777==0o700)
 with tarfile.open(b['archive'],'r:gz') as t:
  proof=json.load(t.extractfile('backup/restore-result.json'));diff=json.load(t.extractfile('backup/restore-differences.json'))
 check('archive contains actual exact restore proof',proof['databaseRows']==proof['schema']==proof['files']=='exact' and diff['differenceCount']==0)
 # Controlled pg_dump refusal, actual exporter/lock/DB. No fake success result.
 wrapper=OUT/'backup-wrapper';wrapper.mkdir();docker=shutil.which('docker');script=wrapper/'docker'
 script.write_text('#!/usr/bin/env python3\nimport os,sys\nif "pg_dump" in sys.argv:sys.exit(73)\nos.execv('+repr(docker)+',['+repr(docker)+']+sys.argv[1:])\n');script.chmod(0o755)
 ids=run('docker','ps','-aq').stdout.split()
 r=ops('backup','--manual',ok=False,env=dict(os.environ,PATH=str(wrapper)+':'+os.environ['PATH']))
 check('failed backup preserves previous verified result',r.returncode!=0 and c.load(root/'state/backup-last-attempt.json')['status']=='FAILED' and c.load(root/'state/backup-success.json')==b)
 check('failed backup leaves no temporary containers',set(run('docker','ps','-aq').stdout.split())==set(ids))
 with (root/'backup.lock').open('rb') as f:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB);check('daily backup error releases actual flock',True)
 ops('enable','--confirm-handover-complete',confirmation);check('handover explicitly arms exact host and container',state()['enabled'] and state()['appId']==cid)
 ops('backup');check('scheduled backup verified with no auto deletion',c.load(root/'state/backup-success.json')['status']=='SUCCESS' and pathlib.Path(b['archive']).exists())
 ops('units');units=root/'service-units';prefix=conf['project'];installed=[]
 try:
  for p in units.iterdir():
   q=pathlib.Path('/etc/systemd/system')/p.name;check('unit target initially absent '+p.suffix,not q.exists());shutil.copyfile(p,q);installed.append(q)
  run('systemctl','daemon-reload')
  v=run('systemd-analyze','verify',*[str(p) for p in installed]);(OUT/'systemd.txt').write_bytes(run('systemctl','--version').stdout+v.stdout+v.stderr)
  check('systemd calendar Moscow accepted',run('systemd-analyze','calendar','*-*-* 03:15:00 Europe/Moscow').returncode==0)
  run('docker','kill','--signal=KILL',cid);wait(lambda:not c.inspect(cid)['State']['Running'])
  ops('supervise');check('real app crash exact same CID recovers',availability()['status']=='RECOVERED' and c.app(conf)['Id']==cid)
  # An unavailable HTTP service does not justify recreating or restarting the bot.
  start=c.inspect(cid)['State']['StartedAt'];run('docker','pause',cid)
  try:
   r=ops('supervise',ok=False);check('HTTP outage recorded without blind restart',r.returncode!=0 and availability()['status']=='UNAVAILABLE' and not availability()['restartAttempted'])
  finally:run('docker','unpause',cid)
  c.ready(conf,cid);check('HTTP outage preserves app start',c.inspect(cid)['State']['StartedAt']==start)
  old=state();bad=dict(old,host={'machine':'wrong','docker':'wrong'});c.save(root/'state/operations.json',bad)
  check('copied host receipt refuses',ops('supervise',ok=False).returncode!=0);c.save(root/'state/operations.json',old)
  dummy='operations-second-app';h['owned'].append(dummy);run('docker','run','-d','--name',dummy,'--network','none','-e','BOT_TOKEN=synthetic-container-token','--entrypoint','node',conf['images']['main'],'-e','setInterval(()=>{},1000)')
  check('second instance refuses supervision',ops('supervise',ok=False).returncode!=0);run('docker','stop',dummy);run('docker','rm',dummy)
  # Real daemon restart + actual systemd service, not an OS reboot assertion.
  # Synthetic app exit with TERM models daemon downtime; clear retry age via fixture clock only.
  v=state();v['attempts']=[time.time()-600];c.save(root/'state/operations.json',v)
  run('docker','update','--restart','unless-stopped',mock)
  run('docker','kill','--signal=TERM',cid);wait(lambda:not c.inspect(cid)['State']['Running'],75)
  run('systemctl','restart','docker',timeout=120);wait(lambda:run('docker','info',check=False).returncode==0)
  wait(lambda:run('docker','exec',c.pg(conf),'pg_isready','-h','127.0.0.1','-U','onlink_admin',check=False).returncode==0)
  run('systemctl','start',prefix+'-supervise.service',timeout=180)
  check('daemon restart systemd restores only same app',c.app(conf)['Id']==cid and availability()['status']=='RECOVERED')
  # Cap/backoff are tested against a truly exited container; no sleep or widened timeout.
  run('docker','kill','--signal=TERM',cid);wait(lambda:not c.inspect(cid)['State']['Running'],75)
  check('recent recovery blocks repeat',b'RECOVERY_BACKOFF' in ops('supervise',ok=False).stderr and not c.inspect(cid)['State']['Running'])
  v=state();v['attempts']=[time.time()-700,time.time()-600,time.time()-500];c.save(root/'state/operations.json',v)
  check('recovery budget blocks crash loop',b'RECOVERY_BUDGET_EXHAUSTED' in ops('supervise',ok=False).stderr and not c.inspect(cid)['State']['Running'])
  v['attempts']=[time.time()-3700];c.save(root/'state/operations.json',v);ops('supervise')
  invoke(root,'stop');check('manual stop persists fence first',state()['enabled'] is False and not c.inspect(cid)['State']['Running'])
  run('systemctl','start',prefix+'-supervise.service');check('boot service cannot undo handover stop',availability()['status']=='FENCED_NO_AUTOSTART' and not c.inspect(cid)['State']['Running'])
  invoke(root,'start','--role','reserve','--confirm-source-stopped',confirmation);ops('supervise');check('manual restart does not silently rearm ownership',availability()['status']=='FENCED_NO_AUTOSTART')
 finally:
  for p in installed:
   if p.suffix=='.timer':run('systemctl','stop',p.name,check=False)
  for p in installed:p.unlink()
  run('systemctl','daemon-reload')
 check('operations no unexpected token containers',len([x for x in run('docker','ps','--filter','label=onlink40.handover='+prefix,'-q').stdout.split()])==1)
