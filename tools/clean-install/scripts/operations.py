"""Opt-in host-local operations. No queue edits, pruning, webhook writes or app recreation."""
import argparse,datetime,hashlib,json,os,pathlib,re,subprocess,sys,tarfile,time,urllib.request
import clean as c
import snapshot

def now():return time.time()
def owner_path(conf):return pathlib.Path(conf['root'])/'state/operations.json'
def host_identity():
 return {'machine':c.sha('/etc/machine-id'),'docker':c.run(['docker','info','--format','{{.ID}}'])}
def container_hash(x):
 # Docker serializes Mounts from a map; order is not a configuration change.
 value={k:x[k] for k in ['Config','HostConfig']};value['Mounts']=sorted(x['Mounts'],key=lambda m:m['Destination'])
 return hashlib.sha256(json.dumps(value,sort_keys=True).encode()).hexdigest()
def code(error):return str(error) if isinstance(error,c.o.Refusal) and re.fullmatch('[A-Z0-9_]+',str(error)) else type(error).__name__
def write_result(conf,name,value):
 value={'at':c.stamp(),**value};c.save(pathlib.Path(conf['root'])/'state'/name,value);print(json.dumps(value),flush=True);return value
def current_owner(conf):
 p=owner_path(conf);return c.load(p) if p.exists() else {'enabled':False,'reason':'not-activated'}
def checked_owner(conf,s):
 v=current_owner(conf);c.need(v.get('enabled') is True,'AUTOSTART_DISABLED')
 c.need(v['host']==host_identity() and v['settingsHash']==s['settingsHash'],'OWNER_HOST_CHANGED')
 c.need(v['appId']==s['appId'] and s['phase']=='running','OWNER_STATE_CHANGED')
 x=c.inspect(s['appId']);c.need(x['Image']==conf['images'][s['role']] and container_hash(x)==v['containerHash'],'OWNER_CONTAINER_CHANGED')
 c.need(x['HostConfig']['RestartPolicy']['Name']=='no','DOCKER_AUTOSTART_NOT_ALLOWED');c.inventory(conf,s)
 return v,x

def enable(conf,s,confirmation):
 c.need(confirmation==s.get('sourceFence',{}).get('handoffCode'),'HANDOVER_CONFIRMATION_REQUIRED')
 c.need(s['phase']=='running','RUNNING_READY_REQUIRED');c.inventory(conf,s);x=c.app(conf)
 c.need(x and x['Id']==s['appId'] and x['State']['Running'],'RUNNING_READY_REQUIRED');c.ready(conf,x['Id'])
 c.need(c.schema(conf)==s['identity'],'IDENTITY_CHANGED');c.checked_image(s['role'],x['Image'])
 c.need(x['HostConfig']['RestartPolicy']['Name']=='no','DOCKER_AUTOSTART_NOT_ALLOWED')
 p=pathlib.Path(conf['root'])/'state/backup-success.json';c.need(p.exists(),'VERIFIED_BACKUP_REQUIRED');b=c.load(p)
 c.need(b['status']=='SUCCESS' and now()-b['completedEpoch']<86400 and c.sha(b['archive'])==b['sha256'],'FRESH_VERIFIED_BACKUP_REQUIRED')
 # Explicit operator attestation is required; no remotely copied receipt enables this lease.
 c.save(owner_path(conf),{'format':'host-operations-v1','enabled':True,'enabledAt':c.stamp(),'host':host_identity(),'settingsHash':s['settingsHash'],'appId':x['Id'],'containerHash':container_hash(x),'attempts':[],'failures':0,'confirmation':'handover-complete-other-host-fenced'})
 write_result(conf,'operations-result.json',{'status':'ENABLED','appId':x['Id']})

