"""Private, complete per-field reconciliation. Differences require review, never retry.

Accepts additive migration defaults only; post-start changes are reported, not
silently treated as user activity. Every table/field, including JSON progress,
cycles, deadlines, cancellation reasons and storage fences, is fingerprinted.
"""
import hashlib,json

def value_hash(v):return hashlib.sha256(json.dumps(v,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()

def compare(before,after,migrated=False):
    if before.get('format')!='pr14-18-data-v1' or after.get('format')!=before['format']:raise ValueError('SNAPSHOT_FORMAT')
    changes=[]
    for table,rows in before['tables'].items():
        current=after['tables'].get(table,{})
        for key,fields in rows.items():
            if key not in current:changes.append([table,key,'MISSING']);continue
            for field,h in fields.items():
                if current[key].get(field)!=h:changes.append([table,key,field,'CHANGED'])
            for field,h in current[key].items():
                if field in fields:continue
                default={'Incident':{'slaPolicy':'LEGACY','slaDeliveredAt':None,'workingDeadlineQueuedAt':None},'OutboundMessage':{'cancelledAt':None,'cancelReason':None}}.get(table,{})
                if not (migrated and field in default and h==value_hash(default[field])):changes.append([table,key,field,'ADDED_FIELD'])
    for table,rows in after['tables'].items():
        for key in rows.keys()-before['tables'].get(table,{}).keys():
            if migrated and table=='_prisma_migrations':continue # exact names/checksums/completion checked independently by schema guard
            changes.append([table,key,'NEW_ROW'])
    return changes
