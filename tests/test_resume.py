"""Targeted R4 cancellation tests: real temp files; simulated Docker/HTTP/flock."""
import contextlib
import copy
import json
import os
import pathlib
import subprocess
import types
import unittest
from unittest.mock import patch
from test_revision_4 import Fixture as BaseFixture, m, OLD, MAIN, RES, Response
import unapplied_resume as u

class Fixture(BaseFixture):
    def __init__(self):
        super().__init__()
        self.resume_mode = 'ok'
        self.resume_calls = []

    def subprocess(self, args, **kw):
        if args[:2] == ['docker', 'start']:
            self.calls.append((args, kw))
            self.resume_calls.append(args)
            if self.resume_mode == 'timeout':
                raise subprocess.TimeoutExpired(args, kw.get('timeout'))
            if self.resume_mode == 'failure':
                return types.SimpleNamespace(returncode=1, stdout='', stderr='SYNTHETIC_SECRET')
            if args != ['docker', 'start', self.c['Id']] or self.c['State']['Running']:
                raise AssertionError('INVALID_RESUME')
            self.c['State'].update(Running=True, Status='running', StartedAt='2026-01-01T02:00:00Z', FinishedAt='')
            if self.resume_mode == 'wrong_container':
                self.c['Id'] = 'replacement'
            return types.SimpleNamespace(returncode=0, stdout=self.c['Id'], stderr='')
        return super().subprocess(args, **kw)

