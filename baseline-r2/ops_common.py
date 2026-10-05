"""Reviewed cutover primitives. No database/MAX access; all subprocess output private.

Only stdlib. Linux fcntl is loaded lazily. Mutation entrypoints require the
inherited backup.lock from locked-session.py. No assert-based safety guards.
"""
import contextlib,contextvars,datetime,hashlib,json,os,pathlib,re,subprocess,sys,time,urllib.request,urllib.parse

DEADLINE=contextvars.ContextVar('operation_deadline',default=None)

class Refusal(Exception):pass
def need(ok,code):
 if not ok:raise Refusal(code)
def sha(b):return hashlib.sha256(b).hexdigest()
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def read_json(p):
 try:return json.loads(pathlib.Path(p).read_text(encoding='utf-8'))
 except (OSError,ValueError):raise Refusal('INVALID_JSON') from None
def settings(p):
 s=read_json(p)
 for k in ['install','prepared','backup_script','backup_lock','releases']:
  need(pathlib.Path(s[k]).is_absolute(),'ABSOLUTE_PATH_REQUIRED')
 need(set(s['images'])=={'old','main','reserve'},'IMAGE_ALLOWLIST_REQUIRED')
 for im in s['images'].values():
  need(bool(re.fullmatch(r'sha256:[0-9a-f]{64}',im['id'])),'INVALID_IMAGE')
  need(bool(re.fullmatch(r'[0-9a-f]{40}',im['revision'])),'INVALID_REVISION')
 need(len({v['id'] for v in s['images'].values()})==3,'DUPLICATE_IMAGE')
 return s
