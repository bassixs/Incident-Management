"""Clean-host handover controller. No old upgrade receipts, no migrations, no MAX writes.
Private state is write-ahead. Every mutating operation uses one inherited-independent flock.
"""
import argparse,contextlib,datetime,fcntl,hashlib,json,os,pathlib,re,secrets,shutil,subprocess,sys,tarfile,time,urllib.request
ROOT=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT/'reviewed'))
import ops_common as o,migration_guard as mg
from snapshot_exporter import Exporter
from data_stream import receive,report
MAIN='c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a'
RESERVE='3c5c38b0f6477d5124593406f09f3af4c2db0c12'
IMAGES={'main':('sha256:a3001d85f28e396c201b3ed09cb6acc9043c1c2cd1bbed3cbe70c46c067af5fb','sha256:c5364eeb7178aafbf0c2e2243308753fcaaf173a4c7391fae7eb9b12177a41e0',MAIN),'reserve':('sha256:2e4a8fbe1c97a51382f9f5c29c85643d234d269b7d0fcc233c008e9f2d56e7d5','sha256:296ab9b7658d389102dce8e4234b95679b6fc49880d9e21d3e6dc31bd905d233',RESERVE)}
def need(v,code):
 if not v:raise o.Refusal(code)
def stamp():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha(p):
 with pathlib.Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def run(a,timeout=30,input=None):
 try:r=subprocess.run([str(x) for x in a],input=input,capture_output=True,timeout=timeout)
 except (OSError,subprocess.TimeoutExpired):raise o.Refusal('COMMAND_UNKNOWN_RESULT') from None
 need(r.returncode==0,'COMMAND_FAILED');return r.stdout.decode().strip()
