# Diagnostics report and derived-index actions

Plan [23](../plans/23_build_diagnostics_and_recovery.md), product §100/§101,
[ADR 0040](../decisions/0040-diagnostics-outcomes.md). Last run 2026-09-13 on
macOS 26.6.2 (arm64), Node v22.23.1, Playwright Chromium and WebKit, SQLite
WASM 3.53.4 with sqlite-vec, canonical schema 13 (the browser proof was
rerun after the schema-13 library activity migration and the bounded
integrity read; both engines pass).

## What is proven

**Classification (Node, real SQLite WASM)** — `npm run test:storage:diagnostics`,
`packages/storage/tests/diagnostics/diagnose.test.ts` (14 tests; the script's
24 tests also cover the doctor audit, blob hash audit and the deadline below):

- the bundled build reports FTS5 and sqlite-vec available;
- a healthy archive reports every §100 check `ok`, in product order, with a
  report that contains no filename;
- a referenced file absent from the catalog or from storage is
  `missing_data`, with integrity and the search index still `ok`;
- a stored file whose size differs from its record is `attention`;
- the reference check is bounded (records and files) and says so;
- a retained derived-index failure, or a failed index status, is
  `rebuildable`; failed sources are `attention`;
- absent FTS5, sqlite-vec or chunk tokenizer are `unsupported` (stated
  inputs: this build has all three, so these cases are not produced by a
  real host);
- persistence granted, refused and unreported are `ok`, `attention`, `unknown`;
- unreferenced b-tree pages (an index whose `sqlite_master` row was removed
  through `writable_schema`, reopened) are reported by `integrity_check` as
  `corruption` while the schema check stays `ok`; a dropped canonical table
  is schema `corruption`; a malformed reference in a record is `corruption`;
- the `sqlite_integrity` check records `elapsedMs` and `databaseBytes`, and
  the light startup read (`automaticIntegrity`) answers `ok` for a file
  within `AUTOMATIC_INTEGRITY_CHECK_MAX_BYTES` and `unchecked`, without a
  scan, above it (ADR 0040 amendment 3).

**Report deadline (Node, fake worker)** — `deadline.test.ts`, 3 tests: a
per-request `timeoutMs` outlives the client default and dispatches no
cancellation; without it the default deadline still yields `UNKNOWN_OUTCOME`;
an invalid deadline (0, negative, fractional, above 600 s, NaN) is refused
before dispatch. The report controller and the stress harness request
`diagnosticsReport` with `INTEGRITY_CHECK_DEADLINE_MS`.

**Application (Chromium and WebKit)** — `npm run test:app:storage-health:browser`,
19 checks per engine, [retained report](results/blob-inventory-ui-macos.json).
On the blob-inventory fixture archive (one referenced file deleted, one
catalog row deleted, one file shortened, orphans, staged and unrecognized
entries):

| Step | Report |
| --- | --- |
| Seeded archive | integrity, schema, FTS5, sqlite-vec, ownership, search index, semantic index `ok`; persistence `attention` (headless profiles are not persisted); attachment references `missing_data` (102 references, 6 distinct digests, 1 file missing, 1 without metadata, 1 size mismatch) |
| Derived ledger fault, owner replaced | search index and semantic index `rebuildable`; integrity and schema `ok`; references still `missing_data` |
| Rebuild search index | both derived checks back to `ok`; index reaches `ready`; canonical record and sync-operation counts unchanged |
| Delete semantic index | notice and refreshed report; semantic state `disabled`; Rebuild semantic index disabled with its reason (no model on this host) |
| Database corruption fault, owner replaced | integrity `corruption` (1 message: "Page 155: never used"); schema, search index `ok`; references `missing_data` |
| Fingerprint | canonical rows, sync and blob operation records, catalog, transfers and every stored file byte equal the baseline taken before the scan |

The report's JSON contains none of the fixture's private names, original
content or `.txt` filenames. The Storage health section's narrow-layout
screenshots ([Chromium](results/storage-health-chromium-mobile.png),
[WebKit](results/storage-health-webkit-mobile.png)) are retained from the
same run.

