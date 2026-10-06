#!/usr/bin/env python3
"""Whole-container synthetic lab. Requires a disposable Linux Docker host.
No production endpoint/credential is accepted. Run by the dedicated Actions branch.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

ROOT = Path(__file__).resolve().parents[2]
LAB = Path(__file__).resolve().parent
OUT = ROOT / 'lab-results'
OUT.mkdir(exist_ok=True)
VERSIONS = {'main': '59149006a7b3d30d01218fad84360e7d71e6d79e', 'reserve': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip()}
NET, PG, MOCK, VOLUME = 'reserve-lab-net', 'reserve-lab-postgres', 'reserve-lab-mock', 'reserve-lab-uploads'
APP, serial = None, 0
report = {'versions': VERSIONS, 'images': {}, 'checks': [], 'starts': [], 'stops': [], 'scope': 'synthetic disposable GitHub runner only'}

def cmd(*args, data=None, check=True, timeout=300):
    result = subprocess.run([str(a) for a in args], input=data, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode and check:
        raise RuntimeError(f'Command failed: {args[:4]}\n{result.stdout[-3000:]}\n{result.stderr[-3000:]}')
    return result

def docker(*args, **kw):
    return cmd('docker', *args, **kw)

def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')

def check(name, condition, evidence=None):
    report['checks'].append({'name': name, 'passed': bool(condition), 'evidence': evidence})
    print(('PASS ' if condition else 'FAIL ') + name, flush=True)
    save('report.json', report)
    if not condition:
        raise AssertionError(name)

def wait(name, predicate, seconds=90):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(.25)  # Bounded observation, never an arbitrary wait for correctness.
    raise TimeoutError(name)

ENV = {'NODE_ENV': 'production', 'BOT_TOKEN': 'synthetic-container-token', 'MAX_API_BASE_URL': 'http://mock:8080',
       'DATABASE_URL': 'postgresql://lab:synthetic_lab_password@postgres:5432/reserve_lab',
       'BOT_MODE': 'webhook', 'WEBHOOK_URL': 'https://synthetic.invalid/webhook/max', 'WEBHOOK_SECRET': 'synthetic-webhook-secret',
       'WEBHOOK_AUTO_REGISTER': 'false', 'LOG_LEVEL': 'info', 'LOG_PRETTY': 'false', 'SLA_ENABLED': 'false',
       'DISTRIBUTION_QUEUE_ENABLED': 'false', 'MEDIA_STORAGE': 'local', 'MEDIA_LOCAL_PATH': '/app/data/uploads',
       'BOT_STATUS_USER_IDS': '', 'ADMINS': '9001', 'APP_TIMEZONE': 'Europe/Moscow'}
env_file = OUT / 'synthetic.env'
env_file.write_text(''.join(f'{k}={v}\n' for k, v in ENV.items()))

def helper(op, image='main', **args):
    common = ['run', '--rm', '-i', '--network', NET, '--cpus', '0.5', '--memory', '384m', '--env-file', env_file,
              '-v', f'{LAB}:/lab:ro', '-v', f'{VOLUME}:/app/data/uploads', '--entrypoint', 'node', f'incident-lab:{image}', '/lab/fixture.cjs']
    return json.loads(docker(*common, data=json.dumps({'op': op, **args})).stdout)

def state(id):
    # Read-only SQL avoids repeatedly launching helper containers while polling.
    assert id.startswith('lab-job-') and id[8:].isdigit()
    sql = f'''SELECT row_to_json(t) FROM (SELECT * FROM "OutboundMessage" WHERE id='{id}') t;'''
    return json.loads(docker('exec', PG, 'psql', '-XAt', '-U', 'lab', '-d', 'reserve_lab', '-c', sql).stdout)

def sql(statement):
    return docker('exec', '-i', PG, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'lab', '-d', 'reserve_lab', data=statement).stdout

def control(**body):
    script = "fetch('http://127.0.0.1:8080/control',process.argv[1]==='{}'?{}:{method:'POST',headers:{'content-type':'application/json'},body:process.argv[1]}).then(r=>{if(!r.ok)throw Error('control HTTP '+r.status);return r.json()}).then(x=>console.log(JSON.stringify(x))).catch(e=>{console.error(e);process.exit(1)})"
    return json.loads(docker('exec', MOCK, 'node', '-e', script, json.dumps(body)).stdout)

def accepted(target):
    return [r for r in control()['ledger'] if r['target'] == target]

def ready(container):
    script = "Promise.all(['/health','/ready'].map(p=>fetch('http://127.0.0.1:3000'+p,{signal:AbortSignal.timeout(1500)}).then(r=>r.status))).then(s=>{console.log(JSON.stringify(s));process.exit(s.every(x=>x===200)?0:1)}).catch(()=>process.exit(1))"
    return docker('exec', container, 'node', '-e', script, check=False, timeout=6).returncode == 0

def start(version, bad=False):
    global APP, serial
    running = docker('ps', '-q', '--filter', 'label=reserve-lab.role=app').stdout.strip()
    check('only one app: none before start', not running)
    serial += 1
    APP = f'reserve-lab-app-{serial}'
    args = ['run', '-d', '--name', APP, '--label', 'reserve-lab.role=app', '--network', NET, '--cpus', '1', '--memory', '768m',
            '--pids-limit', '256', '--env-file', env_file, '--restart', 'no', '--stop-timeout', '75',
            '--log-driver', 'json-file', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=5',
            '-v', f'{VOLUME}:/app/data/uploads']
    if bad:
        args += ['-e', 'BOT_MODE=invalid-fixture-mode']
    began = time.monotonic()
    docker(*args, f'incident-lab:{version}')
    if not bad:
        wait('health/ready did not become ready within 90s', lambda: ready(APP))
        identity = json.loads(docker('inspect', APP).stdout)[0]
        check('correct immutable app image', identity['Image'] == report['images'][version]['id'])
        check('shared attachments mount', any(m.get('Name') == VOLUME and m['Destination'] == '/app/data/uploads' and m['RW'] for m in identity['Mounts']))
        check('app rotation retained', identity['HostConfig']['LogConfig'] == {'Type': 'json-file', 'Config': {'max-file': '5', 'max-size': '20m'}})
        check('unprivileged runtime uid', docker('exec', APP, 'id', '-u').stdout.strip() == '1000')
        report['starts'].append({'version': version, 'container': APP, 'readyMs': round((time.monotonic()-began)*1000), 'image': identity['Image']})
    return APP

def finish_stop(container, began):
    identity = json.loads(docker('inspect', container).stdout)[0]
    log = docker('logs', container).stdout
    # Docker logs can be on either stream; keep both synthetic logs.
    logs = docker('logs', container)
    (OUT / f'{container}.log').write_text(logs.stdout + logs.stderr)
    check('graceful SIGTERM exit', identity['State']['ExitCode'] == 0 and not identity['State']['OOMKilled'] and 'graceful shutdown completed' in log)
    report['stops'].append({'container': container, 'durationMs': round((time.monotonic()-began)*1000), 'exitCode': identity['State']['ExitCode']})
    check('no app left running', not docker('ps', '-q', '--filter', 'label=reserve-lab.role=app').stdout.strip())

def stop():
    global APP
    container = APP
    began = time.monotonic()
    docker('stop', '-t', '75', container, timeout=85)
    finish_stop(container, began)
    APP = None

def terminal(id, desired='SENT'):
    return wait(f'{id} expected {desired}', lambda: (s if (s:=state(id))['status'] == desired else None))

def partial(n, kind=None, attempts=0, media=False):
    # Start from main, persist a real prefix through the SDK/HTTP API, then stop.
    target = f"{'chat' if kind == 'sector' else 'user'}:{-(10000+n) if kind == 'sector' else 10000+n}"
    control(op='rule', target=target, mode='error', status=503, **{'from': 2})
    job = helper('create', n=n, kind=kind, attempts=attempts, media=media)
    expected = 'FAILED' if attempts == 11 else 'PENDING'
    wait('partial persisted', lambda: (s if (s:=state(job['id']))['status'] == expected and len(s['payload'].get('deliveryProgress', {}).get('mids', [])) == 1 else None))
    stop()
    control(op='clear', target=target)
    return job, target

def build():
    report['docker'] = docker('version', '--format', '{{json .}}').stdout.strip()
    for version, sha in VERSIONS.items():
        source = ROOT / 'lab-source' / version
        source.mkdir(parents=True, exist_ok=True)
        archive = source.parent / (version + '.tar')
        cmd('git', 'archive', '--format=tar', f'--output={archive}', sha)
        cmd('tar', '-xf', archive, '-C', source)
        check('clean archive excludes private env/dependencies', not (source/'.env').exists() and not (source/'node_modules').exists())
        for target, tag in [('build', f'incident-lab:build-{version}'), ('runtime', f'incident-lab:{version}')]:
            result = docker('build', '--progress=plain', '--target', target, '--label', f'org.opencontainers.image.revision={sha}', '-t', tag, source, timeout=1200)
            (OUT / f'build-{version}-{target}.log').write_text(result.stdout + result.stderr)
        info = json.loads(docker('image', 'inspect', f'incident-lab:{version}').stdout)[0]
        report['images'][version] = {'sha': sha, 'tree': cmd('git', 'rev-parse', sha+'^{tree}').stdout.strip(), 'id': info['Id'], 'repoDigests': info['RepoDigests'], 'size': info['Size'], 'lockSha256': hashlib.sha256((source/'package-lock.json').read_bytes()).hexdigest()}
        report['images'][version]['nodeVersions'] = json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', f'incident-lab:{version}', '-e', 'console.log(JSON.stringify(process.versions))').stdout)
        script = "const fs=require('fs'),c=require('crypto'),p=require('path'),out={};function walk(d){for(const n of fs.readdirSync(d)){const f=p.join(d,n);if(fs.statSync(f).isDirectory())walk(f);else out[f]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}}walk('dist');walk('prisma');for(const f of ['package.json','package-lock.json'])out[f]=c.createHash('sha256').update(fs.readFileSync(f)).digest('hex');console.log(JSON.stringify(out))"
        manifests = []
        for tag in [f'incident-lab:build-{version}', f'incident-lab:{version}']:
            manifests.append(json.loads(docker('run', '--rm', '--network', 'none', '--entrypoint', 'node', tag, '-e', script).stdout))
        check('runtime dist/schema/lock equal exact-source build stage', manifests[0] == manifests[1], version)
        save(f'{version}-files.json', manifests[1])
    main = json.loads((OUT/'main-files.json').read_text()); reserve = json.loads((OUT/'reserve-files.json').read_text())
    differences = [p for p in main.keys() | reserve.keys() if main.get(p) != reserve.get(p)]
    check('only intended compiled runtime differs', bool(differences) and all(p.startswith('dist/max/max-message.service.') for p in differences), differences)
    report['compose'] = docker('compose','version').stdout.strip()
    docker('pull', 'postgres:16-alpine', timeout=180)
    report['postgresImage'] = json.loads(docker('image', 'inspect', 'postgres:16-alpine').stdout)[0]['Id']

def setup():
    docker('network', 'create', '--internal', NET)
    check('Docker runtime network blocks external routes', json.loads(docker('network', 'inspect', NET).stdout)[0]['Internal'])
    docker('volume', 'create', VOLUME)
    docker('run', '--rm', '--network', 'none', '--user', '0', '-v', f'{VOLUME}:/app/data/uploads', '--entrypoint', 'sh', 'incident-lab:main', '-c', 'chown node:node /app/data/uploads')
    docker('run', '--rm', '--network', 'none', '-v', f'{VOLUME}:/app/data/uploads', '--entrypoint', 'node', 'incident-lab:main', '-e', "require('fs').writeFileSync('/app/data/uploads/fixture.txt','synthetic persistent attachment')")
    docker('run', '-d', '--name', PG, '--network', NET, '--network-alias', 'postgres', '--cpus', '1', '--memory', '512m',
           '-e', 'POSTGRES_USER=lab', '-e', 'POSTGRES_PASSWORD=synthetic_lab_password', '-e', 'POSTGRES_DB=reserve_lab', 'postgres:16-alpine')
    wait('isolated PostgreSQL readiness', lambda: docker('exec', PG, 'pg_isready', '-U', 'lab', '-d', 'reserve_lab', check=False).returncode == 0)
    installed = ROOT/'installed-schema'; installed.mkdir()
    archive = ROOT/'installed-schema.tar'
    cmd('git','archive','--format=tar',f'--output={archive}','8dcfa330183e47551446d10cabbd3b493a42ea0b','prisma')
    cmd('tar','-xf',archive,'-C',installed)
    migration = docker('run','--rm','--network',NET,'--env-file',env_file,'-v',f'{installed}:/installed:ro','--entrypoint','node','incident-lab:main','node_modules/prisma/build/index.js','migrate','deploy','--schema','/installed/prisma/schema.prisma')
    (OUT/'migrate-installed.txt').write_text(migration.stdout+migration.stderr)
    before = helper('switch-seed-installed')
    migration = docker('run','--rm','--network',NET,'--env-file',env_file,'--entrypoint','node','incident-lab:main','node_modules/prisma/build/index.js','migrate','deploy')
    (OUT/'migrate-pr13.txt').write_text(migration.stdout+migration.stderr)
    check('both additive migrations preserve installed records', helper('switch-preserved') == before)
    check('seven storage guards installed', '7' in sql("SELECT count(*) FROM pg_trigger WHERE tgname='guard_retired_storage' AND tgenabled='O';"))
    check('processingToken migration applied', 'processingToken' in sql("SELECT column_name FROM information_schema.columns WHERE table_name='InboundUpdate' AND column_name='processingToken';"))
    report['preservedBaseline']=before
    save('migrations.json', {'preserved':before, 'applied':sql('SELECT migration_name FROM _prisma_migrations ORDER BY migration_name;')})
    helper('switch-seed-journal')
    docker('run', '-d', '--init', '--name', MOCK, '--network', NET, '--network-alias', 'mock', '--cpus', '0.5', '--memory', '256m',
           '-v', f'{LAB}:/lab:ro', '--entrypoint', 'node', 'incident-lab:main', '/lab/mock.cjs')
    wait('local mock ready', lambda: docker('exec', MOCK, 'node', '-e', "fetch('http://localhost:8080/control').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))", check=False).returncode == 0)

def scenarios():
    preserved=helper('switch-preserved')
    protected=helper('switch-journal')
    for version in ('main','reserve','main'):
        start(version)
        check('delayed inbox head and follower remain pending on '+version, helper('switch-inbox-pending'))
        check('records drafts and attachments unchanged on '+version, helper('switch-preserved')==preserved)
        check('journal and permanent fences survive '+version, helper('switch-journal')==protected)
        stop()
        check('retired key rejected by '+version,helper('switch-fence-rejected',image=version))
    helper('switch-inbox-due'); start('reserve')
    wait('delayed inbox drains in sequence',lambda:helper('switch-inbox-done'))
    stop()
    cleanup=helper('switch-drain',image='reserve')
    check('reserve continues journal without reviving unknown delete',cleanup['deletedFiles']==1 and cleanup['unknownPreserved'] and cleanup['fencesRetained'])
    start('main')
    legacy = helper('create', n=1, text='Synthetic legacy no progress')
    terminal(legacy['id']); check('legacy job sent once', len(accepted('user:10001')) == 1)
    helper('create', n=2, text='Synthetic retired greeting', status='FAILED')
    retired = state('lab-job-2')

    # Long text + nine photo tokens + persistent file, with a second switch mid-delivery.
    job, target = partial(3, media=True)
    prefix = state(job['id'])['payload']['deliveryProgress']['mids']
    control(op='rule', target=target, mode='error', status=503, **{'from': 3})
    helper('due', id=job['id']); start('reserve')
    wait('reserve progressed then pending', lambda: (s:=state(job['id']))['status']=='PENDING' and len(s['payload']['deliveryProgress']['mids']) == 3)
    stop(); control(op='clear', target=target); helper('due', id=job['id']); start('main'); done=terminal(job['id'])
    parts=accepted(target)
    check('main-reserve-main keeps prefix without repeating', len(parts)==5 and done['payload']['deliveryProgress']['mids'][:1]==prefix)
    media=[a for r in parts for a in r['message']['body']['attachments'] if a['type']!='inline_keyboard']
    check('all nine photos and file retained', sum(a['type']=='image' for a in media)==9 and sum(a['type']=='file' for a in media)==1)
    file_hash=hashlib.sha256(b'synthetic persistent attachment').hexdigest()
    check('HTTP file upload contains original bytes', any(u['sha256']==file_hash for u in control()['uploads']))

    job,target=partial(4); helper('pending-to-stale-sending', id=job['id']); start('reserve'); terminal(job['id'])
    check('stale SENDING resumes saved prefix', len(accepted(target))==2)
    stop(); start('main')
    job,target=partial(5,kind='answer',attempts=11); failed=state(job['id']); start('reserve')
    follow=helper('create',n=6,target=10005,text='Synthetic successor after FAILED'); terminal(follow['id'])
    check('FAILED prefix unchanged and successor unblocked', state(job['id'])==failed and len(accepted(target))==2)
    check('FAILED answer has no false success', not helper('tracking',id=job['id'])['answer']['deliveredAt'] and not helper('tracking',id=job['id'])['history'])
    stop(); start('main')

    # Fail only completion of one synthetic record, after all actual HTTP ACKs persisted.
    sql('''CREATE FUNCTION lab_reject_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='lab-job-7' AND NEW.status='SENT' THEN RAISE EXCEPTION 'synthetic completion failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER lab_completion BEFORE UPDATE ON "OutboundMessage" FOR EACH ROW EXECUTE FUNCTION lab_reject_completion();''')
    job=helper('create',n=7,kind='answer')
    wait('all ACKs pending completion', lambda: (s:=state(job['id']))['status']=='PENDING' and len(s['payload'].get('deliveryProgress',{}).get('mids',[]))==2)
    stop(); sql('DROP TRIGGER lab_completion ON "OutboundMessage"; DROP FUNCTION lab_reject_completion();')
    before=len(accepted('user:10007')); helper('due',id=job['id']); start('reserve'); terminal(job['id'])
    tracking=wait('single success notice',lambda: (s if len((s:=helper('tracking',id=job['id']))['notices'])==1 and s['notices'][0]['status']=='SENT' else None))
    check('all ACKs complete without resend, exactly one history/notice', len(accepted('user:10007'))==before and bool(tracking['answer']['deliveredAt']) and len(tracking['history'])==1)
    stop(); start('main'); helper('create',n=8,text='Synthetic observation barrier'); terminal('lab-job-8')
    check('return to main does not duplicate final accounting', helper('tracking',id=job['id'])==tracking)

    job,target=partial(9); helper('corrupt',id=job['id']); start('reserve'); terminal(job['id'],'FAILED')
    check('unknown progress fails closed', len(accepted(target))==1 and state(job['id'])['payload']['deliveryProgress']['version']==99)
    stop(); start('main')
    job,target=partial(10,kind='answer'); helper('new-answer',id=job['id']); helper('due',id=job['id']); start('reserve'); terminal(job['id'],'FAILED')
    check('new answer prevents old remainder/success', len(accepted(target))==1 and not helper('tracking',id=job['id'])['history'])
    stop(); start('main')
    job,target=partial(11,kind='sector'); helper('new-assignment',id=job['id']); helper('due',id=job['id']); start('reserve'); terminal(job['id'],'FAILED')
    check('changed assignment stops old card', len(accepted(target))==1)

    for n,mode,status in [(12,'error',429),(13,'drop-before',0),(14,'drop-after',0)]:
        target=f'user:{10000+n}'; control(op='rule',target=target,mode=mode,status=status,count=1)
        helper('create',n=n,text=f'Synthetic HTTP {mode}'); terminal(f'lab-job-{n}')
        check(f'HTTP {mode} {status}',len(accepted(target))==(2 if mode=='drop-after' else 1))
        control(op='clear',target=target)
    # Concurrent ready jobs: real rate gate spaces HTTP calls to the same recipient.
    for n in (15,16,17): helper('create',n=n,target=10015,text=f'Synthetic rate {n}')
    terminal('lab-job-17'); stamps=[r['at'] for r in control()['requests'] if r.get('target')=='user:10015' and r['type']=='send']
    check('HTTP per-target spacing',len(stamps)==3 and all(b-a>=500 for a,b in zip(stamps,stamps[1:])),[round(b-a) for a,b in zip(stamps,stamps[1:])])

    control(op='rule',target='user:10018',mode='hold'); helper('create',n=18,text='Synthetic SIGTERM in-flight')
    wait('in-flight HTTP gate',lambda:'user:10018' in control()['held'])
    began=time.monotonic(); stopping=subprocess.Popen(['docker','stop','-t','75',APP],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    wait('SIGTERM observed',lambda:'shutting down' in docker('logs',APP).stdout,seconds=15)
    check('SIGTERM waits for outstanding ACK',stopping.poll() is None and json.loads(docker('inspect',APP).stdout)[0]['State']['Running'])
    control(op='release',target='user:10018'); stopping.communicate(timeout=80)
    finish_stop(APP,began); check('ACK and final state preserved on shutdown',state('lab-job-18')['status']=='SENT')
    start('main'); check('ACK not replayed after SIGTERM',len(accepted('user:10018'))==1); stop()

    # Creation failure must also allow safe return without starting a second app.
    before=helper('snapshot')
    creation=docker('create','--name','reserve-lab-rejected-create','--network',NET,
                    '--mount',f'type=bind,src={ROOT}/nonexistent-lab-mount,dst=/app/data/uploads',
                    'incident-lab:reserve',check=False)
    check('invalid mount rejects container creation',creation.returncode!=0)
    check('creation failure preserved current DB',helper('snapshot')==before)
    start('main'); stop()
    # Bad configuration must not lead to parallel instances or restoring an old DB.
    before=helper('snapshot'); bad=start('reserve',bad=True)
    wait('invalid configuration exits',lambda:not json.loads(docker('inspect',bad).stdout)[0]['State']['Running'],seconds=20)
    check('invalid launch rejected',json.loads(docker('inspect',bad).stdout)[0]['State']['ExitCode']!=0)
    check('failed launch did not modify DB',helper('snapshot')==before)
    start('main'); helper('create',n=19,text='Synthetic after safe return'); terminal('lab-job-19')
    check('return after failed launch uses existing DB',len(accepted('user:10019'))==1 and state('lab-job-2')==retired)
    check('attachments still readable unchanged',docker('exec',APP,'node','-e',"process.stdout.write(require('fs').readFileSync('/app/data/uploads/fixture.txt','utf8'))").stdout=='synthetic persistent attachment')
    check('no unsupported MAX routes or webhook registration',not control()['unexpected'],control()['unexpected'])
    stop()
    final=helper('snapshot')
    check('all synthetic job IDs preserved',set(f'lab-job-{n}' for n in range(1,20)) <= {j['id'] for j in final['jobs']})
    check('partial and corrupt FAILED remain terminal after all restarts',state('lab-job-5')==failed and state('lab-job-9')['status']=='FAILED' and state('lab-job-9')['payload']['deliveryProgress']['version']==99)
    check('all synthetic incidents and answers retained',len(final['incidents'])==5 and len(final['answers'])==5)
    save('final-synthetic-db.json',final); save('http-ledger.json',control())

ownership_confirmed = False
try:
    if os.environ.get('GITHUB_ACTIONS')!='true':
        raise RuntimeError('This runner is restricted to the approved disposable GitHub Actions environment')
    check('empty disposable daemon',not docker('ps','-aq').stdout.strip())
    ownership_confirmed = True
    build(); setup(); scenarios()
    report['benchmark']=helper('benchmark')
    save('benchmark.json',report['benchmark'])
    report['result']='passed'
except Exception:
    report['result']='failed'; report['error']=traceback.format_exc(); print(report['error'],flush=True)
    raise
finally:
    save('report.json',report)
    for name in docker('ps','-a','--format','{{.Names}}',check=False).stdout.splitlines():
        if name.startswith('reserve-lab-'):
            log=docker('logs',name,check=False); (OUT/(name+'.log')).write_text(log.stdout+log.stderr)
    if docker('inspect',MOCK,check=False).returncode==0:
        try: save('http-ledger.json',control())
        except Exception: pass

    if ownership_confirmed:
        # Only resources created by this lab; no global prune.
        for name in docker('ps','-a','--format','{{.Names}}').stdout.splitlines():
            if name.startswith('reserve-lab-'):
                if json.loads(docker('inspect',name).stdout)[0]['State']['Running']:
                    docker('kill','--signal=TERM',name)
                    docker('wait',name,timeout=90)
                docker('rm',name)
        if docker('volume','inspect',VOLUME,check=False).returncode==0: docker('volume','rm',VOLUME)
        if docker('network','inspect',NET,check=False).returncode==0: docker('network','rm',NET)
        remaining=docker('ps','-aq').stdout.strip()
        save('cleanup.json', {'remainingContainers':remaining,'volumeAbsent':docker('volume','inspect',VOLUME,check=False).returncode!=0,'networkAbsent':docker('network','inspect',NET,check=False).returncode!=0})
        check('owned lab cleaned without prune',not remaining)
