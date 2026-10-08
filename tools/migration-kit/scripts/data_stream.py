"""Bounded NDJSON -> private SQLite index -> merge comparison.

Only one frame/row at a time in Python; SQLite cache 2 MiB, no mmap, temp on disk.
A complete footer, unique row IDs, exact columns, counts and stream hash are
mandatory. The small data.json manifest seals the index only after exporter exit.
"""
import hashlib,json,os,re,sqlite3,time
from pathlib import Path
import ops_common as o
from data_check import value_hash
FORMAT='pr14-18-data-v2'
HEX=re.compile('[0-9a-f]{64}')
DEFAULTS={'Incident':{'slaPolicy':'LEGACY','slaDeliveredAt':None,'workingDeadlineQueuedAt':None},'OutboundMessage':{'cancelledAt':None,'cancelReason':None}}

def digest(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def connect(path,readonly=False):
 c=sqlite3.connect(Path(path).resolve().as_uri()+'?mode=ro',uri=True) if readonly else sqlite3.connect(path)
 c.execute('PRAGMA cache_size=-2048');c.execute('PRAGMA mmap_size=0');c.execute('PRAGMA temp_store=FILE')
 return c

def receive(exporter,path,timeout=90):
 path=Path(path);o.need(not path.exists(),'NEW_DATA_INDEX_REQUIRED')
 with path.open('xb'):os.chmod(path,0o600)
 c=connect(path);sha=hashlib.sha256();tables=rows=fields=0;active=None;columns=None;until=time.monotonic()+timeout
 try:
  c.executescript('CREATE TABLE tables(name TEXT PRIMARY KEY, columns TEXT NOT NULL); CREATE TABLE rows(t TEXT NOT NULL, id TEXT NOT NULL, fields TEXT NOT NULL, PRIMARY KEY(t,id)) WITHOUT ROWID;')
  def read():
   left=until-time.monotonic();o.need(left>0,'EXPORTER_DATA_TIMEOUT')
   frame=exporter.read_json('data',left)
   if frame.get('type')!='end':sha.update(exporter.last_line.encode('utf-8'))
   return frame
  o.need(read()=={'format':FORMAT,'type':'begin'},'INVALID_DATA_SNAPSHOT')
  while True:
   f=read();kind=f.get('type')
   if kind=='end':
    o.need(f=={'type':'end','tables':tables,'rows':rows,'fields':fields,'sha256':sha.hexdigest()},'EXPORTER_FOOTER_MISMATCH');break
   if kind=='table':
    o.need(set(f)=={'type','table','columns'} and isinstance(f['table'],str) and isinstance(f['columns'],list),'INVALID_TABLE_FRAME')
    o.need(all(isinstance(x,str) for x in f['columns']) and len(f['columns'])==len(set(f['columns'])),'INVALID_COLUMNS')
    active=f['table'];columns=set(f['columns']);c.execute('INSERT INTO tables VALUES (?,?)',(active,json.dumps(sorted(columns))))
    tables+=1
   elif kind=='row':
    o.need(set(f)=={'type','table','id','fields'} and active is not None and f['table']==active and isinstance(f['id'],str) and isinstance(f['fields'],dict),'INVALID_ROW_FRAME')
    o.need(set(f['fields'])==columns and all(isinstance(v,str) and HEX.fullmatch(v) for v in f['fields'].values()),'INVALID_FIELD_FINGERPRINTS')
    c.execute('INSERT INTO rows VALUES (?,?,?)',(active,f['id'],json.dumps(f['fields'],separators=(',',':'))))
    rows+=1;fields+=len(columns)
    if rows%128==0:c.commit()
   else:raise o.Refusal('UNKNOWN_DATA_FRAME')
  c.commit()
  return {'format':FORMAT,'index':path.name,'tables':tables,'rows':rows,'fields':fields,'streamSha256':sha.hexdigest(),'indexSha256':digest(path)}
 except sqlite3.IntegrityError:raise o.Refusal('DUPLICATE_DATA_ID_OR_TABLE') from None
 finally:c.close()

def opened(manifest):
 manifest=Path(manifest);m=o.read_json(manifest)
 o.need(m.get('format')==FORMAT and m.get('index')=='data.sqlite','SNAPSHOT_V2_REQUIRED')
 path=manifest.parent/m['index'];o.need(not path.is_symlink() and digest(path)==m['indexSha256'],'DATA_INDEX_CHECKSUM_MISMATCH')
 c=connect(path,True)
 o.need(c.execute('SELECT count(*) FROM rows').fetchone()[0]==m['rows'] and c.execute('SELECT count(*) FROM tables').fetchone()[0]==m['tables'],'DATA_INDEX_COUNTS_MISMATCH')
 return c

def differences(before,after,migrated=False):
 a=opened(before);b=None
 try:
  b=opened(after)
  ta=dict(a.execute('SELECT name,columns FROM tables'));tb=dict(b.execute('SELECT name,columns FROM tables'))
  for t in sorted(set(ta)|set(tb)):
   if t not in tb:yield [t,'MISSING_TABLE'];continue
   if t not in ta:
    if not (migrated and t=='IncidentAssignmentCycle'):yield [t,'ADDED_TABLE']
    continue
   ca=set(json.loads(ta[t]));cb=set(json.loads(tb[t]))
   for col in sorted(ca-cb):yield [t,col,'MISSING_COLUMN']
   for col in sorted(cb-ca):
    if not (migrated and col in DEFAULTS.get(t,{})):yield [t,col,'ADDED_COLUMN']
  ai=iter(a.execute('SELECT t,id,fields FROM rows ORDER BY t,id'));bi=iter(b.execute('SELECT t,id,fields FROM rows ORDER BY t,id'))
  x=next(ai,None);y=next(bi,None)
  while x is not None or y is not None:
   if y is None or (x is not None and x[:2]<y[:2]):
    yield [*x[:2],'MISSING'];x=next(ai,None)
   elif x is None or y[:2]<x[:2]:
    if not (migrated and y[0]=='_prisma_migrations'):yield [*y[:2],'NEW_ROW']
    y=next(bi,None)
   else:
    old=json.loads(x[2]);new=json.loads(y[2])
    for field,h in old.items():
     if new.get(field)!=h:yield [*x[:2],field,'CHANGED']
    for field,h in new.items():
     if field not in old:
      defaults=DEFAULTS.get(x[0],{})
      if not (migrated and field in defaults and h==value_hash(defaults[field])):yield [*x[:2],field,'ADDED_FIELD']
    x=next(ai,None);y=next(bi,None)
 finally:
  a.close()
  if b is not None:b.close()

def report(before,after,path,migrated=False):
 count=0
 with Path(path).open('x',encoding='utf-8') as f:
  os.chmod(path,0o600);f.write('{"differences":[')
  for change in differences(before,after,migrated):
   if count:f.write(',')
   json.dump(change,f,ensure_ascii=False);count+=1
  f.write('],"differenceCount":'+str(count)+',"automaticAcceptance":'+('false' if count else 'true')+'}')
 return count
