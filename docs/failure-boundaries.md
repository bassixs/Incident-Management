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
A PENDING retry with a future deadline and a PROCESSING claim hold their lane: a
later sequence in that partition cannot be selected or directly claimed. Other
partitions remain eligible. A terminal FAILED head releases its lane without
replaying its business action; persistent PENDING ordering survives restart.
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

The existing retention run examines at most 100 intents. Every examined record
rotates by `updatedAt`, including malformed, exhausted and not-yet-due records.
The companion `retention.file-state.v1:<SHA256>` record stores version, attempts,
status, nextAttemptAt and a technical reason. Attempts are persisted before work,
limited to three, separated by at least 60 seconds; there is no new polling timer.
Shared references consume this budget too: after exhaustion their intent remains
for review, not silent deletion. Invalid original records are retained verbatim.
Malformed companion state is also retained rather than guessed or repaired.

A short READ COMMITTED transaction takes an advisory lock **only on the storage
key**, checks current references in the seven reference tables and commits a
permanent `retention.file-fence.v1:<SHA256>` record before external removal. The
migration installs INSERT/UPDATE triggers on those tables. A writer adding a new
storageKey takes the same key lock and rejects a committed fence. Existing keys
retained by an UPDATE require no new reference lock. New reference writes under
REPEATABLE READ/SERIALIZABLE fail closed, because their stale snapshot cannot prove
fence absence; the ordinary application writes use READ COMMITTED. This behavior
must be included in reserve/tool compatibility review.

No table lock or open transaction is held during `storage.remove()`. Reference
scanning has a two-second lock/statement timeout, a five-second transaction limit.
The external call has a five-second observation deadline. **This is not I/O
cancellation.** A timed-out call records `unknown`, retains intent and fence and
receives no automatic retry. Its late resolution cannot create new references,
mark the intent successful, or change other records. Explicit storage failures
can retry within the budget. A process crash can leave ATTEMPT_STARTED; the next
scheduled run may retry idempotent removal within that same persisted budget.

The fence is deliberately retained even after successful deletion: stale clients
cannot resurrect the key, and late external requests remain safe. Do not delete
fences or recycle storage keys. Journal success and accounting are recorded only
after a confirmed removal; lost DB acknowledgement retains uncertainty. Corrupt
records, exhausted records and unknown storage outcomes require a separate review.
The drain checks that all seven reference triggers are enabled before any removal.
It is invoked under the existing retention maintenance lock, not as another worker.

MAX references do not enter the journal. Physical files and PostgreSQL are not one
transaction. Immutable keys, idempotent storage deletion, and backup preservation
of intents, states and permanent fences are required. Reference-scan cost and
trigger overhead on representative data remain a pre-installation measurement;
no production workload was used here.

## Migration and reserve requirements

Migration `20261006120000_inbox_processing_token` adds one nullable TEXT column
to `InboundUpdate`, without defaults, backfill, status changes or data deletion.
Apply it through the ordinary reviewed migration procedure before starting this
version. Migration `20261006230000_storage_deletion_fence` additionally installs
a PostgreSQL function and seven reference triggers. No new table is required;
file intent, retry state and permanent fences live in SystemSetting. `prisma db
push` alone does **not** install these triggers. Apply and verify the migration.
Do not drop the column, triggers, function or journal/fence entries during rollback.

Reserve `3479a893e98addf51509cdb331ba371c2c5aaabc` is **not automatically verified
for this change**. It understands deliveryProgress v1 but retains the three old
failure paths and does not drain the new file-deletion journal. An additive column
being readable by an older client is not evidence of safe fallback behavior.

Before installation, a separately reviewed reserve must backport claim ownership
and safe error settlement, enqueue reconciliation, and atomic retention plus its
post-commit journal, key fences, reference-writer guards and bounded retries (or explicitly keep retention disabled by a separately approved
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

## PR13 review follow-up

On unchanged runtime `97a30be`, test-only commit `03a5471` reproduced all three
review findings: a later event overtook its delayed head, concurrent inbox/outbox
writes hit PostgreSQL lock_timeout while storage was suspended, and 100 failed
intents starved the 101st. Actions 37518651038: existing 120 integrations passed,
three new regressions failed; 545 unit, typecheck and build passed.

Regressions use real PostgreSQL, barriers rather than arbitrary sleeps, controlled
storage promises, and an explicit short storage observation deadline for the
late-result case. Tests include repeat failures, restart, competing inbox claims,
shared reference commits, permanent rejection of retired keys, bounded deletion
budgets and preserved malformed records. The earlier identical-clock owner test
explicitly supplies a stale eligibility read so it still reaches the competing
CAS, rather than passing by skipping the claim.

The expanded comparison identified nine unchanged failures in the old phone,
parallel-photo and manual-cleanup fixtures. Three other draft tests had used
`handle()` to overtake a previously reserved event deliberately. That setup no
longer describes an allowed inbox schedule. Only those out-of-band screen-change
steps now call the real message/callback handlers directly; all assertions about
stale input, photos, phone, registration and ownership remain unchanged. The same
fixture is run on the unchanged review runtime and the new runtime. A separate
regression requires direct `handle()` to leave the follower PENDING until its
lane head completes. The eligibility-outage test uses concurrency=1 to count
requests deterministically; concurrent workers are tested separately.

The CI deliberately retains failed exit codes for the expanded old tests. Its
comparison step checks **all 105 outcomes**, not only the number of failures.
An overall red workflow caused by identical known failures is not reported as a
fully green suite. Targeted regressions, typecheck, build and unit are separate
steps. Intermediate failed attempts remain in Actions artifacts.
