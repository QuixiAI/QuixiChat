# Isolated SQLite selection-catalog prototype

**Status: proof implementation; not a production activation feature.** [ADR 0012](../../../../docs/decisions/0012-archive-selection.md) remains Proposed. Only `selection-proof-<uuid>` namespaces are accepted. Production core, clients, archive workers, selection and UI are unchanged.

The Storage Worker uses the project's pinned SQLite WASM through the official OPFS SAH pool. One initialized SQLite module is shared within each proof worker; separate named pools serve the selection catalog and fixture databases. Every operation acquires the namespace's global Web Lock, opens/unpauses its catalog connection, then closes/pauses the pool before releasing the lock. The catalog has a selection row, indexed operation intents/receipts, and retained archive identities. `journal_mode=DELETE` and `synchronous=FULL` are explicit.

## Proof API

`catalog.ts` exports `SelectionCatalog`, `Selection`, `Activation`, `Receipt`, `OperationStatus`, `SelectionError` and the shared module loader used by the fixture harness.

```ts
const catalog = new SelectionCatalog(`selection-proof-${crypto.randomUUID()}`, 'a');
const current = await catalog.read();
await catalog.guard(current, async () => {
  // A private, serialized source repository effect; no nested selection calls.
});
const receipt = await catalog.activateReviewed(activation, {
  withReviewedCandidate: commitSelection => reviewedBarrier(commitSelection),
  // reviewedBarrier owns source checks, candidate lock and validation.
});
const status = await catalog.status(activation.operationId, activation);
```

The caller must already own the source queue/lock for `guard` and `activate`. The order is source owner → global selection gate → candidate owner (`ifAvailable`). Callbacks run under the gate and must not reenter this catalog or call a client whose worker would wait on the same gate. Production adaptation must use private repository calls at the owning worker, not asynchronous callbacks into a foreground StorageClient.

`activateReviewed` owns only the selection gate. Its private reviewed-barrier callback alone owns the candidate lock, matching `ArchiveRepository.withActivationReview` without nested lock acquisition. The older `activate` proof adapter implements that barrier with its own fixture hooks; production must not wrap another candidate-locking barrier inside it. Publication is synchronous and single-use; its closure expires when the barrier returns or throws. A barrier returning without publication fails, and an escaped callback cannot publish later. Prepublication cancellation remains `CANCELLED` even if the validator throws an unrelated error; cancellation or cleanup exceptions after a successful commit return the authoritative receipt.

Activation binds operation ID, expected archive/selection revision, source sync high-water, candidate archive/manifest digest, review token and job ID. It copies the normalized request before asynchronous work. Both `status(id, fullPayload)` and replay reject changed bound fields. A committed replay returns the original receipt even after a later switch, without switching back. `status(id)` remains available for recovery when only the durable operation identity is known.

An intent commits as `prepared` before candidate validation. A selection transaction changes the head, commits its full receipt, and retains the selected identity together. Validation failure records `failed`. The next holder of the global gate reconciles leftover prepared intents to `interrupted`; it does not select their candidate. Explicit same-ID retry performs fresh checks before committing. SQL COMMIT failure or a lost reply requires status inspection, not a new operation identity or an assumed rollback.

`guard` holds the gate through the effect. Consequently a competing activation either follows a completed fixture write (and rejects an outdated source high-water), or the old selection fails its fence before writing. Selection revision catches switch-away/back even when archive ID matches again. The proof fixture deliberately has sync high-water 10 and count 1.

At most 16 catalog requests can be pending per instance. Known payload fields are individually bounded; stored payload/receipt strings are capped at 16 KiB, reasons at 512 characters. Operation lookup is indexed and intent recovery has a state index. No receipt history is loaded into a JavaScript array. Explicit `integrity()` scans the small catalog; full integrity scans are not on the generation guard path. Receipt retention currently grows on disk with operation count; no automatic pruning is implemented.

A missing catalog is initialized only in an absent isolated root namespace. Existing namespaces with missing, malformed or incompatible catalogs fail unavailable. Schema/application identity and the selected head's committed receipt are checked on open. Physical corruption never causes an empty replacement catalog or automatic writable fallback. Initial creation interrupted after directory allocation likewise requires recovery; there is no unproven bootstrap repair path.

The `proof` activation hooks exist only for the isolated harness. They allow termination after intent, inside the actual SQL transaction and after COMMIT before reply. Test-only SQL creates a pressure table inside the transaction to exercise real page/quota rollback without weakening normal metadata constraints. These hooks must not appear on production request contracts.

## What the proof establishes

Run from the repository root:

