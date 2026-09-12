# @quixi/core

Provider-neutral canonical records, pure validation/branching, and injected worker/host contracts. The only public exports are `@quixi/core/model` and `@quixi/core/contracts`; source compilation uses ES2022 without DOM, Node, Tauri, SQLite, provider transport or inference types.

`model` defines message-tree history with bounded partCount and ordered part records, generation candidates, immutable edits, context snapshots, explicit active paths, source identity/provenance, attachments, documents and derived SearchChunk metadata. Validators report stable codes and paths. UUIDs and clocks come from callers. [ADR 0004](../../docs/decisions/0004-canonical-history.md) defines the relationships and lifecycle; [synthetic fixtures](../../tests/fixtures/canonical/README.md) show normalization expectations and evidence limits.

`contracts` defines 24 canonical mutations with write/sync effects, pure transition previews, bounded request/reply envelopes, independent staged blob transfers, import manifests, progress/errors/cancellation, and privileged HostClient interfaces. `previewMutationBatch` returns a validated value without changing its input; it does not perform or prove a durable transaction. The storage worker must validate commands, enforce original operation-ID idempotency and optimistic revisions, verify staged bytes, and commit canonical writes, publication references, operation results and sync ops atomically.

Storage `request(requestId, operation, args)` uses a caller-assigned request ID for cancellation. Logical mutation/transfer operation IDs are distinct from transport request IDs: retain the original operation ID and payload when retrying an unknown outcome. `operationStatus: not_found` is only an observation, not proof that an in-flight original cannot commit later. The adapter must serialize reconciliation with the original operation or replay the same ID.

Control requests/replies are at most 1 MiB; size validation counts UTF-8 JSON incrementally before constructing a complete serialized copy. Pages have item and byte budgets; their `bytes` measures serialized items, and the complete reply also obeys the envelope limit. Byte transfers use at most four unacknowledged 1 MiB chunks and 64 pending control requests. Every producer must wait for acknowledgments. A giant canonical snapshot is a local validation input, never a permitted bulk transport format.

Text/Note use exactly one inline string of at most 16,384 UTF-16 code units or a verified UTF-8 blob reference. `inlineTextSegments` provides bounded surrogate-safe segments for streaming adapters. `readMessageParts` pages by message/order; `readSyncOperations` pages by monotonic local sequence with a captured high-water mark. Thread/branch tombstones carry root scope rather than enumerating descendants. These corrections were validated during plan 03 integration.

Native attachments use `beginBlobTransfer` → chunks/acknowledgments → `finishBlobTransfer` → `commit` with `stagedBlobIds` (the transfer IDs returned by begin). For canonical_text purpose, the byte layer also verifies UTF-8. Finish verifies actual length/hash and produces `verified_staged`, not published canonical content. Commit must match referenced hashes against verified staging or already published blobs; orphan staging can be discarded/recovered. `readBlobTransfer` opens only published hashes; `discardBlobTransfer` is idempotent and cannot remove a published blob referenced by history. Import bundles use the same bounded byte transport; they are not required for native attachments.

HostClient describes capability/permission and relay privacy, host-registered provider destinations/credential binding, bounded timeouts, host-owned OAuth state/PKCE, staged outbound transfers and handle release. Implementing hosts enforce destination/header/redirect rules and capability checks; these interfaces contain no HTTP or secret implementation. Cancellation after provider dispatch cannot promise to prevent remote computation or billing.

Validation from the repository root:

```sh
npm run typecheck --workspace @quixi/core
npm run typecheck:tests --workspace @quixi/core
npm test --workspace @quixi/core
```