**Controller (Node)** — `npm run test:app:storage-health` also runs
`packages/app/tests/diagnostics/report-controller.test.ts` (4 tests): one
report per run, a fresh operation id per rebuild with the epoch described,
boundary errors as plain messages with the last report kept, invalidation
dropping late results, and disposal.

## Inference self-test (product §100 second list, §101 "run QuixiEmbed self-test")

**Classification (Node)** — `npm run test:embed:self-test`, 7 tests,
`packages/quixi-embed/tests/self-test.mjs`, with substituted encoders: the
three frozen cases are unit vectors from the pinned golden manifest; a
healthy CPU host reports model, tokenizer, scalar and SIMD `ok` and a refused
WebGPU adapter as `attention` with the reason; a digest mismatch is
`corruption` and skips the golden runs; a tokenizer drifting by one id is
`corruption`; CPU vectors outside the parity tolerance or not unit length are
`corruption` while 5e-6 drift is `ok`; no WebAssembly SIMD is `unsupported`;
WebGPU absent is `unsupported`, present but not attempted is `attention`, an
active FP16 route within its bound is `ok`, an FP32 route drifting 2e-3 is
`corruption`, and a route lost mid-test is `attention` naming what served.

**Application (Chromium and WebKit)** — the [semantic proof](semantic-search.md)
(`npm run test:app:semantic:browser`) now runs the Storage health
"Run inference self-test" right after enrolment with the real model and
records every check's outcome and measurements; see the table below for the
last run. The model hash check re-reads the artifact from its OPFS copy and
re-hashes it; the reported digest equals the enrolment's source hash.

| Check | Chromium (WASM SIMD · CPU route) | WebKit (WebGPU · FP32 route) |
| --- | --- | --- |
| Model hash | `ok`, re-read from cache, 90,785,583 bytes, digest equals the lock | same |
| Tokenizer | `ok`, 3 cases, exact ids | same |
| Scalar golden | `ok`, min cosine 1.0, max \|Δ\| 1.09e-7 (bound 2e-5) | same |
| WASM SIMD backend | `ok`, min cosine 1.0, max \|Δ\| 1.09e-7 | same |
| WebGPU backend | `unsupported`: no WebGPU adapter in headless Chromium | `ok`, live `webgpu-fp32` route, max \|Δ\| 8.9e-8 (bound 1e-3) |
| Elapsed | 1.17 s | 1.19 s |

Retained run: [semantic-search-app-macos.json](results/semantic-search-app-macos.json).

## Exportable report (product §100, plan 23)

**Builder (Node)** — `npm run test:app:storage-health` also runs
`packages/app/tests/diagnostics/export.test.ts` (3 tests): the file is built
from an allow-list (a planted secret-looking field and planted payload text
never reach the bytes, long measurements are clipped, absent sections carry a
reason), the name is `quixi-diagnostics-<UTC time>.json`, and saving stages
every byte through the host's `file_save` transfer with the digest, then
saves and releases.

**Application (Chromium and WebKit)** — the storage-health proof (13 checks
per engine, [retained](results/blob-inventory-ui-macos.json)) clicks "Save
diagnostics report" after the seeded run, captures the browser download,
parses it and checks: only the allow-listed top-level keys, storage checks
equal to the panel, the inference section absent with a reason (no model on
that host), and none of the fixture's private names, original content or
`.txt` filenames in the bytes (about 3.7 KB). The semantic proof saves the
file after the inference self-test and checks that its five inference checks
equal the self-test's and that the seeded conversation text is absent.
Headless engines cancel the native save picker, so the proofs disable it and
take the download path, as the shared-app proof does.

## Doctor audit: branches, provenance, sync coverage (product §101)

**Scan (Node, real SQLite WASM)** — `npm run test:storage:diagnostics` also
runs `packages/storage/tests/diagnostics/doctor-audit.test.ts` (4 tests): a
committed archive audits clean across every phase in bounded advances; ten
branch faults planted as raw rows (the commit path and the immutability
triggers refuse them as mutations) are each found by kind with record ids,
declared/found counts and no text; provenance and sync faults likewise; a
completed audit turns stale on the next canonical row; cancellation, foreign
scan ids, bad cursors and a closed owner are refused plainly.

