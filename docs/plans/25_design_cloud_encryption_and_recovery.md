# 25 — Design Cloud encryption, synchronization, and recovery

**Status:** Deferred — excluded from the current implementation goal by the user's 2026-09-08 instruction.

**Workstream:** Deferred Cloud — design gate

**Depends on:** [02](./02_define_canonical_history.md), [03](./03_build_storage_repositories.md), [09](./09_add_archives_and_open_export.md)

## Outcome

Resolve the optional Cloud trust, key-management, recovery, and synchronization contracts before implementing storage of encrypted user archives on Quixi infrastructure.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [6. Deployment architecture](../product.md#6-deployment-architecture)
- [35. Privacy classes](../product.md#35-privacy-classes)
- [95. Quixi Cloud](../product.md#95-quixi-cloud)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [97. Derived data and sync](../product.md#97-derived-data-and-sync)
- [98. Archive export](../product.md#98-archive-export)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)
- [120. Final architecture](../product.md#120-final-architecture)

## Tasks

- [ ] Define Cloud’s threat model and data inventory: canonical operations, attachment bytes, archive snapshots, device identities, and exposed service metadata. Preserve complete local operation without Cloud.
- [ ] Design client-side encryption, key generation/storage, device enrollment, revocation, rotation, and recovery. Explicitly resolve the key-recovery questions deferred by product section 110.4.
- [ ] Define authentication, account lifecycle, paid entitlement, opt-in/opt-out, and deletion behavior separately from archive decryption keys.
- [ ] Define sync-op identity, ordering, idempotency, conflict handling, deletion/tombstones, checkpoints, and snapshot bootstrap. Reconcile these with the canonical mutation coverage established in plans 02–03.
- [ ] Define encrypted attachment transfer, resumable chunks, integrity verification, metadata publication, retention, quota accounting, and partial-transfer cleanup.
- [ ] Specify that FTS, embeddings, compressed indexes, and ranking caches rebuild locally. Document exactly which metadata the service can observe.
- [ ] Design recovery UX for a lost device, lost credentials, lost keys, revoked devices, and unavailable Cloud. Record which cases are recoverable and which cannot be promised.
- [ ] Produce an implementation contract and validation fixtures, and complete a focused security/design review before approving the Cloud implementation gate.

## Deliverables and interfaces

- Cloud architecture/key-recovery decision record, threat model, versioned encrypted transport contracts, and user recovery flows.
- Conflict/idempotency fixtures and an explicit readiness checklist for plan 26.

## Acceptance criteria

- [ ] The design explains who can decrypt each data class and what the server learns in normal operation and recovery.
- [ ] Account recovery does not silently weaken the chosen encryption guarantees.
- [ ] Sync convergence and retry behavior are defined for conflicting offline edits, deletion, interrupted uploads, and revoked devices.
- [ ] Cloud remains optional and its unavailability cannot make a healthy local archive unusable.

## Boundaries and sequencing

This work is deferred and does not gate local-first v1. The product spec does not settle the cryptographic/recovery scheme; resolving and reviewing it is the deliverable of this plan. Do not treat potential Cloud capabilities as an already-approved implementation design.

[Back to the roadmap](./README.md)
