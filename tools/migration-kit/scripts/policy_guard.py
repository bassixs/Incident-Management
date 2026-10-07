"""Explicit activation consent, not a database rewrite or runtime.env edit."""
from pathlib import Path
import ops_common as o
import unapplied_resume as u

def path(s): return Path(s['prepared'])/'policy-activation.json'

def ensure_policy(s):
    o.need(not path(s).is_symlink() and not path(s).with_name(path(s).name+'.ops-next').exists(),'UNSAFE_POLICY_RECEIPT')
    if s['policy']=='LEGACY':
        o.need(not path(s).exists(),'UNEXPECTED_POLICY_RECEIPT')
        return
    v=o.read_json(path(s))
    o.need(v=={'policy':'WORKING_HOURS_V1','settingsHash':u.digest(s),
               'migrationReceiptHash':o.sha((Path(s['prepared'])/'migration-intent.json').read_bytes())},
           'POLICY_RECEIPT_MISMATCH')

def activate(s,ack):
    from migration_guard import ensure_new
    o.require_lock(s);ensure_new(s)
    o.need(ack=='activate-WORKING_HOURS_V1-for-new-incidents' and s['policy']=='WORKING_HOURS_V1','POLICY_ACK_REQUIRED')
    o.no_other_app(s)
    o.clean(o.app(s))
    p=path(s)
    o.need(not p.exists() and not p.is_symlink() and not p.with_name(p.name+'.ops-next').exists(),'POLICY_ALREADY_ATTEMPTED')
    u.record_new(p,{'policy':s['policy'],'settingsHash':u.digest(s),
                   'migrationReceiptHash':o.sha((Path(s['prepared'])/'migration-intent.json').read_bytes())})
    ensure_policy(s)
