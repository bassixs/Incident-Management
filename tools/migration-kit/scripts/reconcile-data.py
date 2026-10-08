"""Stream all differences to a private file. Never accumulate the database."""
import argparse,sys
from data_stream import report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--before',required=True);p.add_argument('--after',required=True);p.add_argument('--report',required=True);p.add_argument('--migrated',action='store_true');a=p.parse_args()
 count=report(a.before,a.after,a.report,a.migrated)
 print('DATA_EXACT' if not count else 'DATA_REVIEW_REQUIRED:'+str(count))
 sys.exit(2 if count else 0)
