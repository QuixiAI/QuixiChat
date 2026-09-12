# Universal storage proof

Measured 2026-09-08 on macOS 26.5.2, Apple Silicon. This is plan 01's backend
feasibility evidence, not a product release or a large-archive guarantee.

## Current matrix

| Host/runtime | Result | Scope and limits |
| --- | --- | --- |
| Web production bundle, Playwright Chromium 153.0.8010.12 | 8 checks pass | Persistent profile; actual browser restart, cross-tab ownership, owner death, SQL rollback, FTS/vector, real OPFS quota failure, and denied-storage handling |
| Web production bundle, Playwright WebKit 26.6 | 7 checks pass; quota check skipped | Persistent profile required in measured build; browser restart and cross-tab recovery pass; no equivalent quota override available |
| Docker/nginx web, same two macOS browser engines | Same 15 passes and 1 skip | Actual container-served bundle and isolation headers; this is not a Linux desktop/WebKitGTK result |
| Tauri 2.11.5, system WKWebView 21624.2.5.11.8 | 22 checks pass, then 23 after process restart | Bundled `tauri://localhost`, storage/FTS/vector/failures, two WebViews sharing an owner, forwarded writes, and surviving-follower takeover |
| Installed Safari 26.5.2 | Unverified | Session creation fails because remote automation is disabled; no settings changed and no storage-failure claim |
| Linux Tauri, Debian bookworm arm64, WebKitGTK 2.50.6 | No-go | Actual worker synchronous OPFS handles are unsupported, including after enabling the relevant public settings; no production workaround applied |
| Newer Linux/WebKitGTK, Windows/WebView2, other browser/OS combinations | Unverified | No support claim until the same artifact and relevant host checks run there |

The browser runner's device user agent can describe an emulated platform. The
physical execution OS above comes from the test host, not the user-agent string.
The checked-in [browser results](results/storage-proof-macos-26.5.2.json),
[Tauri results](../../tests/hosts/results/tauri-macos-26.5.2.json), and
[Safari automation result](../../tests/hosts/results/safari-macos-26.5.2-automation.json)
preserve concrete measurements and limitations.
The [Linux harness and diagnosis](../../tests/hosts/linux/README.md) preserve
the baseline, same-runtime origin comparison, configured feature experiment,
and exact upstream explanation for WebKitGTK 2.50.6's failed handle operation.

## Backend and ownership

Every measured host consumes SQLite 3.53.4 with sqlite-vec v0.1.9, including FTS5,
through one Storage Worker and the official OPFS SAH-pool VFS. The WASM SHA-256 is
`dd7c22431a3b8ad51ab5e6ed91065593574c34c5959d2efdef2f17484eedcb2c`.
Browser tests hash the actual served WASM response against the pinned manifest;
the Tauri runner checks the bundled WASM bytes. The Node smoke test also verifies
artifact hashes, but its memory filesystem is not persistence evidence.

[ADR 0002](../decisions/0002-opfs-worker-ownership.md) defines one-owner Web Lock
coordination, bounded forwarding, serialized operations, close/reopen, and
uncertain write outcomes. Proof record, FTS, and operation-log mutations commit
together. These tables are developer fixtures, not the final canonical schema.

## Persistence and failure observations

- Secure contexts, OPFS synchronous handles in a worker, Web Locks, and
  BroadcastChannel are required. Localhost is used for browser tests; hosted web
  requires HTTPS. Tauri's tested custom origin reports a secure context.
- Web/Docker sends COOP `same-origin` and COEP `require-corp`. Tauri reports
  `crossOriginIsolated=false` and still passes: this VFS does not require
  SharedArrayBuffer. The scoped desktop CSP permits local workers and WASM.
- `navigator.storage.persist()` returned false in the Tauri proof. Short
  application restart durability passed; eviction resistance is not established.
  Quota/usage numbers are observations of a profile, not promised product limits.
- The [WebKit diagnostic](../../tests/diagnostics/WEBKIT_OPFS.md) isolates an
  actual `getDirectory()` failure in an ephemeral context before SQLite starts.
  Persistent contexts pass. Denied storage is surfaced with profile/storage
  guidance and disabled write controls; no alternative database is substituted.
- The [quota test](../../tests/diagnostics/QUOTA.md) observes an actual browser
  `QuotaExceededError` from synchronous OPFS writes under a Chromium quota
  override. SQLite reports an I/O error. After restoring quota and reopening,
  committed text, FTS results, operation counts, and integrity pass; the failed
  record is absent and a subsequent write succeeds.
- The production web and desktop entries no longer reduce a failed archive
  open to a text line. [ADR 0016](../decisions/0016-startup-failure-and-schema-recovery.md)
  maps the storage boundary code to a typed outcome with retry and the exact
  worker message. `tests/e2e/startup-failure.spec.ts` (Chromium) proves it in
  the built web app for an interrupted first run, including recovery on retry
  once storage is available again; `tests/e2e/startup-unsupported-session.spec.ts`
  proves the view against WebKit's real ephemeral-context storage failure;
  `tests/e2e/startup-rescue.spec.ts` (Chromium) browses an intact archive
  that cannot be opened read-only through the retained reader, then rescues
  it byte-exactly from that view through host staging.
- The separate `fullProbe` tests SQLite's page limit. It is explicitly distinct
  from browser quota or physical disk exhaustion. Both it and migration failure
  preserve the committed proof record/operation pair.

## Reproduction

```sh
npm ci
npm run sqlite:build
npx playwright install chromium webkit
QUIXI_TEST_OUTPUT_DIR=playwright-report/web npm run test:e2e
python3 tests/hosts/run_tauri_storage_proof.py
docker build -f deploy/docker/Dockerfile -t quixi-storage-proof:local .
docker run --rm -d --name quixi-storage-proof-local -p 127.0.0.1:4180:8080 quixi-storage-proof:local
QUIXI_TEST_BASE_URL=http://127.0.0.1:4180 QUIXI_TEST_OUTPUT_DIR=playwright-report/docker npx playwright test
docker stop quixi-storage-proof-local
python3 tooling/record-storage-evidence.py --browser web=playwright-report/web/browser-results.json --browser docker=playwright-report/docker/browser-results.json --output docs/validation/results/storage-proof-macos-26.5.2.json
```

SQLite builds from hash-verified public sources in the pinned Emscripten container.
Docker builds these artifacts internally and verifies the reviewed manifest before
building the frontend. CI builds SQLite once, verifies the artifact in consuming
jobs, and runs browser and actual desktop harnesses. CI configuration is present;
the local runs above are evidence, not a claim that remote CI has executed.

## Gate and remaining work

**Backend feasibility gate: pass for the measured environments.** The identical
backend works in all three host forms, including two actual Tauri WebViews and
application restart. Canonical contracts and repositories can consume the proven
worker/ownership boundary without waiting for unrelated OS qualification.

**Release/platform gate: incomplete.** Keep plan 01's remaining platform coverage
open alongside plan 24. No release-wide support claim follows from this decision.
Installed Safari and newer Linux/WebKitGTK remain unverified. The tested
WebKitGTK 2.50.6 configuration is explicitly excluded from supported hosts: its
non-Cocoa synchronous file-handle backend is unimplemented. API presence and
enabling settings do not repair that missing operation. Do not generalize
Playwright WebKit results to system WebKitGTK or replace OPFS with another
canonical backend to bypass this failure.

Plan 24 still owns product-scale workloads, signed installation/upgrades,
long-lived archives, eviction/recovery limits, and final release support. Plan 03
must add canonical migrations/transactions and blobs; plan 09 must prove real
archive export/restore. None of those are satisfied by these small proof records.
