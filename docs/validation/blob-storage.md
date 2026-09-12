# OPFS blob byte-layer acceptance

The private [OpfsBlobStore](../../packages/storage/src/worker/blobs.ts) implements
application-managed bytes under `quixi/blobs/<sha256-prefix>/<sha256>` and staging
under `quixi/temp/blob-transfers/`. It does not enter SQLite VFS directories.
The caller must hold the archive owner lock and serialize calls. The private
[BlobCatalog](../../packages/storage/src/worker/blob-catalog.ts) now supplies
durable transfer metadata and connects verified publication to the canonical
repository. Production StorageClient/owner-worker integration remains plan 03 work.

Uploads accept at most 1 MiB per chunk and flush before acknowledging the offset.
Incremental SHA-256 and a bounded read-back pass verify both the received stream
and its staged file. Only verified files can be copied to content-addressed
storage. Publication verifies the destination before returning and retains staging
until the caller commits canonical metadata. SQL must expose an available
attachment only after successful publication. A crash before that transaction
may leave an orphan file for reconciliation.

Ordered canonical migration 3 creates the blob, transfer and operation catalogs.
Begin/finalize retain caller operation identity; the owner records verified
publication before the canonical SQL transaction. Its synchronous reference
checker requires matching digest/length and, for canonical text, UTF-8 evidence.
Successful canonical commit precedes staging cleanup. Cleanup failure, including
a failed metadata lookup, retains an explicit retry list and never reverses a
committed reference. Finalized stages release live handles; their durable
descriptors reopen and reverify bytes before publication, including after owner
restart. Uploads that never finalized become interrupted.

Publication can repair an incomplete final file only when the durable catalog
has no entry for its hash. A cataloged file is preserved for reference-aware
recovery. Failed reads quarantine its metadata without removing that row;
new references require fresh verification by the current owner. If SQL cannot
record quarantine, changing the owner's verification epoch invalidates cached
authorization in constant memory until actual bytes are checked again.

The `canonical_text` purpose also validates UTF-8 incrementally with a fatal
decoder, including sequences split across byte chunks and the final incomplete
sequence check. The verified descriptor records `utf8Verified`; canonical Text
and Note references require this evidence in the durable catalog. A generic
binary blob's digest alone does not prove that its bytes are UTF-8.

The SHA-256 implementation is pinned to `@noble/hashes` 2.4.0 in the package and
lockfile. Its [upstream incremental API](https://github.com/paulmillr/noble-hashes#implementations)
avoids materializing a whole archive for hashing. Numeric embedding execution is
unrelated to this file-integrity library.

Reads verify content before opening a stream, retain at most four outstanding
chunk descriptors per transfer, and require acknowledgements. Eight total open
upload/download sessions bound handles and bookkeeping. Concurrent readers of
the same immutable file share one verified OPFS access handle. Hashing and copying
use a buffer of at most 1 MiB and yield between blocks for cancellation handling.
The byte layer does not retain delivered read buffers; the client boundary must
also enforce the transfer window before forwarding bytes.

Run `npm run test:storage:blobs` after `npm ci` and installing Playwright Chromium
and WebKit. This command typechecks the harness, builds the production byte-layer
module into a dedicated worker, and launches isolated persistent browser profiles.
It serves only synthetic test content on loopback port 4187. The temporary build
and profiles are removed afterward. The harness is not included in product builds.

The command writes `test-results/blob-storage-browser.json` before testing and
updates its running/failed/passed state. The [recorded macOS run](results/blob-storage-macos-26.5.2.json)
contains the browser identities, individual checks and quota observations.

Measured checks include:

- A 5 MiB + 17 byte deterministic fixture agrees with independent WebCrypto
  SHA-256 after upload, publication, bounded reads and browser process restart.
- Staging is invisible to published reads; duplicate bytes produce one file;
  retrying publication/finalization preserves the verified identity.
- Concurrent reads and publication deduplication work while one reader closes.
- Incorrect ordering, oversized chunks, incomplete streams and digest mismatches
  fail before publication. Empty files emit one acknowledged terminal chunk.
- Canonical text accepts a four-byte UTF-8 character crossing a 1 MiB boundary
  and rejects malformed or truncated encoding before publication.
- Corrupted published content fails reads and deduplication and remains available
  for reference-aware recovery. Cancelled publication leaves no partial new file.
- Transfer counts and read backpressure are enforced. Interrupted staging survives
  actual browser termination with an open access handle and cannot be silently
  reused as a fresh upload. The restart assertion identifies that exact transfer
  file and its acknowledged byte length.
- Chromium's actual origin quota override produces `QuotaExceededError` from
  OPFS. Failed staging is removable, old content remains readable, and new
  publication succeeds after restoring quota. WebKit quota injection is explicitly
  untested because this harness has no equivalent override.
- The same pinned SQLite WASM/OPFS build runs the private canonical repository
  with BlobCatalog. A controlled failure after CreateThread, RegisterAttachment
  and a blob-backed CreateMessage leaves no canonical records or sync operations.
  Retrying commits all three operations; replay after staging cleanup duplicates
  none. The attachment, UTF-8 content, catalog and database integrity survive a
  browser process restart, and unfinished catalog transfers become interrupted.
- Additional failure checks retain a known committed result when cleanup lookup
  fails, release a handle after failed begin metadata, finalize twelve stages
  without exhausting eight active slots, and quarantine corrupt published bytes.
  An exact simulated interrupted-copy disk state is repaired from verified staging
  in the next browser process; this does not claim an OS power-loss test.

These tests do not prove power-loss durability, origin eviction recovery, native
WebView blob behavior, whole-archive memory measurements, every canonical
mutation's browser durability, or public-client multi-tab integration. Staging
state for unfinalized uploads is not automatically resumed after an owner
restart: the inventory streams filenames and sizes for durable SQL reconciliation.
Cleanup decisions must consult committed references and transfer records; age
alone is never evidence that a blob is unreferenced. Archive formats and complete
restore remain plan 09.

Chunk acknowledgement/reply loss is an explicit remaining transport integration
case. The byte layer advances a cursor before sending a reply and does not replay
that reply. The production worker/client must return an unknown outcome and
restart the byte transfer, or implement bounded reply replay. It must not blindly
resend an upload or skip a download chunk. Canonical mutation IDs stay stable
while transfer restarts use their separate lifecycle.
