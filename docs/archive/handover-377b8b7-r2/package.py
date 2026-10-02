from pathlib import Path
import hashlib, io, json, re, subprocess, tarfile, zipfile

edition = Path('output/update-main-377b8b7-r2')
root = edition / 'Na-svyazi-region40'
previous = Path('output/update-main-20260930/Na-svyazi-region40-update-377b8b7.zip')
previous_sha = 'd9683e7b2d1c9e6fcf5549256e58adb1797940fa69236c24092a40ad81855b61'
commit = '377b8b7837037e8aaad4e98530d02588f086edb2'
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(previous.read_bytes()) == previous_sha, 'Previous ZIP changed'
manifest = json.loads((root/'verification/source-manifest.json').read_text(encoding='utf-8'))
sources = {str(p.relative_to(root/'project')).replace('\\','/'): p for p in (root/'project').rglob('*') if p.is_file()}
assert set(sources) == set(manifest)
git_tar = subprocess.check_output(['git','archive','--format=tar',commit])
with tarfile.open(fileobj=io.BytesIO(git_tar)) as tar:
    git_files = {m.name: tar.extractfile(m).read() for m in tar.getmembers() if m.isfile()}
assert set(sources) == set(git_files)
with zipfile.ZipFile(previous) as old:
    for name,p in sources.items():
        content = p.read_bytes()
        assert sha(content) == manifest[name], name
        assert content == old.read('Na-svyazi-region40/project/'+name) == git_files[name], name

report_path = root/'verification/acceptance.json'
report = json.loads(report_path.read_text(encoding='utf-8'))
report['unitTests']['location'] = '24 passed locally and 24 passed in isolated Linux Node 22 container'
report['checks'] = {'bashSyntaxBlocksPassed':14,'nodeStdinSyntaxCommandPassed':True,
                    'projectMatchesGitCommit':True,'projectByteIdenticalToPreviousZip':True,
                    'previousZipUnchanged':True,'projectFileCount':len(sources)}
report_path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8',newline='\n')

# Check package boundaries and obvious credential-bearing files. Application sources
# are exact tracked Git bytes; only reviewed tools/docs/evidence are additional.
for p in root.rglob('*'):
    if not p.is_file(): continue
    rel = p.relative_to(root).as_posix()
    assert p.name not in ['.env','app-runtime.env','database.dump','id_rsa','id_ed25519'], rel
    assert not rel.startswith(('data/','.git/')), rel
    if not rel.startswith('project/'):
        b = p.read_bytes()
        assert b'PRIVATE KEY-----' not in b, rel
        # New tools have no hard-coded credentials/URL userinfo.
        if rel.startswith('config/'):
            assert not re.search(rb'(?:postgres(?:ql)?|https?)://[^\s/]+:[^\s/@]+@',b), rel
            assert not re.search(rb'(?m)^\s*(?:BOT_TOKEN|WEBHOOK_SECRET|POSTGRES_PASSWORD)\s*=\s*[^\s]',b), rel

files = sorted(p for p in root.rglob('*') if p.is_file() and p.name != 'SHA256SUMS')
sums = ''.join(f'{sha(p.read_bytes())}  {p.relative_to(root).as_posix()}\n' for p in files)
(root/'SHA256SUMS').write_text(sums,encoding='utf-8',newline='\n')
out = edition/'Na-svyazi-region40-update-377b8b7-r2.zip'
assert not out.exists(), 'Never silently replace a published ZIP'
with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file(): z.write(p,p.relative_to(edition).as_posix())
with zipfile.ZipFile(out) as z:
    assert z.testzip() is None
    names = z.namelist()
    assert len(names) == len(set(names))
    prefix = 'Na-svyazi-region40/'
    for line in z.read(prefix+'SHA256SUMS').decode('utf-8').splitlines():
        digest,name = line.split('  ',1)
        assert sha(z.read(prefix+name)) == digest, name
    assert len(names) == len(sums.splitlines())+1
digest = sha(out.read_bytes())
out.with_suffix('.zip.sha256').write_text(digest+'  '+out.name+'\n',encoding='ascii',newline='\n')
assert sha(previous.read_bytes()) == previous_sha
print(json.dumps({'archive':str(out.resolve()),'sha256':digest,'files':len(names),'sourceFiles':len(sources),'bytes':out.stat().st_size,'previousUnchanged':True},ensure_ascii=True))
