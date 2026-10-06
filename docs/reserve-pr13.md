# Compatible reserve for PR13 (review candidate)

This branch starts at reserve `3479a893e98addf51509cdb331ba371c2c5aaabc`, itself a backport onto installed source `8dcfa330183e47551446d10cabbd3b493a42ea0b`. Main candidate is PR13 `59149006a7b3d30d01218fad84360e7d71e6d79e`; baseline main is `bbfa7b91c3a149d8951d36a28aefbe9b8e3ffa6c`. Neither version is authorized for installation by these tests.

## Scope and shared failure modes

Only the PR13 runtime/schema delta is backported: ordered inbox admission and claim token, conservative pre-dispatch settlement, uncertain INSERT reconciliation, atomic retention eligibility, durable file-deletion intent/state and permanent per-key fence. Both exact migrations are retained. Tests/fixtures for those guards are carried along; no product feature or R4 implementation is merged.

The reserve retains its separate text/media send loops and stronger validation of progress/MIDs/lease. All other runtime files match PR13. It is NOT an independent implementation of inbox, enqueue, retention, MAX client, retries, rate limits, rights, card updates or delivery accounting. A defect in these shared mechanisms, the database triggers, schema, SDK or external API may affect both versions. Do not switch to this reserve as a claimed cure for such a defect.

`deliveryProgress v1` has not changed. Confirmed prefix MIDs are not replayed; all ACKs with incomplete accounting are finalized without sending again. FAILED is terminal, including retired greetings and rejected-answer notifications. Unknown/malformed progress must stop the job, not restart it from zero. Lost ACK remains ambiguous: if MAX accepted a part but its ACK was lost before durable recording, duplication cannot be ruled out.

## Migrations and storage contract

Apply both additive migrations before starting either candidate:

1. `20261006120000_inbox_processing_token`: nullable `InboundUpdate.processingToken`.
2. `20261006230000_storage_deletion_fence`: seven reference-creation triggers and `guard_retired_storage_reference()`.

Do not replace migrate deploy with db push: db push does not install these triggers. No legacy records are backfilled or deleted. Runtime reserves persistent `SystemSetting` namespaces `retention.file-delete.v1:`, `retention.file-state.v1:` and `retention.file-fence.v1:`. Preserve all three across switching. Never drop fences after confirmed deletion: an old timed-out operation can still finish. New references use READ COMMITTED and immutable, never reused storage keys. Missing triggers, corrupt journal state, unsupported isolation or retired keys must fail closed.

Deleting a storage object occurs after committing a fence and outside DB locks. Timeouts do not cancel external I/O and are not success. `unknown`, `invalid`, `exhausted` records remain for review. Explicit transient errors have a persisted three-attempt budget and 60-second minimum delay. Journal rotation prevents a failing prefix of 100 records starving later records. No manual journal deletion, progress removal or fake SENT is an acceptable compatibility operation.

## Switching plan (not permission to install)

1. Verify exact source and immutable image IDs against the successful runner evidence; verify architecture, mounts, runtime settings and available space separately on a future authorized preparation. Save configuration and current image. Confirm a fresh tested backup and technical before-snapshot, including IDs/history, drafts, queue payloads/progress, attachments and all eight known FAILED.
2. Use reviewed R4 mutual exclusion and verified configuration guards, with new candidate image/revision metadata. Hold backup.lock only across the critical switch. The R4 implementation remains unchanged; its accepted synthetic Docker suite runs independently in CI.
3. Stop only app by SIGTERM and wait for verified graceful completion, no SIGKILL. Ensure there is no second bot. On non-graceful stop, unresolved external send/delete or ownership ambiguity, do not infer completion; inspect durable state before proceeding.
4. Capture final DB/files snapshot after stop. Apply the two migrations exactly once, verify migration history and all seven enabled triggers. Do not restore an older dump or drop new metadata to roll back.
5. Start one pinned candidate against the same DB and attachments. Observe bounded readiness; diagnose timeout rather than immediately changing DB or retrying business actions. Verify data by ID, allowing explicitly evidenced normal state transitions; verify eight terminal FAILED and fences remain unchanged. Confirm delivery/card correctness separately from HTTP readiness.
6. If new app is defective and the defect is confined to differing delivery-loop code, gracefully stop it, snapshot state, apply the compatible reserve's verified configuration and start one reserve container with the current DB. A failure to create/start must leave no running candidate before starting the reserve. Repeat readiness and state reconciliation. Never resume installed `8dcfa330` or old reserve `3479a89` unconditionally after these migrations/work begins.
7. The reverse reserve → PR13 uses the same stop/snapshot/guard/start sequence. PENDING prefixes resume; interrupted inbox PROCESSING is conservatively FAILED/manual (business outcome unknown), not automatically replayed. FAILED outbox requires a separately reviewed explicit retry, never bulk revival. Preserve permanent fences even when the journal is complete.
8. After a future successful installation update backup metadata using expected-value guards, release lock on all exit paths and verify a final backup. Do not keep backup disabled pending human testing. No production action is performed by this branch.

## Evidence and limits

Workflow `reserve-pr13.yml` uses disposable GitHub-hosted Linux, PostgreSQL, synthetic tokens and local HTTP MAX only. The container lab starts from installed migrations, seeds records before the two new migrations, checks preservation, switches whole containers on one DB/volume, tests delayed inbox and durable deletion state plus previous progress/ACK/FAILED/start-failure/SIGTERM scenarios. Image manifests compare actual dist/schema/lock with exact-source build stages. The only expected compiled difference is max-message.service.

The unchanged R4 suite is checked out at `58febee9f9e51a816e45d167ab06cf886508608d`, not copied into runtime. R4 tests use synthetic HTTP containers; the application switching lab separately uses real application containers. This is not yet a rehearsal of a future installation-specific settings file.

The load experiment uses 20,000 inbox and 25,000 outbox records, eight concurrent writers. This is comparable to the last available local report (17,747 / 19,172 on 2026-10-05); no production access is used. It measures DB admission with guards off/on and held external deletion, not complete business throughput, end-user latency or production capacity. Disabling triggers is restricted to the disposable benchmark after app containers stop; never do this in production.

The nine previously failing scenarios are rerun byte-identically on unchanged main, PR13 and reserve. Test exits are not suppressed; the workflow may be red because those existing failures remain. Read individual artifacts and comparison, not just job color. Final numerical results belong in the review report after execution.

No production image upload/deploy/merge, live MAX, production data, R4 change, retention-period change or unrelated test fix is part of this branch.

## Bulk-transaction lock-budget limitation (separate review)

A synthetic INSERT with 20,000 distinct storage keys in one transaction failed with PostgreSQL SQLSTATE 53200 (`out of shared memory`, max_locks_per_transaction) after enabling the new triggers. Each distinct key takes a transaction-scoped advisory lock. This limitation is shared by PR13 and this reserve; switching does not fix it. The dedicated `switch-bulk-probe` compares the exact statement on the installed schema before and after migrations, verifies rollback leaves zero partial rows, and records settings. It is a negative reproduction, NOT a successful bulk-write capability test.

The ordinary admission benchmark seeds its 20,000/25,000 historical records in bounded batches of 250 before measuring single-event concurrent writers. PostgreSQL lock limits and runtime guards are not changed. This fixture preparation is not a runtime fix. Bulk imports/backfills containing very many distinct new storage keys need a separate design review before installation/use; no production size threshold is claimed. Migration adds triggers without rewriting existing rows, so the migration itself does not take one key lock per historical row. Existing application tests are unchanged for this issue.
