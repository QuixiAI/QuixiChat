# Retained archive reads

`readRetainedArchive(archiveId, requestId, operation, args, options?)` reads the
literal existing archive supplied by the caller. It never resolves active
selection, retargets a request after activation, opens a writable archive
session, migrates a schema, reconciles producers, verifies blobs, initializes
search or creates a workspace.

```ts
import { readRetainedArchive } from '@quixi/storage/client';

const thread = await readRetainedArchive(
  previousArchiveId,
  crypto.randomUUID(),
  'readEntity',
  { collection: 'threads', id: threadId },
  { timeoutMs: 15_000 },
);
```

The [client implementation](../../src/client/retained-archive.ts) exports the
`RetainedArchiveOperation` type, allowed-operation list and admission limits.
Only `default` or a core-valid UUID is accepted; arbitrary and `test-*` writable
namespaces are rejected. Supported operations are:

- `readEntity`, `readEntities`, `readMessageParts`, `readSyncOperations`
- `operationStatus`
- `listLibrary`, `readThreadView`, `readConversationWindow`, `readMessageChildren`

Each call uses one dedicated [worker](../../src/worker/retained-archive.ts), with
at most four admitted workers per client module/realm. Admission is immediate;
there is no unbounded queue. The full request envelope is capped at 262,144 bytes,
aggregate admitted request envelopes at 1,048,576 bytes, and the response envelope
at 1,048,576 bytes. Existing canonical page/record limits also apply. The default
deadline is 15 seconds, configurable from 1 millisecond through 60 seconds.
Timeout terminates the owned worker and releases admission; it is a failed read,
not an uncertain mutation. Inputs and responses are copied by structured clone.
Caller-retained result memory is outside these admission counters.

## Existing-file and read-only contract

The worker requests `quixi:archive:<id>:owner` with `ifAvailable`. A held owner
returns `CONFLICT`; the reader never queues behind it or asks that owner to
execute a call. It requires the existing archive directory, database directory,
SAH `.opaque` slots and `/archive.sqlite3`. Missing files return `NOT_FOUND`.
There is no empty-database fallback.

Pinned SQLite SAH-pool initialization can repair invalid slot metadata or
truncate unused slots before SQL opens. The reader therefore checks at most 128
existing slot headers first, reading 524 bytes per slot. It validates the pinned
path/flags/digest layout, detects duplicate paths, requires the archive database,
and refuses malformed, journal, WAL, transient or unreconciled slots. It never
asks pool initialization to repair those states. The header format and legacy/v2
digest behavior come from the repository's pinned `sqlite3.mjs`; these metadata
digests are compatibility checks, not cryptographic authentication.

