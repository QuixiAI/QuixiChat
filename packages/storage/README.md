# @quixi/storage

The only canonical history backend: Storage Worker → SQLite WASM → OPFS.

- `src/client/`: production `createStorageClient()` and separate proof client,
  with bounded requests/transfers and explicit uncertain outcomes.
- `src/worker/`: actual SQLite/OPFS owner, serialized writes, and cross-tab forwarding.
- `src/worker/blobs.ts`: private bounded OPFS staging, verification, publication,
  reads and inventory, with UTF-8 validation for canonical text.
- `src/worker/blob-catalog.ts`: durable transfer lifecycle, current-owner byte
  verification, quarantine and canonical publication/cleanup coordination.
- `src/worker/producers.ts`: durable producer fences and recovery based on
  independent generation Web Locks, preserving live streams across owner handoff.
- `src/worker/search/`: derived FTS schema, shared source chunks and bounded
  indexing/search operations; canonical history remains authoritative.
- `src/proof/`: developer UI at `/storage-proof`; isolated synthetic records.
- `migrations/`: ordered schema migrations.
- `sqlite/`: pinned SQLite + FTS5 + sqlite-vec build inputs and checksums.

Keep repositories, FTS/vector SQL, attachment blobs,
archive export/restore, and multi-tab coordination private to this package.
Canonical mutations and sync operations commit atomically. Importers submit
bounded normalized records through the client; they never issue SQL.

The [A1 matrix](../../docs/validation/storage-proof.md) records actual browser and
WebView behavior and remaining gaps. The production client now connects canonical
transactions, blob transfers, paginated reads, diagnostics and notifications to
the owner worker. [Actual client acceptance](../../docs/validation/archive-client.md)
covers two tabs, lost replies, owner takeover, staged normalized imports,
producer loss, exact search/rebuilds and browser-process restart.
[Blob and private repository evidence](../../docs/validation/blob-storage.md)
adds quota and corruption checks. Provider export parsing lives in
`@quixi/importers`; archive export/restore and the full release matrix remain open.
