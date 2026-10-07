"""Full synthetic restore; the source DB is never overwritten."""
import hashlib
import json

def run_restore(docker, sql, helper, check, out, pg, volume):
    def query(q, db='reserve_lab', ok=True):
        return docker('exec','-i',pg,'psql','-XAt','-v','ON_ERROR_STOP=1','-U','lab','-d',db,data=q,check=ok)
    def fingerprint(db):
        tables=query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1",db).stdout.splitlines()
        result={}
        for table in tables:
            result[table]=query(f"SELECT count(*)||':'||md5(coalesce(string_agg(doc,E'\\n' ORDER BY doc),'')) FROM (SELECT row_to_json(t)::text doc FROM \"{table}\" t) s",db).stdout.strip()
        result['sequences']=query("SELECT sequencename||':'||last_value FROM pg_sequences WHERE schemaname='public' ORDER BY 1",db).stdout
        result['guards']=query("SELECT c.relname||':'||t.tgenabled::text||':'||pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname='guard_retired_storage' ORDER BY 1",db).stdout
        result['enum']=query("SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='OutboxStatus' ORDER BY enumsortorder",db).stdout
        result['function']=query("SELECT pg_get_functiondef('guard_retired_storage_reference'::regproc)",db).stdout
        return result
    before=fingerprint('reserve_lab')
    docker('exec',pg,'pg_dump','-U','lab','-d','reserve_lab','-Fc','-f','/tmp/new-schema.dump')
    docker('cp',pg+':/tmp/new-schema.dump',out/'synthetic-new-schema.dump')
    docker('exec',pg,'createdb','-U','lab','restored')
    result=docker('exec',pg,'pg_restore','-U','lab','-d','restored','--no-owner','--no-privileges','--exit-on-error','--single-transaction','/tmp/new-schema.dump')
    (out/'restore.log').write_text(result.stdout+result.stderr)
    check('full new-schema restore exact rows sequences migrations and guards',fingerprint('restored')==before)
    check('seven enabled restored file guards',len(before['guards'].splitlines())==7 and all(':O:' in x for x in before['guards'].splitlines()))
    targets={'IncidentAttachment':('storageKey','preserved-attachment'), 'AnswerAttachment':('storageKey',''), 'ClarificationAttachment':('storageKey',''), 'InboundUpdate':('payload','delayed-head'), 'OutboundMessage':('attachments','preserved-failed-0'), 'OperatorSession':('data','preserved-draft'), 'PrivateWorkItem':('data','policy-private')}
    # Insert synthetic rows only in the restored DB to exercise missing attachment tables.
    query("INSERT INTO \"Clarification\" (id,\"incidentId\",question,\"askedByUserId\",\"askedByMaxUserId\",\"chatId\",\"questionSourceId\") VALUES ('restore-c','preserved-incident','Synthetic','preserved-user',99001,-99009,'Synthetic'); INSERT INTO \"ClarificationAttachment\" (id,\"clarificationId\",type,\"storageKey\") VALUES ('restore-ca','restore-c','FILE','fresh-ca'); INSERT INTO \"AnswerAttachment\" (id,\"answerId\",type,\"storageKey\") VALUES ('restore-aa','preserved-answer','FILE','fresh-aa');",'restored')
    targets['AnswerAttachment']=('storageKey','restore-aa');targets['ClarificationAttachment']=('storageKey','restore-ca')
    for table,(field,row) in targets.items():
        value="'unknown-delete.txt'" if field=='storageKey' else ("'[ {\"storageKey\":\"unknown-delete.txt\"} ]'::jsonb" if field=='attachments' else "'{\"storageKey\":\"unknown-delete.txt\"}'::jsonb")
        result=query(f'BEGIN; UPDATE "{table}" SET "{field}"={value} WHERE id=\'{row}\'; ROLLBACK;', 'restored',False)
        check('restored '+table+' refuses retired key', result.returncode!=0 and 'STORAGE_KEY_RETIRED' in result.stderr)
    check('source untouched by restore and guard probes',fingerprint('reserve_lab')==before)
    (out/'restore-fingerprint.json').write_text(json.dumps(before,indent=2))
    (out/'synthetic-new-schema.dump.sha256').write_text(hashlib.sha256((out/'synthetic-new-schema.dump').read_bytes()).hexdigest()+'  synthetic-new-schema.dump\n')
