"""Read-only external HTTP availability check. Run on a different machine, no bot token."""
import argparse,json,ssl,urllib.request,sys
p=argparse.ArgumentParser();p.add_argument('--url',required=True);p.add_argument('--ca');a=p.parse_args()
if not a.url.startswith('https://') or '?' in a.url:raise SystemExit('HTTPS_BASE_URL_REQUIRED')
result={}
for path in ['health','ready']:
 try:
  with urllib.request.urlopen(a.url.rstrip('/')+'/'+path,timeout=5,context=ssl.create_default_context(cafile=a.ca)) as r:result[path]=r.status
 except Exception:result[path]=0
ok=all(v==200 for v in result.values());print(json.dumps({'status':'UP' if ok else 'UNAVAILABLE','http':result}));sys.exit(0 if ok else 2)