After preflight, the worker installs the shared pinned SQLite module on the
existing directory, checks `pool.getFileNames()`, opens with flags `r`, applies
`restrictRestoreConnection`, and verifies both `sqlite3_db_readonly` and
`PRAGMA query_only`. SQLite documents the [`r` open mode](https://sqlite.org/wasm/doc/trunk/api-oo1.md)
and the [journal recovery needed by some reads](https://sqlite.org/lockingv3.html).
This helper refuses recovery states instead of performing recovery.

The reader checks the complete contiguous migration ledger against the build's
immutable migration names and SHA-256 of `canonicalJson(sql)`. Schemas 8, 9 and 10 are
compatible; older, future, missing or altered ledgers return `MIGRATION_FAILED`.
There is no `.migrate()` call. The approved canonical/view methods use constructors
without side effects. `operationStatus` supplements canonical receipts with a
bound `SELECT` from `quixi_archive_operations` only when that table already exists;
it does not construct `ArchiveRepository` or create missing metadata.

Handles close and the pool pauses before the owner lock is released. The API is
logically read-only. It does not promise byte-inert OS/SQLite activity for every
possible archive or query: pool handles, connection configuration and internal
temporary work remain implementation details of the pinned SQLite engine. The
tests below specifically verify file-byte preservation for their tested inputs
and failures.

## Rescue export

`exportRescueArchive(archiveId, requestId, sink, options?)` from
`@quixi/storage/client` streams a byte-level rescue archive of the literal
existing archive through `sink`, one acknowledged 1 MiB chunk at a time, and
resolves with the TAR length, SHA-256, entry count and recovery manifest. Its
dedicated [worker](../../src/worker/rescue-export.ts) takes the archive owner
lock only with `ifAvailable` (`CONFLICT` otherwise), runs the same slot-header
preflight as the reader, refuses journal or transient slots (`IO_ERROR`) and a
missing database (`NOT_FOUND`), and then copies the exact `/archive.sqlite3`
bytes from the pool slot plus every `blobs/<xx>/<sha256>` file, as found, into
the standard TAR layout: `format.json` (`kind: "rescue"`), `quixi.sqlite`,
sorted `blobs/<sha256>`, `checksums.jsonl`, `manifest.json`. Only after the
bytes are copied does it open the pinned pool read-only to record the
migration ledger rows as found; a ledger it cannot read is recorded as an
error, never invented. The manifest's `recovery` block holds the database
length and digest, SQLite header page size/count, the ledger, whether that
ledger is a prefix of this build's migrations, blob-file counts and the number
of unrecognized names it skipped. It never migrates, repairs or writes. One
export runs at a time per client module (`OVERLOADED` otherwise), and the
progress deadline applies per step. The production restore path accepts a
rescue archive whose own ledger equals, or is a strict prefix from schema 8 of,
this build's migrations: it verifies the raw database against its checksum,
requires the ledger to agree with the manifest, cleans the raw database into a
fresh candidate at this build's schema with the same step portable exports use
(the migration-aware candidate upgrade), derives the canonical summary from
that candidate, validates it like any portable restore, drops unreferenced blob
files and reports `sourceSchemaVersion`. Ledgers below schema 8, beyond this
build, or with a differing migration are refused by name; see
[ADR 0016](../../../../docs/decisions/0016-startup-failure-and-schema-recovery.md).

## Actual browser evidence

From the repository root after provisioning pinned SQLite and Playwright:

```sh
node packages/storage/tests/retained/run.mjs
```

The runner honors `QUIXI_TEST_BROWSERS` (Chromium and WebKit by default), uses
disposable persistent profiles and a fresh loopback origin, and writes
`test-results/retained-archive.json`. Its report is set to running before build
and records failure instead of retaining a stale success. The current
[rescue report](evidence/rescue/browser-evidence.json) passed twelve groups per
engine in Chromium and WebKit: the six reader groups below, three rescue export
groups and three rescue restore groups. [Checksums](evidence/rescue/checksums.json) bind its report and
the exact captured runner, page and fixture sources. The earlier
[schema 10 report](evidence/schema10/browser-evidence.json) passed the six
reader groups, including the updated future-ledger rejection. Runner snapshots
are for source association; execute the command above from the repository root.

The historical
[browser report](evidence/browser-evidence.json) passed six groups per engine
on macOS arm64. Source, pinned WASM and built artifact hashes are recorded.

| Gate | Evidence |
| --- | --- |
| Approved reads | All nine methods on a public managed default archive and a real production export/restore candidate; source-only later thread stays absent from candidate |
| Text and views | Embedded NUL, Japanese, astral emoji, accents and line breaks survive exactly; thread/window/children/library and sync rows agree |
| Receipts | Canonical and archive control receipts resolve; missing receipt returns `not_found` without creating a table |
| Rejection | Actual worker rejects writes, workspace creation, export, search, stale envelopes, malformed request IDs and oversized envelopes; missing namespace stays absent |
| Admission/cleanup | Four actual workers maximum, fifth rejected before allocation, no worker for invalid input; a deliberately dropped actual reply reaches its deadline, worker terminates and next read succeeds |
| File preservation | Every source/candidate file's SHA-256 is identical before and after reads, rejected work, admission collisions and timeout cleanup |
| Compatibility/recovery | Schema 8 reads unchanged; schema 7/future/bad ledger, empty database pool, corrupt slot digest and an actual worker terminated inside a spilled SQLite transaction reject with all retained file hashes unchanged |
| Rescue bytes | The rescue TAR lists exactly `format.json`, `quixi.sqlite`, one planted blob, `checksums.jsonl`, `manifest.json`; `quixi.sqlite` equals the pool database bytes by length and SHA-256; the blob file hashes to its name; a planted `junk.tmp` is counted as unrecognized and skipped; page size × page count equals the database length; every candidate file hash is unchanged afterwards |
| Rescue of a future schema | A clone with an inserted future ledger row is rescued byte-exactly; its manifest records the `future` row as found and `ledgerCompatible: false`; no file changes |
| Rescue refusals | A held owner (`CONFLICT`), an actual interrupted journal (`IO_ERROR`), an empty pool and an absent namespace (`NOT_FOUND`), a non-production identity (`INVALID_REQUEST`) and a second concurrent export (`OVERLOADED`) are refused with file hashes unchanged |
| Rescue restore | The candidate's rescue TAR restores through the production restore into an isolated ready candidate at this build's schema; the fixture thread reads back exactly through the retained reader, the unreferenced planted blob is absent from the candidate, and the source files are unchanged |
| Live archive rescue restore | The live default archive, including selection bootstrap state and operation claims, rescues while its owner is closed and restores into a clean ready candidate whose later thread reads back; a future-ledger rescue is refused naming the schema versions |
| Older-prefix rescue restore | A clone reverted structurally to schema 8 (objects and ledger equal to a fresh migrations 1–8 database, integrity ok) rescues with a compatible eight-row ledger and restores into a ready candidate at this build's schema reporting `sourceSchemaVersion: 8`, with the same record and operation counts as the schema-10 restore and all nine approved reads equal to the schema-10 candidate's; the rescued files are unchanged; a schema-7 clone is refused at the upgrade floor and a tampered ledger is refused naming migration 1 |

Damage cases operate only on private UUID clones in the disposable test origin.
The interrupted-transaction fixture verifies that the real SQLite journal exists,
terminates its worker, observes release of the real owner lock, then exercises
the public reader. No production repair or reset is used to make that check pass.

The separate [integrated activation evidence](../selection/integration/README.md)
also uses this public helper to read the old source after a real selection switch,
including when the selected candidate and selection catalog become unavailable.
Those integrated checks establish caller-ID independence from selection; the
standalone fixture does not substitute for a full activation workflow.

These are actual Chromium/WebKit results with the pinned SQLite WASM, not installed
Safari, desktop WebView or Linux qualification. Timings are not release benchmarks.
[Checksums](evidence/checksums.json) cover the retained evidence files.
