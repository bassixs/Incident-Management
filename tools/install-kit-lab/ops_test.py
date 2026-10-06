"""Migration kit: real Docker/Postgres/flock and controlled lifecycle failures.

Old app is a synthetic SIGTERM HTTP fixture, main/reserve are exact real images.
No live MAX: only local mock. Independent empty databases per test.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
SCRIPTS=ROOT/'tools/migration-kit/scripts';sys.path.insert(0,str(SCRIPTS))
import ops_common as o
import migration_guard as g
OUT=ROOT/'kit-results';OUT.mkdir(exist_ok=True)
NET='kit-lab-net';PG='kit-lab-pg';MOCK='kit-lab-mock'

def run(*args,check=True,**kw):
    p=subprocess.run([str(a) for a in args],capture_output=True,text=True,timeout=240,**kw)
    if check and p.returncode: raise RuntimeError(str(args[:4])+p.stdout[-1000:]+p.stderr[-1000:])
    return p

def wait(predicate):
    until=time.monotonic()+60
    while not predicate():
        if time.monotonic()>until: raise TimeoutError('lab readiness')
        time.sleep(.25)

def sql(db,text):return run('docker','exec','-i',PG,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','lab','-d',db,input=text).stdout

def probe(env):
    return json.loads(run('docker','run','--rm','--network',NET,'--env-file',env,'--mount',f'type=bind,src={SCRIPTS},dst=/ops,readonly','--entrypoint','node','incident-lab:main','/ops/schema-probe.cjs').stdout)

HTTP='''import http.server,signal,threading
s=http.server.HTTPServer(('0.0.0.0',3000),http.server.BaseHTTPRequestHandler)
def get(self): self.send_response(200);self.end_headers();self.wfile.write(b'OK')
s.RequestHandlerClass.do_GET=get
s.RequestHandlerClass.log_message=lambda *a:None
signal.signal(signal.SIGTERM,lambda *a:s.shutdown())
t=threading.Thread(target=s.serve_forever);t.start();signal.pause();t.join();s.server_close()
print('graceful shutdown completed',flush=True)
'''

class MigrationKit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('GITHUB_ACTIONS')!='true' or run('docker','ps','-aq').stdout.strip(): raise RuntimeError('Empty Actions Docker required')
        cls.tmp=tempfile.TemporaryDirectory(prefix='migration-kit-');cls.root=Path(cls.tmp.name)
        cls.addClassCleanup(cls.cleanup)
        run('docker','network','create','--driver','bridge','--opt','com.docker.network.bridge.host_binding_ipv4=127.0.0.1',NET)
        network=json.loads(run('docker','network','inspect',NET).stdout)[0]
        cls.bridge='br-'+network['Id'][:12]
        # Keep localhost publication (the accepted R4 networking fix), while
        # forbidding NEW routed connections out of this disposable bridge.
        cls.firewall=['-i',cls.bridge,'!','-o',cls.bridge,'-m','conntrack','--ctstate','NEW','-j','REJECT']
        run('sudo','iptables','-I','DOCKER-USER','1',*cls.firewall)
        run('sudo','iptables','-C','DOCKER-USER',*cls.firewall)
        (OUT/'network-isolation.json').write_text(json.dumps({'network':network,'forwardReject':cls.firewall,'scope':'only owned synthetic bridge'},indent=2))
        run('docker','run','-d','--name',PG,'--network',NET,'--network-alias','postgres','--cpus','1','--memory','768m','-e','POSTGRES_USER=lab','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=template_old','postgres:16-alpine')
        wait(lambda:run('docker','exec',PG,'pg_isready','-U','lab',check=False).returncode==0)
        cls.env=cls.root/'template.env';cls.env.write_text('DATABASE_URL=postgresql://lab:synthetic-only@postgres:5432/template_old\n')
        old=cls.root/'old-schema';old.mkdir();archive=cls.root/'old.tar'
        run('git','archive',f'--output={archive}',g.VERSIONS['old'],'prisma');run('tar','-xf',archive,'-C',old)
        run('docker','run','--rm','--network',NET,'--env-file',cls.env,'-v',f'{old}:/old:ro','--entrypoint','node','incident-lab:main','node_modules/prisma/build/index.js','migrate','deploy','--schema','/old/prisma/schema.prisma')
        before=probe(cls.env)['schema']
        sql('template_old','CREATE DATABASE template_new TEMPLATE template_old;')
        envnew=cls.root/'new.env';envnew.write_text(cls.env.read_text().replace('template_old','template_new'))
        run('docker','run','--rm','--network',NET,'--env-file',envnew,'--entrypoint','node','incident-lab:main','node_modules/prisma/build/index.js','migrate','deploy')
        after=probe(envnew)['schema']
        cls.manifest=OUT/'schema-expectations.json'
        cls.manifest.write_text(json.dumps({'versions':g.VERSIONS,'probe_sha256':o.sha((SCRIPTS/'schema-probe.cjs').read_bytes()),'old':before,'new':after},indent=2))
        oldsrc=cls.root/'old-http';oldsrc.mkdir();(oldsrc/'server.py').write_text(HTTP)
        (oldsrc/'Dockerfile').write_text('FROM python:3.12-slim\nCOPY server.py /server.py\nENTRYPOINT ["python","-u","/server.py"]\n')
        run('docker','build','--label','org.opencontainers.image.revision='+g.VERSIONS['old'],'-t','incident-kit:synthetic-old',oldsrc)
        cls.images={role:run('docker','image','inspect','--format','{{.Id}}',tag).stdout.strip() for role,tag in [('old','incident-kit:synthetic-old'),('main','incident-lab:main'),('reserve','incident-lab:reserve')]}
        run('docker','run','-d','--init','--name',MOCK,'--network',NET,'--network-alias','mock','-v',f'{ROOT}/tools/reserve-container-lab:/lab:ro','--entrypoint','node','incident-lab:main','/lab/mock.cjs')
        wait(lambda:run('docker','exec',MOCK,'node','-e',"fetch('http://localhost:8080/control').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",check=False).returncode==0)

    @classmethod
    def cleanup(cls):
        names=run('docker','ps','-a','--format','{{.Names}}').stdout.splitlines()
        for name in [MOCK,PG]:
            if name in names:
                run('docker','stop','-t','30',name);run('docker','rm','-v',name)
        if hasattr(cls,'firewall'):run('sudo','iptables','-D','DOCKER-USER',*cls.firewall,check=False)
        run('docker','network','rm',NET,check=False)
        cls.tmp.cleanup()

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=self.root);self.rootcase=Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        suffix=self.rootcase.name.replace('-','').replace('_','')
        self.db='test_'+suffix;self.name='kit-app-'+suffix;self.migrator='kit-migrate-'+suffix
        sql('postgres',f'CREATE DATABASE "{self.db}" TEMPLATE template_old;')
        sql(self.db,"""INSERT INTO "OutboundMessage" (id,"targetType","targetId",payload,attachments,status,"lastError","updatedAt")
