"""Protocol/diagnostic checks only; real Docker/flock lives in exporter_test.py."""
import json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'migration-kit/scripts'))
import ops_common as o
from snapshot_exporter import Exporter,clean_stderr

class Protocol(unittest.TestCase):
 def test_original_eof_masks_both_phases(self):
  for phase in ['snapshot','data']:
   with self.subTest(phase=phase),self.assertRaises(TypeError):json.loads(None)
 def test_distinct_eof_and_timeout(self):
  for phase in ['snapshot','data']:
   for event,code in [(None,'EOF'),('timeout','TIMEOUT')]:
    with self.subTest(phase=phase,event=event):
     e=Exporter(['docker','run'],Path('.'))
     if event is None:e.lines.put(None)
     with self.assertRaisesRegex(o.Refusal,'EXPORTER_'+phase.upper()+'_'+code):e.read_json(phase,0)
 def test_invalid_json_and_non_object(self):
  for line,code in [('secret malformed','INVALID_JSON'),('[]','INVALID_OBJECT'),('null','INVALID_OBJECT')]:
   e=Exporter(['docker','run'],Path('.'));e.lines.put(line)
   with self.assertRaisesRegex(o.Refusal,'EXPORTER_DATA_'+code):e.read_json('data',0)
 def test_valid_protocol_preserved(self):
  e=Exporter(['docker','run'],Path('.'))
  for phase,item in [('snapshot',{'snapshot':'000-FFF-1'}),('data',{'format':'pr14-18-data-v1','tables':{}})]:
   e.lines.put(json.dumps(item));self.assertEqual(e.read_json(phase,0),item)
 def test_stderr_contains_only_allowed_technical_signatures(self):
  raw='postgresql://user:SYNTHETIC_SECRET@host/db resident-phone text '+ 'libquery_engine P1001 Node.js v22.23.3 Segmentation fault'
  clean=clean_stderr(raw)
  self.assertEqual(clean,{'markers':['SEGMENTATION_FAULT','PRISMA_ENGINE'],'prismaCodes':['P1001'],'nodeVersions':['v22.23.3'],'rawTextOmitted':True})
  self.assertNotIn('SYNTHETIC_SECRET',json.dumps(clean));self.assertNotIn('resident',json.dumps(clean))

if __name__=='__main__':unittest.main(verbosity=2)