def inspect(n):return json.loads(run(['docker','inspect',n]))[0]
def save(p,x):
 p=pathlib.Path(p);t=p.with_name(p.name+'.next');need(not t.exists() and not t.is_symlink(),'PARTIAL_RECORD_REVIEW')
 with t.open('x',encoding='utf8') as f:os.chmod(t,0o600);json.dump(x,f);f.flush();os.fsync(f.fileno())
 os.replace(t,p)
 fd=os.open(p.parent,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def text(p,s):
 p=pathlib.Path(p);need(not p.exists(),'FILE_ALREADY_EXISTS')
 with p.open('x') as f:os.chmod(p,0o600);f.write(s)
def load(p):return json.loads(pathlib.Path(p).read_text())
def envread(p):
 d={}
 for line in pathlib.Path(p).read_text().splitlines():
  if not line.strip() or line.lstrip().startswith('#'):continue
  need('=' in line,'ENV_FORMAT');k,v=line.split('=',1);need(k not in d,'DUPLICATE_ENV_KEY');d[k]=v
 return d
def app(c):
 ids=run(['docker','ps','-aq']).split()
 for cid in ids:
  x=inspect(cid)
  if x['Name'].lstrip('/')==c['project']+'-app':return x
 return None
def none_running(c,allowed=None):
 token=envread(pathlib.Path(c['root'])/'private/runtime.env').get('BOT_TOKEN') if (pathlib.Path(c['root'])/'private/runtime.env').exists() else None
 for cid in run(['docker','ps','-q']).split():
  x=inspect(cid);e=dict(v.split('=',1) for v in x['Config'].get('Env',[]) if '=' in v)
  if x['Name'].lstrip('/')==c['project']+'-app' or (token and e.get('BOT_TOKEN')==token):need(x['Id']==allowed,'ANOTHER_APP_RUNNING')
def checked_image(role,iid):
 x=inspect(iid);need(x['Id'] in IMAGES[role][:2] and x['Config'].get('Labels',{}).get('org.opencontainers.image.revision')==IMAGES[role][2] and x['Architecture']=='amd64' and x['Os']=='linux','WRONG_APPLICATION_IMAGE');return x['Id']
def pg(c):return c['project']+'-postgres'
def psql(c,sql):return run(['docker','exec','-i',pg(c),'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','onlink_admin','-d','onlink40'],input=sql.encode())
def node(c,script,env='probe.env',network=None):
 return ['docker','run','--rm','-i','--network',network or c['project']+'_db','--cpus','0.5','--memory','384m','--pids-limit','128','--env-file',str(pathlib.Path(c['root'])/'private'/env),'--mount',f'type=bind,src={ROOT / "reviewed"},dst=/ops,readonly','--entrypoint','node',c['images']['main'],'/ops/'+script]
def schema(c):
 v=json.loads(run(node(c,'schema-probe.cjs'),30));need(mg.schema_matches(v['schema'],load(ROOT/'schema-expectations.json')['new']),'SCHEMA_NOT_EXACT_NEW');return v['identity']
def fingerprint(c,d):
 d=pathlib.Path(d);need(not d.exists(),'NEW_SNAPSHOT_DIRECTORY_REQUIRED');d.mkdir(mode=0o700)
 with Exporter(node(c,'data-snapshot.cjs')+['--export'],d) as e:
  f=e.read_json('snapshot',30);need(bool(re.fullmatch('[0-9A-F-]+',f.get('snapshot',''))),'SNAPSHOT_INVALID');v=receive(e,d/'data.sqlite');e.finish()
 save(d/'data.json',v);return d/'data.json'
def compose(c,role,command):return run(['docker','compose','--project-name',c['project'],'-f',str(pathlib.Path(c['root'])/(role+'.compose.json')),*command],120)
def verify_files(root,expected):
 root=pathlib.Path(root);actual={}
 for f in root.rglob('*'):
  need(not f.is_symlink(),'SYMLINK_STORAGE')
  if f.is_file():actual[f.relative_to(root).as_posix()]=sha(f)
 need(actual==expected,'FILES_MISMATCH')
def untar(archive,dest,expected=None):
 dest=pathlib.Path(dest);need(dest.is_dir() and not any(dest.iterdir()),'EMPTY_EXTRACT_DESTINATION_REQUIRED')
 seen=set()
 with tarfile.open(archive,'r:gz') as t:
  for m in t:
   rel=pathlib.PurePosixPath(m.name);need(m.isfile() and not rel.is_absolute() and '..' not in rel.parts and m.name not in seen,'UNSAFE_ARCHIVE_ENTRY');seen.add(m.name)
   if expected is not None:need(m.name in expected,'UNEXPECTED_FILE')
   p=dest/rel;p.parent.mkdir(parents=True,exist_ok=True)
   with t.extractfile(m) as src,p.open('xb') as out:os.chmod(p,0o600);shutil.copyfileobj(src,out)
 if expected is not None:verify_files(dest,expected)
def environment(c,b):
 root=pathlib.Path(c['root']);cfg=root/'imported-config';cfg.mkdir(mode=0o700);untar(b/'configuration.tar.gz',cfg)
 need(set(x.name for x in cfg.iterdir())=={'runtime.env','compose.yml'},'CONFIG_ARCHIVE_SET')
 e=envread(cfg/'runtime.env');need(e.get('BOT_TOKEN') and e.get('MEDIA_STORAGE','local')=='local','LOCAL_STORAGE_TOKEN_REQUIRED')
 # Actual source policy can be a Compose override, not runtime.env.
 before=load(b/'backup.json');need(before['phase']=='new','NEW_SCHEMA_BACKUP_REQUIRED')
 e.update(DATABASE_URL=envread(root/'private/app-db.env')['DATABASE_URL'],WEBHOOK_URL='https://'+c['domain']+e.get('WEBHOOK_PATH','/webhook/max'),WEBHOOK_AUTO_REGISTER='false',INCIDENT_SLA_POLICY='WORKING_HOURS_V1',MEDIA_LOCAL_PATH='/app/data/uploads',NODE_EXTRA_CA_CERTS='/etc/ssl/max/russian-trusted-ca.pem',BOT_MODE='webhook',HTTP_HOST='0.0.0.0',HTTP_PORT='3000')
 text(root/'private/runtime.env',''.join(k+'='+v+'\n' for k,v in e.items()))
def init(args):
 root=pathlib.Path(args.root);need(root.is_absolute() and not root.is_symlink() and (not root.exists() or not any(root.iterdir())),'NEW_EMPTY_ROOT_REQUIRED');need(re.fullmatch('[a-zA-Z0-9.-]+',args.domain) and '.' in args.domain,'DOMAIN_INVALID')
 need(os.uname().machine in ['x86_64','amd64'],'AMD64_REQUIRED');root.mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(root,0o700)
 for n in ['private','pgdata','uploads','caddy-data','caddy-config','state','backups']: (root/n).mkdir(mode=0o700)
 (root/'backup.lock').touch(mode=0o600)
 images={r:checked_image(r,IMAGES[r][0] if run(['docker','image','ls','-q','--no-trunc']).find(IMAGES[r][0])>=0 else IMAGES[r][1]) for r in IMAGES}
 for iid in [args.pg_image,args.caddy_image]:
  x=inspect(iid);need(re.fullmatch('sha256:[0-9a-f]{64}',iid) and x['Id']==iid and x['Architecture']=='amd64','EXACT_INFRA_IMAGE_REQUIRED')
 need(run(['docker','run','--rm','--network','none','--entrypoint','postgres',args.pg_image,'--version']).startswith('postgres (PostgreSQL) 16.'),'POSTGRES16_REQUIRED')
 c={'format':'clean-host-v1','root':str(root),'domain':args.domain,'project':'onlink40-'+secrets.token_hex(4),'images':images,'postgresImage':args.pg_image,'caddyImage':args.caddy_image,'challenge':secrets.token_hex(16),'dockerRoot':json.loads(run(['docker','info','--format','{{json .DockerRootDir}}'])),'port':args.port,'httpPort':args.http_port,'httpsPort':args.https_port}
 pw=secrets.token_hex(32);app_pw=secrets.token_hex(32)
 text(root/'private/postgres.env','POSTGRES_USER=onlink_admin\nPOSTGRES_PASSWORD='+pw+'\nPOSTGRES_DB=onlink40\n')
 text(root/'private/probe.env','DATABASE_URL=postgresql://onlink_admin:'+pw+'@postgres:5432/onlink40\n')
 text(root/'private/app-db.env','DATABASE_URL=postgresql://onlink_app:'+app_pw+'@postgres:5432/onlink40\n')
 text(root/'private/bootstrap.sql',"CREATE ROLE onlink_app LOGIN NOSUPERUSER PASSWORD '"+app_pw+"';\nALTER DATABASE onlink40 OWNER TO onlink_app;\nALTER SCHEMA public OWNER TO onlink_app;\n")
 shutil.copyfile(ROOT/'russian-trusted-ca.pem',root/'private/russian-trusted-ca.pem');os.chmod(root/'private/russian-trusted-ca.pem',0o644)
 log={'driver':'json-file','options':{'max-size':'20m','max-file':'5'}}
 def bind(src,target,ro=False):return {'type':'bind','source':str(root/src),'target':target,'read_only':ro,'bind':{'create_host_path':False}}
 net={'db':{'name':c['project']+'_db','internal':True},'front':{'name':c['project']+'_front'}}
 infra={'services':{'postgres':{'image':c['postgresImage'],'container_name':pg(c),'pull_policy':'never','restart':'unless-stopped','env_file':[str(root/'private/postgres.env')],'networks':{'db':{'aliases':['postgres']}},'volumes':[bind('pgdata','/var/lib/postgresql/data')],'logging':log},'caddy':{'image':c['caddyImage'],'container_name':c['project']+'-caddy','pull_policy':'never','restart':'unless-stopped','networks':['front'],'ports':[f'{args.http_port}:80',f'{args.https_port}:443'],'volumes':[bind('Caddyfile','/etc/caddy/Caddyfile',True),bind('caddy-data','/data'),bind('caddy-config','/config')],'logging':log}},'networks':net}
 text(root/'Caddyfile',c['domain']+' {\n handle /handover-check {\n  respond "'+c['challenge']+'" 200\n }\n handle {\n  reverse_proxy app:3000\n }\n}\n')
 save(root/'infra.compose.json',infra)
 for role in IMAGES:
  service={'image':images[role],'container_name':c['project']+'-app','pull_policy':'never','restart':'no','entrypoint':['node','dist/index.js'],'working_dir':'/app','env_file':[str(root/'private/runtime.env')],'networks':{'db':{},'front':{'aliases':['app']}},'ports':[f'127.0.0.1:{args.port}:3000'],'volumes':[bind('uploads','/app/data/uploads'),bind('private/russian-trusted-ca.pem','/etc/ssl/max/russian-trusted-ca.pem',True)],'logging':log,'labels':{'onlink40.handover':c['project']}}
  save(root/(role+'.compose.json'),{'services':{'app':service},'networks':{k:{'external':True,'name':v['name']} for k,v in net.items()}})
 c['hashes']={str(f.relative_to(root)):sha(f) for f in [root/'infra.compose.json',root/'main.compose.json',root/'reserve.compose.json',root/'Caddyfile',root/'private/probe.env',root/'private/app-db.env',root/'private/postgres.env',root/'private/bootstrap.sql',root/'private/russian-trusted-ca.pem']}
 save(root/'settings.json',c);save(root/'state/state.json',{'phase':'prepared','everStartAttempted':False,'settingsHash':sha(root/'settings.json')});print('PREPARED_NO_APP')
@contextlib.contextmanager
def context(root):
 root=pathlib.Path(root);need(root.is_absolute() and not root.is_symlink(),'ROOT_INVALID');need((root/'backup.lock').is_file() and not (root/'backup.lock').is_symlink(),'LOCK_INVALID')
 with (root/'backup.lock').open('rb') as f:
  try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:raise o.Refusal('BACKUP_LOCK_BUSY') from None
  try:
   c=load(root/'settings.json');s=load(root/'state/state.json');need(c['root']==str(root) and s['settingsHash']==sha(root/'settings.json'),'SETTINGS_CHANGED')
   need(not list((root/'state').glob('*.next')),'PARTIAL_STATE_RECORD')
   for n,h in c['hashes'].items():need(sha(root/n)==h,'CONFIGURATION_CHANGED')
   if 'runtimeHash' in s:need(sha(root/'private/runtime.env')==s['runtimeHash'],'RUNTIME_CHANGED')
   yield c,s
  finally:fcntl.flock(f,fcntl.LOCK_UN)
def state(c,s,phase,**kw):s.update(phase=phase,at=stamp(),**kw);save(pathlib.Path(c['root'])/'state/state.json',s)
def inventory(c,s):
 none_running(c,s.get('appId') if s['phase'] in ['running','start-intent'] else None)
 if 'pgId' in s:need(inspect(pg(c))['Id']==s['pgId'],'POSTGRES_CHANGED')
def infra(c,s):
 need(s['phase']=='prepared','PHASE_INVALID');none_running(c);state(c,s,'infra-intent')
 run(['docker','run','--rm','--network','none','--mount',f'type=bind,src={pathlib.Path(c["root"])/"Caddyfile"},dst=/etc/caddy/Caddyfile,readonly','--entrypoint','caddy',c['caddyImage'],'validate','--config','/etc/caddy/Caddyfile'])
 compose(c,'infra',['up','-d','--no-build','--pull','never','postgres','caddy'])
 deadline=time.monotonic()+60
 while True:
  r=subprocess.run(['docker','exec',pg(c),'pg_isready','-h','127.0.0.1','-U','onlink_admin'],capture_output=True)
  if r.returncode==0:break
  need(time.monotonic()<deadline,'POSTGRES_NOT_READY');time.sleep(.3)
 psql(c,(pathlib.Path(c['root'])/'private/bootstrap.sql').read_text());state(c,s,'infra-ready',pgId=inspect(pg(c))['Id']);print('INFRA_READY_NO_APP')
def restore(c,s,backup,envelope):
 need(s['phase']=='infra-ready','RESTORE_PHASE');inventory(c,s);need(app(c) is None,'APP_EXISTS');b=pathlib.Path(backup);e=load(envelope)
 for n,h in load(b/'checksums.json').items():need(pathlib.Path(n).name==n and sha(b/n)==h,'BACKUP_CHECKSUM_MISMATCH')
 v=load(b/'restore-result.json');need(v.get('databaseRows')==v.get('schema')==v.get('files')=='exact' and load(b/'restore-differences.json')['differenceCount']==0 and v['backupChecksumsSha256']==sha(b/'checksums.json'),'SOURCE_RESTORE_UNVERIFIED')
 meta=load(b/'backup.json');need(e.get('format')=='source-fence-v1' and e.get('backupChecksums')==sha(b/'checksums.json') and e.get('sourceStopped') is True and e['sourceIdentity']==meta['application'] and e['sourceIdentity']['image'] in (*IMAGES['main'][:2],*IMAGES['reserve'][:2]) and meta.get('finalRun'),'SOURCE_FENCE_REQUIRED')
 need(mg.schema_matches(meta['schema'],load(ROOT/'schema-expectations.json')['new']),'BACKUP_SCHEMA_NOT_NEW')
 need(psql(c,"BEGIN READ ONLY;SET LOCAL statement_timeout='5s';SELECT count(*) FROM information_schema.tables WHERE table_schema='public';COMMIT;")=='0','TARGET_DATABASE_NOT_EMPTY')
 state(c,s,'restore-intent',sourceFence=e,backupChecksums=sha(b/'checksums.json'))
 with (b/'database.dump').open('rb') as f:
  try:r=subprocess.run(['docker','exec','-i',pg(c),'pg_restore','-U','onlink_admin','-d','onlink40','--role=onlink_app','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],stdin=f,capture_output=True,timeout=180)
  except subprocess.TimeoutExpired:raise o.Refusal('RESTORE_UNKNOWN_RESULT') from None
 need(r.returncode==0,'RESTORE_FAILED_REVIEW_REQUIRED');identity=schema(c)
 expected=load(b/'files.json');untar(b/'uploads.tar.gz',pathlib.Path(c['root'])/'uploads',expected)
 for f in (pathlib.Path(c['root'])/'uploads').rglob('*'):os.chown(f,1000,1000);os.chmod(f,0o700 if f.is_dir() else 0o600)
 os.chown(pathlib.Path(c['root'])/'uploads',1000,1000)
 snap=fingerprint(c,pathlib.Path(c['root'])/'state/restored')
 need(report(b/'data.json',snap,pathlib.Path(c['root'])/'state/restore-differences.json')==0,'TARGET_DATA_MISMATCH')
 environment(c,b);state(c,s,'verified',identity=identity,runtimeHash=sha(pathlib.Path(c['root'])/'private/runtime.env'),files=expected);print('TARGET_RESTORE_VERIFIED_NO_APP')
def ready(c,cid):
 deadline=time.monotonic()+120
 while time.monotonic()<deadline:
  x=inspect(cid);need(x['State']['Running'],'APP_NOT_RUNNING');ok=True
  for route in ['health','ready']:
   try:ok=ok and urllib.request.urlopen(f'http://127.0.0.1:{c["port"]}/{route}',timeout=2).status==200
   except Exception:ok=False
  if ok:return
  time.sleep(.5)
 raise o.Refusal('READINESS_TIMEOUT_DIAGNOSE_FIRST')
def start(c,s,role,confirm):
 need(s['phase'] in ['verified','stopped','start-failed'],'START_PHASE');need(confirm==s['sourceFence']['handoffCode'],'SOURCE_STOP_RECONFIRM_REQUIRED');inventory(c,s);need(schema(c)==s['identity'],'TARGET_IDENTITY_CHANGED');checked_image(role,c['images'][role]);x=app(c)
 if x:
  need(x['Id']==s.get('appId') and not x['State']['Running'] and x['Config'].get('Labels',{}).get('onlink40.handover')==c['project'],'UNRECOGNIZED_APP');need(s['phase'] in ['stopped','start-failed'],'UNEXPECTED_CONTAINER');run(['docker','rm',x['Id']])
 if not s['everStartAttempted']:
  pre=pathlib.Path(c['root'])/('state/prestart-'+secrets.token_hex(8));before=fingerprint(c,pre);need(report(pathlib.Path(c['root'])/'state/restored/data.json',before,pre/'differences.json')==0,'DATA_CHANGED_BEFORE_FIRST_START');verify_files(pathlib.Path(c['root'])/'uploads',s['files'])
 state(c,s,'create-intent',role=role,appId=None)
 try:
  compose(c,role,['create','--no-build','--pull','never','app']);x=app(c);need(x and x['Image']==c['images'][role],'CREATED_IMAGE_MISMATCH');state(c,s,'start-intent',appId=x['Id'],everStartAttempted=True)
  run(['docker','start',x['Id']]);ready(c,x['Id']);none_running(c,x['Id']);state(c,s,'running');print('APP_READY_'+role.upper())
 except Exception:
  # Only known outcomes may be retried by the explicit fallback command.
  x=app(c)
  if x is None or (x['Id']==s.get('appId') and not x['State']['Running']):state(c,s,'start-failed')
  raise

def stop(c,s):
 need(s['phase'] in ['running','start-intent'],'STOP_PHASE');inventory(c,s);x=app(c);need(x and x['Id']==s['appId'] and x['State']['Running'],'APP_ID_CHANGED');state(c,s,'stop-intent');at=stamp();run(['docker','kill','--signal=TERM',x['Id']]);deadline=time.monotonic()+75
 while True:
  y=inspect(x['Id'])
  if not y['State']['Running']:break
  need(time.monotonic()<deadline,'STOP_TIMEOUT_NO_SIGKILL');time.sleep(.3)
 need(y['State']['ExitCode']==0 and not y['State']['OOMKilled'],'UNCLEAN_STOP');r=subprocess.run(['docker','logs','--since',at,y['Id']],capture_output=True,timeout=10);need(r.returncode==0 and b'graceful shutdown completed' in r.stdout+r.stderr,'GRACEFUL_STOP_NOT_CONFIRMED');save(pathlib.Path(c['root'])/'state/stop-receipt.json',{'clean':True,'identity':o.identity(y),'finishedAt':y['State']['FinishedAt']});state(c,s,'stopped',stopAt=stamp());none_running(c);print('STOPPED_NO_SIGKILL')
def abandon(c,s):
 need(not s['everStartAttempted'] and s['phase'] in ['verified','start-failed'],'TARGET_MAY_HAVE_NEW_DATA');inventory(c,s);x=app(c);need(x is None or (not x['State']['Running'] and x['State']['Status']=='created'),'TARGET_MAY_HAVE_RUN');state(c,s,'abandoned');save(pathlib.Path(c['root'])/'state/abandon-proof.json',{'format':'clean-host-abandon-v1','at':stamp(),'sourceFence':s['sourceFence'],'everStartAttempted':False,'targetAppRunning':False});print('TARGET_ABANDONED_SOURCE_RESUME_REQUIRES_OWNER_CONFIRMATION')
def main():
 os.umask(0o077);a=argparse.ArgumentParser();a.add_argument('--root',required=True);a.add_argument('action',choices=['init','infra','restore','start','stop','abandon','status']);a.add_argument('--domain');a.add_argument('--pg-image');a.add_argument('--caddy-image');a.add_argument('--port',type=int,default=3001);a.add_argument('--http-port',type=int,default=80);a.add_argument('--https-port',type=int,default=443);a.add_argument('--backup');a.add_argument('--envelope');a.add_argument('--role',choices=['main','reserve'],default='main');a.add_argument('--confirm-source-stopped');v=a.parse_args()
 if v.action=='init':init(v);return
 with context(v.root) as (c,s):
  if v.action=='infra':infra(c,s)
  elif v.action=='restore':restore(c,s,v.backup,v.envelope)
  elif v.action=='start':start(c,s,v.role,v.confirm_source_stopped)
  elif v.action=='stop':stop(c,s)
  elif v.action=='abandon':abandon(c,s)
  else:print(json.dumps({'phase':s['phase'],'everStartAttempted':s['everStartAttempted'],'appId':s.get('appId'),'role':s.get('role')}))
if __name__=='__main__':
 try:main()
 except Exception as e:print('CLEAN_INSTALL_REFUSED:'+(str(e) if isinstance(e,o.Refusal) else type(e).__name__),file=sys.stderr);sys.exit(2)
