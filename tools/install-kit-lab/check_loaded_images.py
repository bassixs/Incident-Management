import json,subprocess,tarfile,hashlib
from pathlib import Path
pins={
 'old':('59149006a7b3d30d01218fad84360e7d71e6d79e','sha256:c8d257430cf3432f4f862863e223e32f07da4bba4a8571a220b53cec5240a65e'),
 'main':('c41f2d532591ddeb2ce0ea3d217e8a1a2095f38a','sha256:a3001d85f28e396c201b3ed09cb6acc9043c1c2cd1bbed3cbe70c46c067af5fb'),
 'reserve':('3c5c38b0f6477d5124593406f09f3af4c2db0c12','sha256:2e4a8fbe1c97a51382f9f5c29c85643d234d269b7d0fcc233c008e9f2d56e7d5')}
images={}
for role,(revision,iid) in pins.items():
 row=json.loads(subprocess.check_output(['docker','image','inspect','incident-kit:old' if role=='old' else 'incident-lab:'+role]))[0]
 if row['Id']!=iid or row['Config']['Labels']['org.opencontainers.image.revision']!=revision or row['Os']!='linux' or row['Architecture']!='amd64':raise SystemExit('IMAGE_MISMATCH:'+role)
 images[role]={'id':iid,'revision':revision}
Path('kit-results').mkdir(exist_ok=True)
Path('kit-results/images.json').write_text(json.dumps(images,indent=2))
# Docker classic storage exposes config IDs; containerd may expose OCI manifest
# IDs. Accept only descriptors physically present in the SHA-pinned archives and
# pointing to these exact configs. Never infer equivalence from revision labels.
bindings={role:{iid} for role,(_,iid) in pins.items()}
for archive in ['original-kit/main-and-compatible-reserve.tar.gz','verified-images/main-and-reserve.tar.gz']:
 with tarfile.open(archive,'r:gz') as tar:
  for member in tar:
   if not member.isfile() or not member.name.startswith('blobs/sha256/') or member.size>65536:continue
   raw=tar.extractfile(member).read()
   try:doc=json.loads(raw)
   except (ValueError,UnicodeDecodeError):continue
   if not isinstance(doc,dict) or doc.get('schemaVersion')!=2 or not isinstance(doc.get('config'),dict):continue
   digest=hashlib.sha256(raw).hexdigest()
   if member.name!='blobs/sha256/'+digest:raise SystemExit('ARCHIVE_DESCRIPTOR_HASH_MISMATCH')
   for role,(_,iid) in pins.items():
    if doc['config'].get('digest')==iid:bindings[role].add('sha256:'+digest)
Path('kit-results/image-bindings.json').write_text(json.dumps({k:sorted(v) for k,v in bindings.items()},indent=2))
