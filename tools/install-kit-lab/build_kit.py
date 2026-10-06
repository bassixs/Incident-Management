"""Exact pinned image builds and archive reload after all kit checks pass."""
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('container_lab',ROOT/'tools/reserve-container-lab/run.py')
lab=importlib.util.module_from_spec(spec);spec.loader.exec_module(lab)
lab.VERSIONS['reserve']='1a7a0f54217ef33bf4d7fac92f69e8ddfe46ec66'
OUT=ROOT/'kit-results';OUT.mkdir(exist_ok=True)
PACKAGE=ROOT/'installation-kit';PACKAGE.mkdir(exist_ok=True)

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Disposable Actions only')
    if lab.docker('ps','-aq').stdout.strip():raise RuntimeError('Nonempty daemon')
    lab.build()
    p=subprocess.run([sys.executable,str(Path(__file__).with_name('ops_test.py'))],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=2200)
    (OUT/'ops-tests.txt').write_text(p.stdout);print(p.stdout,flush=True)
    if p.returncode:raise RuntimeError('Migration kit tests failed: no final image archive produced')
    if lab.docker('ps','-aq').stdout.strip():raise RuntimeError('Owned lab cleanup incomplete')
    # Preserve only two approved runtime images, no build stages or fixture image.
    raw=OUT/'images.tar'
    lab.docker('save','-o',raw,'incident-lab:main','incident-lab:reserve',timeout=300)
    archive=PACKAGE/'main-and-compatible-reserve.tar.gz'
    with raw.open('rb') as source,archive.open('wb') as dst:
        with gzip.GzipFile(filename='',mode='wb',fileobj=dst,mtime=0,compresslevel=6) as zipped:shutil.copyfileobj(source,zipped)
    raw.unlink()  # only our temporary synthetic packaging file
    digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
    (PACKAGE/(archive.name+'.sha256')).write_text(digest+'  '+archive.name+'\n')
    # Remove exact runtime tags/IDs from disposable daemon before loading archive.
    for version in lab.VERSIONS:lab.docker('image','rm','--no-prune','incident-lab:'+version)
    p=lab.docker('load','-i',archive,timeout=300);(OUT/'archive-load.txt').write_text(p.stdout+p.stderr)
    for version,meta in lab.report['images'].items():
        info=json.loads(lab.docker('image','inspect','incident-lab:'+version).stdout)[0]
        lab.check('loaded actual archive image ID '+version,info['Id']==meta['id'])
        lab.check('loaded revision '+version,info['Config']['Labels']['org.opencontainers.image.revision']==meta['sha'])
        manifest=json.loads((lab.OUT/(version+'-files.json')).read_text())
        script="const f=require('fs'),c=require('crypto');const expected=JSON.parse(process.argv[1]);for(const [p,h] of Object.entries(expected)){if(c.createHash('sha256').update(f.readFileSync(p)).digest('hex')!==h)throw Error('FILE_MISMATCH:'+p)}console.log(Object.keys(expected).length)"
        count=lab.docker('run','--rm','--network','none','--entrypoint','node','incident-lab:'+version,'-e',script,json.dumps(manifest)).stdout.strip()
        lab.check('loaded code/schema/lock manifest '+version,int(count)==len(manifest))
    shutil.copytree(ROOT/'tools/migration-kit/scripts',PACKAGE/'scripts',ignore=shutil.ignore_patterns('__pycache__'))
    shutil.copyfile(OUT/'schema-expectations.json',PACKAGE/'schema-expectations.json')
    proof={'versions':lab.VERSIONS,'images':lab.report['images'],'archive':archive.name,'sha256':digest,'size':archive.stat().st_size,'archiveReloadVerified':True}
    (PACKAGE/'IMAGES.json').write_text(json.dumps(proof,indent=2))
    for name in ('PLAN.md','LIMITATIONS.md'):
        src=ROOT/'tools/migration-kit'/name
        if src.exists():shutil.copyfile(src,PACKAGE/name)
    sums=[]
    for path in sorted(PACKAGE.rglob('*')):
        if path.is_file():
            with path.open('rb') as source:h=hashlib.file_digest(source,'sha256').hexdigest()
            sums.append(h+'  '+path.relative_to(PACKAGE).as_posix())
    (PACKAGE/'SHA256SUMS').write_text('\n'.join(sums)+'\n')
    print(json.dumps(proof,indent=2),flush=True)

if __name__=='__main__':main()
