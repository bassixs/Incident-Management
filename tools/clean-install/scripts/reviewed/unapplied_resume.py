"""Narrow cancellation before cutover. Never recreates a container or touches DB.

Requires a fresh R4 stop proof and unchanged operation journal. The proof is
evidence for cooperating operators, not protection against root deleting records.
"""
import json
import os
import pathlib
import ops_common as o

def digest(value):
    return o.sha(json.dumps(value, sort_keys=True, separators=(',', ':')).encode())

def container_config(c):
    # Inspect contains env credentials. Persist only a digest, never raw Config.
    return digest({k: c.get(k) for k in ('Config', 'HostConfig', 'Mounts')})

def relevant_inventory(s):
    cfg = o.compose(s, o.live_path(s))
    token = cfg['services']['app'].get('environment', {}).get('BOT_TOKEN')
    o.need(isinstance(token, str) and bool(token), 'BOT_IDENTITY_MISSING')
    images = {v['id'] for v in s['images'].values()}
    rows = {}
    for line in o.output(['docker', 'ps', '-a', '--format', '{{json .}}']).splitlines():
        try:
            name = json.loads(line)['Names']
        except (ValueError, KeyError):
            raise o.Refusal('INVALID_INVENTORY') from None
        c = o.inspect(name)
        env = dict(x.split('=', 1) for x in c['Config'].get('Env', []) if '=' in x)
        labels = c['Config'].get('Labels') or {}
        if (env.get('BOT_TOKEN') == token or c.get('Name', '').lstrip('/') == s['app']
            or c['Image'] in images or labels.get('com.docker.compose.project') == s['project']):
            rows[c['Id']] = {'identity': o.identity(c), 'config': container_config(c),
                            'state': c['State']}
    # Raw State is used only inside this digest. No resident data are inspected.
    return {cid: digest(value) for cid, value in sorted(rows.items())}

def operation_records(s, run):
    """Observe control records across runs, including incomplete atomic writes.

Database snapshots/backups are deliberately outside this set. Do not remove or
repair any control record to make a comparison pass.
"""
    result = {}
    root = pathlib.Path(s['prepared'])
    for directory in root.iterdir():
        if not directory.is_dir():
            continue
        for p in directory.iterdir():
            name = p.name
            control = (name.startswith(('applied.', 'apply-intent.', 'start-', 'resume-attempt.')))
            if not control or (directory == run and name == 'resume-attempt.json'):
                continue
            o.need(not directory.is_symlink() and p.is_file() and not p.is_symlink(),
                   'UNSAFE_CONTROL_RECORD')
            result[p.relative_to(root).as_posix()] = o.sha(p.read_bytes())
    return result

def sync_directory(path):
    if os.name == 'posix':
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

def record_new(path, value):
    o.save_new(path, value)
    sync_directory(path.parent)

def no_partial_files(s, run):
    o.need(not list(run.glob('*.ops-next')) and
           not o.live_path(s).with_name('compose.yml.ops-next').exists(),
           'PARTIAL_CONTROL_WRITE')

def proof_for_stop(s, run, before, stopped):
    o.need(container_config(before) == container_config(stopped), 'CONTAINER_CONFIG_CHANGED')
    no_partial_files(s, run)
    return {'version': 1, 'settingsHash': digest(s), 'containerConfig': container_config(stopped),
            'stopped': o.stopped_state(stopped), 'inventory': relevant_inventory(s),
            'records': operation_records(s, run)}

def apply_intent(s, run, c, old, new, before):
    # Write-ahead: even if Compose is changed and then restored or applied.json
    # never reaches disk, resume must not infer that cutover never began.
    o.need(not (run/'resume-attempt.json').exists(), 'RUN_ALREADY_CANCELLED')
    record_new(run/'apply-intent.json', {'from': old, 'to': new, 'container': o.identity(c),
               'composeBefore': o.sha(before), 'stopReceiptHash': o.sha((run/'stop-receipt.json').read_bytes()),
               'at': o.stamp()})

