"""Opt-in portable Linux/Docker lab, NOT run on the author's Windows workstation.

Requires an EMPTY disposable Docker daemon and a preloaded python:3.12-slim image.
Builds only synthetic HTTP fixtures, no application code, DB, MAX or real tokens.
"""
import contextlib
import importlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'revision-4'))
import ops_common as o

if not sys.platform.startswith('linux') or os.environ.get('OPS_DOCKER_TESTS') != '1':
    raise SystemExit('Opt-in Linux Docker lab required; not silently skipped.')

def run(*args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if p.returncode:
        raise RuntimeError('LAB_COMMAND_FAILED:'+args[0])
    return p.stdout.strip()

HTTP_APP = '''import http.server,signal,threading
s=http.server.HTTPServer(('0.0.0.0',3000),http.server.BaseHTTPRequestHandler)
def get(self):
 self.send_response(200); self.end_headers(); self.wfile.write(b'OK')
s.RequestHandlerClass.do_GET=get
s.RequestHandlerClass.log_message=lambda *a:None
signal.signal(signal.SIGTERM,lambda *a:s.shutdown())
t=threading.Thread(target=s.serve_forever); t.start()
signal.pause(); t.join(); s.server_close()
print('graceful shutdown completed',flush=True)
'''

class DockerResume(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if run('docker', 'ps', '-aq'):
            raise RuntimeError('REFUSE_NONEMPTY_DOCKER_DAEMON')
        cls.tmp = tempfile.TemporaryDirectory(prefix='ops-resume-lab-')
        cls.root = Path(cls.tmp.name)
        cls.prefix = 'ops-resume-'+uuid.uuid4().hex[:10]
        cls.images = {}
        cls.net = cls.prefix+'-net'
        base = 'python:3.12-slim'
        run('docker', 'image', 'inspect', base)  # no implicit image download
        run('docker', 'network', 'create', '--internal', cls.net)
        cls.addClassCleanup(cls.clean_lab)
        (cls.root/'server.py').write_text(HTTP_APP)
        (cls.root/'Dockerfile').write_text('FROM python:3.12-slim\nCOPY server.py /server.py\nENTRYPOINT ["python","-u","/server.py"]\n')
        for n, role in enumerate(['old', 'main', 'reserve'], 1):
            tag = cls.prefix+':'+role
            rev = str(n)*40
            run('docker', 'build', '--network=none', '--pull=false', '--label', 'org.opencontainers.image.revision='+rev, '-t', tag, str(cls.root))
            iid = run('docker', 'image', 'inspect', '--format', '{{.Id}}', tag)
            cls.images[role] = {'id': iid, 'revision': rev}

    @classmethod
    def clean_lab(cls):
        # Only our owned lab tags/network; no prune or other objects.
        for role in cls.images:
            run('docker', 'image', 'rm', '--no-prune', cls.prefix+':'+role)
        run('docker', 'network', 'rm', cls.net)
        cls.tmp.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=self.root)
        self.addCleanup(self.tmp.cleanup)
        r = Path(self.tmp.name)
        self.install = r/'install'; self.install.mkdir()
        (self.install/'private').mkdir()
        self.stage = r/'stage'; self.stage.mkdir()
        self.run_dir = self.stage/'run'; self.run_dir.mkdir()
        self.lock = r/'backup.lock'; self.lock.touch()
        self.name = self.prefix+'-'+uuid.uuid4().hex[:6]
        self.project = self.name
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        self.token = 'SYNTHETIC_'+uuid.uuid4().hex
        runtime = self.install/'private/runtime.env'
        runtime.write_text('BOT_TOKEN='+self.token+'\n')
        self.s = {'install': str(self.install), 'prepared': str(self.stage),
                  'backup_script': str(r/'backup.py'), 'backup_lock': str(self.lock),
                  'releases': str(r/'releases'), 'app': self.name, 'project': self.project,
                  'health_base': 'http://127.0.0.1:'+str(port),
                  'runtime_sha256': o.sha(runtime.read_bytes()), 'images': {}}
        for role, meta in self.images.items():
            cfg = {'services': {'app': {'image': meta['id'], 'container_name': self.name,
                   'restart': 'no', 'mem_limit': '128m', 'cpus': '0.25',
                   'environment': {'BOT_TOKEN': self.token},
                   'ports': ['127.0.0.1:'+str(port)+':3000'],
                   'logging': {'driver': 'json-file', 'options': {'max-size':'20m','max-file':'5'}},
                   'networks': ['lab']}}, 'networks': {'lab': {'external': True, 'name': self.net}}}
            path = self.stage/('compose-'+role+'.yml')
            path.write_text(json.dumps(cfg))
            self.s['images'][role] = dict(meta, candidate=str(path), compose_sha256=o.sha(path.read_bytes()))
        for p in [self.stage/'compose-before.yml', self.install/'compose.yml']:
            p.write_bytes(Path(self.s['images']['old']['candidate']).read_bytes())
        self.s['baseline_config_sha256'] = o.sha((self.stage/'compose-before.yml').read_bytes())
        self.settings = r/'settings.json'; self.settings.write_text(json.dumps(self.s))
        self.addCleanup(self.clean_container)
        run('docker', 'compose', '-p', self.project, '-f', str(self.install/'compose.yml'), 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'app')
        o.wait_ready(self.s, self.images['old']['id'])
        self.initial = o.app(self.s)['Id']

    def clean_container(self):
        names = run('docker', 'ps', '-a', '--format', '{{.Names}}').splitlines()
        if self.name in names:
            c = o.inspect(self.name)
            if c['State']['Running']:
                run('docker', 'kill', '--signal=TERM', c['Id'])
                run('docker', 'wait', c['Id'])
            run('docker', 'rm', c['Id'])  # owned synthetic fixture only, never force

    def cli(self, fd, script, *args):
        p = subprocess.run([sys.executable, str(ROOT/'revision-4'/script), '--settings', str(self.settings), *args],
                           env=dict(os.environ, INCIDENT_OPS_LOCK_FD=str(fd)), pass_fds=(fd,),
                           capture_output=True, text=True, timeout=150)
        return p.returncode, p.stdout+p.stderr

    def test_same_real_container_resumes_and_repeat_refused(self):
        old = self.images['old']['id']
        with o.backup_lock(self.s) as fd:
            self.assertEqual(self.cli(fd, 'stop-app.py', old, 'run')[0], 0)
            result = self.cli(fd, 'resume-unapplied.py', old, 'run')
            self.assertEqual(result[0], 0, result[1])
            self.assertEqual(o.app(self.s)['Id'], self.initial)
            self.assertTrue(json.loads((self.run_dir/'resume-attempt.json').read_text())['ready'])
            again = self.cli(fd, 'resume-unapplied.py', old, 'run')
            self.assertEqual(again[0], 2)
            self.assertIn('RESUME_ALREADY_ATTEMPTED', again[1])

    def test_changed_compose_without_applied_does_not_start(self):
        old = self.images['old']['id']
        with o.backup_lock(self.s) as fd:
            self.assertEqual(self.cli(fd, 'stop-app.py', old, 'run')[0], 0)
            (self.install/'compose.yml').write_bytes(Path(self.s['images']['main']['candidate']).read_bytes())
            result = self.cli(fd, 'resume-unapplied.py', old, 'run')
            self.assertEqual(result[0], 2)
            self.assertFalse(o.app(self.s)['State']['Running'])

    def test_applied_then_restored_compose_still_refused(self):
        old = self.images['old']['id']; main = self.images['main']['id']
        with o.backup_lock(self.s) as fd:
            self.assertEqual(self.cli(fd, 'stop-app.py', old, 'run')[0], 0)
            self.assertEqual(self.cli(fd, 'apply-config.py', old, main, self.s['baseline_config_sha256'], self.s['images']['main']['candidate'], 'run')[0], 0)
            (self.install/'compose.yml').write_bytes((self.stage/'compose-before.yml').read_bytes())
            result = self.cli(fd, 'resume-unapplied.py', old, 'run')
            self.assertEqual(result[0], 2)
            self.assertIn('UPDATE_ALREADY_STARTED', result[1])
            self.assertFalse(o.app(self.s)['State']['Running'])

if __name__ == '__main__':
    unittest.main(verbosity=2)