def command(args,timeout=10,allow_failure=False,pass_fds=(),env=None):
 if DEADLINE.get() is not None:
  remaining=DEADLINE.get()-time.monotonic();need(remaining>0,'OPERATION_DEADLINE')
  timeout=min(timeout,remaining)
 try:r=subprocess.run(args,capture_output=True,text=True,timeout=timeout,pass_fds=pass_fds,env=env)
 except (OSError,subprocess.TimeoutExpired):raise Refusal('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
 need(allow_failure or r.returncode==0,'COMMAND_FAILED')
 return r
def output(args,timeout=10):return command(args,timeout).stdout
def inspect(n,timeout=10):
 try:return json.loads(output(['docker','inspect',n],timeout))[0]
 except (ValueError,IndexError,KeyError):raise Refusal('INVALID_INSPECT') from None
def identity(c):
 return {'id':c['Id'],'image':c['Image'],'started':c['State']['StartedAt'],'restarts':c['RestartCount']}
def stopped_state(c):
 return None if c is None else {'identity':identity(c),'status':c['State']['Status'],'exit':c['State']['ExitCode'],'oom':c['State']['OOMKilled'],'running':c['State']['Running']}
def app(s):
 # Absence is established by a successful all-container inventory. A Docker
 # daemon/inspect failure never becomes permission to replace a container.
 rows=output(['docker','ps','-a','--format','{{json .}}'])
 names=[]
 for line in rows.splitlines():
  try:names.append(json.loads(line)['Names'])
  except (ValueError,KeyError):raise Refusal('INVALID_INVENTORY') from None
 return inspect(s['app']) if s['app'] in names else None
def image(s,i):
 matches=[(k,v) for k,v in s['images'].items() if v['id']==i]
 need(len(matches)==1,'IMAGE_NOT_APPROVED');name,v=matches[0]
 c=inspect(i)
 need(c['Id']==i and c['Os']=='linux' and c['Architecture']=='amd64','WRONG_IMAGE_PLATFORM')
 need(c['Config'].get('Labels',{}).get('org.opencontainers.image.revision')==v['revision'],'WRONG_IMAGE_REVISION')
 return name
def compose(s,p):
 try:return json.loads(output(['docker','compose','--project-directory',s['install'],'-p',s['project'],'-f',str(p),'config','--format','json']))
 except ValueError:raise Refusal('INVALID_COMPOSE') from None
def live_path(s):return pathlib.Path(s['install'])/'compose.yml'
def runtime(s):
 b=(pathlib.Path(s['install'])/'private/runtime.env').read_bytes()
 need(sha(b)==s['runtime_sha256'],'RUNTIME_CHANGED')
 return sha(b)
def config(s,p,expected_image,expected_hash=None):
 runtime(s);p=pathlib.Path(p);b=p.read_bytes()
 if expected_hash:need(sha(b)==expected_hash,'COMPOSE_CHANGED')
 c=compose(s,p);basepath=pathlib.Path(s['prepared'])/'compose-before.yml'
 need(sha(basepath.read_bytes())==s['baseline_config_sha256'],'BASELINE_CHANGED')
 base=compose(s,basepath)
 need(set(c['services'])==set(base['services'])=={'app'},'UNEXPECTED_SERVICES')
 need(c['services']['app']['image']==expected_image,'WRONG_COMPOSE_IMAGE')
 need(c['services']['app'].get('logging')=={'driver':'json-file','options':{'max-size':'20m','max-file':'5'}},'LOG_POLICY_CHANGED')
 c['services']['app'].pop('image');base['services']['app'].pop('image')
 need(c==base,'NON_IMAGE_CONFIG_CHANGED')
 return b,c
def no_other_app(s,allowed_id=None):
 _,c=config(s,live_path(s),compose(s,live_path(s))['services']['app']['image'])
 env=c['services']['app'].get('environment',{})
 token=env.get('BOT_TOKEN');need(isinstance(token,str) and bool(token),'BOT_IDENTITY_MISSING')
 for cid in output(['docker','ps','-q']).split():
  row=inspect(cid);e=dict(x.split('=',1) for x in row['Config'].get('Env',[]) if '=' in x)
  labels=row['Config'].get('Labels') or {}
  relevant=(e.get('BOT_TOKEN')==token or row.get('Name','').lstrip('/')==s['app'] or
   labels.get('com.docker.compose.project')==s['project'] and labels.get('com.docker.compose.service')=='app')
  need(not relevant or row['Id']==allowed_id,'SECOND_OR_RUNNING_APP')
def run_dir(s,name):
 need(bool(re.fullmatch(r'[a-zA-Z0-9_-]+',name)),'INVALID_RUN_NAME')
 root=pathlib.Path(s['prepared']).resolve();p=root/name
 need(p.is_dir() and not p.is_symlink() and p.resolve().parent==root,'INVALID_RUN_DIRECTORY')
 return p
def atomic(p,b,expected=None):
 p=pathlib.Path(p);t=p.with_name(p.name+'.ops-next')
 need(not p.is_symlink() and not t.exists(),'UNSAFE_OUTPUT')
 created=False
 try:
  with t.open('xb') as f:
   created=True;os.chmod(t,0o600);f.write(b);f.flush();os.fsync(f.fileno())
  if expected is not None:need(p.read_bytes()==expected,'CONCURRENT_FILE_CHANGE')
  os.replace(t,p);created=False
 finally:
  if created:t.unlink() # only the temp file created by this invocation
def save_new(p,value):
 need(not p.exists(),'RECEIPT_ALREADY_EXISTS')
 with p.open('x',encoding='utf-8') as f:
  os.chmod(p,0o600);json.dump(value,f);f.flush();os.fsync(f.fileno())
def require_lock(s):
 import fcntl
 need(pathlib.Path(s['backup_lock']).is_file() and not pathlib.Path(s['backup_lock']).is_symlink(),'LOCK_FILE_MISSING_OR_UNSAFE')
 try:fd=int(os.environ['INCIDENT_OPS_LOCK_FD']);info=os.fstat(fd);expected=os.stat(s['backup_lock'])
 except (KeyError,ValueError,OSError):raise Refusal('BACKUP_LOCK_REQUIRED') from None
 need((info.st_dev,info.st_ino)==(expected.st_dev,expected.st_ino),'WRONG_LOCK_FILE')
 # A separately opened descriptor must be excluded by the inherited lock.
 with open(s['backup_lock'],'rb') as probe:
  try:fcntl.flock(probe,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:return
  fcntl.flock(probe,fcntl.LOCK_UN)
 raise Refusal('BACKUP_LOCK_NOT_HELD')
@contextlib.contextmanager
def backup_lock(s):
 import fcntl
 need(pathlib.Path(s['backup_lock']).is_file() and not pathlib.Path(s['backup_lock']).is_symlink(),'LOCK_FILE_MISSING_OR_UNSAFE')
 with open(s['backup_lock'],'rb') as f:
  try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise Refusal('BACKUP_ALREADY_RUNNING') from None
  try:yield f.fileno()
  finally:fcntl.flock(f,fcntl.LOCK_UN)
def locked_session(s,args):
 need(bool(args),'COMMAND_REQUIRED')
 with backup_lock(s) as fd:
  env=dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd))
  # No detached/background child. On failure normal finally releases the lock.
  try:r=subprocess.run(args,env=env,pass_fds=(fd,),check=False)
  except OSError:raise Refusal('SESSION_COMMAND_FAILED') from None
  need(r.returncode==0,'SESSION_COMMAND_FAILED')
