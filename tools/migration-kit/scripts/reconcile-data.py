"""Report all differences to a private file. No heuristic success for mutations."""
import argparse,json,os,sys
from pathlib import Path
from data_check import compare
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--before',required=True);p.add_argument('--after',required=True);p.add_argument('--report',required=True);p.add_argument('--migrated',action='store_true');a=p.parse_args()
 result=compare(json.loads(Path(a.before).read_text()),json.loads(Path(a.after).read_text()),a.migrated)
 with open(a.report,'x',encoding='utf-8') as f:
  os.chmod(a.report,0o600);json.dump({'differences':result,'automaticAcceptance':not result},f)
 print('DATA_EXACT' if not result else 'DATA_REVIEW_REQUIRED:'+str(len(result)))
 sys.exit(2 if result else 0)
