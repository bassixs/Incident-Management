"""Exact revision-4 entrypoints; real temporary files, simulated Docker/HTTP/flock/clock.
No subprocess escapes the simulator. No network or production resources.
"""
import contextlib,copy,importlib.util,io,json,os,pathlib,runpy,sys,tempfile,types,unittest
from unittest.mock import patch
ROOT=pathlib.Path(__file__).resolve().parents[1];REV=ROOT/'revision-4'
sys.path.insert(0,str(REV))
spec=importlib.util.spec_from_file_location('ops_common',REV/'ops_common.py');m=importlib.util.module_from_spec(spec);sys.modules['ops_common']=m;spec.loader.exec_module(m)
OLD='sha256:'+'1'*64;MAIN='sha256:'+'2'*64;RES='sha256:'+'3'*64

class Locks:
 LOCK_EX=2;LOCK_NB=4;LOCK_UN=8
 def __init__(self):self.owners={};self.external=False;self.closed=[]
 def flock(self,f,mode):
  fd=f if isinstance(f,int) else f.fileno();s=os.fstat(fd);key=(s.st_dev,s.st_ino)
  if mode==self.LOCK_UN:self.owners.pop(key,None);self.closed.append(fd);return
  if self.external or key in self.owners and self.owners[key]!=fd:raise BlockingIOError()
  self.owners[key]=fd
class Response:
 def __init__(self,status):self.status=status
 def __enter__(self):return self
 def __exit__(self,*a):pass
