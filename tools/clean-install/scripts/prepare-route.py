"""Offline exact Caddy route candidate. Never writes active configuration or calls Docker."""
import argparse,pathlib,hashlib,json,os,re

def digest(b):return hashlib.sha256(b).hexdigest()
p=argparse.ArgumentParser();p.add_argument('--config',required=True);p.add_argument('--sha256',required=True);p.add_argument('--old',required=True);p.add_argument('--new',required=True);p.add_argument('--count',type=int,required=True);p.add_argument('--output',required=True);a=p.parse_args();os.umask(0o077)
src=pathlib.Path(a.config);out=pathlib.Path(a.output)
if src.is_symlink() or out.exists():raise SystemExit('NEW_PRIVATE_OUTPUT_REGULAR_SOURCE_REQUIRED')
b=src.read_bytes()
if digest(b)!=a.sha256:raise SystemExit('CADDY_CHANGED')
for x in [a.old,a.new]:
 if not re.fullmatch('[a-zA-Z0-9_.-]+:3000',x):raise SystemExit('EXACT_UPSTREAM_REQUIRED')
old=('reverse_proxy '+a.old).encode();new=('reverse_proxy '+a.new).encode()
# Exact complete directive. Similar names, extra arguments and comments refuse.
lines=b.splitlines(keepends=True);matched=[i for i,x in enumerate(lines) if x.strip()==old]
if a.old==a.new or a.count<1 or len(matched)!=a.count or b.count(a.old.encode())!=a.count or a.new.encode() in b:raise SystemExit('ROUTE_SET_NOT_EXACT')
for i in matched:lines[i]=lines[i].replace(old,new)
after=b''.join(lines);out.mkdir(mode=0o700)
(out/'Caddyfile.before').write_bytes(b);(out/'Caddyfile.candidate').write_bytes(after)
(out/'route.json').write_text(json.dumps({'beforeSha256':digest(b),'candidateSha256':digest(after),'source':str(src.resolve()),'old':a.old,'new':a.new,'count':a.count,'applied':False},indent=2))
print('PREPARED_ONLY_VALIDATE_AND_REVIEW_BEFORE_APPLY')
