"""Exact historical checksum policy; no DB, environment or production access."""
import copy,hashlib,itertools,json,subprocess,sys,unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools/migration-kit/scripts'))
import migration_guard as g

class HistoricalChecksums(unittest.TestCase):
 def setUp(self):
  self.expected={'migrations':[[n,h[0],True,False] for n,h in g.HISTORICAL_CRLF.items()]+[['other','a'*64,True,False]],'columns':['unchanged'],'triggers':['unchanged']}
 def test_pinned_sql_reproduces_exact_hashes(self):
  for rev in g.VERSIONS.values():
   for name,(lf,crlf) in g.HISTORICAL_CRLF.items():
    with self.subTest(revision=rev,migration=name):
     raw=subprocess.check_output(['git','show',rev+':prisma/migrations/'+name+'/migration.sql'],cwd=ROOT)
     self.assertNotIn(b'\r',raw)
     transformed=raw.replace(b'\n',b'\r\n')
     self.assertEqual(transformed.replace(b'\r\n',b'\n'),raw)
     self.assertEqual(hashlib.sha256(raw).hexdigest(),lf)
     self.assertEqual(hashlib.sha256(transformed).hexdigest(),crlf)
 def test_all_four_variants_without_mutation(self):
  for flags in itertools.product((0,1),repeat=2):
   actual=copy.deepcopy(self.expected)
   for i,flag in enumerate(flags):actual['migrations'][i][1]=list(g.HISTORICAL_CRLF.values())[i][flag]
   before=copy.deepcopy(actual)
   self.assertTrue(g.schema_matches(actual,self.expected));self.assertEqual(actual,before)
 def test_unknown_swapped_other_migration_and_completion_refused(self):
  variants=list(g.HISTORICAL_CRLF.values())
  for index,field,value in [(0,1,'0'*64),(0,1,variants[1][1]),(2,1,variants[0][1]),(0,2,False),(1,3,True),(0,0,'different')]:
   actual=copy.deepcopy(self.expected);actual['migrations'][index][field]=value
   self.assertFalse(g.schema_matches(actual,self.expected))
 def test_schema_order_count_and_malformed_refused(self):
  for edit in [lambda a:a.update(columns=['changed']),lambda a:a.update(triggers=[]),lambda a:a['migrations'].reverse(),lambda a:a['migrations'].pop(),lambda a:a['migrations'].append(a['migrations'][0]),lambda a:a.update(migrations=None),lambda a:a['migrations'][0].append('extra')]:
   actual=copy.deepcopy(self.expected);edit(actual);self.assertFalse(g.schema_matches(actual,self.expected))
 def test_nonreviewed_expected_checksum_not_accepted(self):
  actual=copy.deepcopy(self.expected);expected=copy.deepcopy(self.expected)
  actual['migrations'][0][1]=list(g.HISTORICAL_CRLF.values())[0][1]
  expected['migrations'][0][1]=actual['migrations'][0][1]
  self.assertFalse(g.schema_matches(actual,expected))

if __name__=='__main__':unittest.main(verbosity=2)
