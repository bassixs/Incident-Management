"""Full custom dump/restore on disposable PostgreSQL. No production inputs."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

OUT = Path('restore-results'); OUT.mkdir(exist_ok=True)
PG = 'migration-kit-postgres'
report = {'checks': [], 'scope': 'synthetic empty GitHub runner'}

def run(*args, data=None, check=True):
    p = subprocess.run(args, input=data, text=True, capture_output=True, timeout=300)
    if check and p.returncode:
        raise RuntimeError(str(args[:4])+p.stdout[-2000:]+p.stderr[-2000:])
    return p

def sql(query, db='source', check=True):
    return run('docker','exec','-i',PG,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','synthetic','-d',db,data=query,check=check)

def expect(name, condition, details=None):
    report['checks'].append({'name':name,'passed':bool(condition),'details':details})
    (OUT/'report.json').write_text(json.dumps(report,indent=2))
    print(('PASS ' if condition else 'FAIL ')+name,flush=True)
    if not condition: raise AssertionError(name)

def fingerprint(db):
    tables=sql("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1",db).stdout.splitlines()
    result={}
    for table in tables:
        result[table]=sql(f'''SELECT count(*)||':'||md5(coalesce(string_agg(doc,E'\\n' ORDER BY doc),'')) FROM (SELECT row_to_json(t)::text doc FROM "{table}" t) s''',db).stdout.strip()
    result['sequences']=sql("SELECT sequencename||':'||last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1",db).stdout
    result['guards']=sql("SELECT c.relname||':'||t.tgenabled||':'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='guard_retired_storage' ORDER BY 1",db).stdout
    result['function']=sql("SELECT pg_get_functiondef('guard_retired_storage_reference'::regproc)",db).stdout
    return result

TABLES={
 'IncidentAttachment':('"incidentId",type,"storageKey"',"'i','IMAGE','key-'||n",'storageKey'),
 'AnswerAttachment':('"answerId",type,"storageKey"',"'a','FILE','key-'||n",'storageKey'),
 'ClarificationAttachment':('"clarificationId",type,"storageKey"',"'c','FILE','key-'||n",'storageKey'),
 'InboundUpdate':('"externalUpdateKey","updateType",payload,"updatedAt"',"'event-'||n,'synthetic',jsonb_build_object('storageKey','key-'||n),now()",'payload'),
 'OutboundMessage':('"targetType","targetId",payload,attachments,"updatedAt"',"'user',n,jsonb_build_object('deliveryProgress',jsonb_build_object('version',1,'mids',jsonb_build_array('synthetic-confirmed-mid'))),jsonb_build_array(jsonb_build_object('storageKey','key-'||n)),now()",'attachments'),
 'OperatorSession':('"maxUserId","chatId",type,data,"expiresAt"',"n,n,'WAITING_INCIDENT_CONFIRMATION',jsonb_build_object('storageKey','key-'||n),'2099-01-01'",'data'),
 'PrivateWorkItem':('"maxUserId","incidentId","originChatId",data,"updatedAt"',"1,'i',n,jsonb_build_object('storageKey','key-'||n),now()",'data'),
}

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Disposable Actions runner required')
    if run('docker','ps','-aq').stdout.strip(): raise RuntimeError('Nonempty Docker daemon')
    run('docker','run','-d','--name',PG,'--cpus','1','--memory','768m','-p','127.0.0.1:5432:5432','-e','POSTGRES_USER=synthetic','-e','POSTGRES_PASSWORD=synthetic-only','-e','POSTGRES_DB=source','postgres:16-alpine')
    try:
        import time
        deadline=time.monotonic()+60
        while run('docker','exec',PG,'pg_isready','-U','synthetic',check=False).returncode:
            if time.monotonic()>deadline: raise TimeoutError('Postgres readiness')
            time.sleep(.25)
        env=dict(os.environ,DATABASE_URL='postgresql://synthetic:synthetic-only@127.0.0.1:5432/source')
        p=subprocess.run(['npx','prisma','migrate','deploy'],env=env,capture_output=True,text=True,timeout=180)
        (OUT/'migrate.txt').write_text(p.stdout+p.stderr)
        expect('all candidate migrations applied',p.returncode==0)
        sql('''INSERT INTO "User" (id,"maxUserId","displayName","updatedAt") VALUES ('u',1,'Synthetic',now());
INSERT INTO "Incident" (id,"publicCode","requesterId","requesterMaxUserId","requesterName",text,"deadlineAt","updatedAt") VALUES ('i','INC-SYNTHETIC','u',1,'Synthetic','Synthetic','2099-01-01',now());
INSERT INTO "IncidentAnswer" (id,"incidentId",version,text,"createdByUserId","updatedAt") VALUES ('a','i',1,'Synthetic','u',now());
INSERT INTO "Clarification" (id,"incidentId",question,"askedByUserId","askedByMaxUserId","chatId","questionSourceId") VALUES ('c','i','Synthetic','u',1,1,'synthetic');
INSERT INTO "SystemSetting" (key,value,"updatedAt") VALUES
('retention.file-fence.v1:'||encode(sha256(convert_to('retired-key','UTF8')),'hex'),'PERMANENT_STORAGE_KEY_RETIREMENT_V1',now()),
('retention.file-delete.v1:'||encode(sha256(convert_to('pending-key','UTF8')),'hex'),'{"version":1,"storageKey":"pending-key","size":1,"publicCode":"INC-SYNTHETIC"}',now()),
('retention.file-state.v1:'||encode(sha256(convert_to('pending-key','UTF8')),'hex'),'{"version":1,"attempts":1,"status":"unknown","nextAttemptAt":0,"reason":"STORAGE_RESULT_UNKNOWN"}',now());''')
        for idx,(table,(columns,values,_)) in enumerate(TABLES.items()):
            for start in range(1,5001,250):
                lo=idx*5000+start; hi=lo+249
                sql(f'''INSERT INTO "{table}" (id,{columns}) SELECT '{table}-'||n,{values} FROM generate_series({lo},{hi}) n''')
        report['settings']=sql("SELECT name||'='||setting FROM pg_settings WHERE name IN ('max_connections','max_locks_per_transaction','max_prepared_transactions') ORDER BY 1").stdout
        baseline=fingerprint('source'); (OUT/'baseline.json').write_text(json.dumps(baseline,indent=2))
        expect('seven enabled guards and 35000 distinct referenced keys',len(baseline['guards'].splitlines())==7 and all(':O:' in x for x in baseline['guards'].splitlines()))
        run('docker','exec',PG,'pg_dump','-U','synthetic','-d','source','-Fc','-f','/tmp/full.dump')
        run('docker','cp',PG+':/tmp/full.dump',str(OUT/'synthetic.dump'))
        report['dumpSha256']=hashlib.sha256((OUT/'synthetic.dump').read_bytes()).hexdigest()
        toc=run('docker','exec',PG,'pg_restore','-l','/tmp/full.dump').stdout
        (OUT/'toc.txt').write_text(toc)
        for target,single in [('restored',False),('atomic_restore',True)]:
            run('docker','exec',PG,'createdb','-U','synthetic',target)
            args=['docker','exec',PG,'pg_restore','-U','synthetic','-d',target,'--no-owner','--no-privileges','--exit-on-error']
            if single: args+=['--single-transaction']
            p=run(*args,'/tmp/full.dump',check=False)
            (OUT/(target+'.txt')).write_text(p.stdout+p.stderr)
            expect(target+' full restore',p.returncode==0)
            actual=fingerprint(target);(OUT/(target+'-fingerprint.json')).write_text(json.dumps(actual,indent=2))
            expect(target+' exact all table rows, sequences, migrations, trigger/function definitions',actual==baseline)
            for idx,(table,(_,_,field)) in enumerate(TABLES.items()):
                row=f'{table}-{idx*5000+1}'
                def change(key):
                    v=f"'{key}'" if field=='storageKey' else (f"jsonb_build_array(jsonb_build_object('storageKey','{key}'))" if field=='attachments' else f"jsonb_build_object('storageKey','{key}')")
                    return f'''BEGIN; UPDATE "{table}" SET "{field}"={v} WHERE id='{row}'; ROLLBACK;'''
                expect(target+' '+table+' permits fresh reference',sql(change('fresh-'+table),target,False).returncode==0)
                refused=sql(change('retired-key'),target,False)
                expect(target+' '+table+' rejects retired reference',refused.returncode!=0 and 'STORAGE_KEY_RETIRED' in refused.stderr)
            expect(target+' guard probes rolled back',fingerprint(target)==baseline)
        report['success']=True
    finally:
        (OUT/'report.json').write_text(json.dumps(report,indent=2))
        logs=run('docker','logs',PG,check=False);(OUT/'postgres.log').write_text(logs.stdout+logs.stderr)
        run('docker','stop','-t','30',PG);run('docker','rm','-v',PG)

if __name__=='__main__': main()