def make_backup(conf,s,manual=False):
 if not manual and not current_owner(conf).get('enabled'):
  return write_result(conf,'backup-last-attempt.json',{'status':'SKIPPED_FENCED'})
 if not manual:checked_owner(conf,s)
 c.need(s['phase']=='running','BACKUP_REQUIRES_RUNNING_OWNER')
 root=pathlib.Path(conf['root']);runid=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+os.urandom(4).hex();d=root/'backups'/runid
 try:
  snapshot.backup(conf,s,d,False)
  v=c.load(d/'restore-result.json');c.need(v['databaseRows']==v['schema']==v['files']=='exact' and c.load(d/'restore-differences.json')['differenceCount']==0,'RESTORE_NOT_EXACT')
  # Unencrypted staging never leaves the private root. No retention or external publication.
  archive=root/'backups'/(runid+'.tar.gz');partial=archive.with_suffix('.gz.partial')
  with tarfile.open(partial,'x:gz') as t:t.add(d,arcname='backup',recursive=True)
  # Verify archive bytes against every file, not just a successful tar exit.
  expected={str(p.relative_to(d)):c.sha(p) for p in d.rglob('*') if p.is_file()};seen={}
  with tarfile.open(partial,'r:gz') as t:
   for m in t:
    if m.isdir():continue
    rel=pathlib.PurePosixPath(m.name);c.need(m.isfile() and rel.parts[0]=='backup' and '..' not in rel.parts,'ARCHIVE_MEMBER_INVALID');key=str(pathlib.PurePosixPath(*rel.parts[1:]));c.need(key not in seen,'ARCHIVE_DUPLICATE')
    with t.extractfile(m) as f:seen[key]=hashlib.file_digest(f,'sha256').hexdigest()
  c.need(seen==expected,'ARCHIVE_FILES_MISMATCH');os.rename(partial,archive);os.chmod(archive,0o600)
  h=c.sha(archive);c.text(pathlib.Path(str(archive)+'.sha256'),h+'  '+archive.name+'\n')
  result={'status':'SUCCESS','runId':runid,'archive':str(archive),'sha256':h,'restoreDifferences':0,'completedEpoch':now(),'elapsedSeconds':round(now()-datetime.datetime.strptime(runid[:16],'%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc).timestamp(),2),'publication':'disabled','encryption':'not-requested'}
  write_result(conf,'backup-success.json',result);write_result(conf,'backup-last-attempt.json',result)
 except Exception as e:
  write_result(conf,'backup-last-attempt.json',{'status':'FAILED','runId':runid,'reason':code(e)});raise

def health(conf):
 result={}
 for path in ['health','ready']:
  try:
   with urllib.request.urlopen(f'http://127.0.0.1:{conf["port"]}/{path}',timeout=3) as r:result[path]=r.status
  except Exception:result[path]=0
 return result

def supervise(conf,s):
 if not current_owner(conf).get('enabled'):
  return write_result(conf,'availability.json',{'status':'FENCED_NO_AUTOSTART'})
 v,x=checked_owner(conf,s);recovered=False
 if not x['State']['Running']:
  c.need(x['State']['Status']=='exited','UNKNOWN_CONTAINER_STATE');c.need(c.schema(conf)==s['identity'],'DATABASE_NOT_READY_OR_CHANGED')
  attempts=[t for t in v.get('attempts',[]) if now()-t<3600]
  c.need(len(attempts)<3,'RECOVERY_BUDGET_EXHAUSTED');c.need(not attempts or now()-attempts[-1]>=300,'RECOVERY_BACKOFF')
  v['attempts']=attempts+[now()];v['lastAttemptAt']=c.stamp();c.save(owner_path(conf),v)
  # Only start the exact existing container; never recreate, rollback or reset queues.
  c.run(['docker','start',x['Id']]);c.ready(conf,x['Id']);c.none_running(conf,x['Id']);recovered=True
 h=health(conf);ok=all(vv==200 for vv in h.values());v['failures']=0 if ok else v.get('failures',0)+1;c.save(owner_path(conf),v)
 result=write_result(conf,'availability.json',{'status':'RECOVERED' if recovered else ('UP' if ok else 'UNAVAILABLE'),'http':h,'consecutiveFailures':v['failures'],'appId':x['Id'],'alert':not ok,'restartAttempted':recovered})
 if not ok:raise c.o.Refusal('READINESS_UNAVAILABLE_NO_BLIND_RESTART')
 return result

def units(conf):
 root=pathlib.Path(conf['root']);out=root/'service-units';c.need(not out.exists(),'UNITS_ALREADY_PREPARED');out.mkdir(mode=0o700)
 for p in [str(root),str(c.ROOT)]:c.need(re.fullmatch('[a-zA-Z0-9_./-]+',p),'UNIT_PATH_REQUIRES_SAFE_ABSOLUTE')
 prefix=conf['project'];base='[Unit]\nAfter=docker.service network-online.target\nWants=network-online.target\nRequires=docker.service\n\n[Service]\nType=oneshot\nUser=root\nUMask=0077\nNice=10\nIOSchedulingClass=idle\n'
 for action in ['backup','supervise']:
  unit=base+f'ExecStart=/usr/bin/python3 {c.ROOT}/operations.py --root {root} {action}\nTimeoutStartSec=infinity\n'
  c.text(out/(prefix+'-'+action+'.service'),unit)
  timer='[Unit]\nDescription=Onlink40 '+action+' (gated by host ownership)\n[Timer]\n'
  timer+=('OnCalendar=*-*-* 03:15:00 Europe/Moscow\nPersistent=true\n' if action=='backup' else 'OnBootSec=60s\nOnUnitInactiveSec=30s\n')
  timer+=f'Unit={prefix}-{action}.service\nAccuracySec=1s\n[Install]\nWantedBy=timers.target\n';c.text(out/(prefix+'-'+action+'.timer'),timer)
 print('UNITS_PREPARED_NOT_INSTALLED_OR_ENABLED')

def main():
 os.umask(0o077);a=argparse.ArgumentParser();a.add_argument('--root',required=True);a.add_argument('action',choices=['units','enable','disable','backup','supervise','status']);a.add_argument('--confirm-handover-complete');a.add_argument('--manual',action='store_true');v=a.parse_args()
 try:
  with c.context(v.root) as (conf,s):
   if v.action=='units':units(conf)
   elif v.action=='enable':enable(conf,s,v.confirm_handover_complete)
   elif v.action=='disable':c.disarm(conf,'operator-fence');print('AUTOSTART_DISABLED')
   elif v.action=='backup':make_backup(conf,s,v.manual)
   elif v.action=='supervise':supervise(conf,s)
   else:print(json.dumps({'owner':current_owner(conf).get('enabled',False),'phase':s['phase']}))
 except Exception as e:
  # Lock contention is visible, not evidence that the app died. No automatic retries here.
  if v.action=='supervise':print(json.dumps({'status':'SUPERVISION_REFUSED','reason':code(e),'alert':str(e)!='BACKUP_LOCK_BUSY'}),flush=True)
  raise
if __name__=='__main__':
 try:main()
 except Exception as e:print('OPERATIONS_REFUSED:'+code(e),file=sys.stderr);sys.exit(2)