```sh
node --experimental-transform-types packages/storage/tests/selection/run.mjs
npx tsc --noEmit
```

The final extended suite passes 14 Chromium and 13 WebKit checks. The harness builds on port 4201 and uses disposable persistent Chromium/WebKit profiles, two real Storage Workers, real OPFS and separate real SQLite fixture databases. Its [recorded evidence](../../tests/selection/browser-evidence.json) includes artifact/source hashes, user agents, checks and every timing sample. It tests two-client races, admission, stale generation fences, candidate contention/validation failure, SQL_FULL rollback, actual worker termination during the transaction, lost committed reply followed by another switch, complete browser-process restart with pending intent, explicit same-ID resume, and physical SQLite-header corruption. Retained fixture integrity/counts remain unchanged after selection failure/corruption.

Chromium additionally uses the official [CDP quota override](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin), records actual `QuotaExceededError` from unmodified-result OPFS write calls, restores quota in `finally`, and verifies rolled-back head/receipt plus integrity after reopen. Pressure is one bounded 8 MiB SQLite zeroblob in a test-only transaction; the origin quota must stay below 32 MiB. WebKit's absence of an equivalent CDP control is explicitly skipped, while its separate SQL_FULL and actual transaction-termination tests run.

The [SQLite atomic-commit documentation](https://www.sqlite.org/atomiccommit.html) explains the rollback-journal mechanism being exercised. The [official WASM persistence documentation](https://sqlite.org/wasm/doc/trunk/persistence.md) describes the pool's pause/unpause lifecycle. These sources support the mechanism; actual browser evidence is still required for this filesystem/backend combination. There is no cross-database transaction: fixture history and selection are sequenced by locks, while only selection plus its receipt share a SQL transaction.

## Measured cost and remaining production gates

Each evidence run records cold initialization and 40 serialized generation checkpoints with at least 20 ms between samples. `openMs` includes pool unpause, SQLite open, schema/head checks and intent recovery; `closeMs` includes connection close and pool pause. Guard roundtrip includes the separate fixture pool/write plus worker messaging. It is not an isolated selection-only microbenchmark or a platform performance guarantee. See the adjacent evidence for measured median/p95/max values; machine load and concurrent work cause variation. Reusing a dedicated selection-owner connection could reduce these costs but requires separate ownership/deadlock qualification.

Recorded run: 2026-09-08T23:51:44.313Z. All times below are milliseconds.

| Engine | Cold open | Warm open median / p95 | Close/pause median / p95 | Guard roundtrip median / p95 / max |
| --- | --- | --- | --- | --- |
| chromium | 76.8 | 2.3 / 5.9 | 1.0 / 5.9 | 22.0 / 42.0 / 48.0 |
| webkit | 75.0 | 2.0 / 3.0 | 0.0 / 1.0 | 5.0 / 7.0 / 7.0 |

The legacy negative fixture deliberately imports no runtime selection code. It queues for the old archive owner lock while a managed activation is paused, then reacquires that lock after selection changes and writes two real SQLite checkpoints into the old archive. This **reproduces an unsupported bypass**; it is not a passing stale-writer protection claim. A separate test-only unqualified-cohort route refuses further activation without creating an intent or changing the pointer, even when no owner of the currently selected source appears in its lock snapshot. This tests the fail-closed policy, not a mechanism for proving a cohort qualified. Production activation remains off.

The candidate callback currently checks a real fixture database's integrity and sentinel; it does **not** invoke the production ArchiveRepository validator or validate a persisted archive review token. There are no real canonical generation records in these fixture effects. Before production activation, integrate the existing exact persisted review/candidate validation, source sync high-water read, every foreground/implicit canonical effect, managed client revisions, live-producer policy, cleanup exceptions, retained-archive review UI and full operation-status routing. Requalify those paths, large-candidate freeze/cancellation behavior, actual native WebViews, bootstrap interruption recovery and unsupported-schema handling. The prototype does not authorize a restore candidate to become the active production archive.

## Production integration review

The [ADR's production inventory](../../../../docs/decisions/0012-archive-selection.md#production-integration-inventory--review-only-2026-09-08) maps foreground, bootstrap, recovery, blob and maintenance effects to proposed guards. It also specifies mandatory active/retained/candidate access modes, the pre-fence-client rollout gate, and a production `activateReviewed` callback composition that avoids reacquiring the candidate owner lock already held by `ArchiveRepository.withActivationReview`. These are design edits only. Do not directly wire the prototype's candidate-locking `activate` around that existing barrier or expose an unmanaged production-write opt-out.
