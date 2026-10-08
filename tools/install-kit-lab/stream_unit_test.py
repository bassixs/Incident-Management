import copy,hashlib,json,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'migration-kit/scripts'))
import ops_common as o
from data_stream import receive,report,differences,FORMAT
from snapshot_exporter import Exporter
H='a'*64
class Stream:
 def __init__(self,frames):self.frames=iter(frames)
 def read_json(self,phase,timeout):
  try:f=next(self.frames)
  except StopIteration:raise o.Refusal('EXPORTER_DATA_EOF')
  self.last_line=json.dumps(f,separators=(',',':'),ensure_ascii=False)+'\n';return f

def frames(rows=2):
 result=[{'format':FORMAT,'type':'begin'},{'type':'table','table':'Synthetic','columns':['id','payload']}]
 result += [{'type':'row','table':'Synthetic','id':str(i),'fields':{'id':H,'payload':H}} for i in range(rows)]
 sha=hashlib.sha256(''.join(json.dumps(f,separators=(',',':'))+'\n' for f in result).encode()).hexdigest()
 return result+[{'type':'end','rows':rows,'fields':rows*2,'tables':1,'sha256':sha}]

class Streaming(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
 def index(self,name,items):
  d=self.root/name;d.mkdir();m=receive(Stream(items),d/'data.sqlite');o.save_new(d/'data.json',m);return d/'data.json'
 def test_exact_and_private_files(self):
  a=self.index('a',frames());b=self.index('b',frames())
  self.assertEqual(report(a,b,self.root/'report.json'),0)
  self.assertEqual(json.loads((self.root/'report.json').read_text())['differenceCount'],0)
 def test_truncated_at_every_frame(self):
  for n in range(len(frames())):
   with self.subTest(n=n),self.assertRaisesRegex(o.Refusal,'EOF'):self.index(str(n),frames()[:n])
 def test_duplicates(self):
  for what in ['row','table']:
   f=frames();f.insert(3,copy.deepcopy(f[2 if what=='row' else 1]))
   with self.subTest(what=what),self.assertRaisesRegex(o.Refusal,'DUPLICATE'):self.index(what,f)
 def test_omission_or_corruption(self):
  for what in ['row','field','digest','count']:
   f=frames()
   if what=='row':del f[2]
   elif what=='field':del f[2]['fields']['payload']
   elif what=='digest':f[-1]['sha256']='b'*64
   else:f[-1]['rows']=3
   with self.subTest(what=what),self.assertRaises(o.Refusal):self.index(what,f)
 def test_differences_streamed(self):
  a=self.index('a',frames(5000));b=self.index('b',frames(0))
  self.assertEqual(report(a,b,self.root/'report.json'),5000)
 def test_index_mutation_refused(self):
  a=self.index('a',frames());b=self.index('b',frames());(b.parent/'data.sqlite').write_bytes(b'broken')
  with self.assertRaisesRegex(o.Refusal,'CHECKSUM'):list(differences(a,b))
 def test_empty_table_difference(self):
  a=self.index('a',frames(0));f=frames(0);f[1]['table']='Other'
  f[-1]['sha256']=hashlib.sha256(''.join(json.dumps(x,separators=(',',':'))+'\n' for x in f[:-1]).encode()).hexdigest()
  b=self.index('b',f);self.assertEqual(len(list(differences(a,b))),2)
 def test_receiver_queue_is_bounded(self):
  e=Exporter(['docker','run'],self.root);self.assertEqual(e.lines.maxsize,8)
 def test_oversize_frame_refused(self):
  e=Exporter(['docker','run'],self.root);e.lines.put('FRAME_TOO_LARGE')
  with self.assertRaisesRegex(o.Refusal,'FRAME_TOO_LARGE'):e.read_json('data',0)
 def test_legacy_snapshot_refused(self):
  d=self.root/'legacy.json';d.write_text('{"format":"pr14-18-data-v1","tables":{}}')
  with self.assertRaisesRegex(o.Refusal,'SNAPSHOT_V2_REQUIRED'):list(differences(d,d))
if __name__=='__main__':unittest.main(verbosity=2)