SELECT 'preserved-failed-'||n,'user',n,'{}','[]','FAILED',CASE WHEN n<6 THEN 'MANUALLY_RETIRED_FOREIGN_BOT_ADDED' ELSE 'MAX_HTTP_403' END,now() FROM generate_series(0,7) n;
INSERT INTO "OperatorSession" (id,"maxUserId","chatId",type,data,"expiresAt") VALUES ('preserved-draft',999,999,'WAITING_INCIDENT_CONFIRMATION','{"draftText":"Synthetic","draftMedia":[{"storageKey":"preserved.txt"}]}','2099-01-01');""")
        self.protected_sql='''SELECT jsonb_build_object('failed',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM "OutboundMessage" t WHERE id LIKE 'preserved-failed-%'),'draft',(SELECT to_jsonb(t) FROM "OperatorSession" t WHERE id='preserved-draft'));'''
        self.protected=sql(self.db,self.protected_sql)
        self.install=self.rootcase/'install';(self.install/'private').mkdir(parents=True)
        self.prepared=self.rootcase/'prepared';self.prepared.mkdir();(self.prepared/'run').mkdir()
        self.lock=self.rootcase/'backup.lock';self.lock.touch()
        self.uploads=self.rootcase/'uploads';self.uploads.mkdir();os.chmod(self.uploads,0o777)
        (self.uploads/'preserved.txt').write_text('synthetic attachment')
        with socket.socket() as sock: sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        runtime=self.install/'private/runtime.env'
        values={'BOT_TOKEN':'synthetic-container-token','DATABASE_URL':f'postgresql://lab:synthetic-only@postgres:5432/{self.db}',
          'NODE_ENV':'production','MAX_API_BASE_URL':'http://mock:8080','BOT_MODE':'webhook','WEBHOOK_URL':'https://synthetic.invalid/webhook/max','WEBHOOK_SECRET':'synthetic-only','WEBHOOK_AUTO_REGISTER':'false','LOG_PRETTY':'false','SLA_ENABLED':'false','DISTRIBUTION_QUEUE_ENABLED':'false','MEDIA_STORAGE':'local','MEDIA_LOCAL_PATH':'/app/data/uploads','ADMINS':'9001','BOT_STATUS_USER_IDS':''}
        runtime.write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
        self.s={'install':str(self.install),'prepared':str(self.prepared),'backup_script':str(self.rootcase/'backup.py'),'backup_lock':str(self.lock),'releases':str(self.rootcase/'releases'),'app':self.name,'project':self.name,'health_base':'http://127.0.0.1:'+str(port),'runtime_sha256':o.sha(runtime.read_bytes()),'images':{}}
        for role,iid in self.images.items():
            cfg={'services':{'app':{'image':iid,'container_name':self.name,'restart':'no','mem_limit':'768m','cpus':'1','env_file':[str(runtime)],'ports':['127.0.0.1:'+str(port)+':3000'],'volumes':[str(self.uploads)+':/app/data/uploads'],'logging':{'driver':'json-file','options':{'max-size':'20m','max-file':'5'}},'networks':['lab']}},'networks':{'lab':{'external':True,'name':NET}}}
            path=self.prepared/('compose-'+role+'.yml');path.write_text(json.dumps(cfg))
            self.s['images'][role]={'id':iid,'revision':g.VERSIONS[role],'candidate':str(path),'compose_sha256':o.sha(path.read_bytes())}
        oldbytes=Path(self.s['images']['old']['candidate']).read_bytes()
        (self.prepared/'compose-before.yml').write_bytes(oldbytes);(self.install/'compose.yml').write_bytes(oldbytes)
        self.s['baseline_config_sha256']=o.sha(oldbytes)
        self.s['migration']={'network':NET,'container':self.migrator,'manifest':str(self.manifest),'manifest_sha256':o.sha(self.manifest.read_bytes()),'identity':probe(runtime)['identity']}
        self.settings=self.rootcase/'settings.json';self.settings.write_text(json.dumps(self.s))
        self.addCleanup(self.clean_case)
        run('docker','compose','-p',self.name,'-f',self.install/'compose.yml','up','-d','--no-build','--pull','never','app')
        o.wait_ready(self.s,self.images['old'])
        self.initial=o.app(self.s)['Id']
        self.assertEqual(o.app(self.s)['NetworkSettings']['Ports']['3000/tcp'],[{'HostIp':'127.0.0.1','HostPort':str(port)}])

    def clean_case(self):
        records={str(p.relative_to(self.prepared)):p.read_text() for p in self.prepared.rglob('*.json')}
        evidence={'test':self.id(),'records':records,'migrations':sql(self.db,'SELECT migration_name,finished_at IS NOT NULL,rolled_back_at IS NOT NULL FROM _prisma_migrations ORDER BY migration_name;')}
        (OUT/(self._testMethodName+'.json')).write_text(json.dumps(evidence,indent=2))
        for name in [self.name,self.migrator,self.name+'-second']:
            if name not in run('docker','ps','-a','--format','{{.Names}}').stdout.splitlines():continue
            c=o.inspect(name)
            if c['State']['Running']:run('docker','kill','--signal=TERM',name);run('docker','wait',name)
            logs=run('docker','logs',name,check=False);(OUT/(name+'.log')).write_text(logs.stdout+logs.stderr)
            run('docker','rm',name)
        # The lock must be available after every success/refusal/exception.
        with o.backup_lock(self.s): pass
        self.assertEqual((self.uploads/'preserved.txt').read_text(),'synthetic attachment')
        self.assertEqual(sql(self.db,self.protected_sql),self.protected)
        sql('postgres',f'DROP DATABASE "{self.db}";')

    def cli(self,fd,script,*args,code=0,contains=None):
        p=run(sys.executable,SCRIPTS/script,'--settings',self.settings,*args,check=False,env=dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd)),pass_fds=(fd,))
        print(json.dumps({'test':self.id(),'script':script,'exit':p.returncode,'output':p.stdout+p.stderr}),flush=True)
        self.assertEqual(p.returncode,code,p.stdout+p.stderr)
        if contains:self.assertIn(contains,p.stdout+p.stderr)
        if script=='start-app.py' and code==0:
            env=dict(v.split('=',1) for v in o.app(self.s)['Config']['Env'] if '=' in v)
            self.assertEqual(env['MAX_API_BASE_URL'],'http://mock:8080')
            self.assertEqual(env['BOT_TOKEN'],'synthetic-container-token')
            run('sudo','iptables','-C','DOCKER-USER',*self.firewall)
        return p

    def stop(self,fd):self.cli(fd,'stop-app.py',self.images['old'],'run')
    def migrate(self,fd):self.cli(fd,'migrate-app.py','run')
    def apply(self,fd,target='main'):self.cli(fd,'apply-config.py',self.images['old'],self.images[target],self.s['baseline_config_sha256'],self.s['images'][target]['candidate'],'run')

    def test_cancel_before_migrations_same_container(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd)
            self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='MIGRATION_RECEIPT_REQUIRED')
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run')
            self.assertEqual(o.app(self.s)['Id'],self.initial)
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='RESUME_ALREADY_ATTEMPTED')

    def test_migrator_container_without_receipt_blocks_old_resume(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd)
            run('docker','create','--name',self.migrator,'--entrypoint','node',self.images['main'],'-e','process.exit(0)')
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='MIGRATION_CONTAINER_ALREADY_EXISTS')
            self.assertFalse(o.app(self.s)['State']['Running'])

    def test_identity_mismatch_preserves_running_old(self):
        self.s['migration']['identity']['oid']='0'
        self.settings.write_text(json.dumps(self.s))
        with o.backup_lock(self.s) as fd:
            self.cli(fd,'stop-app.py',self.images['old'],'run',code=2,contains='DATABASE_IDENTITY_CHANGED')
        self.assertTrue(o.app(self.s)['State']['Running'])

    def test_interrupted_migration_denies_old_and_new(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd)
            # A synthetic PostgreSQL DDL fault interrupts the actual Prisma CLI
            # after migration 1. No application migration is edited for the test.
            sql(self.db,"""CREATE FUNCTION synthetic_ddl_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_TAG='CREATE FUNCTION' THEN RAISE EXCEPTION 'SYNTHETIC_DDL_FAILURE'; END IF; END; $$;
