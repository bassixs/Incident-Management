"""Bounded exporter protocol and cleanup of its uniquely owned Docker container.

Never persist stdout or raw stderr. The latter is untrusted (it can contain
connection strings, SQL and resident content), so diagnostics keep only fixed
technical signatures and counters. Limits match the reviewed original kit.
"""
import collections,json,os,queue,re,subprocess,threading,time
from pathlib import Path
import ops_common as o

LABEL='incident.ops.snapshot-export'
def clean_stderr(text):
    signatures={
      'JS_HEAP_OOM':'JavaScript heap out of memory',
      'SEGMENTATION_FAULT':'Segmentation fault',
      'PRISMA_ENGINE':'libquery_engine',
      'SNAPSHOT_SCRIPT_FAILED':'DATA_SNAPSHOT_FAILED',
      'MODULE_NOT_FOUND':"MODULE_NOT_FOUND",
      'PERMISSION_DENIED':'EACCES',
      'CONNECTION_REFUSED':'ECONNREFUSED',
      'BROKEN_PIPE':'EPIPE',
    }
    markers=[key for key,value in signatures.items() if value in text]
    codes=sorted(set(re.findall(r'\bP(?:1000|1001|1002|1003|1008|1010|1011|1012|1017|2024|2028)\b',text)))
    versions=sorted(set(re.findall(r'Node\.js (v[0-9]+\.[0-9]+\.[0-9]+)',text)))
    return {'markers':markers,'prismaCodes':codes,'nodeVersions':versions,
            'rawTextOmitted':True}

class Exporter:
    def __init__(self,command,dest):
        self.command=command;self.dest=Path(dest);self.name='incident-snapshot-'+os.urandom(12).hex()
        self.cid=None;self.process=None;self.phase='create';self.lines=queue.Queue()
        self.tail=collections.deque(maxlen=64);self.stderr_bytes=0;self.stderr_lines=0
        self.readers=[];self.finished=False;self.state=None;self.cleanup='not-started'
        self.error=None;self.started=o.stamp()
        self.create_attempted=False
    def __enter__(self):
        try:
            o.need(self.command[:2]==['docker','run'],'EXPORTER_COMMAND_INVALID')
            args=[x for x in self.command[2:] if x!='--rm']
            # Establish a durable, inspectable container identity before attaching.
            self.create_attempted=True
            created=o.command(['docker','create','--name',self.name,'--label',LABEL+'='+self.name,'--log-driver','none',*args],timeout=30)
            self.cid=created.stdout.strip()
            o.need(bool(re.fullmatch('[0-9a-f]{64}',self.cid)),'EXPORTER_ID_INVALID')
            self._inspect()
            self.process=subprocess.Popen(['docker','start','--attach','--interactive',self.cid],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8',errors='replace')
            def stdout():
                try:
                    for line in self.process.stdout:self.lines.put(line)
                finally:self.lines.put(None)
            def stderr():
                # Bounded chunks also handle a huge stderr line without a newline.
                while True:
                    line=self.process.stderr.read(2048)
                    if not line:break
                    self.stderr_bytes+=len(line.encode());self.stderr_lines+=1
                    self.tail.append(line)
            for reader in [stdout,stderr]:
                t=threading.Thread(target=reader,daemon=True);t.start();self.readers.append(t)
            return self
        except BaseException as exc:
            self.__exit__(type(exc),exc,exc.__traceback__);raise
    def _inspect(self):
        row=o.inspect(self.cid or self.name)
        o.need(row.get('Name','').lstrip('/')==self.name and row['Config'].get('Labels',{}).get(LABEL)==self.name,'EXPORTER_OWNER_MISMATCH')
        if self.cid:o.need(row['Id']==self.cid,'EXPORTER_ID_CHANGED')
        else:self.cid=row['Id']
        self.state={k:row['State'].get(k) for k in ['Status','Running','ExitCode','OOMKilled','StartedAt','FinishedAt']}
        return row
    def read_json(self,phase,timeout):
        self.phase=phase
        try:line=self.lines.get(timeout=timeout)
        except queue.Empty:raise o.Refusal('EXPORTER_'+phase.upper()+'_TIMEOUT') from None
        o.need(line is not None,'EXPORTER_'+phase.upper()+'_EOF')
        try:result=json.loads(line)
        except (ValueError,TypeError):raise o.Refusal('EXPORTER_'+phase.upper()+'_INVALID_JSON') from None
        o.need(isinstance(result,dict),'EXPORTER_'+phase.upper()+'_INVALID_OBJECT')
        return result
    def finish(self):
        self.phase='release'
        try:
            self.process.stdin.write('release\n');self.process.stdin.flush();self.process.stdin.close()
        except (BrokenPipeError,OSError):raise o.Refusal('EXPORTER_RELEASE_PIPE_FAILED') from None
        try:rc=self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:raise o.Refusal('EXPORTER_RELEASE_TIMEOUT') from None
        row=self._inspect()
        o.need(rc==0 and not row['State']['Running'] and row['State']['ExitCode']==0 and not row['State']['OOMKilled'],'EXPORTER_EXIT_FAILED')
        self.finished=True
    def __exit__(self,kind,error,trace):
        self.error=str(error) if isinstance(error,o.Refusal) else (type(error).__name__ if error else None)
        cleanup_error=None
        try:
            if self.process and self.process.stdin and not self.process.stdin.closed:
                try:self.process.stdin.close()
                except (BrokenPipeError,OSError):pass
            # If create failed ambiguously, consult only this random, owned name.
            if not self.cid:
                names=o.output(['docker','ps','-a','--format','{{.Names}}']).splitlines()
                if self.name in names:self._inspect()
                # A create timeout can have a late daemon result. One absent
                # inventory entry does not prove that it can never appear.
                elif self.create_attempted:raise o.Refusal('EXPORTER_CREATE_RESULT_UNKNOWN')
            if self.cid:
                row=self._inspect()
                if row['State']['Running']:
                    o.command(['docker','stop','-t','15',self.cid],timeout=20)
                    row=self._inspect()
                o.need(not row['State']['Running'],'EXPORTER_STILL_RUNNING')
            if self.process:
                try:self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    self.process.terminate();self.process.wait(timeout=5)
                for t in self.readers:t.join(timeout=5)
                o.need(not any(t.is_alive() for t in self.readers),'EXPORTER_READER_STILL_RUNNING')
            if self.cid:o.command(['docker','rm',self.cid],timeout=10)
            self.cleanup='confirmed'
        except Exception as exc:
            cleanup_error=exc;self.cleanup='unknown'
        finally:
            diagnostic={'format':'snapshot-export-result-v1','startedAt':self.started,'finishedAt':o.stamp(),
                'phase':self.phase,'success':self.finished and error is None and cleanup_error is None,
                'error':self.error,'cliExitCode':self.process.poll() if self.process else None,
                'containerId':self.cid,'containerName':self.name,'containerState':self.state,
                'cleanup':self.cleanup,'stderrBytes':self.stderr_bytes,'stderrChunks':self.stderr_lines,
                'stderr':clean_stderr(''.join(self.tail))}
            o.save_new(self.dest/'exporter-result.json',diagnostic)
            print('EXPORTER_RESULT:'+json.dumps(diagnostic),flush=True)
            if self.process:
                for stream in [self.process.stdout,self.process.stderr]:
                    if stream:stream.close()
        if cleanup_error:raise o.Refusal('EXPORTER_CLEANUP_UNCONFIRMED') from None
        return False
