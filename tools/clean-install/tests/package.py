import gzip,hashlib,json,pathlib,shutil,subprocess,zipfile
ROOT=pathlib.Path(__file__).resolve().parents[3];K=ROOT/'tools/clean-install';OUT=ROOT/'clean-package';OUT.mkdir();D=OUT/'kit';D.mkdir()
report=json.loads((ROOT/'clean-results/report.json').read_text());
if not report['passed']:raise RuntimeError('NO_PACKAGE_FROM_FAILED_RUN')
for n in ['scripts','docs']:shutil.copytree(K/n,D/n,ignore=shutil.ignore_patterns('__pycache__'))
shutil.copyfile(ROOT/'verified-images/main-and-reserve.tar.gz',D/'main-and-reserve.tar.gz')
infra=ROOT/'clean-results/image-ids.json';meta=json.loads(infra.read_text());shutil.copyfile(infra,D/'IMAGE-IDS.json')
raw=OUT/'infrastructure.tar';subprocess.run(['docker','save','-o',str(raw),meta['postgres'],meta['caddy']],check=True)
with raw.open('rb') as src,gzip.open(D/'postgres-and-caddy.tar.gz','wb') as dst:shutil.copyfileobj(src,dst)
raw.unlink()
(D/'review').mkdir()
for n in ['report.json','environment.txt','image-ids.json','cleanup.txt']:shutil.copyfile(ROOT/'clean-results'/n,D/'review'/n)
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip();(D/'VERSION.json').write_text(json.dumps({'toolCommit':sha,'applicationBuilds':0,'main':'c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a','reserve':'3c5c38b0f6477d5124593406f09f3af4c2db0c12','reviewedDependencies':'40967e269d1cd60db58a142ac0c979e444ae67eb','run':__import__('os').environ.get('GITHUB_RUN_ID')},indent=2))
lines=[]
for p in sorted(D.rglob('*')):
 if p.is_file():lines.append(hashlib.file_digest(p.open('rb'),'sha256').hexdigest()+'  '+p.relative_to(D).as_posix())
(D/'SHA256SUMS').write_text('\n'.join(lines)+'\n')
z=OUT/'clean-install-reviewed.zip'
with zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as f:
 for p in D.rglob('*'):
  if p.is_file():f.write(p,p.relative_to(D).as_posix(),compress_type=zipfile.ZIP_STORED if p.suffix=='.gz' else zipfile.ZIP_DEFLATED)
(z.with_suffix('.zip.sha256')).write_text(hashlib.file_digest(z.open('rb'),'sha256').hexdigest()+'  '+z.name+'\n')
shutil.rmtree(D) # Only this packager's newly created staging directory in disposable runner.
