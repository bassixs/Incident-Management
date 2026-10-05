# One-off review panel replacement: isolated review branch

This independent test branch contains no application changes or deployment workflow.
It is not intended for merging into main. Production execution is not authorized.

`panel-swap.cjs` reads the installed 8dcfa330 panel predicate, text generator and
buttons. It sends one provisional panel without controls, then atomically changes
only its exact SystemSetting.value and OutboundMessage.firstMessageId. The existing
worker activates and pins it on its normal cycle. No queue statuses, retries,
incident rows, other panels, deletion or unpin are performed by this tool.

Each write requires an explicit command, a private durable journal, the original
expected revision/chat/job/MID, matching links and an idle SENT job. The transaction
locks the exact job and setting with NOWAIT; there are no HTTP calls under locks.
All other fields except ordinary updatedAt are preserved. SENDING, PENDING, FAILED,
changed references, changed payload or recovery state cause refusal.

The journal records send intent before the sole POST. After an unknown POST result,
only bounded GET reconciliation is possible; an absent or ambiguous candidate never
causes a second POST. Unknown commit outcomes require a consistent read of both links.
An explicit guarded rollback changes the same links back, then awaits normal worker
refresh/pin. It never restores a database snapshot. Observations require two distinct
completed worker cycles and confirmed controls/pin on the selected message.

## Testing

The workflow runs only on this named test branch, with contents:read, no deployment,
SSH, production secrets or production endpoints. It checks out exact 8dcfa330 as a
separate fixture, installs its lock file, creates an empty PostgreSQL database and
runs `node --test --test-concurrency=1 tests/panel-swap.test.cjs`.

PostgreSQL and transactions/locks are real. MAX is mocked at the API boundary.
The actual installed-version MaxMessageService and PinnedPanelService perform normal
queue processing against the isolated DB. Lost POST and COMMIT acknowledgments are
injected, not network failures on a live system. The fixture is not an active bot.

Full logs/checksums are retained in Actions artifacts even on failure. Private
expected.json, deployment paths, channel IDs and operational journals are excluded.
Live MAX permissions, message visibility in the client, and production execution
remain untested. The old message is retained, including its existing buttons; after
replacement it ceases to be the active update target. Do not recreate the container
or lose the private operation journal while this maintenance is in progress.
