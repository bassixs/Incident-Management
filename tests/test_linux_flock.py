"""Real Linux flock/subprocess/bash; temporary files only, no Docker or network."""
import contextlib
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

if not sys.platform.startswith('linux'):
    raise SystemExit('Linux is required; these tests must not silently skip.')
import fcntl

ROOT = Path(__file__).resolve().parents[1]

def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

m = module(ROOT/'revision-4/ops_common.py', 'ops_r4')

@contextlib.contextmanager
def inherited(fd):
    old = os.environ.get('INCIDENT_OPS_LOCK_FD')
    os.environ['INCIDENT_OPS_LOCK_FD'] = str(fd)
    try:
        yield
    finally:
        if old is None:
            os.environ.pop('INCIDENT_OPS_LOCK_FD', None)
        else:
            os.environ['INCIDENT_OPS_LOCK_FD'] = old

def child(mode, path):
    m.require_lock({'backup_lock': path})
    # The ownership check must not unlock the inherited open description.
    with open(path, 'rb') as probe:
        try:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise RuntimeError('Inherited lock was released')
    if mode == 'failure':
        raise SystemExit(17)
    if mode == 'exception':
        raise RuntimeError('SYNTHETIC_CHILD_FAILURE')

class LinuxFlock(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ops-r3-flock-')
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'backup.lock'
        self.path.touch(mode=0o600)
        self.s = {'backup_lock': str(self.path)}

    def assert_available(self):
        with self.path.open('rb') as probe:
            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(probe, fcntl.LOCK_UN)

    def assert_busy(self):
        with self.path.open('rb') as probe:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def through_bash(self, mode):
        # Real inherited FD across Python -> bash -> Python; no mock of fcntl,
        # Popen, bash, file descriptors or the open file description.
        m.locked_session(self.s, ['bash', '--noprofile', '--norc', '-c',
            '"$1" "$2" --child "$3" "$4"', 'ops-test', sys.executable,
            str(Path(__file__).resolve()), mode, str(self.path)])

    def test_r2_reproduces_wrong_fd_acceptance(self):
        old = module(ROOT/'baseline-r2/ops_common.py', 'ops_r2')
        with self.path.open('rb') as a, self.path.open('rb') as b:
            fcntl.flock(a, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with inherited(b.fileno()):
                old.require_lock(self.s)  # characterization: unsafe acceptance
            self.assert_busy()
        self.assert_available()

    def test_independent_fd_with_other_owner_refused_and_owner_preserved(self):
        with self.path.open('rb') as a, self.path.open('rb') as b:
            fcntl.flock(a, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with inherited(b.fileno()), self.assertRaisesRegex(m.Refusal, '^BACKUP_LOCK_NOT_OWNED$'):
                m.require_lock(self.s)
            self.assert_busy()
            fcntl.flock(a, fcntl.LOCK_UN)
            self.assert_available()

    def test_unlocked_fd_refused_and_no_lock_left_behind(self):
        with self.path.open('rb') as b:
            with inherited(b.fileno()), self.assertRaisesRegex(m.Refusal, '^BACKUP_LOCK_NOT_HELD$'):
                m.require_lock(self.s)
            self.assert_available()

    def test_owner_fd_accepted_without_releasing_lock(self):
        with m.backup_lock(self.s) as fd, inherited(fd):
            m.require_lock(self.s)
            m.require_lock(self.s)
            self.assert_busy()
        self.assert_available()

    def test_dup_same_open_description_accepted(self):
        with m.backup_lock(self.s) as fd:
            duplicate = os.dup(fd)
            try:
                with inherited(duplicate):
                    m.require_lock(self.s)
                self.assert_busy()
            finally:
                os.close(duplicate)
            self.assert_busy()
        self.assert_available()

    def test_real_bash_inheritance_and_release_after_success(self):
        self.through_bash('success')
        self.assert_available()

    def test_release_after_child_nonzero_exit(self):
        with self.assertRaisesRegex(m.Refusal, '^SESSION_COMMAND_FAILED$'):
            self.through_bash('failure')
        self.assert_available()

    def test_release_after_child_exception(self):
        with self.assertRaisesRegex(m.Refusal, '^SESSION_COMMAND_FAILED$'):
            self.through_bash('exception')
        self.assert_available()

    def test_release_after_child_cannot_start(self):
        with self.assertRaisesRegex(m.Refusal, '^SESSION_COMMAND_FAILED$'):
            m.locked_session(self.s, [str(Path(self.temp.name)/'does-not-exist')])
        self.assert_available()

    def test_release_after_error_inside_lock_scope(self):
        with self.assertRaisesRegex(RuntimeError, '^SYNTHETIC_SCOPE_ERROR$'):
            with m.backup_lock(self.s) as fd, inherited(fd):
                m.require_lock(self.s)
                raise RuntimeError('SYNTHETIC_SCOPE_ERROR')
        self.assert_available()

    def test_second_session_refused_with_real_lock(self):
        with m.backup_lock(self.s):
            with self.assertRaisesRegex(m.Refusal, '^BACKUP_ALREADY_RUNNING$'):
                # Would exit 0 if started, but must not get that far.
                m.locked_session(self.s, [sys.executable, '-c', 'raise SystemExit(0)'])
            self.assert_busy()
        self.assert_available()

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        child(sys.argv[2], sys.argv[3])
    else:
        unittest.main(verbosity=2)