**Application (Chromium and WebKit)** — the storage-health proof (15 checks
per engine, [retained](results/blob-inventory-ui-macos.json)): the seeded
archive audits clean (records and operations counted, no repair or deletion
control); after the fixture plants a message with a missing parent, a message
whose part count differs from its parts, a provenance row for a missing
import source and a sync operation naming a missing record, the audit reports
exactly those four kinds with `collection/id` identifiers and none of the
fixture's titles, filenames or content.

## File content verification: blob hashes (product §101)

**Scan (Node, real SQLite WASM, in-memory verified-read store)** —
`npm run test:storage:diagnostics` also runs
`packages/storage/tests/diagnostics/blob-hash-audit.test.ts` (3 tests): intact
files verify in blocks of at most 128 KiB with a large file spanning
advances and every open read discarded; altered bytes, a shorter file, a
missing file and an unreadable file are found by digest with sizes and no
content; a completed audit turns stale when the files or the catalog change;
cancellation releases the open read; a closed owner refuses.

**Application (Chromium and WebKit)** — the storage-health proof (17 checks
per engine, [retained](results/blob-inventory-ui-macos.json)): on the seeded
archive the verification re-reads every catalogued file and reports the
shortened file and the deleted file by digest and size while every other
file verifies; after the fixture rewrites the referenced attachment with
different bytes of the same length, the verification reports that digest as
content differing, which only hashing can find. No filename or content
appears in the panel.

## Reviewed cleanup (product §101 "find orphan blobs", ADR 0041)

**Controller (Node)** — `npm run test:app:storage-health` also runs
`packages/app/tests/diagnostics/cleanup-controller.test.ts` (3 tests): only
orphan findings can be ticked, at most thirty-two; nothing is sent without a
review; confirming sends exactly the reviewed digests bound to the scan and
records deletions and refusals; a new or stale scan drops the selection;
errors are plain; disposal stops everything.

**Application (Chromium and WebKit)** — the storage-health proof (19 checks
per engine, [retained](results/blob-inventory-ui-macos.json)): the deletion
control is disabled until files are ticked; two ticked unreferenced files
are shown with their digests and total size in a review; "Keep the files"
changes nothing (canonical counts equal); confirming deletes exactly those
two (orphan count 98 → 96 after a new scan); the scan reads stale until a
new one and a stale scan refuses further deletion; a referenced file, an
import-protected file and an unknown digest are each refused as not a
finding of the scan. The storage-level inventory proof was rerun after the
staleness trigger change ([retained](results/blob-inventory-worker-macos.json),
11 checks per engine).

A race surfaced on the way: background lexical indexing marks catalog rows
verified after reading text blobs, which made a completed scan stale before
the user could confirm. The inventory and hash-audit triggers now ignore
catalog updates that change neither digest nor size, and the stale message
names what changed.

## Fault fixtures and repair verification (plan 23)

The blob-inventory fixture worker plants faults outside the production
client protocol, as raw rows or files the commit path refuses as mutations:

| Fault | Planted state | Repair exercised | Verified against |
| --- | --- | --- | --- |
| `derived-failure` | search ledger checksum from another build | Rebuild search index (repair path) | canonical rows, operations, catalog, transfers, file bytes fingerprinted equal; index returns to `ready` |
| `semantic-failure` | semantic ledger checksum from another build | Delete semantic index (namespace recreated); Rebuild semantic index re-embeds (semantic proof) | canonical record and sync-operation counts equal; message list equal; the same semantic query answers |
| `corrupt-database` | an index's pages left unreferenced through `writable_schema` | none offered (export and restore) | report names corruption separately from the derived indexes |
| `doctor-faults` | missing parent, overcounted parts, missing import source, sync op naming a missing record | none offered (no canonical rewrite) | Doctor audit names exactly those four |
| `blob-corrupt` | same-length altered bytes in a referenced file | none offered (restore the file from a backup) | file content verification names the digest |
| fixture seed | deleted file, deleted catalog row, shortened file, orphans, stray staging, unrecognized entries | reviewed cleanup of orphans only | fingerprint after cleanup differs only in the deleted files |

