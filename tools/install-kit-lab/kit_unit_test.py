import copy,hashlib,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'migration-kit/scripts'))
import ops_common as o
import migration_guard as g
import policy_guard as p
from data_check import compare,value_hash

class Kit(unittest.TestCase):
 def test_data_comparison_exact_and_every_new_field(self):
  before={'format':'pr14-18-data-v1','tables':{'Incident':{'i':{'text':value_hash('Synthetic')}}}}
  after=copy.deepcopy(before)
  for k,v in {'slaPolicy':'LEGACY','slaDeliveredAt':None,'workingDeadlineQueuedAt':None}.items():after['tables']['Incident']['i'][k]=value_hash(v)
  self.assertEqual(compare(before,after,True),[])
  for key in after['tables']['Incident']['i']:
   changed=copy.deepcopy(after);changed['tables']['Incident']['i'][key]='changed'
   self.assertTrue(compare(before,changed,True))
 def test_cycles_dispositions_progress_missing_records_detected(self):
  tables={'IncidentAssignmentCycle':{'cycle':{'preparationDueAt':'a','outcome':'b'}},'OutboundMessage':{'job':{'status':value_hash('CANCELLED'),'cancelReason':'c','deliveryProgress':'d'}},'SystemSetting':{'fence':{'value':'e'}}}
  a={'format':'pr14-18-data-v1','tables':tables}
  for t,rows in tables.items():
   for k,fields in rows.items():
    for f in fields:
     b=copy.deepcopy(a);b['tables'][t][k][f]='wrong';self.assertTrue(compare(a,b))
    b=copy.deepcopy(a);del b['tables'][t][k];self.assertTrue(compare(a,b))
 def test_explicit_activation_partial_and_changed_settings(self):
  with tempfile.TemporaryDirectory() as d:
   s={'prepared':d,'policy':'WORKING_HOURS_V1'};Path(d,'migration-intent.json').write_text('{}')
   with patch.object(o,'require_lock'),patch.object(g,'ensure_new'),patch.object(o,'no_other_app'),patch.object(o,'clean'),patch.object(o,'app'):
    with self.assertRaises(o.Refusal):p.ensure_policy(s)
    with self.assertRaises(o.Refusal):p.activate(s,'wrong')
    p.activate(s,'activate-WORKING_HOURS_V1-for-new-incidents');p.ensure_policy(s)
    with self.assertRaises(o.Refusal):p.activate(s,'activate-WORKING_HOURS_V1-for-new-incidents')
    with self.assertRaises(o.Refusal):p.ensure_policy(dict(s,extra=True))
    Path(d,'policy-activation.json').write_text('{')
    with self.assertRaises(o.Refusal):p.ensure_policy(s)
 def test_real_flock_owner_foreign_unlocked_and_exception_release(self):
  import fcntl
  with tempfile.TemporaryDirectory() as d:
   path=Path(d,'backup.lock');path.touch();s={'backup_lock':str(path)}
   with path.open('rb') as a,path.open('rb') as b:
    fcntl.flock(a,fcntl.LOCK_EX|fcntl.LOCK_NB)
    with patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(a.fileno())):o.require_lock(s)
    with patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(b.fileno())):
     with self.assertRaisesRegex(o.Refusal,'BACKUP_LOCK_NOT_OWNED'):o.require_lock(s)
    fcntl.flock(a,fcntl.LOCK_UN)
    with patch.dict(os.environ,INCIDENT_OPS_LOCK_FD=str(b.fileno())):
     with self.assertRaisesRegex(o.Refusal,'BACKUP_LOCK_NOT_HELD'):o.require_lock(s)
   with self.assertRaisesRegex(RuntimeError,'synthetic'):
    with o.backup_lock(s):raise RuntimeError('synthetic')
   with o.backup_lock(s):pass

if __name__=='__main__':unittest.main(verbosity=2)
