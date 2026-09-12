# Derived PDF extraction repository proof

From the repository root:

```sh
npx tsc --noEmit -p packages/storage/tests/extraction/tsconfig.json
node packages/storage/tests/extraction/run.mjs
```

The tests verify the repository-pinned SQLite WASM hash before instantiation and seed actual canonical Document/Attachment records referencing a checked-in synthetic PDF. They exercise the private `ExtractionRepository`; the injected identity lookup reads canonical records, and the injected operation-claim callback writes a stable proof journal in the same SQLite transaction. No operation-claim trigger depends on extraction tables.

Retained evidence is [results/repository-wasm.json](./results/repository-wasm.json), with TAP output alongside it. The report records the actual canonical migration ledger, runtime, exact contract/repository/schema/WASM hashes and bounded publication timing. The tests do not claim OPFS durability, browser/process-owner termination, production StorageClient routing or complete PDF-to-app integration.

Coverage includes atomic stage/page/checkpoint/outbox publication, original operation receipts after lost replies and cleanup, payload/kind/global-claim conflicts, rollback before commit, explicit writer-epoch resume, unchanged state across SQLite close/reopen, source/version/run fences, bounded maps and Unicode/NUL source text, array/getter/surrogate validation, empty/scanned pages, stored page classification independent of bounded window length, actual SQLite FULL rollback, logical admission and clear reserve, bounded cleanup queues, local map corruption detection, and canonical-write isolation from a missing extraction table. A registered page is fed continuously through the existing StructuralChunker and actual FTS5 to prove a phrase spanning extraction events; this is not yet production SearchRepository integration.

The maximum-text fixture publishes 262,144 UTF-16 units including an initial NUL. The near-map-limit fixture stages 32,768 spans through 256 bounded batches; it computes expected maps incrementally rather than collecting a complete map array. Its publication timing is recorded, not asserted as a portable deadline. Physical SQLite/OPFS quota and PDF.js internal allocations are separate from logical 256 MiB/run and 1 GiB/archive admission limits.