def clean(c):
 need(c is not None and not c['State']['Running'] and c['State']['Status']=='exited' and c['State']['ExitCode']==0 and not c['State']['OOMKilled'],'UNCLEAN_OR_RUNNING_APP')
def receipt(s,r,c):
 v=read_json(r/'stop-receipt.json')
 need(v.get('clean') is True and v.get('identity')==identity(c),'STOP_RECEIPT_MISMATCH')
 need(v['runtime']==runtime(s) and v['compose']==sha(live_path(s).read_bytes()),'STOP_RECEIPT_CONFIG_MISMATCH')
 return v
def stop(s,expected,name):
 require_lock(s);image(s,expected);r=run_dir(s,name)
 need(not (r/'stop-receipt.json').exists(),'RECEIPT_ALREADY_EXISTS')
 config(s,live_path(s),expected);c=app(s)
 need(c is not None and c['State']['Running'] and c['Image']==expected,'WRONG_OR_STOPPED_APP')
 need(c['HostConfig']['RestartPolicy']['Name']=='no','RESTART_POLICY_CHANGED')
 no_other_app(s,c['Id']);runtime_hash=runtime(s);cfg=sha(live_path(s).read_bytes());at=stamp()
 deadline=time.monotonic()+75
 command(['docker','kill','--signal=TERM',c['Id']],timeout=min(10,max(.001,deadline-time.monotonic())))
 while True:
  remaining=deadline-time.monotonic();need(remaining>0,'STOP_TIMEOUT_NO_SIGKILL')
  now=inspect(c['Id'],min(5,remaining));need(identity(now)==identity(c),'CONTAINER_REPLACED')
  if not now['State']['Running']:break
  time.sleep(min(1,max(0,deadline-time.monotonic())))
 clean(now);no_other_app(s)
 logs=command(['docker','logs','--since',at,c['Id']])
 need('graceful shutdown completed' in logs.stdout+logs.stderr,'NO_GRACEFUL_SHUTDOWN_CONFIRMATION')
 need(runtime(s)==runtime_hash and sha(live_path(s).read_bytes())==cfg,'CONFIG_CHANGED_DURING_STOP')
 save_new(r/'stop-receipt.json',{'clean':True,'identity':identity(c),'compose':cfg,'runtime':runtime_hash,'signalAt':at,'finishedAt':now['State']['FinishedAt']})
def apply(s,old,new,expected_sha,candidate,name):
 require_lock(s);role=image(s,new);need(role!='old','INCOMPATIBLE_ROLLBACK_FORBIDDEN');image(s,old)
 r=run_dir(s,name);need(not (r/'applied.json').exists(),'ALREADY_APPLIED')
 c=app(s);clean(c);need(c['Image']==old,'WRONG_INSTALLED_IMAGE');v=receipt(s,r,c)
 no_other_app(s);before,_=config(s,live_path(s),old,expected_sha)
 need(pathlib.Path(candidate).resolve()==pathlib.Path(s['images'][role]['candidate']).resolve(),'CANDIDATE_NOT_APPROVED')
 after,_=config(s,candidate,new,s['images'][role]['compose_sha256'])
 atomic(live_path(s),after,before)
 save_new(r/'applied.json',{'image':new,'compose':sha(after),'allowedContainer':stopped_state(c),'stopReceiptHash':sha((r/'stop-receipt.json').read_bytes())})
def wait_ready(s,expected):
 deadline=time.monotonic()+120;token=DEADLINE.set(deadline)
 try:return wait_ready_inner(s,expected,deadline)
 finally:DEADLINE.reset(token)