def validate(s, run, expected, receipt_bytes):
    o.require_lock(s)
    from migration_guard import ensure_cancel
    ensure_cancel(s)
    o.need((run/'stop-receipt.json').is_file() and not (run/'stop-receipt.json').is_symlink(),
           'UNSAFE_STOP_RECEIPT')
    o.need((run/'stop-receipt.json').read_bytes() == receipt_bytes, 'STOP_RECEIPT_CHANGED')
    no_partial_files(s, run)
    o.need(not any(p.name.startswith(('applied.', 'apply-intent.', 'start-')) for p in run.iterdir()),
           'UPDATE_ALREADY_STARTED')
    v = o.read_json(run/'stop-receipt.json')
    proof = v.get('resumeProof')
    o.need(isinstance(proof, dict) and proof.get('version') == 1, 'RESUME_PROOF_REQUIRED')
    o.need(proof.get('settingsHash') == digest(s), 'RESUME_SETTINGS_CHANGED')
    c = o.app(s)
    o.clean(c)
    o.need(c['Image'] == expected, 'WRONG_INSTALLED_IMAGE')
    o.receipt(s, run, c)
    o.need(o.stopped_state(c) == proof.get('stopped'), 'STOPPED_STATE_CHANGED')
    o.need(c['State']['FinishedAt'] == v.get('finishedAt'), 'STOP_FINISHED_AT_CHANGED')
    o.need(container_config(c) == proof.get('containerConfig'), 'CONTAINER_CONFIG_CHANGED')
    o.need(c['HostConfig']['RestartPolicy']['Name'] == 'no', 'RESTART_POLICY_CHANGED')
    # Both byte hash and effective configuration must still be the stopped one.
    o.config(s, o.live_path(s), expected, v['compose'])
    o.no_other_app(s)
    o.need(operation_records(s, run) == proof.get('records'), 'OPERATION_RECORDS_CHANGED')
    o.need(relevant_inventory(s) == proof.get('inventory'), 'CONTAINER_INVENTORY_CHANGED')
    return c, v

def resume(s, expected, name):
    o.require_lock(s)
    from migration_guard import ensure_cancel
    ensure_cancel(s)
    o.image(s, expected)
    run = o.run_dir(s, name)
    attempt = run/'resume-attempt.json'
    o.need(not attempt.exists() and not attempt.is_symlink(), 'RESUME_ALREADY_ATTEMPTED')
    receipt_bytes = (run/'stop-receipt.json').read_bytes()
    c, v = validate(s, run, expected, receipt_bytes)
    record = {'image': expected, 'container': o.identity(c), 'at': o.stamp(),
              'stopReceiptHash': o.sha(receipt_bytes), 'result': 'incomplete', 'ready': False}
    record_new(attempt, record)
    # Re-check after the durable intent and immediately before the only lifecycle command.
    validate(s, run, expected, receipt_bytes)
    result = o.command(['docker', 'start', c['Id']], timeout=60, allow_failure=True)
    current = o.app(s)
    record.update(result='returned', returncode=result.returncode,
                  observed=o.identity(current) if current else None)
    o.atomic(attempt, json.dumps(record).encode(), attempt.read_bytes())
    sync_directory(run)
    o.need(result.returncode == 0, 'RESUME_START_FAILED')
    o.need(current is not None and current['Id'] == c['Id'] and current['Image'] == expected,
           'RESUMED_CONTAINER_CHANGED')
    o.need(container_config(current) == v['resumeProof']['containerConfig'], 'CONTAINER_CONFIG_CHANGED')
    o.need(current['RestartCount'] == 0 and not current['State']['OOMKilled'], 'RESUMED_CONTAINER_UNHEALTHY')
    o.no_other_app(s, c['Id'])
    o.wait_ready(s, expected)
    final = o.app(s)
    o.need(final is not None and o.identity(final) == o.identity(current), 'RESUMED_CONTAINER_CHANGED')
    o.need(final['State']['Running'] and final['State']['Status'] == 'running'
           and not final['State']['OOMKilled'], 'RESUMED_CONTAINER_STOPPED')
    o.need(container_config(final) == v['resumeProof']['containerConfig'], 'CONTAINER_CONFIG_CHANGED')
    o.config(s, o.live_path(s), expected, v['compose'])
    o.need(operation_records(s, run) == v['resumeProof']['records'], 'OPERATION_RECORDS_CHANGED')
    record.update(ready=True, finishedAt=o.stamp(), final=o.identity(final))
    o.atomic(attempt, json.dumps(record).encode(), attempt.read_bytes())
    sync_directory(run)
