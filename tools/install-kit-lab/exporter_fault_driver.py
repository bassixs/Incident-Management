"""Test-only injection. Production capture/locks/restore guards stay real."""
import importlib.util,sys
from pathlib import Path
SCRIPTS=Path(__file__).resolve().parents[1]/'migration-kit/scripts'
sys.path.insert(0,str(SCRIPTS))
import ops_common as o
spec=importlib.util.spec_from_file_location('backup',SCRIPTS/'backup-data.py')
b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
original=b.node
settings,destination,fixture=sys.argv[1:]
def injected(s,env,network,script,*args):
 cmd=original(s,env,network,script,*args)
 if script=='data-snapshot.cjs' and '--export' in args:
  at=cmd.index('--entrypoint');cmd[at:at]=['--mount',f'type=bind,src={Path(fixture).parent},dst=/faults,readonly']
  cmd[cmd.index('/ops/'+script)]='/faults/'+Path(fixture).name
 return cmd
b.node=injected
try:b.capture(o.settings(settings),'old',Path(destination))
except Exception as e:
 print('BACKUP_REFUSED:'+ (str(e) if isinstance(e,o.Refusal) else type(e).__name__),file=sys.stderr);sys.exit(2)