def wait_ready_inner(s,expected,deadline):
 image(s,expected);seen=None
 while time.monotonic()<deadline:
  remaining=deadline-time.monotonic()
  c=inspect(s['app'],min(3,remaining))
  need(c['Image']==expected,'WRONG_RUNNING_IMAGE')
  need(c['State']['Running'] and c['State']['Status']=='running','APP_NOT_RUNNING')
  url=urllib.parse.urlsplit(s['health_base']);need(url.scheme=='http' and url.hostname=='127.0.0.1' and url.port,'INVALID_HEALTH_ENDPOINT')
  ports=c['HostConfig'].get('PortBindings',{}).get('3000/tcp',[])
  need({'HostIp':'127.0.0.1','HostPort':str(url.port)} in ports,'HEALTH_PORT_NOT_OWNED_BY_APP')
  if seen is None:seen=identity(c);no_other_app(s,c['Id'])
  need(identity(c)==seen,'CONTAINER_REPLACED')
  ready=True
  for path in ['health','ready']:
   remaining=deadline-time.monotonic()
   if remaining<=0:ready=False;break
   try:
    with urllib.request.urlopen(s['health_base']+'/'+path,timeout=min(2,remaining)) as response:
     ready=ready and response.status==200
   except (OSError,TimeoutError):ready=False
  if ready:
   again=inspect(s['app'],min(3,max(.001,deadline-time.monotonic())))
   need(identity(again)==seen and again['State']['Running'],'CONTAINER_REPLACED_OR_STOPPED')
   no_other_app(s,again['Id']);return
  time.sleep(min(2,max(0,deadline-time.monotonic())))
 raise Refusal('READINESS_TIMEOUT_NO_RESTART')
def start(s,target,name):
 require_lock(s);role=image(s,target);need(role!='old','INCOMPATIBLE_ROLLBACK_FORBIDDEN')
 r=run_dir(s,name);v=read_json(r/'applied.json')
 need(v['image']==target and v['compose']==sha(live_path(s).read_bytes()),'APPLIED_CONFIG_MISMATCH')
 need(v['stopReceiptHash']==sha((r/'stop-receipt.json').read_bytes()),'STOP_RECEIPT_CHANGED')
 config(s,live_path(s),target);no_other_app(s);c=app(s)
 need(stopped_state(c)==v['allowedContainer'],'UNEXPECTED_CONTAINER')
 if c:need(not c['State']['Running'],'APP_STILL_RUNNING')
 attempt=r/('start-'+role+'.json');need(not attempt.exists(),'START_ALREADY_ATTEMPTED')
 record={'image':target,'compose':v['compose'],'stopReceiptHash':v['stopReceiptHash'],'at':stamp(),'ready':False,'result':'incomplete'}
 save_new(attempt,record)
 result=command(['docker','compose','-p',s['project'],'-f',str(live_path(s)),'up','-d','--no-deps','--no-build','--pull','never','app'],timeout=60,allow_failure=True)
 current=app(s)
 record.update(result='returned',returncode=result.returncode,observed=identity(current) if current else None)
 atomic(attempt,json.dumps(record).encode(),attempt.read_bytes())
 need(result.returncode==0,'CREATE_OR_START_FAILED')
 need(current is not None and current['Image']==target,'WRONG_STARTED_IMAGE')
 no_other_app(s,current['Id']);wait_ready(s,target)
 record['ready']=True;atomic(attempt,json.dumps(record).encode(),attempt.read_bytes())