class Resume(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()
        self.stack = contextlib.ExitStack()
        self.stack.enter_context(self.f.patched())
        self.stack.enter_context(self.f.locked())
        self.f.ok('stop-app.py', OLD, 'run')
        self.r = self.f.p/'run'

    def tearDown(self):
        self.stack.close()
        self.f.close()

    def refuse(self, reason):
        self.f.fail(reason, 'resume-unapplied.py', OLD, 'run')
        self.assertFalse(self.f.resume_calls)
        self.assertFalse((self.r/'resume-attempt.json').exists())

    def test_success_same_cid_no_recreation_no_data_change(self):
        f = self.f
        protected = f.root/'data.json'
        protected.write_text('{"FAILED":8,"photos":46,"database":"synthetic"}')
        before = {p: p.read_bytes() for p in [protected, f.i/'compose.yml', f.i/'private/runtime.env', pathlib.Path(f.s['backup_script'])]}
        f.ok('resume-unapplied.py', OLD, 'run')
        self.assertEqual(f.resume_calls, [['docker', 'start', 'original']])
        self.assertFalse(f.children)
        self.assertEqual(f.c['Id'], 'original')
        self.assertTrue(f.c['State']['Running'])
        record = json.loads((self.r/'resume-attempt.json').read_text())
        self.assertTrue(record['ready'])
        self.assertEqual(record['final']['id'], 'original')
        for p, value in before.items():
            self.assertEqual(p.read_bytes(), value)

    def test_repeat_after_success_refused_no_second_start(self):
        f = self.f
        f.ok('resume-unapplied.py', OLD, 'run')
        f.fail('RESUME_ALREADY_ATTEMPTED', 'resume-unapplied.py', OLD, 'run')
        self.assertEqual(len(f.resume_calls), 1)

    def test_changed_compose_refused_even_when_no_applied_record(self):
        p = self.f.i/'compose.yml'
        p.write_text(p.read_text()+' ')
        self.refuse('STOP_RECEIPT_CONFIG_MISMATCH')

    def test_compose_switched_without_applied_refused(self):
        p = self.f.i/'compose.yml'
        p.write_bytes(pathlib.Path(self.f.s['images']['main']['candidate']).read_bytes())
        self.refuse('STOP_RECEIPT_CONFIG_MISMATCH')

    def test_changed_runtime_refused(self):
        (self.f.i/'private/runtime.env').write_text('BOT_TOKEN=SYNTHETIC_CHANGED')
        self.refuse('RUNTIME_CHANGED')

    def test_replaced_container_refused(self):
        self.f.c['Id'] = 'another'
        self.refuse('STOP_RECEIPT_MISMATCH')

    def test_wrong_image_refused(self):
        self.f.c['Image'] = MAIN
        self.refuse('WRONG_INSTALLED_IMAGE')

    def test_changed_started_at_refused(self):
        self.f.c['State']['StartedAt'] = 'new-start'
        self.refuse('STOP_RECEIPT_MISMATCH')

    def test_changed_finish_time_refused(self):
        self.f.c['State']['FinishedAt'] = 'new-finish'
        self.refuse('STOP_FINISHED_AT_CHANGED')

    def test_changed_mounts_refused(self):
        self.f.c['Mounts'] = [{'Source': 'different', 'Destination': '/data'}]
        self.refuse('CONTAINER_CONFIG_CHANGED')

    def test_changed_restart_policy_refused(self):
        self.f.c['HostConfig']['RestartPolicy']['Name'] = 'always'
        self.refuse('CONTAINER_CONFIG_CHANGED')

    def test_running_original_refused(self):
        self.f.c['State'].update(Running=True, Status='running')
        self.refuse('UNCLEAN_OR_RUNNING_APP')

    def test_unclean_exit_refused(self):
        self.f.c['State']['ExitCode'] = 137
        self.refuse('UNCLEAN_OR_RUNNING_APP')

    def test_second_running_instance_different_project_refused(self):
        f = self.f
        f.clone = f.container(MAIN, 'other', True)
        f.clone['Name'] = '/different'
        f.clone['Config']['Labels'] = {}
        self.refuse('SECOND_OR_RUNNING_APP')

    def test_new_stopped_related_instance_refused(self):
        f = self.f
        f.clone = f.container(MAIN, 'other', False)
        f.clone['Name'] = '/different'
        self.refuse('CONTAINER_INVENTORY_CHANGED')

    def test_missing_lock_refused(self):
        with patch.dict(os.environ, {}, clear=True):
            self.refuse('BACKUP_LOCK_REQUIRED')

    def test_independent_unlocked_fd_refused(self):
        with open(self.f.s['backup_lock'], 'rb') as fd:
            with patch.dict(os.environ, {'INCIDENT_OPS_LOCK_FD': str(fd.fileno())}):
                self.refuse('BACKUP_LOCK_NOT_OWNED')

    def test_r3_receipt_without_proof_refused(self):
        p = self.r/'stop-receipt.json'
        v = json.loads(p.read_text()); del v['resumeProof']; p.write_text(json.dumps(v))
        self.refuse('RESUME_PROOF_REQUIRED')

    def test_partial_stop_receipt_refused(self):
        (self.r/'stop-receipt.json').write_text('{')
        self.refuse('INVALID_JSON')

    def test_missing_stop_receipt_no_start(self):
        (self.r/'stop-receipt.json').unlink()
        rc, _ = self.f.cli('resume-unapplied.py', OLD, 'run')
        self.assertNotEqual(rc, 0)
        self.assertFalse(self.f.resume_calls)

    def test_applied_present_but_empty_refused(self):
        (self.r/'applied.json').touch()
        self.refuse('UPDATE_ALREADY_STARTED')

    def test_start_attempt_partial_refused(self):
        (self.r/'start-main.json').write_text('{')
        self.refuse('UPDATE_ALREADY_STARTED')

    def test_resume_attempt_partial_refused(self):
        (self.r/'resume-attempt.json').write_text('{')
        self.f.fail('RESUME_ALREADY_ATTEMPTED', 'resume-unapplied.py', OLD, 'run')
        self.assertFalse(self.f.resume_calls)

    def test_temporary_control_file_refused(self):
        (self.r/'stop-receipt.json.ops-next').touch()
        self.refuse('PARTIAL_CONTROL_WRITE')

    def test_temporary_compose_refused(self):
        (self.f.i/'compose.yml.ops-next').touch()
        self.refuse('PARTIAL_CONTROL_WRITE')

    def test_settings_changed_refused(self):
        self.f.s['project'] = 'changed-project'
        self.f.settings.write_text(json.dumps(self.f.s))
        self.refuse('RESUME_SETTINGS_CHANGED')

    def test_new_attempt_in_different_run_refused(self):
        other = self.f.p/'other-run'; other.mkdir()
        (other/'start-main.json').write_text('{')
        self.refuse('OPERATION_RECORDS_CHANGED')

    def test_legitimate_final_snapshot_files_do_not_block(self):
        (self.r/'database-stopped.dump').write_bytes(b'SYNTHETIC')
        (self.r/'uploads-stopped.tar.gz').write_bytes(b'SYNTHETIC')
        (self.f.p/'run-stopped.json').write_text('{}')
        self.f.ok('resume-unapplied.py', OLD, 'run')

    def test_apply_intent_before_compose_failure_blocks_resume(self):
        f = self.f
        with patch.object(m, 'atomic', side_effect=OSError('SYNTHETIC_WRITE_FAILURE')):
            code, _ = f.cli('apply-config.py', OLD, MAIN, f.s['baseline_config_sha256'], f.s['images']['main']['candidate'], 'run')
        self.assertNotEqual(code, 0)
        self.assertTrue((self.r/'apply-intent.json').exists())
        self.assertFalse((self.r/'applied.json').exists())
        self.assertEqual(m.sha((f.i/'compose.yml').read_bytes()), f.s['baseline_config_sha256'])
        self.refuse('UPDATE_ALREADY_STARTED')

    def test_interrupted_applied_write_then_compose_restored_still_refused(self):
        f = self.f; original = m.save_new
        def interrupt(p, value):
            if p.name == 'applied.json':
                p.write_text('{')
                raise OSError('SYNTHETIC_WRITE_FAILURE')
            return original(p, value)
        with patch.object(m, 'save_new', interrupt):
            code, _ = f.cli('apply-config.py', OLD, MAIN, f.s['baseline_config_sha256'], f.s['images']['main']['candidate'], 'run')
        self.assertNotEqual(code, 0)
        (f.i/'compose.yml').write_bytes((f.p/'compose-before.yml').read_bytes())
        self.refuse('UPDATE_ALREADY_STARTED')

    def test_change_after_resume_intent_before_start_refused(self):
        original = u.record_new
        def change(p, value):
            original(p, value)
            if p.name == 'resume-attempt.json':
                (self.f.i/'compose.yml').write_text('CHANGED')
        with patch.object(u, 'record_new', change):
            self.f.fail('STOP_RECEIPT_CONFIG_MISMATCH', 'resume-unapplied.py', OLD, 'run')
        self.assertFalse(self.f.resume_calls)
        self.assertEqual(json.loads((self.r/'resume-attempt.json').read_text())['result'], 'incomplete')

    def test_start_nonzero_recorded_no_automatic_retry(self):
        f = self.f; f.resume_mode = 'failure'
        f.fail('RESUME_START_FAILED', 'resume-unapplied.py', OLD, 'run')
        record = json.loads((self.r/'resume-attempt.json').read_text())
        self.assertEqual(record['returncode'], 1)
        self.assertFalse(record['ready'])
        f.fail('RESUME_ALREADY_ATTEMPTED', 'resume-unapplied.py', OLD, 'run')
        self.assertEqual(len(f.resume_calls), 1)

    def test_timeout_keeps_unknown_result_and_refuses_repeat(self):
        f = self.f; f.resume_mode = 'timeout'
        f.fail('COMMAND_UNAVAILABLE_OR_TIMEOUT', 'resume-unapplied.py', OLD, 'run')
        self.assertEqual(json.loads((self.r/'resume-attempt.json').read_text())['result'], 'incomplete')
        f.fail('RESUME_ALREADY_ATTEMPTED', 'resume-unapplied.py', OLD, 'run')
        self.assertEqual(len(f.resume_calls), 1)

    def test_readiness_timeout_does_not_stop_resumed_app(self):
        f = self.f; f.http_status = 503
        f.fail('READINESS_TIMEOUT', 'resume-unapplied.py', OLD, 'run')
        self.assertTrue(f.c['State']['Running'])
        self.assertFalse(json.loads((self.r/'resume-attempt.json').read_text())['ready'])
        self.assertEqual(f.now, 120)
        self.assertEqual(len([a for a, kw in f.calls if a[:2] == ['docker', 'kill']]), 1)

    def test_wrong_container_after_start_not_marked_ready(self):
        self.f.resume_mode = 'wrong_container'
        self.f.fail('RESUMED_CONTAINER_CHANGED', 'resume-unapplied.py', OLD, 'run')
        self.assertFalse(json.loads((self.r/'resume-attempt.json').read_text())['ready'])

    def test_exit_after_ready_before_result_not_marked_success(self):
        original = m.wait_ready
        def exit_after_ready(s, image):
            original(s, image)
            self.f.c['State'].update(Running=False, Status='exited', ExitCode=1)
        with patch.object(m, 'wait_ready', exit_after_ready):
            self.f.fail('RESUMED_CONTAINER_STOPPED', 'resume-unapplied.py', OLD, 'run')
        self.assertFalse(json.loads((self.r/'resume-attempt.json').read_text())['ready'])

    def test_apply_still_forbids_old(self):
        f = self.f
        f.fail('INCOMPATIBLE_ROLLBACK_FORBIDDEN', 'apply-config.py', MAIN, OLD, f.s['baseline_config_sha256'], f.s['images']['old']['candidate'], 'run')

    def test_start_still_forbids_old(self):
        self.f.fail('INCOMPATIBLE_ROLLBACK_FORBIDDEN', 'start-app.py', OLD, 'run')

    def test_recover_still_forbids_old(self):
        self.f.fail('COMPATIBLE_RESERVE_REQUIRED', 'recover-config.py', MAIN, OLD, self.f.s['baseline_config_sha256'], 'run', 'reviewed-start-failure')

class ResumeLockRelease(unittest.TestCase):
    def test_failed_resume_releases_wrapper_lock_without_retry(self):
        f = Fixture()
        try:
            with f.patched():
                with f.locked():
                    f.ok('stop-app.py', OLD, 'run')
                f.resume_mode = 'failure'
                f.fail('SESSION_COMMAND_FAILED', 'locked-session.py', '--', 'synthetic-execute', 'resume-unapplied.py', OLD, 'run')
                self.assertFalse(f.lock.owners)
                self.assertEqual(len(f.resume_calls), 1)
                self.assertFalse(f.c['State']['Running'])
        finally:
            f.close()

if __name__ == '__main__':
    unittest.main(verbosity=2)
