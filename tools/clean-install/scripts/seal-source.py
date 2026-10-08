"""Seal a verified stopped-source final backup; never captures, stops or writes the source DB."""
import argparse,json,pathlib,subprocess,sys,datetime,secrets
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from clean import need,load,sha,inspect,save,IMAGES,o,stamp

def seal(backup,receipt,dest):
 b=pathlib.Path(backup);r=load(receipt);m=load(b/'backup.json');v=load(b/'restore-result.json');d=pathlib.Path(dest)
 need(not d.exists(),'NEW_ENVELOPE_REQUIRED')
 for n,h in load(b/'checksums.json').items():need(pathlib.Path(n).name==n and sha(b/n)==h,'BACKUP_CHECKSUM_MISMATCH')
 need(r.get('clean') is True and r['identity']==m['application'] and m.get('finalRun'),'STOP_RECEIPT_MISMATCH')
 need(m['application']['image'] in (*IMAGES['main'][:2],*IMAGES['reserve'][:2]),'SOURCE_IMAGE_NOT_REVIEWED')
 x=inspect(r['identity']['id']);need(not x['State']['Running'] and x['State']['Status']=='exited' and x['State']['ExitCode']==0 and not x['State']['OOMKilled'],'SOURCE_NOT_CLEANLY_STOPPED')
 need(o.identity(x)==r['identity'],'SOURCE_CONTAINER_CHANGED')
 need(datetime.datetime.fromisoformat(m['createdAt'])>=datetime.datetime.fromisoformat(r['finishedAt'].replace('Z','+00:00')),'BACKUP_PRECEDES_STOP')
 need(v.get('databaseRows')==v.get('schema')==v.get('files')=='exact' and load(b/'restore-differences.json')['differenceCount']==0 and v['backupChecksumsSha256']==sha(b/'checksums.json'),'RESTORE_NOT_VERIFIED')
 # Another instance with the same identity token is not an allowed source.
 token=dict(i.split('=',1) for i in x['Config']['Env'] if '=' in i).get('BOT_TOKEN');need(bool(token),'BOT_IDENTITY_MISSING')
 from clean import run
 for cid in run(['docker','ps','-q']).split():need(dict(i.split('=',1) for i in inspect(cid)['Config'].get('Env',[]) if '=' in i).get('BOT_TOKEN')!=token,'SOURCE_SECOND_APP_RUNNING')
 save(d,{'format':'source-fence-v1','at':stamp(),'sourceStopped':True,'sourceIdentity':r['identity'],'sourceFinishedAt':r['finishedAt'],'backupChecksums':sha(b/'checksums.json'),'stopReceiptHash':sha(receipt),'handoffCode':secrets.token_hex(16),'contract':'Source must remain stopped. A fresh confirmation from source operator is required immediately before first target start.'});print('SOURCE_FENCE_SEALED_KEEP_SOURCE_STOPPED')
if __name__=='__main__':
 try:
  a=argparse.ArgumentParser();a.add_argument('--backup',required=True);a.add_argument('--stop-receipt',required=True);a.add_argument('--output',required=True);v=a.parse_args();seal(v.backup,v.stop_receipt,v.output)
 except Exception as e:print('SOURCE_SEAL_REFUSED:'+(str(e) if isinstance(e,o.Refusal) else type(e).__name__),file=sys.stderr);sys.exit(2)
