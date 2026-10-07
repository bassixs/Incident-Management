# Historical checksum policy: review edition

Only `scripts/migration_guard.py` changes in the operational kit. The original
6cd29e6614892684a516e3213c4cb107f5af665c edition remains unchanged. Do not mix files
or deploy this edition without review and explicit installation authorization.

Two exact checksum pairs are allowed, each only for its own migration name:

| Migration | Reviewed LF | Historical CRLF |
|---|---|---|
| 20260906000000_sla_day_one_reminder | ae937553357266f941dc9ede8264cf5b12ac80f2410f70abc7684b2a1aecf39c | dee2d4053518eeb04d4ea71e0489329d223e4a7c50cb67bc5ffb9db54497efbb |
| 20260906120000_clarifications | a1cde4275a0d5190435a23fbc831bc5b187f999c9ff97580b2683117b31c0322 | 053d0542c57a3459f3bade7c1e5301cc1d4088f5cd3e7797a5f6787ba1002429 |

Source proof reads Git blobs for pinned old 8dcfa330, main 59149006 and reserve
1a7a0f54. LF→CRLF→LF reproduces the same SQL bytes. Production history, SQL files
and the downloaded LF schema manifest are never changed. Only the in-memory
comparison of these exact actual checksum cells maps to their exact reviewed LF
values. Names, order, count, finished/rolled-back flags and every other schema
field still compare exactly. DB identity and durable migration ledger checks stay
unchanged. Unknown hashes and swapped migration/hash pairs fail closed.

The dedicated Docker test applies all 21 old migrations to five new PostgreSQL
databases: four LF/CRLF combinations, plus a deliberately edited synthetic SQL
copy that must be rejected. These histories are produced by actual Prisma, not
by substituting approved checksum values in a history table. Negative unknown
hash/completion flags use explicitly corrupted synthetic records only.

The focused R4 subset uses real Docker/PostgreSQL/flock, existing main/reserve
images and local HTTP MAX mock. The old app remains the previously reviewed
synthetic HTTP/SIGTERM fixture. Lost CLI response is injected; the underlying DDL
and late completion are real. The existing prohibition on old-app resume after
migration intent remains, including unknown/partial results.

This change does not fix MAX403, runtime delivery or SQL migrations. The reserve
still shares PR13 guards with main and cannot repair a common defect or incomplete
migration. Unknown ACKs/deletion outcomes remain unknown. No new production image
is required. Replace the kit only after review, preserving the original edition,
and repeat bounded read-only production schema/identity/config validation before
any separately authorized cutover. No production changes are part of this review.
