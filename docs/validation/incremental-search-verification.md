# Incremental initial verification for lexical search

This plan-07 increment closes the initial whole-source verification path in
`SearchRepository.advanceSlice`. The implementation follows
[ADR 0029](../decisions/0029-incremental-search-blob-verification.md).

## Behavior

One indexing admission hashes at most 128 KiB before returning to the owner.
Verification and subsequent decoding share that admission budget. Pending
hash/file state is held across admissions, with no byte/range access until the
digest completes. A foreground read of the same digest can complete that shared
verification safely. Cancellation and source invalidation discard the cursor;
owner restart discards hash progress and re-verifies actual bytes. Corruption
cannot publish chunks and retires all dependent reader state. Pending readers
consume the existing eight-transfer budget; no persistent schema or wire method
is added.

## Qualification

The storage proofs pass on macOS 26.6.2 / arm64 / Node 22.23.1:

- `npm run test:storage:blobs`: both Chromium and Playwright WebKit pass the
  existing byte/catalog/restart checks plus seven new verification checks per
  engine. The existing quota override runs only in Chromium; WebKit records it
  as not run.
- `npm run test:storage:client`: **29 checks per engine**, including foreground
  request admission during incomplete verification and exact tail retrieval after
  process restart.
- **135 distinct unit/SQL tests**: 25 search, 18 incremental blob, 57 canonical,
  and 65 related SQL tests. The canonical and related suites overlap on 30 tests;
  their raw totals must not be added without removing that overlap. Six related
  fixture TypeScript projects also pass.
- `npm run test:app:browser`: **61 groups per engine**, with the existing full
  application, imports, chat, attachments, routing, recovery and search scenarios.
- `npm run check` passes.

The [aggregate record](results/incremental-search-verification-checks-macos.json)
retains **141 source hashes** (107 from the application run plus 34 additional
sources) and **15 artifacts**, including all three passing browser reports and
logs. Every report source hash matches the retained snapshot; the app runner
also checks that its source hashes stayed unchanged throughout qualification.
The [application report](results/incremental-search-verification-app-macos.json)
is a regression proof; the new per-admission behavior is established by the
specialized storage fixtures below.

The [blob report](results/incremental-search-verification-blobs-macos.json) uses
actual SQLite/OPFS with **2,097,202 bytes** of canonical text. It checks zero
physical/searchable chunks during verification, exact original tail offsets,
cancellation and shared foreground completion. It leaves real hash/file/database
handles open for process termination. Restart begins verification at zero and
finishes the queued rebuild. Exact canonical-record and sync-operation hashes
match before/after verification, cancellation, foreground reads and restart.

The [production-client report](results/incremental-search-verification-client-macos.json)
uses **2,175,034 bytes**, queues a canonical read behind each indexing admission,
and records **16 foreground reads during incomplete verification** in each
engine. The maximum observed verification advance is **131,072 bytes** in each.
Maximum observed foreground response time across the complete fixture is
**106.6 ms in Chromium** and **31 ms in WebKit**; these are observations on this
run, not release latency guarantees. The exact message remains unchanged,
canonical/sync counts match, and the tail hit survives browser-process restart.

Unit/SQL cases additionally cover physical read-byte accounting, transfer
pressure, zero-length files, source revision changes/tombstones, late digest
failure, catalog metadata, publication during a pending hash, and sibling-reader
cleanup. Corruption is exercised by these tests; the new browser fixture does
not claim a physical-corruption injection.

The first browser attempt exposed a harness defect: two calls to initialize the
shipped SQLite module in one worker attempted an invalid WASM URL and left the
page's request pending. Live runner inspection established the error before the
failed run was stopped. The fixtures now share one initialized module and reject
pending requests on worker errors. The [failed report](results/incremental-search-verification/attempts/blobs-sqlite-reinitialization.json),
[diagnosis](results/incremental-search-verification/attempts/sqlite-reinitialization-diagnosis.json)
and log are retained; they are not counted as passing evidence.

All fixtures are disposable synthetic local archives. A byte-work cap does not
guarantee a fixed wall-clock filesystem latency. Release corpus relevance,
cross-host scale, installed Safari/WebKitGTK and semantic integration remain
open requirements.
