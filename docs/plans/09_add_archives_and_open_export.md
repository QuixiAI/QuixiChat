# 09 — Add portable archives and open export

**Status:** In progress — portable/open export, managed activation, shared replacement UI, retained-history recovery, schema-8 candidate upgrade and the web-to-desktop cross-host restore pass production-path checks; cross-host and host gates remain open; the scale gate passed on 2026-09-12 ([archive-scale.md](../validation/archive-scale.md))

**Workstream:** A7 — ownership and recovery

**Depends on:** [03](./03_build_storage_repositories.md)

## Outcome

Let users export a complete local archive, restore it on another supported host, and read their textual history without Quixi.

## Product references

- [5. Hard architectural rules](../product.md#5-hard-architectural-rules)
- [11. OPFS layout](../product.md#11-opfs-layout)
- [21. Raw provider preservation](../product.md#21-raw-provider-preservation)
- [27. Import transactions](../product.md#27-import-transactions)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [97. Derived data and sync](../product.md#97-derived-data-and-sync)
- [98. Archive export](../product.md#98-archive-export)
- [99. Open export](../product.md#99-open-export)
- [111. Storage stress tests](../product.md#111-storage-stress-tests)
- [115. V1 success criteria](../product.md#115-v1-success-criteria)
- [116. Product-core success criteria](../product.md#116-product-core-success-criteria)

## Tasks

- [x] Freeze and document an archive manifest/version contract covering quixi.sqlite, blob references, included data, source schema version, and integrity checks.
- [x] Implement a consistent database snapshot/export while the worker owns SQLite. Define how concurrent mutations are handled so exported metadata and blobs agree.
- [x] Stream archive production and consumption with bounded memory, progress, cancellation, temporary-file cleanup, and storage-capacity checks. — Production and consumption are bounded and streamed at scale ([archive-scale.md](../validation/archive-scale.md): 30,000 messages, 106 MB portable and 65 MB open exports in ≤ 1 MiB / ≤ 128-record steps with phase progress, an isolated restore validating 60,900 records in bounded steps); cancellation and cleanup are covered by the archive tests (allocation/cancellation failures unlink only private output); since 2026-09-12 every export and restore begins with a storage-capacity check ([ADR 0010](../decisions/0010-portable-archives.md) amendment): the worker compares the database plus blob bytes (export) or twice the announced container size (restore) plus slack with the browser's storage estimate and refuses up front as `QUOTA_EXCEEDED` with both numbers; an unknown estimate never refuses (`capacity.test.ts`, 15 archive tests, browser snapshot proof).
- [x] Implement restore validation for manifest/schema compatibility, corrupt or missing blobs, and incomplete archives. Stage and validate restoration before replacing an active archive; make replacement intent explicit to the user. Manifest, container, schema, record, topology, journal and blob validation run in an isolated candidate ([archive proof](../../packages/storage/tests/archives/README.md)); rescue archives (`kind: "rescue"`, [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)) and portable archives whose ledger is a strict prefix from schema 8 are upgraded in that candidate through the fresh-schema copy before validation and review, while lower, newer or differing ledgers are refused by name ([retained proof](../../packages/storage/tests/retained/README.md#rescue-export)); replacement is an explicit reviewed action in the [shared UI](../../packages/app/src/features/archives/tests/browser/README.md).
- [x] Implement JSONL and Markdown export plus attachment files. Preserve roles, branches, generation metadata, provenance, and unsupported-part descriptions sufficiently for independent interpretation.
- [x] Allow derived search data to be excluded and schedule local rebuilds after restoration. Keep credentials and host secret material out of archive and open exports.
- [x] Expose archive and open-format operations through StorageClient and the shared UI, using HostClient only for file transfer/dialogs.

## Deliverables and interfaces

- Versioned archive format documentation, export/restore operations, and open-format serializers.
- Small round-trip fixtures and corruption/interruption recovery scenarios.

## Acceptance criteria

- [x] An archive exported from one supported host restores on another with matching canonical records, branches, provenance, and blob hashes. — [cross-host-restore.md](../validation/cross-host-restore.md): a portable archive exported by the web host (Playwright Chromium, production Storage Worker) restores in the native Tauri WebView (macOS WebKit, production Storage Worker) into a validated candidate whose fifteen collection digests (threads, states, contexts, messages, generations, parts, events, attachments, provenance and the rest), record and sync-operation counts and blob file hashes equal the export's; the candidate is read back through the retained reader, never activated.
- [x] A restore failure leaves the previous usable archive intact and reports the cause. — [archive-scale.md](../validation/archive-scale.md): a 106 MB container with 64 KiB zeroed is refused at the checksum claim with a named code and reason in both engines, and the active archive keeps integrity "ok" and answers an exact search afterwards; the archive proofs cover corrupt graph/schema/journal refusals and schema-7 refusal by name.
- [x] JSONL and Markdown text can be read with ordinary tools without running Quixi. — [archive-scale.md](../validation/archive-scale.md): the system `tar` lists and extracts the open export; `records.jsonl` and `checksums.jsonl` parse line by line with `JSON.parse` (91,503 records, no invalid line, 30,000 message and 300 thread records); `history.md` carries all 30,000 message passages as plain text.
- [x] Exports remain bounded at large archive sizes and do not require embeddings or a Cloud account. — [archive-scale.md](../validation/archive-scale.md): 30,000 messages export in 1,537 (portable) and 2,209 (open) bounded steps and stream out in 64 KiB chunks in both engines, on a page with no embedding model and no Cloud account.

## Implementation evidence

[ADR 0010](../decisions/0010-portable-archives.md) records the version-1 TAR/PAX subset, trusted fresh-schema logical snapshot, readonly candidate validation, review barrier, byte/work bounds and remaining release gates. Thirteen pinned-WASM/codec tests pass. [Actual browser results](../../packages/storage/tests/archives/results/snapshot-browser.json) cover private and public owner-worker paths, 9 MiB raw bytes, canonical/journal/import/tombstone fidelity, restart revalidation and foreground byte pressure. The web HostClient now stages file saves on disk, with actual 32 MiB download/retention/cleanup tests in both browser engines. Provider-request staging remains separately capped.

Schema 9 adds a committed compatibility barrier for known older writers without rewriting canonical records or sync operations. Streaming NUL/Unicode preservation remains covered across reserved transport provenance in SQLite and Markdown. Since 2026-09-09, portable and rescue archives from schema 8 onward restore through the candidate upgrade of ADR 0016 §3, proven on a genuine schema-8 portable and a genuine schema-8 rescue; schema 7 and earlier are refused by name and the active archive is preserved.

StorageClient has bounded archive jobs, transfer routes, outstanding-job listing and isolated restore summaries. Shared workflows prepare output before a separate Save gesture and can stage an existing ready export. Both hosts now open a managed selection; worker ingress, owner startup, foreground effects and maintenance enforce its exact revision. The [production activation evidence](../../packages/storage/tests/selection/integration/README.md) covers real export/restore/review/switch, stale and live-producer refusals, lost replies, process restart, retained source history and missing selection data. The [retained reader](../../packages/storage/tests/retained/README.md) validates existing files before opening a read-only connection and refuses recovery-required archives without modifying their files. [Protocol evidence](../../packages/storage/tests/protocol/README.md) covers the known schema-8 owner/follower cohort.

The shared replacement panel and explicit host remount pass [seven UI groups per browser](../../packages/app/src/features/archives/tests/browser/README.md), including a saved ready restore across reload. Resuming revalidates the candidate under its current storage owner before a fresh explicit review; it never implicitly activates. Unsent drafts remain in old views on selection hints, and unresolved activation replies use the original global receipt identity. Schema 10 adds [durable local operation claims](../decisions/0015-durable-derived-operation-claims.md); portable snapshots exclude those rows and validation requires their table to be empty. Checked tasks do not close the broader capacity, cross-host or large-archive acceptance gates above.

## Boundaries and sequencing

Archive restoration is a recovery operation, not an implicit merge of two unrelated archives. Provider imports use plan 04. Remote encrypted backup and key recovery are deferred to plans 25–26.

[Back to the roadmap](./README.md)

## Context exclusion compatibility regression — 2026-09-10

[ADR 0019](../decisions/0019-reviewed-context-compaction.md) introduces schema 11
and archive protocol 3 for immutable reviewed attachment exclusions. The ledger
gate refuses old writers; the transport gate also isolates old followers.
[Acceptance](../validation/context-compaction.md) records canonical upgrade/replay,
exact policy/event/original-attachment portable roundtrip in Chromium/WebKit,
current activation/protocol and extraction/retained-recovery regressions.
The schema-8 restore fixture stays separate from the new policy fixture.
Native and cross-host release gates remain open; this completes no whole plan.

## Reviewed summary compatibility — 2026-09-10

[ADR 0020](../decisions/0020-reviewed-summary-proposals.md) adds schema 12 / archive
protocol 4 for typed SummaryProposal provenance and reviewed prefix policies.
[Acceptance](../validation/context-summaries.md) records source/revision/digest
validation, complete-text eligibility, required atomic apply/clear audit events,
replay/rollback/reopen, schema-10/11 upgrade and older-client refusal. The real
portable snapshot proof preserves a summary generation, proposal, verified frozen
input, edited reviewed text, exclusions, canonical edges and journal exactly in
both browser engines; its schema-8 fixture remains separate. Retained recovery,
activation and affected search/extraction regressions pass. Native/cross-host
and release-scale gates remain open; no whole plan is closed.
