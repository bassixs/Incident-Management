"""Build r2 from a committed tree + the immutable, already restored r1 data.

Never contacts a server, snapshots a database, or reads a runtime .env.
Usage: python tools/build_handover_revision.py --previous OLD.zip --out OUTPUT
       [--revision HEAD] [--acceptance isolated-result.json]
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

OLD_SHA = '9b524d0140dac26b903e2cf889afa4b38cbcb0adb221408146c90657f847b553'
BASE = '7dded197aa4b1bded85867ac4b47a7da4415e44d'
PREFIX = 'Na-svyazi-region40/'
sha = lambda value: hashlib.sha256(value).hexdigest()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--previous', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--revision', default='HEAD')
    parser.add_argument('--acceptance', type=Path)
    args = parser.parse_args()
    original = args.previous.read_bytes()
    assert sha(original) == OLD_SHA, 'Unexpected previous full archive; do not repackage unverified data'
    revision = subprocess.check_output(['git', 'rev-parse', args.revision], text=True).strip()
    assert re.fullmatch('[0-9a-f]{40}', revision)
    unchanged = ['src', 'prisma', 'package.json', 'package-lock.json', 'Dockerfile', 'docker-compose.yml']
    assert not subprocess.check_output(['git', 'diff', '--name-only', BASE, revision, '--', *unchanged], text=True).strip(), 'Runtime application must not change in this revision'
    source = subprocess.check_output(['git', 'archive', '--format=tar', revision])
    files = {}
    with tarfile.open(fileobj=io.BytesIO(source)) as archive:
        for member in archive:
            assert '..' not in PurePosixPath(member.name).parts and not PurePosixPath(member.name).is_absolute()
            if member.isfile(): files['project/' + member.name] = archive.extractfile(member).read()
            else: assert member.isdir(), 'No archive symlinks allowed'
    with zipfile.ZipFile(io.BytesIO(original)) as archive:
        assert archive.testzip() is None
        sums = archive.read(PREFIX + 'SHA256SUMS').decode().splitlines()
        for line in sums:
            digest, name = line.split('  ', 1)
            assert sha(archive.read(PREFIX + name)) == digest, name
        for name in archive.namelist():
            relative = name.removeprefix(PREFIX)
            assert name.startswith(PREFIX) and '..' not in PurePosixPath(relative).parts
            if relative.startswith('data/'):
                files[relative] = archive.read(name)
            elif relative in ['config/business-settings.env', 'config/chat-bindings.json', 'config/prepare-final-copy.sql']:
                files[relative] = archive.read(name)
            elif relative.startswith('verification/'):
                files['verification/previous/' + relative.removeprefix('verification/')] = archive.read(name)
    files['START-HERE.md'] = files['project/deploy/handover/START-HERE.md']
    files['config/check.cjs'] = files['project/deploy/handover/check.cjs']
    files['config/.env.mincifra.example'] = files['project/deploy/handover/.env.mincifra.example']
    files['verification/source-revision.txt'] = (revision + '\n').encode()
    public_source = {name.removeprefix('project/'): sha(data) for name, data in files.items() if name.startswith('project/')}
    data_manifest = {name: sha(data) for name, data in files.items() if name.startswith('data/')}
    assert files['data/database.dump'][:5] == b'PGDMP'
    assert sha(files['data/database.dump']) == '11142251f1d1c162c5f250749364c9a45bbe92b2b99617a5e88216c105e0ea3d'
    report = {'edition': 'r2', 'sourceRevision': revision, 'runtimeBaseline': BASE, 'unchangedRuntimePaths': unchanged,
              'previousArchiveSha256': OLD_SHA, 'newSnapshotTaken': False, 'dataFilesCopiedByteForByte': data_manifest,
              'oldArchiveUnchanged': True, 'runtimeSecretsIncluded': False,
              'confirmation': 'Deployment mode/password policy were already documented in r1; env template and generic database error handling were inconsistent. data/database.dump name and restore-before-check order were already correct.'}
    if args.acceptance:
        result = json.loads(args.acceptance.read_text(encoding='utf-8-sig'))
        assert result['sourceRevision'] == revision
        assert result['dumpSha256'] == sha(files['data/database.dump'])
        assert result['checkSha256'] == sha(files['config/check.cjs'])
        assert result['passed'] and result['maxMessagesSent'] == 0 and not result['webhooksRegistered']
        files['verification/r2-acceptance.json'] = (json.dumps(result, ensure_ascii=False, indent=2) + '\n').encode()
    for name, data in files.items():
        assert PurePosixPath(name).name not in ['.env', '.env.local', 'app-runtime.env'], name
        assert not re.search(rb'(?m)^-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?$', data), name
    files['verification/source-manifest.json'] = (json.dumps(public_source, indent=2) + '\n').encode()
    files['verification/r2-package.json'] = (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode()
    files['SHA256SUMS'] = ''.join(sha(value) + '  ' + name + '\n' for name, value in sorted(files.items())).encode()
    args.out.mkdir(parents=True, exist_ok=True)
    destination = args.out / 'Na-svyazi-region40-full-2026-09-30-r2.zip'
    assert destination.resolve() != args.previous.resolve()
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(files.items()): archive.writestr(PREFIX + name, data)
    with zipfile.ZipFile(destination) as archive:
        assert archive.testzip() is None
        for name, data in files.items(): assert archive.read(PREFIX + name) == data
    assert sha(args.previous.read_bytes()) == OLD_SHA
    digest = sha(destination.read_bytes())
    destination.with_suffix('.zip.sha256').write_text(digest + '  ' + destination.name + '\n', encoding='ascii')
    print(json.dumps({'archive': str(destination.resolve()), 'sha256': digest, 'revision': revision, 'files': len(files), 'dataFilesUnchanged': len(data_manifest), 'bytes': destination.stat().st_size}, indent=2))

if __name__ == '__main__': main()
