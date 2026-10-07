"""Package tested scripts and previously verified archive; never build an image."""
import hashlib,json,os,shutil,subprocess,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2];out=ROOT/'package-output';out.mkdir()
kit=ROOT/'installation-kit-pr14-18';kit.mkdir()
def digest(p):
 with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
for name in ['PLAN.md','LIMITATIONS.md','EXPORTER-REVIEW.md','settings.example.json']:
 shutil.copyfile(ROOT/'tools/migration-kit'/name,kit/name)
shutil.copytree(ROOT/'tools/migration-kit/scripts',kit/'scripts',ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
shutil.copyfile(ROOT/'kit-results/schema-expectations.json',kit/'schema-expectations.json')
shutil.copyfile(ROOT/'kit-results/images.json',kit/'IMAGES.json')
shutil.copyfile(ROOT/'kit-results/image-bindings.json',kit/'IMAGE-BINDINGS.json')
shutil.copyfile(ROOT/'verified-images/main-and-reserve.tar.gz',kit/'main-and-reserve.tar.gz')
shutil.copyfile(ROOT/'verified-images/main-and-reserve.tar.gz.sha256',kit/'main-and-reserve.tar.gz.sha256')
(kit/'sources').mkdir()
for role in ['main','reserve']:
 rev=json.loads((kit/'IMAGES.json').read_text())[role]['revision']
 subprocess.run(['git','archive','--format=tar.gz','-o',str(kit/'sources'/(role+'.tar.gz')),rev],cwd=ROOT,check=True)
(kit/'review').mkdir()
for name in ['operational-result.json','backup-restore-result.json','component-versions.json']:
 shutil.copyfile(ROOT/'kit-results'/name,kit/'review'/name)
for name in ['unit.log','operational.log','environment.txt']:shutil.copyfile(ROOT/name,kit/'review'/name)
shutil.copytree(ROOT/'tools/install-kit-lab/baseline-evidence',kit/'review/baseline-evidence')
shutil.copytree(ROOT/'tools/install-kit-lab',kit/'review/tests',ignore=shutil.ignore_patterns('__pycache__','*.pyc','baseline-evidence'))
for p in (ROOT/'kit-results').glob('exporter-fault-*.json'):shutil.copyfile(p,kit/'review'/p.name)

diff=subprocess.check_output(['git','diff','e1c15c777b8123c85f683cf2528aab2b7a03bfae','HEAD','--','tools/migration-kit','tools/install-kit-lab','.github/workflows/backup-exporter-review.yml'],cwd=ROOT)
(kit/'review/ops.diff').write_bytes(diff)
(kit/'KIT.json').write_text(json.dumps({'edition':'pr14-18-exporter-v2','settingsFormat':'pr14-18-v1','opsCommit':os.environ['GITHUB_SHA'],'parentOps':'e1c15c777b8123c85f683cf2528aab2b7a03bfae','applicationImageArtifact':11510892680,'applicationImageRun':37686043412,'imageBuildsInThisRun':0,'actionsRun':os.environ['GITHUB_RUN_ID']},indent=2))
(kit/'SHA256SUMS').write_text(''.join(digest(p)+'  '+p.relative_to(kit).as_posix()+'\n' for p in sorted(kit.rglob('*')) if p.is_file()))
archive=out/'installation-kit-pr14-18.zip'
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_STORED) as z:
 for p in sorted(kit.rglob('*')):
  if p.is_file():z.write(p,p.relative_to(kit))
(out/(archive.name+'.sha256')).write_text(digest(archive)+'  '+archive.name+'\n')
shutil.copyfile(kit/'KIT.json',out/'KIT.json');shutil.copyfile(kit/'SHA256SUMS',out/'INTERNAL-SHA256SUMS')
print(json.dumps({'archiveSha256':digest(archive),'size':archive.stat().st_size,'files':len((kit/'SHA256SUMS').read_text().splitlines())}))
