"""Complete private backup and isolated restore, never starts the bot.

Requires the inherited backup lock. Database dump and per-field fingerprints
share one exported PostgreSQL snapshot; file changes cause refusal. Output may
contain personal data and secrets: keep local mode 0700, never publish it.
"""
import argparse,hashlib,json,os,re,subprocess,sys,tarfile,time
from pathlib import Path
import ops_common as o
import migration_guard as g
from data_check import compare

ROOT=Path(__file__).resolve().parent
def filehash(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def files(root):
    o.need(root.is_dir() and not root.is_symlink(),'UPLOADS_DIRECTORY_REQUIRED')
    result={}
    for p in sorted(root.rglob('*')):
        o.need(not p.is_symlink(),'SYMLINK_IN_UPLOADS')
        if p.is_file():result[p.relative_to(root).as_posix()]=filehash(p)
    return result
def node(s,env,network,script,*args):
    return ['docker','run','--rm','-i','--network',network,'--cpus','0.5','--memory','384m','--pids-limit','128',
            '--env-file',str(env),'--mount',f'type=bind,src={ROOT},dst=/ops,readonly','--entrypoint','node',s['images']['main']['id'],'/ops/'+script,*args]
def private_json(p,value):o.save_new(p,value)
def config(s):
    b=s['backup'];o.need(set(b)=={'postgres','postgres_id','user','database','uploads','restore_image'},'BACKUP_SETTINGS_REQUIRED')
    for k in ('postgres','user','database'):o.need(bool(re.fullmatch('[A-Za-z0-9_.-]+',b[k])),'BACKUP_IDENTIFIER_INVALID')
    o.need(o.inspect(b['postgres'])['Id']==b['postgres_id'],'POSTGRES_ID_CHANGED')
    o.need(b['database']==s['migration']['identity']['database'],'BACKUP_DATABASE_MISMATCH')
    o.need(Path(b['uploads']).is_absolute(),'UPLOADS_ABSOLUTE_REQUIRED')
    o.need(bool(re.fullmatch('sha256:[0-9a-f]{64}',b['restore_image'])),'RESTORE_IMAGE_ID_REQUIRED')
    return b
def capture(s,kind,dest,runname=None):
    o.require_lock(s);b=config(s);g.assert_schema(s,kind)
    current=o.app(s);o.need(current is not None,'APP_CONTAINER_REQUIRED')
    o.image(s,current['Image']);o.config(s,o.live_path(s),current['Image'])
    if runname:
        c=o.app(s);o.clean(c);o.receipt(s,o.run_dir(s,runname),c);o.no_other_app(s)
    o.need(dest.is_absolute() and not dest.exists(),'NEW_PRIVATE_BACKUP_DIRECTORY_REQUIRED')
    dest.mkdir(mode=0o700);uploads=Path(b['uploads']);before=files(uploads)
    env=Path(s['install'])/'private/runtime.env'
    cmd=node(s,env,s['migration']['network'],'data-snapshot.cjs','--export')
    # Timeout the whole export process as well as pg_dump; no detached exporter.
    exporter=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    import threading,queue
    lines=queue.Queue()
    def read():
        for line in exporter.stdout:lines.put(line)
        lines.put(None)
    thread=threading.Thread(target=read,daemon=True);thread.start()
    try:
        first=json.loads(lines.get(timeout=30));snap=first['snapshot']
        o.need(bool(re.fullmatch('[0-9A-F-]+',snap)),'INVALID_EXPORTED_SNAPSHOT')
        fingerprints=json.loads(lines.get(timeout=90))
        with (dest/'database.dump').open('xb') as f:
            os.chmod(f.name,0o600)
            p=subprocess.run(['docker','exec',b['postgres'],'pg_dump','-U',b['user'],'-d',b['database'],'-Fc','--snapshot='+snap],stdout=f,stderr=subprocess.PIPE,timeout=120)
            o.need(p.returncode==0,'PG_DUMP_FAILED')
        exporter.stdin.write('release\n');exporter.stdin.flush();exporter.stdin.close()
        o.need(exporter.wait(timeout=15)==0,'SNAPSHOT_EXPORT_FAILED')
    finally:
        if exporter.stdin and not exporter.stdin.closed:exporter.stdin.close()
        try:exporter.wait(timeout=15)
        except subprocess.TimeoutExpired:exporter.terminate();exporter.wait(timeout=5)
    with tarfile.open(dest/'uploads.tar.gz','w:gz') as tar:
        for name in before:tar.add(uploads/name,arcname=name,recursive=False)
    o.need(files(uploads)==before,'FILES_CHANGED_DURING_BACKUP')
    with tarfile.open(dest/'configuration.tar.gz','w:gz') as tar:
        for name,p in [('compose.yml',o.live_path(s)),('runtime.env',env)]:tar.add(p,arcname=name,recursive=False)
    o.runtime(s)
    private_json(dest/'data.json',fingerprints)
    private_json(dest/'files.json',before)
    private_json(dest/'backup.json',{'kit':s['kit'],'phase':kind,'identity':s['migration']['identity'],'application':o.identity(current),'composeSha256':filehash(o.live_path(s)),'createdAt':o.stamp(),'finalRun':runname,'schema':g.probe(s)})
    for p in dest.iterdir():os.chmod(p,0o600)
    private_json(dest/'checksums.json',{p.name:filehash(p) for p in dest.iterdir() if p.is_file()})
    print('BACKUP_CAPTURED_RESTORE_NOT_YET_VERIFIED')
def verify(s,dest):
    o.require_lock(s);b=config(s)
    g.probe(s) # re-confirm source identity, without changing or restoring it
    for name,h in o.read_json(dest/'checksums.json').items():
        o.need(Path(name).name==name and filehash(dest/name)==h,'BACKUP_CHECKSUM_MISMATCH')
    meta=o.read_json(dest/'backup.json');o.need(meta['kit']==s['kit'] and meta['identity']==s['migration']['identity'],'BACKUP_IDENTITY_MISMATCH')
    _,manifest=g.configuration(s);o.need(g.schema_matches(meta['schema'],manifest[meta['phase']]),'BACKUP_SCHEMA_MISMATCH')
    name='incident-restore-'+os.urandom(8).hex();password=os.urandom(24).hex()
    env=dest/'restore.env'
    o.need(not env.exists() and not env.is_symlink() and not (dest/'restore-result.json').exists(),'RESTORE_ALREADY_ATTEMPTED_OR_REVIEW_REQUIRED')
    with env.open('x') as f:
        os.chmod(env,0o600);f.write('POSTGRES_USER=checker\nPOSTGRES_PASSWORD='+password+'\nPOSTGRES_DB=verify\nDATABASE_URL=postgresql://checker:'+password+'@127.0.0.1:5432/verify\n')
    cid=None
    try:
        print('RESTORE_STEP:isolated-database-start',flush=True)
        cid=o.output(['docker','run','-d','--name',name,'--network','none','--cpus','0.5','--memory','768m','--pids-limit','128','--env-file',str(env),b['restore_image']]).strip()
        until=time.monotonic()+45
        # initdb's temporary server accepts local sockets before initialization
        # completes. The restore must wait for the final TCP listener.
        while o.command(['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','checker'],allow_failure=True).returncode:
            o.need(time.monotonic()<until,'RESTORE_DB_NOT_READY');time.sleep(.25)
        print('RESTORE_STEP:pg-restore',flush=True)
        with (dest/'database.dump').open('rb') as f:
            result=subprocess.run(['docker','exec','-i',cid,'pg_restore','-U','checker','-d','verify','--no-owner','--no-privileges','--single-transaction','--exit-on-error'],stdin=f,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=180)
            o.need(result.returncode==0,'ISOLATED_RESTORE_FAILED')
        print('RESTORE_STEP:schema-and-data',flush=True)
        schema=json.loads(o.output(node(s,env,'container:'+cid,'schema-probe.cjs'),30))['schema']
        o.need(g.schema_matches(schema,manifest[meta['phase']]),'RESTORED_SCHEMA_MISMATCH')
        data=json.loads(o.output(node(s,env,'container:'+cid,'data-snapshot.cjs'),90))
        o.need(not compare(o.read_json(dest/'data.json'),data),'RESTORED_DATA_MISMATCH')
        expected=o.read_json(dest/'files.json');seen={}
        with tarfile.open(dest/'uploads.tar.gz','r:gz') as tar:
            for m in tar:
                o.need(m.isfile() and m.name in expected and m.name not in seen,'ARCHIVE_MEMBER_INVALID')
                with tar.extractfile(m) as f:seen[m.name]=hashlib.file_digest(f,'sha256').hexdigest()
        o.need(seen==expected,'RESTORED_FILES_MISMATCH')
        private_json(dest/'restore-result.json',{'verifiedAt':o.stamp(),'backupChecksumsSha256':filehash(dest/'checksums.json'),'kit':s['kit'],'restoreImage':b['restore_image'],'databaseRows':'exact','schema':'exact','files':'exact','applicationStarted':False,'sourceDatabaseWritten':False})
        print('BACKUP_RESTORE_VERIFIED')
    finally:
        if cid:
            print('RESTORE_STEP:isolated-database-cleanup',flush=True)
            # The command budget must contain Docker's requested 30-second grace.
            o.command(['docker','stop','-t','30',cid],timeout=35);o.command(['docker','rm','-v',cid])
        if env.exists():env.unlink() # only this function's random disposable credentials
def main():
    a=argparse.ArgumentParser();a.add_argument('--settings',required=True);a.add_argument('action',choices=['capture','verify']);a.add_argument('--output',required=True);a.add_argument('--schema',choices=['old','new']);a.add_argument('--final-run')
    v=a.parse_args();s=o.settings(v.settings);dest=Path(v.output)
    if v.action=='capture':o.need(v.schema is not None,'SCHEMA_REQUIRED');capture(s,v.schema,dest,v.final_run)
    else:verify(s,dest)
if __name__=='__main__':
    try:main()
    except Exception as e:
        print('BACKUP_REFUSED:'+ (str(e) if isinstance(e,o.Refusal) else type(e).__name__),file=sys.stderr);sys.exit(2)
