# Database failure boundaries and post-commit media deletion

Base: `bbfa7b91c3a149d8951d36a28aefbe9b8e3ffa6c`. These changes are separate from
the R4 Docker laboratory. No production repair, retention run, image build or
deployment is part of this change.

## Inbox

A claim has a random `InboundUpdate.processingToken`. Every completion or error
settlement compares that token, `PROCESSING` and the captured lease timestamp.
Two processes claiming in the same millisecond cannot settle each other's work.
The read after claiming is inside error handling. A lost claim acknowledgement
is reconciled through the same ownership predicate, without calling the handler.

Only a failure **before** dispatch can return to `PENDING`: at most three claim
attempts, with a five-second delay between them. Failures once dispatch has
started remain `FAILED` for review, including an uncertain completion write.
`PROCESSED` is written only after dispatch returns. If its ACK is lost after the
database accepted it, the error CAS cannot overwrite the completed row.

When the database also rejects the error-state write, the existing inbox sweep
retries the pending **state settlement**, not the business action. Until storage
recovers the row can still be `PROCESSING`; no process can promise a database
write during an outage. A process restart retains the existing conservative
policy: interrupted processing becomes `FAILED`, without replay. The in-memory
knowledge that dispatch never started is deliberately not inferred after a crash.
There must still be only one running application instance; this is not a new
multi-instance startup protocol. Terminal failed phone events are scrubbed.

## Enqueue

The outgoing UUID is allocated before writing owned files. After an INSERT error,
enqueue checks that UUID, then the caller's dedupe key. A confirmed row is reused;
no second INSERT or mutation of its status/progress is performed. A failed read
does not prove absence. Even a successful absent read after a transport error
does not rule out a transaction still committing, so its files are retained.

Only pre-INSERT staging failures and a confirmed unique-constraint rejection
permit removal of this attempt's newly staged files. Borrowed files and MAX photo
references are not removed by this path. An uncertain result with no recoverable
row is reported with the technical outbox ID (`ENQUEUE_RECONCILIATION_REQUIRED`).
There is no automatic enqueue replay and no orphan directory sweep. The durable
worker can resume a committed row after database recovery/restart.

Callers deliberately retrying a logical enqueue must preserve its dedupe key.
For an uncertain send without one, inspect the logged outbox ID before issuing a
new send; a new independent API call cannot infer the intent of the previous call.
Unresolved files remain for a separately reviewed ownership check. Lack of a row
at one point in time alone is not permission to delete them.

`deliveryProgress` remains v1 with the same plan hash/MIDs/part-order semantics.
Confirmed MAX parts are not reset by enqueue reconciliation. The previously
documented lost MAX ACK ambiguity is unchanged.

## Retention

The 90-day cutoff, terminal statuses and selection rules are unchanged. For each
candidate, retention locks the incident row, re-reads eligibility and current
attachment/answer membership, then deletes dependent jobs, action locks and the
incident in the same transaction. A no-longer-eligible candidate causes no
dependent deletion. A transaction rollback preserves all those records and files.

Physical removal is separate durable post-commit work, recorded in the same
deletion transaction under `SystemSetting.key = retention.file-delete.v1:<SHA256
of storageKey>`. The string value is versioned JSON with `version`, `storageKey`,
`size` and `publicCode`. It is internal data, not a user-editable setting.
Only a subsequent committed journal read permits file removal. A lost commit ACK
does not cause speculative deletion; committed intents can be recovered later.

The existing retention run drains at most 100 intents. It checks references in
incident, answer and clarification attachments, outbound attachments/payloads,
resident sessions, private work items and inbound payloads. Shared/unknown files
are retained and rotated to avoid starving later intents. MAX photo references
do not enter this journal. Failed removal leaves the intent for a later run;
repeated physical removal must remain idempotent. A failure after the removal but
before the journal commit can repeat the removal, never a business action.

Reference checks/removal use a separate transaction and bounded table locks
(`lock_timeout=2s`, transaction timeout 20s). They occur **after** the incident
deletion commit; they do not delete incident records. This briefly serializes
reference writers, including the outbox. A representative deployment must assess
storage latency and reference-scan cost before enabling the new retention code.
Filesystem/S3 operations are not a distributed PostgreSQL transaction: storage
keys must remain immutable and never be recycled for new content. A storage
operation with unknown outcome retains its intent for reconciliation.

## Migration and reserve requirements

Migration `20261006120000_inbox_processing_token` adds one nullable TEXT column
to `InboundUpdate`, without defaults, backfill, status changes or data deletion.
Apply it through the ordinary reviewed migration procedure before starting this
version. The JSON file-deletion journal requires no additional table migration.
Do not drop the column or delete journal entries during rollback.

Reserve `3479a893e98addf51509cdb331ba371c2c5aaabc` is **not automatically verified
for this change**. It understands deliveryProgress v1 but retains the three old
failure paths and does not drain the new file-deletion journal. An additive column
being readable by an older client is not evidence of safe fallback behavior.

Before installation, a separately reviewed reserve must backport claim ownership
and safe error settlement, enqueue reconciliation, and atomic retention plus its
post-commit journal (or explicitly keep retention disabled by a separately approved
operational plan). Re-run main → reserve → main using the same migrated synthetic
database, partial deliveryProgress, interrupted inbox claims, uncertain enqueue
and pending/shared file-deletion intents. Validate actual images, graceful worker
shutdown, backup/restore of the new field and journal, and readiness. None of those
new image/switch checks is claimed by this source-level PR.

## Evidence and fixture correction

The unchanged runtime at `823838eec8abf3f401e92542a0577445b8d12df1`
reproduced four regressions covering the three defects: claimed read left
PROCESSING, committed outgoing file missing, related job missing after an
eligibility change, and file missing after rollback. The selected integration
set also reproduced the pre-existing registration fixture failure.

That fixture created `WAITING_INCIDENT_CONFIRMATION` without a current
`data.previewToken` and called `create()` without matching `draftPreviewToken`.
It expected registration but received `ConflictError: Черновик уже подтверждён
или устарел.` The fixture now supplies a matching synthetic token. Production
token checks, the duplicate-registration rejection, incident count and atomic
registration/outbox assertions are unchanged.

CI uses synthetic PostgreSQL 16, MAX mocks, `npm ci`, typecheck, build, all unit
tests and the related integration set. Runtime and tests are never run against
production. The first diagnostic CI pipeline accidentally returned tee's status;
its failing JSON results were retained. Explicit bash/pipefail was then enabled
and the unchanged baseline was repeated with an actual failed Actions status.
The review report links both the confirmed baseline and final results; a green
workflow label alone is not considered test evidence.