The storage-health proof (19 checks per engine) and the semantic proof (14
checks per engine) carry these steps; the archive proofs cover restore
([archive-scale.md](archive-scale.md): a corrupted container is refused and
the active archive stays intact; an isolated candidate validates every
record).

## Recovery foundation: what remains accessible per failure class (plan 23)

Archive export/restore is the recovery foundation; every failure class below
keeps a path to the bytes and, where possible, to the history. Each row cites
the proof that exercises it.

| Failure class | What remains accessible | Recovery path | Evidence |
| --- | --- | --- | --- |
| Storage unavailable or denied at startup (no OPFS, ephemeral context) | Nothing local; the typed startup outcome names the cause and offers retry | Retry once storage is available; an interrupted first run recovers on retry | `tests/e2e/startup-failure.spec.ts`, `startup-unsupported-session.spec.ts` ([storage-proof.md](storage-proof.md), [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)) |
| Schema initialization or migration fails (ledger from a newer build, tampered ledger) | The exact database and blob bytes through the rescue export; bounded read-only history at a compatible ledger prefix | Rescue export through host staging; rescue restore into a fresh candidate at this build's schema (schema 8 onward, migration-aware upgrade) | `tests/e2e/startup-rescue.spec.ts`, plan 09 schema-8 rescue and portable fixtures ([09](../plans/09_add_archives_and_open_export.md)) |
| Derived lexical index fails (search ledger from another build) | Every conversation, message, attachment and export; search refuses with the reason | Rebuild search index (repair path replaces the derived tables); canonical rows, operations, catalog, transfers and file bytes fingerprinted unchanged | this document, storage-health proof `derived-failure` fault |
| Derived semantic namespace fails (semantic ledger from another build) | Everything above plus exact search | Delete semantic index recreates the namespace; Rebuild semantic index re-embeds with a new generation and unchanged canonical counts | this document, storage-health proof `semantic-failure` fault; semantic proof rebuild step |
| SQLite file corruption (unreferenced pages, damaged b-tree) | Whatever SQLite still reads; the report names corruption separately from the derived indexes | Export a backup (portable or open) while readable; restore it as an isolated candidate before activation; a corrupted container is refused at validation with the active archive intact | storage-health proof `corrupt-database` fault; [archive-scale.md](archive-scale.md) corrupted-container refusal |
| Stored file missing, shortened or altered | All saved records; the affected attachment is served as unavailable, never as verified | Storage scan and file content verification name the digests; restore the file from an earlier backup; reviewed cleanup removes only unreferenced files | this document (inventory, hash audit, ADR 0041) |
| Browser storage eviction (persistence not granted) | Nothing local after eviction | Persistent-storage request and exported backups beforehand; the report classifies the grant as attention | onboarding and storage-health status ([onboarding.md](onboarding.md)) |

No repair rewrites canonical history. Restore on a second host (cross-host)
and the desktop entry's native exercise of the startup outcome remain plan 09
and plan 01/24 gates.

## Limits

- The reference check is bounded (newest 4,096 referencing records, first 64
  distinct digests probed for a file). It reports `complete: false` beyond
  that and defers to the storage scan; it does not hash file contents.
- `unsupported` outcomes are proven by classification only; no host in the
  matrix lacks FTS5, sqlite-vec or the tokenizer.
- The corruption fixture is a real inconsistency SQLite detects, not a
  torn write; a database that fails to open is handled by the startup
  outcome ([ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)),
  not by this report.
- Semantic rebuild (re-embedding) is exercised by the semantic proof, not
  here; on this fixture host it is disabled because no model is provided.
- Cycle detection in parent chains is not attempted by the Doctor audit; a
  self-parent is found, a longer cycle is not. The file verification reuses
  a session's already-verified shared read when one is open for a digest,
  so a file fully hashed earlier in the same owner session is not hashed
  twice.
- The inference self-test
  proves the routes present on the two Playwright engines; hardware WebGPU
  adapters on other machines remain plan 19/21/24 gates.