class Fixture:
 def __init__(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.now=0;self.calls=[];self.timeout=False;self.log=True
  self.http_status=200;self.http_cost=False;self.clone=None;self.inspect_failure=False;self.mode='ok';self.lock=Locks();self.children=[];self.generation=0
  self.s={'install':str(self.root/'install'),'prepared':str(self.root/'stage'),'backup_script':str(self.root/'backup.py'),'backup_lock':str(self.root/'backup.lock'),'releases':str(self.root/'releases'),'app':'synthetic-app','project':'synthetic-project','health_base':'http://127.0.0.1:3001','images':{}}
  pathlib.Path(self.s['backup_lock']).touch(mode=0o600)
  self.i=pathlib.Path(self.s['install']);self.p=pathlib.Path(self.s['prepared']);(self.i/'private').mkdir(parents=True);(self.p/'run').mkdir(parents=True)
  (self.i/'private/runtime.env').write_text('BOT_TOKEN=SYNTHETIC_NOT_A_REAL_TOKEN\n');self.s['runtime_sha256']=m.sha((self.i/'private/runtime.env').read_bytes())
  self.base={'services':{'app':{'image':OLD,'logging':{'driver':'json-file','options':{'max-size':'20m','max-file':'5'}},'environment':{'BOT_TOKEN':'SYNTHETIC_NOT_A_REAL_TOKEN'},'volumes':['synthetic-uploads']}}}
  (self.p/'compose-before.yml').write_text(json.dumps(self.base));(self.i/'compose.yml').write_text(json.dumps(self.base));self.s['baseline_config_sha256']=m.sha((self.i/'compose.yml').read_bytes())
  for n,k in enumerate(['old','main','reserve'],1):
   iid={1:OLD,2:MAIN,3:RES}[n];cfg=copy.deepcopy(self.base);cfg['services']['app']['image']=iid
   candidate=self.p/('compose-'+k+'.yml');candidate.write_text(json.dumps(cfg))
   self.s['images'][k]={'id':iid,'revision':str(n)*40,'candidate':str(candidate),'compose_sha256':m.sha(candidate.read_bytes())}
   (pathlib.Path(self.s['releases'])/(str(n)*40)/'project').mkdir(parents=True)
  self.settings=self.root/'settings.json';self.settings.write_text(json.dumps(self.s));self.c=self.container(OLD,'original',True)
  self.reset_backup()
 def reset_backup(self):
  src=(pathlib.Path(self.s['releases'])/('1'*40)/'project').as_posix()
  pathlib.Path(self.s['backup_script']).write_text("REV = '"+'1'*40+"'\nIMAGE = '"+OLD+"'\ndef copy_snapshot():\n copy_tree(Path('"+src+"'), stage / 'project')\n")
 def container(self,image,cid,running):
  return {'Id':cid,'Name':'/'+self.s['app'],'Image':image,'RestartCount':0,'State':{'StartedAt':'2026-01-01T00:00:00Z','FinishedAt':'2026-01-01T00:01:00Z','Running':running,'Status':'running' if running else 'exited','ExitCode':0,'OOMKilled':False},'HostConfig':{'RestartPolicy':{'Name':'no'},'PortBindings':{'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':'3001'}]}},'Config':{'Env':['BOT_TOKEN=SYNTHETIC_NOT_A_REAL_TOKEN'],'Labels':{'com.docker.compose.project':self.s['project'],'com.docker.compose.service':'app'}}}
 def http(self,url,timeout):
  if self.http_cost:self.now+=timeout;raise OSError('SYNTHETIC_SECRET_HTTP_ERROR')
  return Response(self.http_status)
 def sleep(self,t):self.now+=t
 def subprocess(self,args,**kw):
  self.calls.append((args,kw));rc=0;out='';err=''
  if args==['synthetic-child-failure']:rc=17;err='SYNTHETIC_SECRET_STDERR'
  elif args==['synthetic-child-exception']:raise OSError('SYNTHETIC_SECRET_FAILURE')
  elif args and args[0]=='synthetic-execute':
   with patch.dict(os.environ,kw['env']):rc,out=self.cli(*args[1:])
  elif args[:2]==['docker','inspect']:
   name=args[2]
   if self.inspect_failure is True or self.inspect_failure=='app' and name not in [OLD,MAIN,RES]:return types.SimpleNamespace(returncode=125,stdout='',stderr='SYNTHETIC_SECRET_DAEMON')
   if name in [OLD,MAIN,RES]:
    role=next(k for k,v in self.s['images'].items() if v['id']==name)
    row={'Id':name,'Os':'linux','Architecture':'amd64','Config':{'Labels':{'org.opencontainers.image.revision':self.s['images'][role]['revision']}}}
   else:
    row=next((c for c in [self.c,self.clone] if c and name in [c['Id'],c['Name'].lstrip('/')]),None)
    if row is None:rc=1
   out=json.dumps([row]) if row else ''
  elif args[:3]==['docker','ps','-a']:
   out='\n'.join(json.dumps({'Names':c['Name'].lstrip('/')}) for c in [self.c,self.clone] if c)
  elif args[:3]==['docker','ps','-q']:out='\n'.join(c['Id'] for c in [self.c,self.clone] if c and c['State']['Running'])
  elif args[:2]==['docker','compose']:
   p=pathlib.Path(args[args.index('-f')+1])
   if 'config' in args:out=p.read_text()
   elif 'up' in args:
    self.children.append(args)
    if any(c and c['State']['Running'] for c in [self.c,self.clone]):raise AssertionError('SECOND_INSTANCE_WOULD_START')
    self.generation+=1;target=json.loads(p.read_text())['services']['app']['image']
    if self.mode=='missing':self.c=None;rc=1
    elif self.mode=='unchanged':rc=1
    else:
     self.c=self.container(target,'new-'+str(self.generation),self.mode=='ok')
     if self.mode=='created':self.c['State']['Status']='created';rc=1
     if self.mode=='exit1':self.c['State']['ExitCode']=1
    err='SYNTHETIC_SECRET_COMPOSE_ERROR' if rc else ''
   else:raise AssertionError('UNMOCKED_COMPOSE')
  elif args[:2]==['docker','kill']:
   if args[2]!='--signal=TERM':raise AssertionError('FORCE_SIGNAL')
   if not self.timeout:self.c['State'].update(Running=False,Status='exited')
  elif args[:2]==['docker','logs']:out='graceful shutdown completed' if self.log else 'ordinary log'
  else:raise AssertionError('UNMOCKED_COMMAND:'+str(args))
  return types.SimpleNamespace(returncode=rc,stdout=out,stderr=err)
 @contextlib.contextmanager
 def patched(self):
  with patch.object(m.subprocess,'run',self.subprocess),patch.object(m.urllib.request,'urlopen',self.http),patch.object(m.time,'monotonic',lambda:self.now),patch.object(m.time,'sleep',self.sleep),patch.dict(sys.modules,{'fcntl':self.lock}):yield
 @contextlib.contextmanager
 def locked(self):
  with m.backup_lock(self.s) as fd:
   with patch.dict(os.environ,{'INCIDENT_OPS_LOCK_FD':str(fd)}):yield
 def cli(self,script,*args):
  buf=io.StringIO()
  with patch.object(sys,'argv',[script,'--settings',str(self.settings),*args]),contextlib.redirect_stdout(buf),contextlib.redirect_stderr(buf):
   try:runpy.run_path(str(REV/script),run_name='__main__');code=0
   except SystemExit as e:code=e.code
  return code,buf.getvalue()
 def stop_apply(self):
  self.ok('stop-app.py',OLD,'run')
  self.ok('apply-config.py',OLD,MAIN,self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run')
 def ok(self,*args):
  code,text=self.cli(*args)
  if code:raise AssertionError(text)
 def fail(self,marker,*args):
  code,text=self.cli(*args)
  if code!=2 or marker not in text:raise AssertionError((code,text,marker))
  if 'SYNTHETIC_SECRET' in text or 'SYNTHETIC_NOT_A_REAL_TOKEN' in text:raise AssertionError('SECRET_LEAK')
 def close(self):self.tmp.cleanup()

class Revision(unittest.TestCase):
 def setUp(self):
  self.f=Fixture();self.stack=contextlib.ExitStack();self.stack.enter_context(self.f.patched());self.stack.enter_context(self.f.locked())
 def tearDown(self):self.stack.close();self.f.close()
 def test_stop_clean_receipt_and_only_term(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');self.assertFalse(f.c['State']['Running']);self.assertTrue((f.p/'run/stop-receipt.json').exists());self.assertEqual([a for a,k in f.calls if a[:2]==['docker','kill']],[['docker','kill','--signal=TERM','original']])
 def test_stop_timeout_no_sigkill_no_receipt(self):
  f=self.f;f.timeout=True;f.fail('STOP_TIMEOUT_NO_SIGKILL','stop-app.py',OLD,'run');self.assertEqual(f.now,75);self.assertTrue(f.c['State']['Running']);self.assertFalse((f.p/'run/stop-receipt.json').exists())
 def test_stop_wrong_image(self):
  f=self.f;f.fail('WRONG_COMPOSE_IMAGE','stop-app.py',MAIN,'run');self.assertFalse(any(a[:2]==['docker','kill'] for a,k in f.calls))
 def test_stop_wrong_container_image(self):
  f=self.f;f.c['Image']=MAIN;f.fail('WRONG_OR_STOPPED_APP','stop-app.py',OLD,'run');self.assertFalse(any(a[:2]==['docker','kill'] for a,k in f.calls))
 def test_stop_oom_refused(self):
  f=self.f;f.c['State']['OOMKilled']=True;f.fail('UNCLEAN_OR_RUNNING_APP','stop-app.py',OLD,'run')
 def test_stop_exit137_refused(self):
  f=self.f;f.c['State']['ExitCode']=137;f.fail('UNCLEAN_OR_RUNNING_APP','stop-app.py',OLD,'run')
 def test_stop_missing_graceful_log(self):
  f=self.f;f.log=False;f.fail('NO_GRACEFUL','stop-app.py',OLD,'run')
 def test_stop_restart_policy_refused(self):
  f=self.f;f.c['HostConfig']['RestartPolicy']['Name']='always';f.fail('RESTART_POLICY_CHANGED','stop-app.py',OLD,'run')
 def test_stop_changed_configuration_before_signal(self):
  f=self.f;p=f.i/'compose.yml';c=json.loads(p.read_text());c['services']['app']['volumes']=['unexpected'];p.write_text(json.dumps(c));f.fail('NON_IMAGE_CONFIG_CHANGED','stop-app.py',OLD,'run');self.assertFalse(any(a[:2]==['docker','kill'] for a,k in f.calls))
 def test_apply_running_refused(self):
  f=self.f;f.fail('UNCLEAN_OR_RUNNING_APP','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],f.s['images']['main']['candidate'],'run')
 def test_apply_wrong_hash_refused(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');f.fail('COMPOSE_CHANGED','apply-config.py',OLD,MAIN,'0'*64,f.s['images']['main']['candidate'],'run')
 def test_apply_changed_runtime(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');(f.i/'private/runtime.env').write_text('changed');f.fail('RUNTIME_CHANGED','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],f.s['images']['main']['candidate'],'run')
 def test_apply_nonimage_change_refused(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');p=pathlib.Path(f.s['images']['main']['candidate']);c=json.loads(p.read_text());c['services']['app']['volumes']=['wrong'];p.write_text(json.dumps(c));f.s['images']['main']['compose_sha256']=m.sha(p.read_bytes());f.settings.write_text(json.dumps(f.s));f.fail('NON_IMAGE_CONFIG_CHANGED','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],str(p),'run')
 def test_apply_missing_receipt(self):
  f=self.f;f.c['State'].update(Running=False,Status='exited');f.fail('INVALID_JSON','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],f.s['images']['main']['candidate'],'run')
 def test_apply_unrelated_receipt(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');p=f.p/'run/stop-receipt.json';v=json.loads(p.read_text());v['identity']['id']='other';p.write_text(json.dumps(v));f.fail('STOP_RECEIPT_MISMATCH','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],f.s['images']['main']['candidate'],'run')
 def test_apply_duplicate_under_other_project_same_token(self):
  f=self.f;f.ok('stop-app.py',OLD,'run');f.clone=f.container(OLD,'other',True);f.clone['Name']='/other-project-app';f.clone['Config']['Labels']={};f.fail('SECOND_OR_RUNNING_APP','apply-config.py',OLD,MAIN,f.s['baseline_config_sha256'],f.s['images']['main']['candidate'],'run');self.assertEqual(json.loads((f.i/'compose.yml').read_text())['services']['app']['image'],OLD)
 def test_lock_required(self):
  f=self.f
  with patch.dict(os.environ,{},clear=True):f.fail('BACKUP_LOCK_REQUIRED','stop-app.py',OLD,'run')
 def test_start_success(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');self.assertTrue(json.loads((f.p/'run/start-main.json').read_text())['ready']);self.assertEqual(len(f.children),1)
 def test_start_duplicate_invocation(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');f.fail('SECOND_OR_RUNNING_APP','start-app.py',MAIN,'run');self.assertEqual(len(f.children),1)
 def test_start_other_instance_appeared(self):
  f=self.f;f.stop_apply();f.clone=f.container(MAIN,'other',True);f.clone['Name']='/other';f.fail('SECOND_OR_RUNNING_APP','start-app.py',MAIN,'run');self.assertFalse(f.children)
 def test_start_unclean_state_after_apply_refused(self):
  f=self.f;f.stop_apply();f.c['State']['ExitCode']=137;f.fail('UNEXPECTED_CONTAINER','start-app.py',MAIN,'run');self.assertFalse(f.children)
 def test_start_restarted_predecessor_refused(self):
  f=self.f;f.stop_apply();f.c['RestartCount']=1;f.fail('UNEXPECTED_CONTAINER','start-app.py',MAIN,'run');self.assertFalse(f.children)
 def failed_start(self,mode):
  f=self.f;f.stop_apply();f.mode=mode
  expected='APP_NOT_RUNNING' if mode=='exit1' else 'CREATE_OR_START_FAILED'
  f.fail(expected,'start-app.py',MAIN,'run');return f
 def recovery(self,f):
  f.ok('recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
  f.mode='ok';f.ok('start-app.py',RES,'run');self.assertEqual(f.c['Image'],RES);self.assertEqual(len(f.children),2)
 def test_create_failure_missing_then_reserve(self):self.recovery(self.failed_start('missing'))
 def test_create_failure_preserved_old_then_reserve(self):self.recovery(self.failed_start('unchanged'))
 def test_create_failure_created_then_reserve(self):self.recovery(self.failed_start('created'))
 def test_start_exits_one_then_reserve(self):self.recovery(self.failed_start('exit1'))
 def test_recover_daemon_failure_is_not_absence(self):
  f=self.failed_start('created');f.inspect_failure='app';before=(f.i/'compose.yml').read_bytes();f.fail('COMMAND_FAILED','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure');self.assertEqual(before,(f.i/'compose.yml').read_bytes())
 def test_recover_second_project_instance_refused(self):
  f=self.failed_start('created');f.clone=f.container(OLD,'other',True);f.clone['Name']='/unrelated-name';f.clone['Config']['Labels']={};f.fail('SECOND_OR_RUNNING_APP','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_unknown_start_result_refused(self):
  f=self.failed_start('created');p=f.p/'run/start-main.json';v=json.loads(p.read_text());v['result']='incomplete';p.write_text(json.dumps(v));f.fail('NOT_A_FAILED_START','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_receipt_tampering(self):
  f=self.failed_start('created');p=f.p/'run/stop-receipt.json';p.write_text('{}');f.fail('STOP_RECEIPT_CHANGED','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_changed_compose_refused(self):
  f=self.failed_start('created');p=f.i/'compose.yml';p.write_text(p.read_text()+' ');f.fail('COMPOSE_CHANGED','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_no_start_evidence(self):
  f=self.f;f.stop_apply();f.fail('INVALID_JSON','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_unrelated_container(self):
  f=self.failed_start('created');f.c['Id']='foreign';f.fail('START_CONTAINER_CHANGED','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_successful_start_forbidden(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');f.fail('NOT_A_FAILED_START','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_running_refused(self):
  f=self.failed_start('created');f.c['State'].update(Running=True,Status='running');f.fail('SECOND_OR_RUNNING_APP','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_oom_refused(self):
  f=self.failed_start('exit1');f.c['State']['OOMKilled']=True;f.fail('UNSAFE_START_FAILURE','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_137_refused(self):
  f=self.failed_start('exit1');f.c['State']['ExitCode']=137;f.fail('UNCLEAN_START_FAILURE','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_old_incompatible_forbidden(self):
  f=self.failed_start('created');f.fail('COMPATIBLE_RESERVE_REQUIRED','recover-config.py',MAIN,OLD,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_recover_stale_attempt(self):
  f=self.failed_start('created');p=f.p/'run/start-main.json';v=json.loads(p.read_text());v['at']='2000-01-01T00:00:00+00:00';p.write_text(json.dumps(v));f.fail('STALE_START_ATTEMPT','recover-config.py',MAIN,RES,f.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
 def test_wait_timeout_bounded_no_restart(self):
  f=self.f;f.http_status=503;f.fail('READINESS_TIMEOUT','wait-ready.py',OLD);self.assertEqual(f.now,120);self.assertFalse(f.children);self.assertFalse(any(a[:2]==['docker','kill'] for a,k in f.calls))
 def test_wait_slow_http_bounded(self):
  f=self.f;f.http_cost=True;f.fail('READINESS_TIMEOUT','wait-ready.py',OLD);self.assertLessEqual(f.now,120)
 def test_wait_wrong_image(self):self.f.fail('WRONG_RUNNING_IMAGE','wait-ready.py',MAIN)
 def test_wait_stopped_with_healthy_other_listener(self):
  f=self.f;f.c['State'].update(Running=False,Status='exited');f.fail('APP_NOT_RUNNING','wait-ready.py',OLD)
 def test_wait_wrong_port(self):
  f=self.f;f.c['HostConfig']['PortBindings']['3000/tcp'][0]['HostPort']='3999';f.fail('HEALTH_PORT_NOT_OWNED','wait-ready.py',OLD)
 def test_wait_second_instance_refused(self):
  f=self.f;f.clone=f.container(MAIN,'other',True);f.clone['Name']='/another';f.fail('SECOND_OR_RUNNING_APP','wait-ready.py',OLD)
 def test_wait_replaced_container_refused(self):
  f=self.f
  def replace_on_http(url,timeout):f.c['Id']='replacement';return Response(200)
  with patch.object(m.urllib.request,'urlopen',replace_on_http):f.fail('CONTAINER_REPLACED_OR_STOPPED','wait-ready.py',OLD)
 def test_metadata_success_changes_exact_three_lines(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');p=pathlib.Path(f.s['backup_script']);before=p.read_text();f.ok('update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN);self.assertEqual(sum(a!=b for a,b in zip(before.splitlines(),p.read_text().splitlines())),3)
 def test_metadata_mismatched_old_unchanged(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');p=pathlib.Path(f.s['backup_script']);p.write_text(p.read_text().replace("REV = '"+'1'*40,"REV = '"+'3'*40));before=p.read_bytes();f.fail('UNEXPECTED_BACKUP_METADATA','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN);self.assertEqual(p.read_bytes(),before)
 def test_metadata_wrong_active_image(self):self.f.fail('WRONG_RUNNING_IMAGE','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
 def test_metadata_duplicate_literal_refused(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');p=pathlib.Path(f.s['backup_script']);p.write_text(p.read_text()+"\nREV = '"+'1'*40+"'\n");before=p.read_bytes();f.fail('UNEXPECTED_BACKUP_METADATA','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN);self.assertEqual(before,p.read_bytes())
 def test_metadata_missing_source_refused(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');(pathlib.Path(f.s['releases'])/('2'*40)/'project').rmdir();f.fail('SOURCES_MISSING','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
 def test_metadata_wrong_revision_refused(self):self.f.fail('METADATA_VERSION_MISMATCH','update-backup-metadata.py','1'*40,OLD,'3'*40,MAIN)
 def test_metadata_second_update_refused(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');args=('update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN);f.ok(*args);f.fail('UNEXPECTED_BACKUP_METADATA',*args)
 def test_metadata_without_inherited_lock_refused(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run')
  with patch.dict(os.environ,{},clear=True):f.fail('BACKUP_LOCK_REQUIRED','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
 def test_roundtrip_main_reserve_main_preserves_sentinels(self):
  f=self.f;data=f.root/'protected-data.json';data.write_text(json.dumps({'FAILED':8,'database':'synthetic','uploads':['synthetic-file']}));before=data.read_bytes()
  f.stop_apply();f.ok('start-app.py',MAIN,'run');f.ok('update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
  for name,old,new,oldrev,newrev,role in [('reserve-run',MAIN,RES,'2'*40,'3'*40,'reserve'),('main-run',RES,MAIN,'3'*40,'2'*40,'main')]:
   (f.p/name).mkdir();f.ok('stop-app.py',old,name);h=m.sha((f.i/'compose.yml').read_bytes());f.ok('apply-config.py',old,new,h,f.s['images'][role]['candidate'],name);f.ok('start-app.py',new,name);f.ok('update-backup-metadata.py',oldrev,old,newrev,new)
  self.assertEqual(data.read_bytes(),before);self.assertEqual(len(f.children),3)
 def test_no_secrets_in_cli_failure(self):
  f=self.f;f.inspect_failure=True;f.fail('COMMAND_FAILED','wait-ready.py',OLD)
 def test_protected_database_and_no_forbidden_commands(self):
  f=self.f;f.stop_apply();f.ok('start-app.py',MAIN,'run');f.ok('update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
  for args,_ in f.calls:
   self.assertFalse(set(args)&{'restart','rm','prune','psql','pg_restore','build','pull','exec','SIGKILL'})

class LockRelease(unittest.TestCase):
 def test_missing_lock_refused_without_creating_replacement(self):
  f=Fixture()
  try:
   p=pathlib.Path(f.s['backup_lock']);p.unlink()
   with f.patched():f.fail('LOCK_FILE_MISSING_OR_UNSAFE','locked-session.py','--','synthetic-child-failure')
   self.assertFalse(p.exists());self.assertFalse(f.calls)
  finally:f.close()
 def test_stop_timeout_releases_session_lock(self):
  f=Fixture()
  try:
   f.timeout=True
   with f.patched():f.fail('SESSION_COMMAND_FAILED','locked-session.py','--','synthetic-execute','stop-app.py',OLD,'run')
   self.assertFalse(f.lock.owners);self.assertTrue(f.c['State']['Running']);self.assertEqual(f.now,75)
  finally:f.close()
 def test_metadata_failure_releases_session_lock(self):
  f=Fixture()
  try:
   with f.patched():f.fail('SESSION_COMMAND_FAILED','locked-session.py','--','synthetic-execute','update-backup-metadata.py','1'*40,OLD,'2'*40,MAIN)
   self.assertFalse(f.lock.owners)
  finally:f.close()
 def test_session_nonzero_releases_lock_and_fd(self):
  f=Fixture()
  try:
   with f.patched():f.fail('SESSION_COMMAND_FAILED','locked-session.py','--','synthetic-child-failure')
   self.assertFalse(f.lock.owners)
   with self.assertRaises(OSError):os.fstat(f.lock.closed[-1])
  finally:f.close()
 def test_session_exception_releases_lock(self):
  f=Fixture()
  try:
   with f.patched():f.fail('SESSION_COMMAND_FAILED','locked-session.py','--','synthetic-child-exception')
   self.assertFalse(f.lock.owners)
  finally:f.close()
 def test_concurrent_session_refused_before_child(self):
  f=Fixture()
  try:
   with f.patched(),f.locked():f.fail('BACKUP_ALREADY_RUNNING','locked-session.py','--','synthetic-child-failure')
   self.assertFalse(f.calls)
  finally:f.close()
 def test_existing_backup_excludes_session(self):
  f=Fixture()
  try:
   f.lock.external=True
   with f.patched():f.fail('BACKUP_ALREADY_RUNNING','locked-session.py','--','synthetic-child-failure')
   self.assertFalse(f.calls)
  finally:f.close()

if __name__=='__main__':unittest.main(verbosity=2)
