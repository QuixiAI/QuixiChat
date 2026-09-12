# Private canonical repository

`CanonicalRepository` is worker-private and accepts the official SQLite OO shape (`exec` and `selectValue`) plus an injected synchronous verified-blob checker. It imports no OPFS, provider HTTP or UI implementation. See [ADR 0006](../../../../../docs/decisions/0006-canonical-persistence.md) for invariants, scale corrections and outstanding integration work.

```ts
const repository = new CanonicalRepository(db, {
  assertBlobAvailable: (sha, bytes, stages, encoding) =>
    blobCatalog.assertAvailable(sha, bytes, stages, encoding),
});
repository.migrate(); // ordered canonical schema version 6
```

Methods: `commit`, `committedTransaction`, `operationStatus`, `readEntities`, `readMessageParts`, `readSyncOperations`, `resolveSourceIdentity`, bounded `get`, and `recoverInterrupted`. Recovery requires coordinator-confirmed generation IDs, never an inference from a storage-owner handoff alone.

The owner performs blob prepublication before `commit`, then stage cleanup after SQL success. A callback named `beforeCommit` is available for failure injection; it is not an application hook for asynchronous work. No awaited I/O belongs inside the repository transaction.

The tests use actual pinned SQLite WASM under Node's memory filesystem. This is SQL acceptance, not OPFS/process persistence evidence. The import suite proves bounded staging and complete atomic publication for a sealed 2,000-part message and 50,000-message thread. The SQL allocation-denial test uses SQLite page limits, not browser quota.

Normalized imports add methods matching the core `StorageOperations` names: `beginNormalizedImport`, `stageImportRecords`, `validateImportStep`, `finalizeNormalizedImport`, `cancelNormalizedImport`, `normalizedImportStatus` and `readStagedImportRecords`. The worker must preserve operation/import IDs after uncertain replies. Cached control results are historical; query status for current progress and validation readiness.

Worker orchestration helpers:

- `committedImportOperation(operation, args)` checks replay/payload conflicts before external work.
- `importValidationRecords({importId,maxRecords})` yields one next candidate record at a time. It accounts for topology work and owner/high-water invalidation; no SQL statement remains open across yields.
- `recordImportBlobTransfers(importId, transferIds)` retains at most 128 supplied transfer links per call before publication.
- `readImportBlobTransfers(importId,{after,maxItems})` pages up to 128 transfer IDs; `forgetImportBlobTransfer(importId,transferId)` acknowledges completed cleanup. Links outlive publish/cancel and restart.

Finalization requires expectedRecordCount/expectedManifestDigest and current-owner incremental validation. It performs no awaited I/O. Sync consumers must hide ImportRecord groups until the matching PublishImport marker verifies count/digest; ordinary per-page application is insufficient.
