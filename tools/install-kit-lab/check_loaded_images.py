import json,subprocess
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
