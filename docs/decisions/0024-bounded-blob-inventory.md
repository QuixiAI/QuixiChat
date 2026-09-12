# 0024 — Bounded blob inventory without archive repair

Date: 2026-09-10

Status: Implemented and qualified; see [executed evidence](../validation/blob-inventory.md).

## Problem and scope

Plan 03 requires orphan detection alongside verified publication and missing
reference handling. Product §100–101 and plan 23 require inspectable findings,
bounded work and cancellation before cleanup. Publication can write verified
bytes before a canonical transaction commits; therefore a catalog row, file age
or absent canonical reference alone cannot authorize deletion.

This increment inventories canonical blob references, pending publication/import
protection, catalog metadata and managed OPFS entries. It reports missing files,
missing catalog entries, size mismatches, unreferenced blobs, protected blobs,
staged files and unrecognized entries. It does not rehash every blob or implement
repair. Existing ingestion and ordinary verified reads retain their own hash
checks. Full hash audits and other Quixi Doctor operations remain plan 23 work.

## Public boundary and lifecycle

The existing Storage Worker remains the sole SQLite owner. Five additive
StorageClient operations begin, advance, inspect, page findings and cancel an
inventory identified by a UUID. Each advance admits at most 64 work items;
findings pages admit at most 64 rows and 64 KiB. Input fields are closed and
validated before dispatch. There are no deletion arguments or arbitrary paths.

One scan is active per storage owner. Work yields between batches so ordinary
archive operations remain usable. Cancellation releases enumeration resources
and retains the partial result as cancelled. Owner/process loss requires a new
scan; an OPFS iterator is not a portable resume cursor. A repeated request must
not create a second active scan or silently skip an unknown result. Finding
cursors belong to their scan and cannot read a different scan's rows.

The scan detects changes to its canonical, catalog and pending-work inputs
between batches. Changed inputs invalidate the result instead of allowing a
partial old/new inventory to appear complete. Completed results are observations
of the scanned archive state, not continuing permission to delete anything.
External filesystem corruption is not an atomic snapshot of OPFS; another scan
is required after external modification or recovery.

## Classification and preservation

Canonical references include available attachments, available raw objects and
blob-backed text/note parts. Missing-source declarations that never promised
local bytes are distinguished from broken references. Pending transfers and
hidden import work must protect bytes that have not yet become canonical.
Staging is reported separately; neither age nor a terminal-looking filename is
proof that cleanup is safe. Unrecognized entries are counted without traversing
arbitrary directory trees or exposing original filenames.

The inventory reads file metadata, not conversation bodies or credential stores.
Findings contain managed hashes/UUID paths, lengths and counts. It never changes
canonical records, sync operations, catalog verification state or blob bytes.
Any derived scan bookkeeping must remain bounded in working memory and separate
from canonical history. Failed diagnostics cannot disable ordinary archive use.

Reference and finding indexes use connection-local TEMP tables. The initial
archive connection sets `temp_store=FILE` before installing any temporary
operation fences, with a bounded temporary page cache. The pinned SQLite build
uses `TEMP_STORE=2`, which permits this runtime override. Changing that pragma
after TEMP objects exist would drop them and is forbidden here. Preparing a new
scan clears previous scratch rows in capped batches. There are no new persistent
schema objects, canonical migration or archive protocol version. Temporary SQL
mutation guards and the byte-store mutation counter invalidate observations when
an admitted write changes their inputs.

## User workflow

Storage health offers an explicit scan, progress, Stop, bounded findings and a
fresh scan after cancellation or stale results. Labels distinguish missing
bytes, mismatched metadata, protected pending work and unreferenced files.
Findings explain recovery options without offering automatic deletion. The UI
must remain keyboard usable and must not imply that a presence/size inventory
is a successful full content-integrity audit.

## Required evidence

Actual Chromium and WebKit worker/OPFS tests must cover references from every
supported source, present/missing/mismatched/unregistered files, pending-work
protection, directory anomalies, bounded pagination, cancellation, changed
inputs and owner restart. The app proof must run the production panel and
controller against real worker storage, show findings and preserve originals.
Canonical records, journal identities and fixture blob bytes must remain exact.
Archive/export compatibility and the ordinary application/storage regressions
remain required where the implementation touches their shared boundaries.

Plan 03's blob task can close only after this detection evidence is combined
with its existing ingestion/publication/read/recovery evidence. This decision
does not complete plan 23 or authorize an orphan cleanup implementation.
