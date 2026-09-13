# ADR 0040: Diagnostics outcomes and report content

**Status:** Accepted, 2026-09-12
**Plans:** [23](../plans/23_build_diagnostics_and_recovery.md)
**Product:** §100 Diagnostics, §101 Quixi Doctor, §14 Persistence status

## Context

Product §100 lists the storage and inference checks a user should be able to
run; plan 23 requires that detected corruption be distinguished from an
unsupported capability, from missing data and from a rebuildable derived
index, and that diagnostic exports contain no secrets or unsolicited history.
The application already reported backend, schema, integrity and usage on the
Storage health view, and exposed semantic delete/rebuild on the semantic
panel, but nothing named what a finding meant or offered the FTS rebuild.

## Decision

1. **A fixed outcome vocabulary.** Every diagnostic check reports exactly one
   of `ok`, `corruption`, `unsupported`, `missing_data`, `rebuildable`,
   `attention` or `unknown`. The classification lives in one worker module
   (`packages/storage/src/worker/diagnostics.ts`) so the same evidence always
   maps to the same outcome:
   - `corruption` only for what SQLite's `integrity_check` reports, a missing
     canonical table, or a malformed reference inside a saved record;
   - `unsupported` for compile-time or host facts (no FTS5, no sqlite-vec, no
     bundled chunk tokenizer), which imply nothing about the data;
   - `missing_data` when a saved record refers to bytes this device does not
     hold (no catalog row or no stored file);
   - `rebuildable` for the derived search failure the owner retains, or a
     failed index status; canonical history is intact in that state;
   - `attention` for a usable state worth acting on (persistence not granted,
     a stored file whose size differs from its record, failed sources);
   - `unknown` when the host does not report the fact.
2. **The report is operational metadata only.** Its `contentPolicy` is
   `operational-metadata-only`; `assertDiagnosticsReportContent` refuses a
   report whose measurements are not plain identifiers, numbers, booleans or
   short strings. The reference SQL extracts digests and byte lengths from
   record payloads and never returns the payload. This makes the report
   exportable without a redaction step (plan 23's export task builds on it).
3. **Bounded, explicit, read-only.** The report runs `integrity_check`, so it
   is an explicit action and never polled. The reference check examines the
   newest 4,096 referencing records and probes the first 64 distinct digests
   for a stored file; the full walk remains the storage scan ([ADR 0024](./0024-bounded-blob-inventory.md)).
   Nothing in the report writes.
4. **Repairs are distinct actions on Storage health.** "Rebuild search index"
   sends `rebuildSearch` (derived FTS data only; a failed derived index takes
   the repair path that replaces its tables). "Delete semantic index" and
   "Rebuild semantic index" reuse the semantic controller because it also owns
   the inference runtime. None of the three reads canonical rows for writing.

5. **The exportable file is an allow-list projection of the two reports**
   (amendment 2, 2026-09-12). `buildDiagnosticsExport` copies only the named
   fields of the storage report and the inference self-test, clips string
   measurements, records why a section is absent, and adds the host kind and
   user agent; it is saved through the host's verified `file_save` staging.
   Nothing else in the application is consulted, so provider credentials
   (which never leave the host secret boundary) and conversation text cannot
   appear in it.

## Consequences

- The onboarding capability check keeps reading the lighter `diagnostics`
  operation; the report is a separate, heavier operation.
- Inference diagnostics live in the embedding service, not in the storage
  report (amendment 1, 2026-09-12): `EmbeddingService.selfTest()` re-reads
  and re-hashes the model artifact, runs three frozen golden cases (token ids
  and reference vectors from the goldens manifest) through the scalar and
  SIMD WASM backends and through the live WebGPU route when one is active,
  and probes WebGPU availability otherwise. Its five checks (model hash,
  tokenizer, scalar golden, WASM SIMD backend, WebGPU backend) use the same
  outcome vocabulary minus `missing_data` and `rebuildable`, which cannot
  apply to a runtime. CPU routes must meet the parity suites' tolerance
  (cosine ≥ 0.999999, |Δ| ≤ 2e-5); the GPU routes carry their own bounds
  (FP32: cosine ≥ 0.9999, |Δ| ≤ 1e-3; FP16: cosine ≥ 0.999, |Δ| ≤ 5e-3),
  chosen so a vector outside them would change rankings. A golden mismatch
  is `corruption` because a runtime that does not reproduce its reference
  cannot be trusted, whatever the cause. The scheduler's memo is cleared
  before the GPU cases so they are computed, not recalled. The self-test
  loads the runtime if it is not loaded and leaves it loaded.
- Integrity cost at scale (amendment 3, 2026-09-13). The 1M-message WebKit
  stress run showed that `PRAGMA integrity_check` over a whole-archive file
  outlives the storage client's default 60 s reply deadline, which then
  reports an unknown outcome and the worker keeps scanning. Two changes:
  the explicit report is requested with a per-request deadline
  (`StorageRequestOptions.timeoutMs`, `INTEGRITY_CHECK_DEADLINE_MS` =
  600 s, the client maximum) and its `sqlite_integrity` check records
  `elapsedMs` and `databaseBytes`; and the light `diagnostics` operation
  that onboarding and the import controller read at startup verifies
  integrity only for files up to `AUTOMATIC_INTEGRITY_CHECK_MAX_BYTES`
  (256 MiB, from `page_count × page_size`), answering `unchecked` above it
  so opening a large archive never runs a whole-file scan. The bound is a
  function of the file size alone, so the answer is deterministic for a
  given archive; a large archive is verified on request from Storage health
  (product §101 "SQLite integrity_check"). While the report's scan runs,
  other requests to the same worker queue behind it under their own
  deadlines; the report remains an explicit action for that reason.
- Corruption fixtures create real inconsistencies (unreferenced b-tree pages
  after a `writable_schema` edit) rather than mocked results; a fixture that
  needs SQLite to *fail to open* is still outstanding and is covered by
  [ADR 0016](./0016-startup-failure-and-schema-recovery.md)'s startup outcome.
