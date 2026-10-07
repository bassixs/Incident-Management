"""Migration-aware extension to R4. Ledger is write-ahead and never auto-reset.

No rollback SQL; no schema repair; unknown outcome requires separate review.
"""
import json
from pathlib import Path
import re
import ops_common as o
import unapplied_resume as u

ROOT=Path(__file__).resolve().parent
VERSIONS={'old':'59149006a7b3d30d01218fad84360e7d71e6d79e',
 'main':'c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a',
 'reserve':'3c5c38b0f6477d5124593406f09f3af4c2db0c12'}

# Exact historical representations, verified against the pinned SQL sources.
# Only actual checksum cells are compared through this allowlist. The reviewed
# manifest, migration names/order/completion flags and every schema field remain
# unchanged. No database history or SQL file is rewritten.
HISTORICAL_CRLF={
 '20260906000000_sla_day_one_reminder':(
  'ae937553357266f941dc9ede8264cf5b12ac80f2410f70abc7684b2a1aecf39c',
  'dee2d4053518eeb04d4ea71e0489329d223e4a7c50cb67bc5ffb9db54497efbb'),
 '20260906120000_clarifications':(
  'a1cde4275a0d5190435a23fbc831bc5b187f999c9ff97580b2683117b31c0322',
  '053d0542c57a3459f3bade7c1e5301cc1d4088f5cd3e7797a5f6787ba1002429'),
}

def schema_matches(actual,expected):
    if not isinstance(actual,dict) or not isinstance(actual.get('migrations'),list):
        return False
    rows=[]
    for row in actual['migrations']:
        if not isinstance(row,list) or len(row)!=4:
            return False
        copy=list(row)
        variants=HISTORICAL_CRLF.get(copy[0]) if isinstance(copy[0],str) else None
        if variants and copy[1]==variants[1]:copy[1]=variants[0]
        rows.append(copy)
    return dict(actual,migrations=rows)==expected