CREATE EVENT TRIGGER synthetic_failure ON ddl_command_start EXECUTE FUNCTION synthetic_ddl_failure();""")
            self.cli(fd,'migrate-app.py','run',code=2,contains='MIGRATION_FAILED_OR_UNKNOWN')
            self.assertEqual(sql(self.db,"SELECT count(*) FROM information_schema.columns WHERE table_name='InboundUpdate' AND column_name='processingToken';").strip(),'1')
            self.assertEqual(sql(self.db,"SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;").strip(),'1')
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='MIGRATION_ALREADY_STARTED')
            self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='MIGRATION_RESULT_UNKNOWN')
            self.assertFalse(o.app(self.s)['State']['Running'])

    def test_partial_local_receipt_blocks_old_resume(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd);g.ledger(self.s).write_text('{')
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='MIGRATION_ALREADY_STARTED')
            self.assertFalse(o.app(self.s)['State']['Running'])

    def test_lost_cli_result_and_late_migration_completion(self):
        with o.backup_lock(self.s) as fd,patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd)):
            self.stop(fd)
            holder=subprocess.Popen(['docker','exec','-i',PG,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','lab','-d',self.db],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                holder.stdin.write('BEGIN; LOCK TABLE "InboundUpdate" IN ACCESS EXCLUSIVE MODE; SELECT \'LOCK_READY\';\n');holder.stdin.flush()
                import select
                self.assertTrue(select.select([holder.stdout],[],[],30)[0],'lock holder timeout')
                self.assertEqual(holder.stdout.readline().strip(),'LOCK_READY')
                actual=o.command
                def lost(args,*pos,**kw):
                    if args[:2]==['docker','run'] and '--name' in args and self.migrator in args:
                        actual(args[:2]+['-d']+args[2:],*pos,**kw)
                        wait(lambda:sql(self.db,"SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'ALTER TABLE%';").strip()!='0')
                        raise o.Refusal('COMMAND_UNAVAILABLE_OR_TIMEOUT')
                    return actual(args,*pos,**kw)
                with patch.object(o,'command',side_effect=lost):
                    with self.assertRaisesRegex(o.Refusal,'COMMAND_UNAVAILABLE_OR_TIMEOUT'):g.migrate(self.s,'run')
                self.assertTrue(o.inspect(self.migrator)['State']['Running'])
                self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='MIGRATION_ALREADY_STARTED')
                self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='MIGRATION_RESULT_UNKNOWN')
            finally:
                holder.stdin.write('ROLLBACK;\n');holder.stdin.close();holder.wait(timeout=30)
            wait(lambda:not o.inspect(self.migrator)['State']['Running'])
            self.assertEqual(o.inspect(self.migrator)['State']['ExitCode'],0)
            self.assertEqual(probe(self.install/'private/runtime.env')['schema'],json.loads(self.manifest.read_text())['new'])
            # Late successful DDL is evidence for review, not implicit permission.
            self.assertEqual(json.loads(g.ledger(self.s).read_text())['state'],'started')
            self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='MIGRATION_RESULT_UNKNOWN')

    def test_complete_migrations_old_compose_no_old_resume(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd);self.migrate(fd)
            self.assertEqual(o.sha((self.install/'compose.yml').read_bytes()),self.s['baseline_config_sha256'])
            self.assertFalse((self.prepared/'run/applied.json').exists())
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='MIGRATION_ALREADY_STARTED')
            self.apply(fd,'reserve');self.cli(fd,'start-app.py',self.images['reserve'],'run')
            self.assertEqual(o.app(self.s)['Image'],self.images['reserve'])

    def test_missing_receipt_cannot_hide_changed_schema(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd)
            sql(self.db,'ALTER TABLE "InboundUpdate" ADD COLUMN "processingToken" TEXT;')
            self.cli(fd,'resume-unapplied.py',self.images['old'],'run',code=2,contains='DATABASE_SCHEMA_NOT_OLD')

    def test_main_reserve_main_same_database(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd);self.migrate(fd);self.apply(fd);self.cli(fd,'start-app.py',self.images['main'],'run')
            for number,(old,new) in enumerate([('main','reserve'),('reserve','main')]):
                name='switch'+str(number);(self.prepared/name).mkdir()
                self.cli(fd,'stop-app.py',self.images[old],name)
                self.cli(fd,'apply-config.py',self.images[old],self.images[new],self.s['images'][old]['compose_sha256'],self.s['images'][new]['candidate'],name)
                self.cli(fd,'start-app.py',self.images[new],name)
                self.assertEqual(o.app(self.s)['Image'],self.images[new])

    def test_second_instance_refuses_stop(self):
        with o.backup_lock(self.s) as fd:
            self.cli(fd,'migrate-app.py','run',code=2,contains='UNCLEAN_OR_RUNNING_APP')
        self.assertFalse(g.ledger(self.s).exists())
        cfg=o.compose(self.s,o.live_path(self.s))['services']['app']
        run('docker','run','-d','--name',self.name+'-second','--env-file',self.install/'private/runtime.env',self.images['old'])
        with o.backup_lock(self.s) as fd:
            self.cli(fd,'stop-app.py',self.images['old'],'run',code=2,contains='SECOND_OR_RUNNING_APP')
        self.assertTrue(o.app(self.s)['State']['Running'])

    def test_refuses_schema_drift_after_completed_migration(self):
        with o.backup_lock(self.s) as fd:
            self.stop(fd);self.migrate(fd)
            sql(self.db,'ALTER TABLE "OutboundMessage" DISABLE TRIGGER guard_retired_storage;')
            self.cli(fd,'apply-config.py',self.images['old'],self.images['main'],self.s['baseline_config_sha256'],self.s['images']['main']['candidate'],'run',code=2,contains='DATABASE_SCHEMA_NOT_NEW')

    def test_controlled_create_failure_selects_real_reserve(self):
        with o.backup_lock(self.s) as fd,patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd)):
            self.stop(fd);self.migrate(fd);self.apply(fd)
            actual=o.command
            def failed(args,*pos,**kw):
                if args[:2]==['docker','compose'] and 'up' in args:
                    return subprocess.CompletedProcess(args,125,'','synthetic create failure')
                return actual(args,*pos,**kw)
            with patch.object(o,'command',side_effect=failed):
                with self.assertRaisesRegex(o.Refusal,'CREATE_OR_START_FAILED'):o.start(self.s,self.images['main'],'run')
            self.cli(fd,'recover-config.py',self.images['main'],self.images['reserve'],self.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
            self.cli(fd,'start-app.py',self.images['reserve'],'run')
            self.assertEqual(o.app(self.s)['Image'],self.images['reserve'])

    def test_controlled_container_exit_selects_real_reserve(self):
        with o.backup_lock(self.s) as fd,patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(fd)):
            self.stop(fd);self.migrate(fd);self.apply(fd)
            actual=o.command
            def failed(args,*pos,**kw):
                if args[:2]==['docker','compose'] and 'up' in args:
                    # Controlled real Docker exit replaces only this stopped
                    # synthetic container. No candidate image is modified.
                    run('docker','rm',self.name)
                    run('docker','run','--name',self.name,
                        '--label','com.docker.compose.project='+self.name,
                        '--label','com.docker.compose.service=app',
                        '--label','com.docker.compose.config-hash=synthetic-start-failure',
                        '--label','com.docker.compose.container-number=1',
                        '--label','com.docker.compose.oneoff=False',
                        '--entrypoint','node',self.images['main'],'-e','process.exit(17)',check=False)
                    return subprocess.CompletedProcess(args,125,'','synthetic start failure')
                return actual(args,*pos,**kw)
            with patch.object(o,'command',side_effect=failed):
                with self.assertRaisesRegex(o.Refusal,'CREATE_OR_START_FAILED'):o.start(self.s,self.images['main'],'run')
            self.cli(fd,'recover-config.py',self.images['main'],self.images['reserve'],self.s['images']['main']['compose_sha256'],'run','reviewed-start-failure')
            self.cli(fd,'start-app.py',self.images['reserve'],'run')
            self.assertEqual(o.app(self.s)['Image'],self.images['reserve'])

if __name__=='__main__':unittest.main(verbosity=2)
