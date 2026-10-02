from pathlib import Path, PurePosixPath
import json,hashlib,tarfile,zipfile,shutil,re,subprocess
from urllib.parse import urlparse,unquote
out=Path('output/full-handover-20260930');root=out/'Na-svyazi-region40';root.mkdir(exist_ok=True)
rev='7dded197aa4b1bded85867ac4b47a7da4415e44d';sha=lambda b:hashlib.sha256(b).hexdigest()
source=Path('tmp/handover-source-7dded19.tar.gz')
assert sha(source.read_bytes())=='f7405ad07ec2f810556995ad04f8290213dcc15d6b513a0bdfed152113c41eee'
bundle=out/'final-data-config.tar.gz'
assert sha(bundle.read_bytes())=='372a17edef5a72b477cfe42bea863da414ce0c06a48a0f43ed4bfc00eeb5fed7'
for archive,dest in [(source,root/'project'),(bundle,root)]:
 with tarfile.open(archive) as t:
  if archive==source:assert t.pax_headers['comment']==rev
  for m in t.getmembers():assert (m.isfile() or m.isdir()) and not PurePosixPath(m.name).is_absolute() and '..' not in PurePosixPath(m.name).parts
  t.extractall(dest,filter='data')
config=root/'config';config.mkdir(exist_ok=True)
for p in (root/'configuration').glob('*'):shutil.copyfile(p,config/p.name)
# Extracted duplicate configuration directory is not part of the package.
for p in (root/'configuration').glob('*'):p.unlink()
(root/'configuration').rmdir()
shutil.copyfile('tmp/handover-check.cjs',config/'check.cjs')
shutil.copyfile('tmp/START-HERE-full.md',root/'START-HERE.md')
verification=root/'verification';verification.mkdir(exist_ok=True)
(verification/'source-revision.txt').write_text(rev+'\n',encoding='ascii')
source_manifest={p.relative_to(root/'project').as_posix():sha(p.read_bytes()) for p in sorted((root/'project').rglob('*')) if p.is_file()}
assert len(source_manifest)==312
with tarfile.open(source) as t:
 for m in t.getmembers():
  if m.isfile():assert source_manifest[m.name]==sha(t.extractfile(m).read())
(verification/'source-manifest.json').write_text(json.dumps(source_manifest,indent=2)+'\n',encoding='utf-8')
lock=json.loads((root/'project/package-lock.json').read_text(encoding='utf-8'))
versions={k:lock['packages']['node_modules/'+k]['version'] for k in ['@maxhub/max-bot-api','@prisma/client','prisma','typescript','vitest','fastify','dotenv']}
hosts=sorted(set(urlparse(v['resolved']).netloc for v in lock['packages'].values() if v.get('resolved')))
assert hosts==['registry.npmjs.org'],hosts
(verification/'versions.json').write_text(json.dumps({'nodeDocker':'22-alpine','postgresDocker':'16-alpine','caddyDocker':'2-alpine','lockedPackages':versions,'npmDownloadHosts':hosts},indent=2)+'\n',encoding='utf-8')
unchanged=['package.json','package-lock.json','Dockerfile','docker-compose.yml','prisma/schema.prisma','prisma/migrations']
assert not subprocess.check_output(['git','diff','--name-only','0e6ac39',rev,'--',*unchanged],text=True).strip()
known=set()
for p in [Path('.env'),Path('tmp/handover-20260929-v2/package/project/.env'),Path('tmp/handover-20260929-v2/package/config/app-runtime.env')]:
 if p.is_file():
  for line in p.read_text(encoding='utf-8-sig').splitlines():
   if line.startswith('#') or '=' not in line:continue
   k,v=line.split('=',1);v=v.strip().strip('\"\'')
   if re.search(r'TOKEN|SECRET|PASSWORD|ACCESS_KEY',k) and len(v)>=8 and 'REPLACE_' not in v:known.add(v.encode())
   if k=='DATABASE_URL':
    password=unquote(urlparse(v).password or '')
    if len(password)>=8:known.add(password.encode())
patterns=[rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',rb'gh[pousr]_[A-Za-z0-9]{30,}',rb'AKIA[0-9A-Z]{16}']
hits=[]
for p in root.rglob('*'):
 if not p.is_file():continue
 assert p.name not in ['.env','app-runtime.env']
 b=p.read_bytes()
 if any(s in b for s in known) or any(re.search(x,b) for x in patterns):hits.append(p.relative_to(root).as_posix())
assert not hits,hits
report=json.loads((root/'data/restore-result.json').read_text())
assert sha((root/'data/database.dump').read_bytes())==report['preparedDumpSha256']
with tarfile.open(root/'data/uploads.tar.gz') as t:assert not any(m.isfile() for m in t.getmembers())
with tarfile.open(root/'data/uploads.tar.gz') as t:assert t.getmembers(), 'Real archive expected'
check={'sourceRevision':rev,'sourceFiles':312,'type':'clean-install-other-MAX-bot','databasePreparedOnIsolatedCopy':True,'uploadsFiles':0,'runtimeEnvIncluded':False,'knownLocalSecretValuesChecked':len(known),'secretMatches':hits,'databaseExpandedSQLSecretScan':{'checked':report['secretValuesChecked'],'matches':report['secretMatches']},'unchangedSince0e6ac39':unchanged,'oldBotStarted':False,'liveMaxTest':False}
(verification/'package-check.json').write_text(json.dumps(check,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
entries={p.relative_to(root).as_posix():sha(p.read_bytes()) for p in sorted(root.rglob('*')) if p.is_file() and p.name!='SHA256SUMS'}
(root/'SHA256SUMS').write_text(''.join(f'{v}  {k}\n' for k,v in entries.items()),encoding='utf-8',newline='\n')
archive=out/'Na-svyazi-region40-full-2026-09-30.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file():z.write(p,'Na-svyazi-region40/'+p.relative_to(root).as_posix())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for k,v in entries.items():assert sha(z.read('Na-svyazi-region40/'+k))==v,k
 assert len(z.namelist())==len(entries)+1
digest=sha(archive.read_bytes());archive.with_suffix('.zip.sha256').write_text(digest+'  '+archive.name+'\n',encoding='ascii')
print(json.dumps({'archive':str(archive.resolve()),'sha256':digest,'files':len(entries)+1,'bytes':archive.stat().st_size,**check},ensure_ascii=False,indent=2))
