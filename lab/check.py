"""Real Docker 29.1.3 lab; refuses any endpoint other than the nested fixture."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request

OUT = Path('results')
ROOT = Path('lab/contexts')
BASE = 'http://127.0.0.1:23750'
checks = []


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def save(name, value):
    (OUT / (name + '.json')).write_text(json.dumps(value, indent=2) + '\n')


def api(path):
    with urllib.request.urlopen(BASE + path, timeout=90) as r:
        return json.load(r)


def docker(*args, native=False, expect=0):
    cmd = ['docker', 'exec']
    if native:
        cmd += ['-e', 'DOCKER_BUILDKIT=0']
    cmd += ['exact-cache-engine', 'docker', *args]
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=240)
    print('$', ' '.join(cmd), '\n', result.stdout, flush=True)
    require(result.returncode == expect, f'command exit {result.returncode}, expected {expect}')
    return result.stdout


def cache():
    rows = api('/system/df')['BuildCache'] or []
    for row in rows:
        # Engine 29.1.3 API has a leading space in this JSON field's tag.
        row['Parents'] = row.get('Parents', row.get(' Parents')) or []
    require(len({r['ID'] for r in rows}) == len(rows), 'duplicate cache ID')
    return {r['ID']: r for r in rows}


def protected():
    images = api('/images/json?all=1')
    containers = api('/containers/json?all=1')
    result = {'images': sorted((r['Id'], sorted(r.get('RepoTags') or []),
                               sorted(r.get('RepoDigests') or [])) for r in images),
              'containers': [], 'volumes': api('/volumes')['Volumes'] or []}
    for row in sorted(containers, key=lambda c: c['Id']):
        r = api('/containers/' + row['Id'] + '/json')
        result['containers'].append({k: r[k] for k in
            ['Id', 'Image', 'Config', 'HostConfig', 'Mounts', 'State', 'RestartCount']})
    result['volumes'].sort(key=lambda v: v['Name'])
    return result


def fixture(group, count, load=False):
    for n in range(count):
        name = f'{group}-{n:03d}'
        ctx = ROOT / name
        ctx.mkdir(parents=True)
        (ctx / 'a').write_text('shared parent within group ' + group)
        (ctx / 'b').write_text('unique child ' + name)
        syntax = '# syntax=docker/dockerfile:1.7.0\n' if group == 'frontend' else ''
        (ctx / 'Dockerfile').write_text(syntax + 'FROM scratch\nCOPY a /a\nCOPY b /b\n')
        args = ['buildx', 'build', '--builder', 'default', '--progress=plain']
        args += ['--load', '-t', 'cache-lab-' + name] if load else ['--output=type=cacheonly']
        docker(*args, '/lab/' + ctx.as_posix())


def prune(ids, name):
    require(ids and all(re.fullmatch('[a-z0-9]{25}', i) for i in ids), 'invalid exact ID list')
    require(len(ids) == len(set(ids)), 'duplicate allowlist')
    before = cache()
    resources = protected()
    save(name + '-before', list(before.values()))
    pattern = '^(' + '|'.join(ids) + ')$'
    output = docker('builder', 'prune', '--all', '--force', '--filter', 'id=' + pattern,
                    '--filter', 'private=""', native=True)
    (OUT / (name + '-prune.txt')).write_text(output)
    reported = re.findall(r'^([a-z0-9]{25})$', output, flags=re.M)
    require(set(reported) <= set(ids), f'{name}: reported deletion outside allowlist')
    after = cache()
    save(name + '-after', list(after.values()))
    removed = set(before) - set(after)
    require(removed <= set(ids), f'{name}: non-allowlisted cache removed: {removed - set(ids)}')
    require(set(after) <= set(before), f'{name}: unexpected concurrent cache creation')
    for i in set(before) - set(ids):
        # Fields changed by DU dependency recomputation are excluded, content identity isn't.
        for field in ['ID', 'Type', 'CreatedAt', 'Parents', 'Description']:
            require(before[i].get(field) == after[i].get(field), f'{name}: control changed {i}/{field}')
    require(resources == protected(), f'{name}: image/container/volume changed')
    marker = docker('exec', 'cache-control-running', 'cat', '/data/marker').strip()
    require(marker == 'CONTROL-DATA', 'control volume content changed')
    checks.append({'name': name, 'allowlist': ids, 'removed': sorted(removed),
                   'reported': reported, 'preservedControlRecords': len(set(before)-set(ids)),
                   'resourcesUnchanged': True})
    save('results', checks)
    return removed


def main():
    require(os.environ.get('GITHUB_ACTIONS') == 'true', 'only disposable Actions fixture supported')
    version, info = api('/version'), api('/info')
    save('version', version); save('info', info)
    require(version['Version'] == '29.1.3' and version['Arch'] == 'amd64', 'wrong Engine')
    if os.environ.get('LAB_ENGINE') == 'ubuntu':
        require(version['GitCommit'] == '29.1.3-0ubuntu4.1', 'wrong Ubuntu build')
        docker('version')
        print(subprocess.check_output(['docker', 'exec', 'exact-cache-engine', 'dpkg-query',
              '-W', 'docker.io', 'containerd', 'runc'], text=True))
    require(any('io.containerd.snapshotter.v1' in str(r) for r in info['DriverStatus']), 'not containerd store')
    require(not api('/containers/json?all=1'), 'inner daemon not empty')
    require(not (api('/volumes')['Volumes'] or []), 'inner volumes not empty')
    require(not api('/images/json?all=1') and not cache(), 'inner images/cache not empty')
    docker('version'); docker('buildx', 'version')
    helptext = docker('builder', 'prune', '--help', native=True)
    require('--builder' not in helptext, 'unexpected Buildx forwarding')
    docker('pull', 'busybox:1.36')
    docker('volume', 'create', 'cache-control-volume')
    docker('run', '-d', '--name', 'cache-control-running', '--mount',
           'type=volume,src=cache-control-volume,dst=/data', 'busybox:1.36',
           'sh', '-c', 'echo CONTROL-DATA > /data/marker; exec tail -f /dev/null')
    docker('create', '--name', 'cache-control-stopped', 'busybox:1.36', 'true')
    fixture('image-control', 2, load=True)
    fixture('cache-control', 3)
    controls = set(cache())
    fixture('target', 45)
    fixture('frontend', 1)
    rows = cache()
    candidates = [i for i, r in rows.items() if i not in controls and not r['InUse'] and not r['Shared']]
    require(len(candidates) >= 125, f'insufficient synthetic private records {len(candidates)}')
    save('initial-resources', protected())
    save('initial-cache', list(rows.values()))
    require(not prune(['z' * 25], '01-nonexistent'), 'nonexistent ID removed something')
    shared = next(i for i, r in rows.items() if r['Shared'])
    require(not prune([shared], '02-shared-denied'), 'shared filter failed')
    # Delete a child while its parent is explicitly outside the allowlist.
    child = next(i for i in candidates if rows[i].get('Parents') and
                 rows[i]['Type'] == 'regular')
    parent_ids = set(rows[child]['Parents'])
    require(child in prune([child], '03-single-child'), 'private child was not removed')
    require(parent_ids <= set(cache()), 'unselected parent removed')
    require(not prune([child], '04-repeat-same-id'), 'repeat unexpectedly deleted')
    front = next(i for i, r in rows.items() if r['Type'] == 'frontend' and not r['InUse'] and not r['Shared'])
    require(front in prune([front], '05-frontend-exact'), 'frontend cache not removed')
    # Keep children before their parent when selecting a bounded allowlist.
    rows = cache()
    available = {i for i in candidates if i in rows}
    ordered = []
    while available:
        parents = {p for i in available for p in (rows[i].get('Parents') or [])}
        leaves = sorted(available - parents)
        require(leaves, 'cycle in synthetic parent graph')
        ordered.extend(leaves)
        available.difference_update(leaves)
    chosen = ordered[:123]
    require(len(chosen) == 123, 'need exactly 123 selected records')
    removed = prune(chosen, '06-exact-123')
    require(removed == set(chosen), f'only {len(removed)}/123 deleted')
    require(controls <= set(cache()), 'original control cache lost')
    save('final-resources', protected())
    print('PASS: exact 123 IDs plus one individual child; all controls preserved.', flush=True)


if __name__ == '__main__':
    main()