def configuration(s):
    o.need(s.get('kit')=='pr14-18-v1','KIT_EDITION_MISMATCH')
    o.need(s.get('policy') in ('LEGACY','WORKING_HOURS_V1'),'POLICY_SELECTION_REQUIRED')
    m=s.get('migration')
    o.need(isinstance(m,dict),'MIGRATION_CONFIGURATION_REQUIRED')
    o.need({k:v['revision'] for k,v in s['images'].items()}==VERSIONS,'MIGRATION_VERSION_MISMATCH')
    for name in ('network','container'):
        o.need(isinstance(m.get(name),str) and bool(re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]+',m[name])), 'MIGRATION_NAME_INVALID')
    manifest=Path(m['manifest'])
    o.need(manifest.is_absolute() and manifest.is_file() and not manifest.is_symlink(),'MIGRATION_MANIFEST_REQUIRED')
    o.need(o.sha(manifest.read_bytes())==m.get('manifest_sha256'),'MIGRATION_MANIFEST_CHANGED')
    expected=o.read_json(manifest)
    o.need(expected.get('versions')==VERSIONS,'MIGRATION_MANIFEST_VERSIONS')
    o.need(expected.get('probe_sha256')==o.sha((ROOT/'schema-probe.cjs').read_bytes()),'SCHEMA_PROBE_CHANGED')
    o.need(isinstance(m.get('identity'),dict) and set(m['identity'])=={'system','database','oid'},'DATABASE_IDENTITY_REQUIRED')
    return m,expected

def ledger(s): return Path(s['prepared'])/'migration-intent.json'

def probe(s):
    configuration(s)
    o.runtime(s)
    iid=s['images']['main']['id'];o.image(s,iid)
    result=o.command(['docker','run','--rm','--network',s['migration']['network'],
       '--cpus','0.5','--memory','384m','--pids-limit','128','--env-file',str(Path(s['install'])/'private/runtime.env'),
       '--mount',f'type=bind,src={ROOT},dst=/ops,readonly',
       '--entrypoint','node',iid,'/ops/schema-probe.cjs'],timeout=30)
    try: value=json.loads(result.stdout)
    except ValueError: raise o.Refusal('SCHEMA_PROBE_INVALID') from None
    o.need(value.get('identity')==s['migration']['identity'],'DATABASE_IDENTITY_CHANGED')
    return value['schema']

def assert_schema(s,kind):
    _,expected=configuration(s)
    o.need(schema_matches(probe(s),expected[kind]), 'DATABASE_SCHEMA_NOT_'+kind.upper())

def no_migrator(s,absent=False):
    # A failed daemon query never establishes absence. Stopped old records stay.
    names=o.output(['docker','ps','-a','--format','{{json .}}'])
    for line in names.splitlines():
        try: name=json.loads(line)['Names']
        except (ValueError,KeyError): raise o.Refusal('INVALID_INVENTORY') from None
        if name==s['migration']['container']:
            o.need(not absent,'MIGRATION_CONTAINER_ALREADY_EXISTS')
            row=o.inspect(name)
            o.need(not row['State']['Running'],'MIGRATION_STILL_RUNNING')

def ensure_cancel(s):
    configuration(s)
    o.need(not ledger(s).exists() and not ledger(s).is_symlink()
           and not ledger(s).with_name('migration-intent.json.ops-next').exists(),'MIGRATION_ALREADY_STARTED')
    no_migrator(s,absent=True)
    assert_schema(s,'old')

def ensure_new(s):
    configuration(s)
    path=ledger(s)
    o.need(path.is_file() and not path.is_symlink(),'MIGRATION_RECEIPT_REQUIRED')
    v=o.read_json(path)
    o.need(v.get('state')=='complete' and v.get('settingsHash')==u.digest(s)
           and v.get('identity')==s['migration']['identity'],'MIGRATION_RESULT_UNKNOWN')
    no_migrator(s)
    c=o.inspect(s['migration']['container'])
    o.need(c['Id']==v.get('containerId') and c['Image']==s['images']['main']['id']
           and c['State']['Status']=='exited' and c['State']['ExitCode']==0
           and not c['State']['OOMKilled'],'MIGRATION_CONTAINER_MISMATCH')
    assert_schema(s,'new')

def before_stop(s,image):
    if image==s['images']['old']['id']: ensure_cancel(s)
    else: ensure_new(s)

def migrate(s,name):
    o.require_lock(s)
    m,_=configuration(s);run=o.run_dir(s,name)
    c=o.app(s);o.clean(c)
    o.need(c['Image']==s['images']['old']['id'],'MIGRATION_REQUIRES_OLD_STOPPED')
    o.receipt(s,run,c);o.no_other_app(s)
    ensure_cancel(s)
    # Prove this exact R4 stop remains cancellable before making it irrevocable.
    u.validate(s,run,c['Image'],(run/'stop-receipt.json').read_bytes())
    record={'state':'started','at':o.stamp(),'identity':m['identity'],'settingsHash':u.digest(s),
            'stopReceiptHash':o.sha((run/'stop-receipt.json').read_bytes()),'containerName':m['container']}
    u.record_new(ledger(s),record)  # fsync before even attempting Docker creation
    o.no_other_app(s)
    # No app entrypoint, only Prisma CLI. A timeout leaves durable unknown state;
    # the container may still be running and must not be removed or retried.
    result=o.command(['docker','run','--name',m['container'],'--restart','no',
       '--network',m['network'],'--cpus','0.5','--memory','384m','--pids-limit','128',
       '--env-file',str(Path(s['install'])/'private/runtime.env'),
       '--entrypoint','node',s['images']['main']['id'],'node_modules/prisma/build/index.js','migrate','deploy'],
       timeout=180,allow_failure=True)
    o.need(result.returncode==0,'MIGRATION_FAILED_OR_UNKNOWN')
    no_migrator(s);current=o.inspect(m['container'])
    o.need(current['Image']==s['images']['main']['id'] and current['State']['Status']=='exited'
           and current['State']['ExitCode']==0 and not current['State']['OOMKilled'],'MIGRATION_FAILED_OR_UNKNOWN')
    assert_schema(s,'new')
    record.update(state='complete',containerId=current['Id'],completedAt=o.stamp())
    o.atomic(ledger(s),json.dumps(record).encode(),ledger(s).read_bytes());u.sync_directory(ledger(s).parent)
    ensure_new(s)
