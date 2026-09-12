# Production archive client acceptance

The public `createStorageClient()` implementation now connects canonical history,
blob transfers and diagnostics through the elected Storage Worker, pinned SQLite
WASM and OPFS. This is the production API, exercised by a synthetic browser
harness. The [shared application](./shared-app.md) also exercises that client through
the real library, chat, search and export interface.

The [incremental verification proof](incremental-search-verification.md) retains
29 passing checks per engine against the current byte/catalog/search changes.
Queued foreground reads complete between incomplete 128 KiB verification turns;
the exact tail result survives a process restart. Its retained report includes
the existing ownership, transfer, import, producer and repair regression checks.

## Reproduction

Run `npm run test:storage:client` after installing dependencies, provisioning the
pinned SQLite artifacts and installing Playwright Chromium/WebKit. The command
builds the actual module worker and client with Vite, then runs separate browser
profiles on an isolated loopback origin. It does not use an in-memory database or
mock StorageClient.

The runner writes `test-results/archive-client-browser.json`, marking it running
before execution and passed only after both engines finish. It records source
checksums, browser versions, owner identities, diagnostics and individual checks.
The retained macOS report is [here](./results/archive-client-macos-26.5.2.json).

## Covered behavior

- Two tabs resolve to one SQLite/OPFS owner. A follower sends canonical operations
  and bounded binary transfers through BroadcastChannel to that owner.
- A 5 MiB + 17 byte synthetic blob is uploaded, hashed, finalized and published
  with its attachment metadata and a thread/message transaction. Staged bytes
  cannot be read as published content before the canonical commit.
- The client admits 64 ordinary control calls and reserves separate cancellation
  admission. The test checks that a 65th ordinary request is rejected locally and
  that subsequent admission recovers; cancellation saturation is not tested here.
- Four upload/read credits include calls awaiting replies. Read credits remain
  occupied until the owner's acknowledgement response. A locally rejected fifth
  call can be retried without consuming an owner sequence. Out-of-order ACKs and
  final-chunk behavior preserve the independently calculated SHA-256.
- Verified range readers preserve exact selected bytes without rehashing a held
  parent. The test covers eight active leases, out-of-bounds rejection, repeated
  small ranges, a child surviving parent discard and an acknowledged empty EOF.
- Invalid canonical transactions roll back metadata and corresponding sync
  operations. Transaction replay after staging cleanup adds no operations. Sync
  pagination preserves its high-water snapshot and operation ordering.
- Real worker replies are selectively suppressed in the harness **after execution**.
  A lost commit reply yields `UNKNOWN_OUTCOME`; operation-status queries find the
  durable commit, and retrying its original transaction is safe. A lost upload ACK
  invalidates that client transfer; explicit discard and a fresh transfer recover.
  These checks simulate reply loss, not power failure or operating-system crashes.
- Closing the actual owner tab without calling StorageClient.close releases its
  worker and lock. The follower acquires ownership, reads the same canonical and
  blob data, and rejects replay of an unfinished upload's original begin operation.
  That interrupted transfer can be explicitly discarded.
- Closing and relaunching the entire browser process with the same profile retains
  the database, blob digest and transaction replay behavior.
- A normalized import with 1,001 ordered parts and verified blob-backed long text
  is submitted in bounded batches. Replaying a staging batch creates no duplicate
  records; staging stays invisible to canonical reads and allocates no sync
  sequences. After actual owner-tab termination, publication rejects stale
  validation evidence. Incremental revalidation in the new owner verifies bytes
  and permits one atomic publication of 1,006 records plus its sync marker.
- Imported parts, blob bytes and the publication state survive browser-process
  restart. Cancellation removes normalized staging without publishing canonical
  records or sync operations. Idle owner maintenance removes temporary blob files
  for published/cancelled jobs, using durable cleanup mappings. Published transfer
  identities remain replayable; transfers shared with active imports are retained.
- Change notifications reach the owner for a follower's commit. Operation progress
  returns to the requesting follower. Cancellation while the ownership lock is
  externally held reports `not_dispatched`.
- Independent producer locks preserve live generation output when the storage
  owner tab ends. Actual producer-tab and browser-process termination recover
  registered attempts as partial, preserve their exact committed prefix and record
  one event. Lost registrations fence delayed creation; committed retries remain
  idempotent. Unregistered historical attempts remain untouched.
- Production FTS searches committed text without embedding weights, returns exact
  part/message positions and highlight ranges in plain text (including literal
  markup), and keeps the old valid epoch searchable during a derived rebuild.
  Explicit semantic requests report unavailability while Best uses lexical search.
- Idle worker slices index new canonical text automatically and broadcast status
  to subscribers. Foreground admission cancels background verification and can
  release its held reader. The existing eight-range-reader acceptance also runs
  with this scheduler enabled.
- A test-only offline worker takes the archive ownership lock and removes the
  derived search queue. The normal client then reopens, reports failed search,
  commits a canonical title change and explicitly rebuilds search. The repair
  restores exact results without changing canonical records or sync operations.

## Scope and remaining work

The API is exported from `@quixi/storage/client`; the proof-only client and
`/storage-proof` remain separate. The default archive uses `quixi/database` and
`quixi/blobs` under OPFS. Tests use distinct archive IDs and temporary profiles.
Only the elected owner opens SQLite or synchronous blob handles. Byte calls never
automatically retry after an unknown outcome; callers retain their transfer ID
for discard and their canonical operation/transaction IDs for reconciliation.

Staged normalized import publication is integrated; this harness supplies
synthetic normalized records, rather than parsing a provider export. Provider
import normalizers have a separate browser harness. Generation producer ownership
and recovery follow [ADR 0008](../decisions/0008-generation-producer-coordination.md).
FTS is available through bounded maintenance/search operations and automatic idle
indexing, with foreground work taking priority. Initial blob verification reads
the entire file through bounded buffers and is cancellable; a chunk-count budget
does not bound that first verification's elapsed time. Broader search and release
cases remain tracked in plan 07. Archive
export/restore and product UI remain subsequent integration work. Semantic search
and other unintegrated operations return typed `UNSUPPORTED` errors.

This suite does not qualify every production operation on desktop WebViews, test
power loss, or prove the complete storage stress matrix. The separate
[blob/catalog acceptance](./blob-storage.md) covers actual Chromium quota override,
corruption and interrupted-publication disk states. The
[host feasibility matrix](./storage-proof.md) records measured platform support
and the tested Linux WebKitGTK limitation. Plan 03 remains in progress.
