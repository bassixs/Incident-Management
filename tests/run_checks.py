"""Local simulations; real flock on Linux. Docker lab is an explicit opt-in."""
import hashlib, json, os, pathlib, platform, re, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[1]
results = root/'results'; results.mkdir(exist_ok=True)
report = {'python':sys.version, 'platform':platform.platform(), 'runs':[],
          'docker':'NOT RUN (explicit --docker and empty disposable Linux daemon required)'}
suites = []
for name, script in [('simulation','test_revision_4.py'), ('resume','test_resume.py')]:
    suites += [(name, [], script), (name+'-optimized', ['-O'], script)]
if sys.platform.startswith('linux'):
    suites += [('linux-flock', [], 'test_linux_flock.py'), ('linux-flock-optimized', ['-O'], 'test_linux_flock.py')]
else:
    report['realFlock'] = 'NOT RUN: Linux unavailable; R3 Linux evidence is historical only'
if '--docker' in sys.argv:
    if not sys.platform.startswith('linux'): raise SystemExit('Docker lab requires Linux')
    suites += [('real-docker', [], 'test_real_docker.py')]
for name, flags, script in suites:
    env = dict(os.environ)
    if name == 'real-docker': env['OPS_DOCKER_TESTS']='1'
    r = subprocess.run([sys.executable,*flags,str(root/'tests'/script)], capture_output=True,
                       text=True, timeout=600 if name=='real-docker' else 120, env=env)
    log = r.stdout+r.stderr
    (results/(name+'.txt')).write_text(log, encoding='utf-8')
    count = re.search(r'Ran (\d+) tests', log)
    report['runs'].append({'name':name,'exitCode':r.returncode,'tests':int(count.group(1)) if count else None})
    if r.returncode:
        print(log); raise SystemExit(r.returncode)
    if name=='real-docker': report['docker']='PASSED synthetic Linux/Docker fixture'
report['revisionFiles'] = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((root/'revision-4').glob('*.py'))}
(results/'report.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
print(json.dumps(report,indent=2))
