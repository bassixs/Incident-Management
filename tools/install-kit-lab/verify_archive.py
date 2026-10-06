"""Load the delivered archive on a second fresh disposable runner."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

def run(*args):return subprocess.check_output([str(a) for a in args],text=True,timeout=300)

def main():
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Disposable Actions only')
    if run('docker','ps','-aq').strip() or run('docker','image','ls','-q').strip():raise RuntimeError('Fresh empty daemon required')
    kit=Path('installation-kit').resolve()
    for line in (kit/'SHA256SUMS').read_text().splitlines():
        digest,name=line.split('  ',1);path=kit/name
        if not path.resolve().is_relative_to(kit):raise RuntimeError('Unsafe manifest path')
        with path.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
        if actual!=digest:raise RuntimeError('Checksum mismatch: '+name)
    meta=json.loads((kit/'IMAGES.json').read_text())
    expected={'main':'59149006a7b3d30d01218fad84360e7d71e6d79e','reserve':'1a7a0f54217ef33bf4d7fac92f69e8ddfe46ec66'}
    if meta['versions']!=expected or {k:v['sha'] for k,v in meta['images'].items()}!=expected:raise RuntimeError('Unapproved source revision')
    result={'archiveSha256':meta['sha256'],'docker':run('docker','version','--format','{{json .}}'),'images':{}}
    result['load']=run('docker','load','-i',kit/meta['archive'])
    script="const f=require('fs'),c=require('crypto'),m=JSON.parse(f.readFileSync('/verify.json'));for(const [p,h] of Object.entries(m))if(c.createHash('sha256').update(f.readFileSync(p)).digest('hex')!==h)throw Error(p);console.log(Object.keys(m).length)"
    for role,im in meta['images'].items():
        row=json.loads(run('docker','image','inspect','incident-lab:'+role))[0]
        if row['Id']!=im['id'] or row['Config']['Labels']['org.opencontainers.image.revision']!=im['sha']:raise RuntimeError('Wrong restored image')
        count=int(run('docker','run','--rm','--network','none','--cpus','0.5','--memory','128m','-v',str(kit/(role+'-files.json'))+':/verify.json:ro','--entrypoint','node',im['id'],'-e',script))
        result['images'][role]={'id':row['Id'],'sha':im['sha'],'verifiedFiles':count}
    if run('docker','ps','-aq').strip():raise RuntimeError('Unexpected container left')
    result['success']=True
    Path('fresh-archive-verification.json').write_text(json.dumps(result,indent=2))
    (kit/'fresh-archive-verification.json').write_text(json.dumps(result,indent=2))
    sums=[]
    for path in sorted(kit.rglob('*')):
        if path.is_file() and path.name!='SHA256SUMS':
            with path.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
            sums.append(digest+'  '+path.relative_to(kit).as_posix())
    (kit/'SHA256SUMS').write_text('\n'.join(sums)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
