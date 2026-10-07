"""Targeted metadata gate tests; temp files, simulated Docker/DB/lock only."""
import contextlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS=Path(__file__).resolve().parents[1]/'migration-kit/scripts'
sys.path.insert(0,str(SCRIPTS))
import ops_common as o
import migration_guard as g
import unapplied_resume as u

class Metadata(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        root=Path(self.tmp.name);self.root=root
        manifest=root/'manifest.json'
        manifest.write_text(json.dumps({'versions':g.VERSIONS,'image_ids':{k:[v] for k,v in g.IMAGE_IDS.items()},'probe_sha256':o.sha((SCRIPTS/'schema-probe.cjs').read_bytes()),'old':{'state':'old','migrations':[]},'new':{'state':'new','migrations':[]}}))
        self.s={'kit':'pr14-18-v1','policy':'LEGACY','install':str(root),'prepared':str(root),'backup_script':str(root/'backup.py'),'releases':str(root/'releases'),
          'images':{k:{'id':g.IMAGE_IDS[k],'revision':v} for n,(k,v) in enumerate(g.VERSIONS.items(),1)},
          'migration':{'network':'synthetic-net','container':'synthetic-migrate','manifest':str(manifest),'manifest_sha256':o.sha(manifest.read_bytes()),'identity':{'system':'1','database':'synthetic','oid':'1'}}}
        for rev in g.VERSIONS.values():(root/'releases'/rev/'project').mkdir(parents=True)
        self.backup=root/'backup.py'
        self.before=("REV = '"+g.VERSIONS['old']+"'\nIMAGE = '"+self.s['images']['old']['id']+"'\ndef copy_snapshot():\n copy_tree(Path('"+(root/'releases'/g.VERSIONS['old']/'project').as_posix()+"'), stage / 'project')\n")
        self.backup.write_text(self.before)
        self.schema={'state':'new','migrations':[]}
        self.stack=contextlib.ExitStack();self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(o,'require_lock'))
        self.stack.enter_context(patch.object(o,'output',return_value=''))
        self.stack.enter_context(patch.object(o,'inspect',return_value={'Id':'migration-cid','Image':self.s['images']['main']['id'],'State':{'Running':False,'Status':'exited','ExitCode':0,'OOMKilled':False}}))
        self.stack.enter_context(patch.object(g,'probe',side_effect=lambda s:self.schema))
        self.stack.enter_context(patch.object(o,'image',return_value='main'))
        self.stack.enter_context(patch.object(o,'app',return_value={'Id':'main-cid','Image':self.s['images']['main']['id'],'State':{'Running':True}}))
        self.stack.enter_context(patch.object(o,'no_other_app'))
        self.stack.enter_context(patch.object(o,'config'))
        self.stack.enter_context(patch.object(o,'wait_ready'))

    def complete(self):
        g.ledger(self.s).write_text(json.dumps({'state':'complete','identity':self.s['migration']['identity'],'settingsHash':u.digest(self.s),'containerId':'migration-cid'}))

    def update(self):
        o.metadata(self.s,g.VERSIONS['old'],self.s['images']['old']['id'],g.VERSIONS['main'],self.s['images']['main']['id'])

    def test_without_migration_receipt_never_writes(self):
        with self.assertRaisesRegex(o.Refusal,'MIGRATION_RECEIPT_REQUIRED'):self.update()
        self.assertEqual(self.backup.read_text(),self.before)

    def test_partial_actual_schema_never_writes(self):
        self.complete();self.schema={'state':'partial'}
        with self.assertRaisesRegex(o.Refusal,'DATABASE_SCHEMA_NOT_NEW'):self.update()
        self.assertEqual(self.backup.read_text(),self.before)

    def test_unexpected_original_metadata_never_writes(self):
        self.complete();changed=self.before.replace("REV = '","REV = 'changed-")
        self.backup.write_text(changed)
        with self.assertRaisesRegex(o.Refusal,'UNEXPECTED_BACKUP_METADATA'):self.update()
        self.assertEqual(self.backup.read_text(),changed)

    def test_exact_complete_state_changes_only_three_expected_lines(self):
        self.complete();self.update()
        expected=self.before.replace(g.VERSIONS['old'],g.VERSIONS['main']).replace(self.s['images']['old']['id'],self.s['images']['main']['id'])
        self.assertEqual(self.backup.read_text(),expected)
        self.assertEqual(sum(a!=b for a,b in zip(self.before.splitlines(),expected.splitlines())),3)
        with self.assertRaisesRegex(o.Refusal,'UNEXPECTED_BACKUP_METADATA'):self.update()
        self.assertEqual(self.backup.read_text(),expected)

if __name__=='__main__':unittest.main(verbosity=2)
