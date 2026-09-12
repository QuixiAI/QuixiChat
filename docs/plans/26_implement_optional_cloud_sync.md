# 26 — Implement optional encrypted Cloud sync and backup

**Status:** Deferred — excluded from the current implementation goal by the user's 2026-09-08 instruction.

**Workstream:** Deferred Cloud — implementation after design gate

**Depends on:** [24](./24_validate_scale_and_release_hosts.md), [25](./25_design_cloud_encryption_and_recovery.md)

## Outcome

Add explicitly enabled encrypted backup and multi-device synchronization using the reviewed Cloud contract while keeping the local archive authoritative and independently usable.

## Product references

- [3. Product pillars](../product.md#3-product-pillars)
- [6. Deployment architecture](../product.md#6-deployment-architecture)
- [35. Privacy classes](../product.md#35-privacy-classes)
- [95. Quixi Cloud](../product.md#95-quixi-cloud)
- [96. Synchronization operations](../product.md#96-synchronization-operations)
- [97. Derived data and sync](../product.md#97-derived-data-and-sync)
- [98. Archive export](../product.md#98-archive-export)
- [99. Open export](../product.md#99-open-export)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)
- [115. V1 success criteria](../product.md#115-v1-success-criteria)
- [120. Final architecture](../product.md#120-final-architecture)

## Tasks

- [ ] Implement the independently deployable Cloud service, authentication/entitlement checks, encrypted object/operation storage, quotas, and operational monitoring defined by plan 25.
- [ ] Implement client key/device lifecycle and enrollment/recovery UI according to the reviewed design. Integrate native secret storage and the documented browser key-handling policy.
- [ ] Consume committed sync operations from StorageClient and implement retryable upload/download, checkpoints, conflict resolution, snapshot bootstrap, and encrypted attachment transfer.
- [ ] Apply incoming canonical changes transactionally through the Storage Worker and trigger local derived-data rebuild/indexing as required. Keep remote data out of private SQL implementation boundaries.
- [ ] Implement explicit Cloud enable/disable, backup status, sync progress, pause/error states, device management, export, and service-data deletion workflows.
- [ ] Implement desktop/browser continuity and archive recovery from encrypted backups without requiring the original provider account.
- [ ] Exercise offline changes, concurrent devices, duplicate/reordered delivery, expired sessions, revoked devices, key rotation/recovery, interrupted large uploads, and quota exhaustion.
- [ ] Deploy incrementally with the reviewed operational controls, redacted logs, recovery runbooks, migration/version compatibility, and rollback procedures.

## Deliverables and interfaces

- Optional Cloud service and clients, encrypted backup/sync integration, and account/device recovery UX.
- Multi-device convergence tests, deployment configuration, observability, and operational recovery documentation.

## Acceptance criteria

- [ ] Two enrolled devices converge on canonical history and verified attachments after offline changes and repeated delivery.
- [ ] The service stores only the content/metadata permitted by the reviewed encryption design and receives no default plaintext archive.
- [ ] FTS and semantic indexes rebuild locally instead of being synchronized as authoritative data.
- [ ] Disabling or losing Cloud leaves local chat, history, import, search, and open export usable.
- [ ] Backup recovery and device revocation behave exactly as documented, including unrecoverable cases.

## Boundaries and sequencing

Begin implementation only after plan 25’s design/review gate and a validated local-first release from plan 24. Neither billing nor Cloud authentication may become a prerequisite for ordinary local archive access.

[Back to the roadmap](./README.md)