def recover(s,old,new,expected_sha,name,ack):
 require_lock(s);need(ack=='reviewed-start-failure','REVIEW_REQUIRED')
 oldrole=image(s,old);newrole=image(s,new)
 need(oldrole in ['main','reserve'] and newrole in ['main','reserve'] and old!=new,'COMPATIBLE_RESERVE_REQUIRED')
 r=run_dir(s,name);v=read_json(r/'applied.json');a=read_json(r/('start-'+oldrole+'.json'))
 need(a['image']==v['image']==old and a['compose']==v['compose']==expected_sha,'START_ATTEMPT_MISMATCH')
 need(a['stopReceiptHash']==v['stopReceiptHash']==sha((r/'stop-receipt.json').read_bytes()),'STOP_RECEIPT_CHANGED')
 need(a['result']=='returned' and not a['ready'],'NOT_A_FAILED_START')
 age=(datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(a['at'])).total_seconds()
 need(0<=age<=300,'STALE_START_ATTEMPT')
 need(read_json(r/'stop-receipt.json').get('clean') is True,'NO_CLEAN_PREDECESSOR')
 before,_=config(s,live_path(s),old,expected_sha);no_other_app(s);c=app(s)
 need((identity(c) if c else None)==a['observed'],'START_CONTAINER_CHANGED')
 if c:
  need(not c['State']['Running'] and c['State']['Status'] in ['created','exited'] and not c['State']['OOMKilled'],'UNSAFE_START_FAILURE')
  need(c['State']['ExitCode']!=137,'UNCLEAN_START_FAILURE')
  need(c['Image'] in [old,read_json(r/'stop-receipt.json')['identity']['image']],'WRONG_FAILED_IMAGE')
 need(a['returncode']!=0 or c is not None and c['State']['ExitCode']!=0,'NO_FAILED_START_EVIDENCE')
 after,_=config(s,s['images'][newrole]['candidate'],new,s['images'][newrole]['compose_sha256'])
 atomic(live_path(s),after,before)
 v.update(image=new,compose=sha(after),allowedContainer=stopped_state(c))
 atomic(r/'applied.json',json.dumps(v).encode(),(r/'applied.json').read_bytes())
def metadata(s,oldrev,oldimage,newrev,newimage):
 require_lock(s);role=image(s,newimage);need(role in ['main','reserve'],'COMPATIBLE_IMAGE_REQUIRED')
 oldroles=[v for v in s['images'].values() if v['id']==oldimage and v['revision']==oldrev]
 need(len(oldroles)==1 and s['images'][role]['revision']==newrev,'METADATA_VERSION_MISMATCH')
 c=app(s);need(c is not None and c['State']['Running'] and c['Image']==newimage,'WRONG_RUNNING_IMAGE')
 no_other_app(s,c['Id']);config(s,live_path(s),newimage);wait_ready(s,newimage)
 p=pathlib.Path(s['backup_script']);original=p.read_bytes();text=original.decode();updated=text
 releases=pathlib.Path(s['releases']);need((releases/newrev/'project').is_dir(),'SOURCES_MISSING')
 pairs=[("REV = '"+oldrev+"'","REV = '"+newrev+"'"),("IMAGE = '"+oldimage+"'","IMAGE = '"+newimage+"'"),("copy_tree(Path('"+(releases/oldrev/'project').as_posix()+"'), stage / 'project')","copy_tree(Path('"+(releases/newrev/'project').as_posix()+"'), stage / 'project')")]
 for a,b in pairs:need(updated.count(a)==1,'UNEXPECTED_BACKUP_METADATA');updated=updated.replace(a,b,1)
 need(len(text.splitlines())==len(updated.splitlines()) and sum(a!=b for a,b in zip(text.splitlines(),updated.splitlines()))==3,'UNEXPECTED_METADATA_DIFF')
 try:compile(updated,str(p),'exec')
 except SyntaxError:raise Refusal('BACKUP_SYNTAX_INVALID') from None
 atomic(p,updated.encode(),original)
def cli(name):
 try:
  need(len(sys.argv)>=3 and sys.argv[1]=='--settings','SETTINGS_REQUIRED');s=settings(sys.argv[2]);args=sys.argv[3:]
  functions={'stop-app.py':(stop,2),'apply-config.py':(apply,5),'recover-config.py':(recover,5),'wait-ready.py':(wait_ready,1),'update-backup-metadata.py':(metadata,4),'start-app.py':(start,2)}
  if name=='locked-session.py':
   need(args and args[0]=='--','COMMAND_REQUIRED');locked_session(s,args[1:])
  else:
   fn,n=functions[name];need(len(args)==n,'ARGUMENT_COUNT');fn(s,*args)
  print('OPS_OK:'+name)
 except Refusal as e:print('OPS_REFUSED:'+str(e),file=sys.stderr);raise SystemExit(2)
 except Exception:print('OPS_REFUSED:UNEXPECTED_LOCAL_ERROR',file=sys.stderr);raise SystemExit(3)
