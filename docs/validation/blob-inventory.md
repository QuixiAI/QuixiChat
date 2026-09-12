# Bounded blob inventory and storage health

Recorded 2026-09-10 on macOS 26.6.2 arm64, Node 22.23.1, pinned SQLite
3.53.4 and the repository's Chromium/WebKit builds. Product §10–11 and
§100–101; plans 03 and 23; [ADR 0024](../decisions/0024-bounded-blob-inventory.md).
All qualification uses isolated synthetic archives.

## Delivered behavior

Storage health offers an explicit local scan, progress, Stop and paged findings.
It compares available attachment/raw-object references and blob-backed text
with catalog metadata and managed OPFS entries. It reports missing files,
missing metadata, wrong lengths, unreferenced blobs, protected files, staged
files and unrecognized entries. It reads sizes rather than rehashing all content.
Canonical history, sync operations, catalog verification state and stored bytes
remain unchanged.

Verified/published or retained transfers, hidden normalized-import records and
retained import associations protect their files. Protection is conservative:
retained transfer/import data may still need bytes even when no work is running.
The current importer commits original raw bytes before recording resumable
checkpoints and registers upload/import ownership before publishing normalized
references. Finding an unreferenced file does not establish permission to delete
it. This increment exposes no deletion or repair operation.

The five StorageClient operations validate closed arguments before dispatch.
Each advance performs at most 64 work items, including scratch cleanup,
nonmatching records, prefix directories and unknown entries. SQL uses scalar
projections and indexed one-row steps instead of reading whole conversation
payloads or retaining a JavaScript inventory. TEMP reference/finding tables use
file-backed storage and a 1 MiB page-cache target, configured at initial owner
startup before any TEMP operation fences. Preparing the next scan clears old
scratch rows in capped batches. Canonical schema 12, archive protocol 4 and
portable formats remain unchanged; scratch data is connection-local.

Only one scan runs per owner. Repeating its ID is idempotent; another active
scan is refused. Cancellation releases enumeration and retains a partial result.
SQL mutation guards, the byte-store mutation counter and SQLite data-version
checks invalidate observations when their inputs change, including after
completion. An ordinary read-handle close is not a file mutation. Broken
promised reference/transfer metadata fails the scan instead of silently dropping
protection. A new owner requires an explicit new scan; there is no fabricated
resume position for an unordered OPFS iterator.

The controller advances one batch at a time and displays one page of at most
32 findings/16 KiB. Stop, disposal, replacement and late replies cannot restore
old results or cancel a newer scan. Navigating between app panels retains the
same active scan. Canonical changes immediately hide findings, while status
checks around page reads and on remount detect other stale/owner-loss cases.
Keyboard start/stop/paging and narrow layouts are exercised. Findings expose
only managed digest/UUID paths, lengths and counts; unrecognized original names
and file/message content are omitted.

## Executed evidence

| Check | Passed |
| --- | ---: |
| Core contracts, including four new inventory boundary cases | 61 tests |
| Storage health controller, including delayed-result races | 7 tests |
| Actual worker/OPFS inventory | 11 groups per Chromium/WebKit |
| Actual shared application storage-health workflow | 7 groups per Chromium/WebKit |
| Existing production storage-client regression | 28 checks per Chromium/WebKit |
| Existing blob/catalog regression | 37 Chromium; 31 WebKit checks |
| Existing shared application regression | 42 groups per Chromium/WebKit |
| Actual native regional app/storage-startup regression | 63 checks in five processes |
| `npm run check` | SQLite verification, TypeScript and both frontend builds |

The [worker report](results/blob-inventory-worker-macos.json) retains 28 source
hashes. Each engine inventories 106 canonical records and 112 fixture files in
50 advances capped at seven work items, yielding 111 findings through 23 bounded
pages: one missing file, one missing catalog entry, 98 orphans, one size mismatch,
three protected blobs, four stages and three unrecognized entries. Dedicated
cases cover an actual unfinished upload, cancellation, competing scan refusal,
cross-scan cursors, live append/canonical changes after completion, a read close,
malformed available references, and actual browser-process restart.

Before/after fingerprints cover canonical records, sync/blob operations,
stable catalog fields, durable transfer rows and every fixture file's hash.
Intentional title mutations are counted separately; corrupted reference fixtures
fail without further changes. Staging recovery is allowed to occur before the
baseline. The scan itself neither quarantines nor repairs missing/wrong-size
bytes. The effective file-backed TEMP setting and cache target are asserted.

The [application report](results/blob-inventory-ui-macos.json) verifies all seven
categories, unchanged fingerprints, bounded pages, keyboard focus, Stop,
navigation during a scan, stale results and real storage-owner replacement,
and since 2026-09-12 the plan 23 [diagnostics report and repair actions](./diagnostics.md)
on the same fixture archive (13 checks per engine).
The [Chromium](results/storage-health-chromium-mobile.png) and
[WebKit](results/storage-health-webkit-mobile.png) 390-pixel screenshots were
visually inspected. Long identifiers wrap without horizontal page overflow.
WebKit fixtures use isolated persistent browser profiles, matching the existing
OPFS proofs; the first ephemeral-context attempt was not qualifying evidence.

[Storage-client](results/blob-inventory-client-regression-macos.json),
[blob/catalog](results/blob-inventory-blobs-regression-macos.json),
[shared-app](results/blob-inventory-app-regression-macos.json) and
[native](results/blob-inventory-native-regression-macos.json) reports preserve
their executed scope and source hashes. The blob regression includes actual
Chromium quota failure/recovery; WebKit has no equivalent quota-injection hook.
The native regression checks ordinary archive startup and established regional
workflows under the new TEMP configuration, not native inventory acceptance.
The [aggregate check report](results/blob-inventory-checks-macos.json) records
commands, logs and verified artifact/source hashes. No remote CI run is claimed.
Its fixture-file hashes predate the 2026-09-12 fault operations added to the
fixture for the diagnostics proof; the worker and application reports above
were rerun on that date against the current fixture (11 and 12 checks per engine).

## Acceptance and remaining work

The new detection evidence plus the current ingestion, publication, bounded-read,
rollback, interruption and quota regressions close plan 03's final blob task.
Its other tasks and acceptance criteria retain their linked SQL/client/migration
evidence, so plan 03 is complete. Release-scale and additional platform evidence
remain with plans 01 and 24.

Plan 23 is underway, not complete. Full hash verification, branch/import/sync
audits, richer diagnostics, exportable reports and explicitly reviewed cleanup
remain open. This scan is not an atomic snapshot of externally modified OPFS;
restart it after external modification or recovery. Timing observations are not
release performance measurements. Earlier reports retain historical hashes and
their original scope. Summary fidelity still has zero scored model runs, and
official provider-export qualification still needs authorized fixtures.
