"""Test-only write AFTER exported fingerprints, BEFORE pg_dump imports snapshot."""
import importlib.util,subprocess,sys
from pathlib import Path
SCRIPTS=Path(__file__).resolve().parents[1]/'migration-kit/scripts';sys.path.insert(0,str(SCRIPTS))
import ops_common as o
spec=importlib.util.spec_from_file_location('backup',SCRIPTS/'backup-data.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
s=o.settings(sys.argv[1]);original=subprocess.run
seen=False

def run(cmd,*args,**kw):
 global seen
 if 'pg_dump' in cmd:
  if seen:raise RuntimeError('Duplicate pg_dump')
  seen=True
  original(['docker','exec',s['backup']['postgres'],'psql','-XqAt','-v','ON_ERROR_STOP=1','-U',s['backup']['user'],'-d',s['backup']['database'],'-c',"INSERT INTO \"SystemSetting\"(key,value,\"updatedAt\") VALUES ('after-export-fence','synthetic concurrent write',now())"],check=True,capture_output=True,timeout=10)
 return original(cmd,*args,**kw)
b.subprocess.run=run
b.capture(s,'old',Path(sys.argv[2]))
if not seen:raise RuntimeError('Snapshot fence not exercised')
