"""Current clean-host capture + isolated restore. No app startup or old DB replacement."""
import argparse,pathlib,sys,os,json,tarfile,subprocess,secrets,time,hashlib
from clean import *
def backup(c,s,d,final):
 inventory(c,s);need(s['phase'] in (['stopped'] if final else ['running','stopped']),'SNAPSHOT_PHASE');need(schema(c)==s['identity'],'IDENTITY_CHANGED');x=app(c);need(x and x['Id']==s['appId'],'APP_CHANGED')
 d=pathlib.Path(d);need(d.is_absolute() and not d.exists(),'NEW_BACKUP_DIRECTORY_REQUIRED');d.mkdir(mode=0o700);storage=pathlib.Path(c['root'])/'uploads';expected={p.relative_to(storage).as_posix():sha(p) for p in storage.rglob('*') if p.is_file()};verify_files(storage,expected)
 with Exporter(node(c,'data-snapshot.cjs')+['--export'],d) as e:
  snap=e.read_json('snapshot',30)['snapshot'];need(bool(re.fullmatch('[0-9A-F-]+',snap)),'SNAPSHOT_INVALID');v=receive(e,d/'data.sqlite')
  with (d/'database.dump').open('xb') as f:
   r=subprocess.run(['docker','exec',pg(c),'pg_dump','-U','onlink_admin','-d','onlink40','-Fc','--snapshot='+snap],stdout=f,stderr=subprocess.PIPE,timeout=120);need(r.returncode==0,'PG_DUMP_FAILED')
  e.finish()
 with tarfile.open(d/'uploads.tar.gz','w:gz') as t:
  for n in expected:t.add(storage/n,arcname=n,recursive=False)
 verify_files(storage,expected)
 with tarfile.open(d/'configuration.tar.gz','w:gz') as t:t.add(pathlib.Path(c['root'])/'private/runtime.env',arcname='runtime.env');t.add(pathlib.Path(c['root'])/(s['role']+'.compose.json'),arcname='compose.yml')
 save(d/'data.json',v);save(d/'files.json',expected);save(d/'backup.json',{'format':'clean-host-v1','phase':'new','schema':json.loads(run(node(c,'schema-probe.cjs')))['schema'],'identity':s['identity'],'application':o.identity(x),'createdAt':stamp(),'finalRun':'clean-host-stop' if final else None})
 save(d/'checksums.json',{p.name:sha(p) for p in d.iterdir() if p.is_file()})
 name='onlink-restore-'+secrets.token_hex(8);pw=secrets.token_hex(32);env=d/'verify.env';text(env,'POSTGRES_PASSWORD='+pw+'\nDATABASE_URL=postgresql://postgres:'+pw+'@127.0.0.1:5432/postgres\n');cid=None
 try:
  cid=run(['docker','run','-d','--name',name,'--network','none','--cpus','0.5','--memory','768m','--pids-limit','128','--env-file',str(env),c['postgresImage']]);until=time.monotonic()+60
  while subprocess.run(['docker','exec',cid,'pg_isready','-h','127.0.0.1'],capture_output=True).returncode:need(time.monotonic()<until,'VERIFY_DB_TIMEOUT');time.sleep(.3)
  with (d/'database.dump').open('rb') as f:r=subprocess.run(['docker','exec','-i',cid,'pg_restore','-U','postgres','-d','postgres','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],stdin=f,capture_output=True,timeout=180)
  need(r.returncode==0,'VERIFY_RESTORE_FAILED')
  def probe(script):
   return ['docker','run','--rm','-i','--network','container:'+cid,'--cpus','0.5','--memory','384m','--pids-limit','128','--env-file',str(env),'--mount',f'type=bind,src={ROOT / "reviewed"},dst=/ops,readonly','--entrypoint','node',c['images']['main'],'/ops/'+script]
  sch=json.loads(run(probe('schema-probe.cjs')));need(mg.schema_matches(sch['schema'],load(ROOT/'schema-expectations.json')['new']),'VERIFY_SCHEMA_MISMATCH')
  rdir=d/'restored-data';rdir.mkdir(mode=0o700)
  with Exporter(probe('data-snapshot.cjs')+['--export'],rdir) as e:e.read_json('snapshot',30);v=receive(e,rdir/'data.sqlite');e.finish()
  save(rdir/'data.json',v);need(report(d/'data.json',rdir/'data.json',d/'restore-differences.json')==0,'VERIFY_DATA_MISMATCH')
  files=d/'restored-files';files.mkdir(mode=0o700);untar(d/'uploads.tar.gz',files,expected)
  verified={'verifiedAt':stamp(),'databaseRows':'exact','schema':'exact','files':'exact','backupChecksumsSha256':sha(d/'checksums.json')}
 finally:
  if cid:run(['docker','stop','-t','30',cid],35);run(['docker','rm','-v',cid])
  if env.exists():env.unlink()
 save(d/'restore-result.json',verified);print('CAPTURE_AND_ISOLATED_RESTORE_EXACT')
if __name__=='__main__':
 try:
  os.umask(0o077);p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--output',required=True);p.add_argument('--final',action='store_true');a=p.parse_args()
  with context(a.root) as (c,s):backup(c,s,a.output,a.final)
 except Exception as e:print('SNAPSHOT_REFUSED:'+(str(e) if isinstance(e,o.Refusal) else type(e).__name__),file=sys.stderr);sys.exit(2)
