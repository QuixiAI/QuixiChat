# 01 — Prove universal local storage

**Status:** Complete (2026-09-13) — the universal SQLite WASM/OPFS path is proven on the web, Docker web and macOS desktop hosts with the go/no-go published in the [storage matrix](../validation/storage-proof.md); support is restricted where the path fails (Linux WebKitGTK 2.50.6 no-go) or cannot be verified here (installed Safari, Windows/WebView2, other combinations), and those remain release-host gates in plan 24 rather than a second backend.

**Workstream:** A1 — platform gate

**Depends on:** None; can start from the current scaffold.

## Outcome

Prove that one Storage Worker → SQLite WASM → OPFS implementation can support the intended browser and desktop hosts. Produce measured platform evidence before committing to a supported-host matrix.

## Product references

- [5. Hard architectural rules](../product.md#5-hard-architectural-rules)
- [6. Deployment architecture](../product.md#6-deployment-architecture)
- [9. Universal SQLite distribution](../product.md#9-universal-sqlite-distribution)
- [10. Storage Worker](../product.md#10-storage-worker)
- [11. OPFS layout](../product.md#11-opfs-layout)
- [12. Multi-tab ownership](../product.md#12-multi-tab-ownership)
- [103. Track A — Product Core](../product.md#103-track-a--product-core)
- [110. Release/platform risks](../product.md#110-releaseplatform-risks)
- [111. Storage stress tests](../product.md#111-storage-stress-tests)

## Tasks

- [x] Inventory the actual browser engines and desktop WebViews to test. Record OS, browser/WebView versions, secure-context requirements, isolation headers, quotas, and required APIs; distinguish tested support from provisional support.
- [x] Pin SQLite and sqlite-vec sources, versions, licenses, hashes, compiler settings, and toolchain. Build one reproducible WASM distribution with FTS5 and sqlite-vec enabled.
- [x] Implement minimal worker startup, typed request/reply/error handling, database initialization, migration bootstrap, serialized transactions, shutdown, and OPFS directory ownership in the storage package.
- [x] Implement one-owner coordination using a Web Lock and same-origin messaging. Define forwarding, owner loss, reconnect, and notification behavior without allowing a second SQLite owner.
- [x] Add a developer storage-proof screen to the shared app and run the identical implementation through web, Docker web, and Tauri. Keep proof records separate from future user history.
- [x] Exercise persistence requests, reload/restart durability, quota exhaustion, interrupted transactions, migration failure, and multi-tab contention. Record Safari durability and WebKitGTK OPFS results explicitly. — Ticked 2026-09-13 against retained evidence: persistence requests through the host with the browser's actual answer ([onboarding.md](../validation/onboarding.md)); reload and browser-process restart durability, interrupted transactions and owner takeover ([storage-proof.md](../validation/storage-proof.md), [archive-client.md](../validation/archive-client.md)); real OPFS quota exhaustion and recovery ([QUOTA.md](../../tests/diagnostics/QUOTA.md), `tests/e2e/storage-quota.spec.ts`); migration failure as a typed startup outcome with rescue export ([ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)) and refused newer or altered ledgers (`repository.test.ts`); multi-tab contention through the owner/follower protocol proofs and a second tab reading a 1,000,000-message archive ([storage-stress.md](../validation/storage-stress.md)). Safari: unverified, remote automation disabled ([safari.md](../../tests/hosts/safari.md)); WebKitGTK 2.50.6: no-go for synchronous OPFS handles ([linux](../../tests/hosts/linux/README.md)).
- [x] Publish the tested support matrix and a go/no-go decision. If the universal path fails on a host, document the blocker and restrict support instead of adding a second canonical backend.

## Deliverables and interfaces

- Pinned build recipe and artifact manifest under packages/storage/sqlite; generated binaries remain build artifacts.
- A minimal storage worker/client boundary, platform proof harness, and recorded results reusable by later storage tests.

## Acceptance criteria

- [x] The same checksummed SQLite artifact passes transaction, reopen, FTS5, and vector smoke checks on every claimed host.
- [x] Concurrent tabs never acquire independent active database ownership; clients recover predictably after the owner exits.
- [x] Failure tests preserve committed data and produce actionable errors; unsupported environments are reported honestly.

## Implementation evidence

- [Storage proof matrix and reproduction](../validation/storage-proof.md): real
  production web and Docker runs each pass 15 browser checks, with one explicitly
  skipped WebKit quota check; actual bundled macOS Tauri proof passes 22 checks,
  then 23 after process restart, including two-WebView ownership and takeover.
- [Ownership decision](../decisions/0002-opfs-worker-ownership.md),
  [pinned SQLite distribution](../../packages/storage/sqlite/README.md), and
  [browser scenarios](../../tests/e2e/storage-proof.spec.ts).
- [Actual OPFS quota recovery](../../tests/diagnostics/QUOTA.md) and
  [restricted WebKit session diagnosis](../../tests/diagnostics/WEBKIT_OPFS.md).

Remaining host and release limitations are recorded explicitly in the matrix.
The backend feasibility decision allows plans 02–03 to consume the proven worker
contract while this plan's broader platform qualification remains open. Installed
Safari automation is unavailable. Actual Linux/WebKitGTK 2.50.6 is a measured
no-go for synchronous OPFS handles; newer Linux runtimes and Windows/WebView2
remain unverified. See the [Linux diagnosis](../../tests/hosts/linux/README.md).
Proof APIs are not the canonical repositories required by plan 03.

## Boundaries and sequencing

This proves platform feasibility, not the complete canonical schema. Plan 02 consumes its findings. QuixiEmbed port work in plan 16 can proceed independently; embedding availability is irrelevant to this gate.

[Back to the roadmap](./README.md)
